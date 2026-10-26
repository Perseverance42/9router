/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { parseModel } from "./model.js";
import { peekStreamForContent, reconstructStream, isNoRetryFinish } from "./emptyFailover.js";
import {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";

// Peek a 2xx combo response for real content. Returns null for non-SSE responses (leave
// them untouched). For SSE, returns { outcome: "content"|"empty", finishReason, response }
// where `response` is a faithful replay of the original stream (head buffer + live reader).
async function peekComboResponse(result, log) {
  const ct = (result.headers.get("content-type") || "").toLowerCase();
  if (!result.body || !ct.includes("text/event-stream")) return null;
  const peeked = await peekStreamForContent(result.body);
  const response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return { outcome: peeked.outcome, finishReason: peeked.finishReason, timedOut: peeked.timedOut, response };
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) {
    comboRotationState.delete(comboName);
    clearStickyComboSession(comboName);
  } else {
    comboRotationState.clear();
    clearStickyComboSession();
  }
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
  if (!data || typeof data !== "object") return false;

  // OpenAI chat format
  if (Array.isArray(data.choices)) {
    if (data.choices.length === 0) return true;
    const choice = data.choices[0];
    if (!choice) return true;

    const msg = choice.message || choice.delta;
    const content = msg?.content;
    const hasContent = typeof content === "string" ? content.trim().length > 0 : (Array.isArray(content) && content.length > 0);
    const hasToolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call);
    const hasReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false;

    const finish = choice.finish_reason;
    const isNormalFinish = finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call";

    if (!hasContent && !hasToolCalls && !hasReasoning && (!isNormalFinish || finish === "in_progress" || finish === "incomplete")) {
      return true;
    }
  }

  // Anthropic messages format
  if (Array.isArray(data.content)) {
    const hasContent = data.content.some((c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use");
    const stopReason = data.stop_reason;
    if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
      return true;
    }
  }

  return false;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", or "smart"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {boolean} [options.autoSwitch=true] - Capability auto-switching
 * @param {string|null} [options.sessionId=null] - Client session identifier for prompt cache retention
 * @param {string} [options.smartPolicy="smart"] - Policy: "smart" (adaptive ≥80%), "strict" (lock 1st model), "per-turn", or "custom"
 * @param {boolean} [options.sessionSticky=true] - Keep chosen model across session requests to retain prompt cache
 * @param {number} [options.confidenceThreshold=0.8] - Minimum confidence required for model switch (0-1)
 * @param {Function|null} [options.resolveSmartChoice=null] - Smart router resolver callback: (body, models) => Promise<{ choice, probabilities, confidence } | null>
 * @returns {Promise<Response>}
 */
export async function handleComboChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  comboStrategy,
  comboStickyLimit = 1,
  autoSwitch = true,
  sessionId = null,
  smartPolicy = "smart",
  sessionSticky = true,
  confidenceThreshold = 0.8,
  resolveSmartChoice = null,
}) {
  let rotatedModels = models;
  let activeStickyModel = null;

  if (comboStrategy === "smart") {
    const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase();
    const isPerTurn = policy === "per-turn" || sessionSticky === false;
    const isStrict = policy === "strict";

    let switchThreshold = 0.8;
    if (policy === "custom") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    } else if (policy === "smart-switch-70") switchThreshold = 0.7;
    else if (policy === "smart-switch-90") switchThreshold = 0.9;
    else if (policy.startsWith("smart-switch") || policy === "smart") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    }

    if (!isPerTurn && sessionId) {
      activeStickyModel = getStickyComboModel(comboName, sessionId, models);
    }

    if (activeStickyModel) {
      if (isStrict) {
        // Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
        log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`);
      } else if (typeof resolveSmartChoice === "function") {
        // Smart Switch (Adaptive): check if the user's task drastically shifted
        try {
          const smartResult = await resolveSmartChoice(body, models);
          const newChoice = smartResult?.choice;
          const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

          if (newChoice && newChoice !== activeStickyModel && models.includes(newChoice) && conf !== null && conf >= switchThreshold) {
            // Task changed with high confidence: switch model and update session
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`);
            if (sessionId) {
              setStickyComboModel(comboName, sessionId, newChoice);
              activeStickyModel = newChoice;
            }
          } else {
            // Stay on current model to preserve warm prompt cache
            rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
            log.info("COMBO", `smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`);
          }
        } catch (err) {
          // Fail open to active sticky model
          rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
          log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, { error: err?.message || String(err) });
        }
      } else {
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
      }
    } else if (typeof resolveSmartChoice === "function") {
      // Turn 1 or per-turn: evaluate System One to select initial model
      try {
        const smartResult = await resolveSmartChoice(body, models);
        const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

        if (smartResult?.choice && models.includes(smartResult.choice)) {
          if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
            log.info("COMBO", `smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`);
          } else {
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`);
            if (!isPerTurn && sessionId) {
              setStickyComboModel(comboName, sessionId, smartResult.choice);
              activeStickyModel = smartResult.choice;
            }
          }
        } else {
          log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`);
        }
      } catch (err) {
        log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, { error: err?.message || String(err) });
      }
    }
  } else {
    // Apply rotation strategy if enabled
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let requestScopedResult = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(body, modelStr);
      
      // Success (2xx). A 2xx is necessary but NOT sufficient: Gemini aborts (e.g.
      // MALFORMED_FUNCTION_CALL) still return 200 and stream empty content, which would
      // otherwise be delivered as a successful empty answer with no failover.
      // Peek the stream for real content before committing to this candidate.
      if (result.ok) {
        let peeked = null;
        try {
          peeked = await peekComboResponse(result, log);
        } catch (peekErr) {
          // peekStreamForContent is written not to throw; if reconstruction/Response
          // construction ever does, result.body is already locked by getReader() and can no
          // longer be streamed. Returning `result` would hand the client a locked, unreadable
          // body. Degrade to a clean, valid (empty) SSE stream instead.
          log.warn("COMBO", `empty-peek error on ${modelStr}, returning empty SSE: ${peekErr?.message || peekErr}`);
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (!peeked) {
          // Non-streaming (or non-SSE) response — not this peek's job. The zero-content
          // JSON check still applies on a non-final seat.
          const isLastModel = i === rotatedModels.length - 1;
          if (!isLastModel) {
            const contentType = result.headers?.get?.("content-type") || "";
            if (contentType.includes("application/json")) {
              try {
                const peekBody = await result.clone().json();
                if (isZeroContentResponse(peekBody)) {
                  log.warn("COMBO", `Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`);
                  if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
                    clearStickyComboSession(comboName, sessionId);
                  }
                  lastError = "Zero usable content";
                  lastStatus = 200;
                  continue;
                }
              } catch {
                // Ignore JSON parse errors
              }
            }
          }

          log.info("COMBO", `Model ${modelStr} succeeded`);
          return result;
        }

        if (peeked.outcome === "content") {
          log.info("COMBO", `Model ${modelStr} succeeded${peeked.timedOut ? " (peek deadline; committed)" : ""}`);
          return peeked.response;
        }

        // Empty generation. Fall through to the next candidate unless this is a legitimately
        // empty class (content filter) or the last candidate — in which case return the
        // (empty) response as-is, preserving prior behaviour rather than manufacturing a 5xx.
        const reasonLabel = peeked.finishReason || "no-content";
        const isLast = i === rotatedModels.length - 1;
        if (isNoRetryFinish(peeked.finishReason) || isLast) {
          log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — ${isNoRetryFinish(peeked.finishReason) ? "no-retry class" : "last candidate"}, returning as-is`);
          return peeked.response;
        }

        log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — falling through to next candidate`);
        if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
          clearStickyComboSession(comboName, sessionId);
        }
        // Drain/close the discarded stream in the background so its usage logging still runs.
        peeked.response.body?.cancel?.().catch(() => {});
        lastError = `empty generation (${reasonLabel})`;
        if (!lastStatus) lastStatus = 502;
        continue;
      }

      // If the model that failed was the session-sticky model, clear it so next turns re-evaluate
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { provider } = parseModel(modelStr);
      const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(result.status, errorText, 0, provider);

      if (!shouldFallback && !requestScoped) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // A request-scoped 4xx (validation failure, unsupported parameter, context
      // overflow) says this member cannot serve THIS request — not that the
      // credential is unhealthy. Members run on different providers with
      // different validation, so the next member may well serve it. Advance
      // without a cooldown, and without waiting: there is nothing to recover.
      // checkFallbackError() reports no account fallback here on purpose (a
      // request-scoped fault must not evict a healthy account from rotation).
      if (requestScoped) {
        log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, { status: result.status });
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        if (!requestScopedResult) requestScopedResult = result;
        continue;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // At least one member rejected the request itself. Hand back that member's own
  // response — status and body — rather than the synthesized envelope below: the
  // synthesized one reaches the client as a 200 carrying an error object, which
  // reads as an empty success, and it buries the member that named the real cause.
  // This is also what the caller saw before combos advanced on these errors.
  if (requestScopedResult) {
    log.warn("COMBO", `No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`);
    return requestScopedResult;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export { handleFusionChat } from "./fusion.js";

export {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";
