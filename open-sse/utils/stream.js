import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { PROVIDERS } from "../config/providers.js";
import { liftReasoningAliases } from "../translator/concerns/reasoning.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, ensureStreamToolCallIds } from "./streamHelpers.js";
import { restoreToolNames } from "./opencodeFingerprint.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Bound translator usage deferral. This timeout does not authorize successful
// completion: a stalled upstream without its terminal event remains incomplete.
const PENDING_COMPLETION_FLUSH_MS = 3000;

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat = mode === STREAM_MODE.PASSTHROUGH ? FORMATS.OPENAI : undefined,
    sourceFormat = mode === STREAM_MODE.PASSTHROUGH ? FORMATS.OPENAI : undefined,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;

  // Tool-call ids already sent to the client, keyed by the tool-call index.
  // A late fragment that opens a NEW index without an id must not reach the
  // client as-is: strict OpenAI-compatible SDKs abort the turn on a
  // tool_call without a string id (#4992).
  const seenToolCallIds = new Map();

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let responsesFailureSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;
  let upstreamCompleted = false;
  let upstreamStarted = false;
  let upstreamInvalid = false;
  // Hold only terminal frames. Text still streams; Fusion owns tool validation.
  const pendingTerminals = [];
  let eventData = [];
  let eventName = null;
  let passthroughFrame = "";

  // SSE data fields belong to one event, not one JSON object per line.
  const assembleEvents = (lines, eof = false) => {
    if (targetFormat === FORMATS.OLLAMA) return lines;
    const events = [];
    const dispatch = () => {
      const payload = eventData.join("\n");
      if (payload.trim()) {
        if (eventName) events.push(`event: ${eventName}`);
        let value = payload;
        try { value = JSON.stringify(JSON.parse(payload)); } catch { /* classified below */ }
        events.push(`data: ${value}`, "");
      }
      eventData = [];
      eventName = null;
    };
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) { dispatch(); continue; }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") eventData.push(value);
      if (field === "event") eventName = value;
    }
    if (eof) dispatch();
    return events;
  };

  const emitOutput = (output, controller) => {
    const terminal = output.split("\n").some((line) => {
      if (!line.startsWith("data:")) return false;
      const parsed = parseSSELine(line);
      // Native incomplete/failed events retain failure semantics; only success
      // terminals synthesized by translators need completion authorization.
      return parsed?.type === "message_stop" ||
        ["response.completed", "response.done"].includes(parsed?.type);
    });
    if (terminal) { pendingTerminals.push(output); return; }
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
  };
  const releaseTerminals = (controller) => {
    if (!upstreamCompleted || upstreamInvalid) return;
    finalizeStream();
    for (const output of pendingTerminals.splice(0)) {
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
    }
  };

  // Only wire-level completion counts. Translators can synthesize finish_reason
  // on flush, even when the upstream disconnected mid-response.
  const observeCompletion = (line, parsed) => {
    if (!line.trim() || (!line.startsWith("data:") && targetFormat !== FORMATS.OLLAMA)) return;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      upstreamInvalid = true;
      return;
    }
    if (targetFormat === FORMATS.OLLAMA && parsed.done === true) upstreamCompleted = true;
    if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY, FORMATS.VERTEX].includes(targetFormat)) {
      // Match the Gemini translator's native/response envelopes, not its fallback
      // mapping of unknown finish reasons to stop. Only these are complete turns.
      const response = parsed.response || parsed;
      if (response.error) upstreamInvalid = true;
      const reason = response.candidates?.[0]?.finishReason;
      if (reason) {
        if (reason === "STOP" || reason === "MAX_TOKENS") upstreamCompleted = true;
        else upstreamInvalid = true;
        if (reason === "MAX_TOKENS" && sourceFormat === FORMATS.OPENAI_RESPONSES) upstreamInvalid = true;
      }
    }
    if (parsed.type === "message_start" && parsed.message?.id) upstreamStarted = true;
    if (sourceFormat === FORMATS.OPENAI_RESPONSES &&
        ["length", "content_filter", "max_tokens"].includes(parsed.choices?.[0]?.finish_reason || parsed.delta?.stop_reason || parsed.done_reason)) upstreamInvalid = true;
    if (parsed.error || parsed.type === "error" || parsed.type === "response.failed" ||
        parsed.response?.error || ["failed", "incomplete"].includes(parsed.response?.status) ||
        parsed.type === "response.incomplete") upstreamInvalid = true;
    if ((targetFormat === FORMATS.OPENAI && line.slice(5).trim() === "[DONE]") ||
        (targetFormat === FORMATS.CLAUDE && parsed.type === "message_stop" && upstreamStarted) ||
        (targetFormat === FORMATS.OPENAI_RESPONSES &&
          ["response.completed", "response.done"].includes(parsed.type) &&
          (parsed.response?.status === undefined || parsed.response.status === "completed"))) upstreamCompleted = true;
  };

  const emitCompletedOpenAIStream = (controller) => {
    if ((sourceFormat !== FORMATS.OPENAI &&
        !(sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES)) || streamDoneSent) return;
    // An explicit response.failed may close with DONE, but never releases success.
    if (!responsesFailureSent && (!upstreamCompleted || upstreamInvalid)) return;
    releaseTerminals(controller);
    finalizeStream();
    const output = "data: [DONE]\n\n";
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
    streamDoneSent = true;
  };

  // Lane quirk: upstream streams thinking under the OpenRouter aliases
  // (`reasoning` / `reasoning_details[]`) instead of reasoning_content — OpenCode
  // Free's MiMo route does. Lift it on every passthrough delta so OpenAI-shaped
  // clients, the thinking accumulation below and usage accounting see the text.
  const liftAliases = mode === STREAM_MODE.PASSTHROUGH && !!PROVIDERS[provider]?.quirks?.reasoningAliasFields;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Flush translator state after its usage wait, but release completion only
  // after the upstream supplied its own terminal event.
  const flushPendingCompletion = (controller) => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      emitOutput(output, controller);
      sseEmittedCount++;
    }
    releaseTerminals(controller);
  };

  const processChunk = (chunk, controller, eof = false) => {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const trailingCR = !eof && buffer.endsWith("\r");
      const lines = (trailingCR ? buffer.slice(0, -1) : buffer).split(/\r\n|\r|\n/);
      buffer = (lines.pop() || "") + (trailingCR ? "\r" : "");
      if (eof && buffer) { lines.push(buffer); buffer = ""; }

      for (const line of assembleEvents(lines, eof)) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (!trimmed) {
            if (passthroughFrame) emitOutput(passthroughFrame + "\n", controller);
            passthroughFrame = "";
            continue;
          }
          if (trimmed.startsWith("data:")) observeCompletion(trimmed, parseSSELine(trimmed));
          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") {
            passthroughFrame = "";
            emitCompletedOpenAIStream(controller);
            continue;
          }
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              let parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // A fragment that opens a new tool-call index without an id breaks
              // strict OpenAI-compatible clients. Mint/reuse one before the
              // chunk reaches the client.
              const toolCallIdFixed = ensureStreamToolCallIds(parsed, seenToolCallIds);

              // The fingerprint pass renames a colliding caller tool to an alias
              // (read -> read_client). On this path nothing restored it, so the
              // client received a call to a tool it never declared and answered
              // "Model tried to call unavailable tool 'read_client'" (#4986).
              let toolNameRestored = false;
              if (toolNameMap?.size) {
                const restored = restoreToolNames(parsed, toolNameMap);
                if (restored !== parsed) {
                  parsed = restored;
                  toolNameRestored = true;
                }
              }

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Alias lanes: expose thinking as reasoning_content (additive) before
              // the valuable-content check, so reasoning-only chunks survive.
              if (liftAliases && parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice?.delta) {
                    const lifted = liftReasoningAliases(choice.delta);
                    if (lifted !== choice.delta) {
                      choice.delta = lifted;
                      fieldsInjected = true;
                    }
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed) || parsed.type === "response.incomplete";

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected || toolCallIdFixed || toolNameRestored) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          passthroughFrame += output;
          // The complete event is emitted at its blank delimiter, not per data line.
          if (responsesTerminal) currentOpenAIResponsesEvent = null;
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        observeCompletion(trimmed, parsed);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && (isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed) ||
            openAIResponsesEventName === "response.incomplete")) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // A direct Chat-to-Responses translation can defer response.completed
          // while waiting for a usage trailer. [DONE] ends that opportunity even
          // if the upstream keeps the HTTP connection open, so finish now.
          if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
              state.completionPending && !state.completedSent) {
            flushPendingCompletion(controller);
          }

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            responsesFailureSent = true;
            sseEmittedCount++;
          }

          emitCompletedOpenAIStream(controller);
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          emitOutput(output, controller);
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            emitOutput(output, controller);
            sseEmittedCount++;
          }
        }

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound translator usage wait, not completion evidence.
        if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
            state?.completionPending && !state?.completedSent && !completionFlushTimer) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
      releaseTerminals(controller);
  };

  return new TransformStream({
    transform: processChunk,
    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        processChunk(new Uint8Array(), controller, true);
        if (mode === STREAM_MODE.PASSTHROUGH) {
          finalizeStream();
          emitCompletedOpenAIStream(controller);
          return;
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            emitOutput(output, controller);
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
          responsesFailureSent = true;
        }

        finalizeStream();
        releaseTerminals(controller);
        emitCompletedOpenAIStream(controller);
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
        throw error;
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, toolNameMap = null, format = FORMATS.OPENAI) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    targetFormat: format,
    sourceFormat: format,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
