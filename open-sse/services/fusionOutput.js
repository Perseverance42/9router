import { FORMATS } from "../translator/formats.js";
import { initState, translateResponse } from "../translator/index.js";
import { translateNonStreamingResponse } from "../handlers/chatCore/nonStreamingHandler.js";
import { liftReasoningAliases } from "../translator/concerns/reasoning.js";
import { CLAUDE_BLOCK, OPENAI_FINISH, RESPONSES_INCOMPLETE_REASON, RESPONSES_STATUS, ROLE } from "../translator/schema/index.js";
import { formatSSE } from "../utils/streamHelpers.js";
import { SSE_DONE, SSE_HEADERS_CORS } from "../utils/sseConstants.js";

const SUPPORTED_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

function validateCompletion(completion, sourceFormat) {
  if (!completion || typeof completion.id !== "string" || !completion.id ||
      typeof completion.model !== "string" || !Number.isInteger(completion.created) ||
      !Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new TypeError("Expected a completed OpenAI Chat completion");
  }
  if (sourceFormat !== FORMATS.OPENAI && completion.choices.length !== 1) {
    throw new TypeError(`${sourceFormat} output requires exactly one choice`);
  }
  for (const choice of completion.choices) {
    const message = choice?.message;
    if (!Number.isInteger(choice.index) || !message || message.role !== ROLE.ASSISTANT ||
        (message.content != null && typeof message.content !== "string") ||
        ![OPENAI_FINISH.STOP, OPENAI_FINISH.LENGTH, OPENAI_FINISH.TOOL_CALLS, OPENAI_FINISH.CONTENT_FILTER].includes(choice.finish_reason)) {
      throw new TypeError("Expected an assistant message with text/null content and a terminal finish_reason");
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      throw new TypeError("Expected tool_calls to be an array");
    }
    for (const call of message.tool_calls || []) {
      if (call?.type !== "function" || typeof call.id !== "string" || !call.id ||
          typeof call.function?.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") {
        throw new TypeError("Expected function tool calls with IDs, names and string arguments");
      }
      if (sourceFormat === FORMATS.CLAUDE) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { /* rejected below */ }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new TypeError("Claude tool arguments must be a JSON object");
        }
      }
    }
  }
}

function responsesBody(completion) {
  const body = translateNonStreamingResponse(completion, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
  const finishReason = completion.choices[0].finish_reason;
  if (finishReason === OPENAI_FINISH.LENGTH || finishReason === OPENAI_FINISH.CONTENT_FILTER) {
    body.status = RESPONSES_STATUS.INCOMPLETE;
    body.incomplete_details = { reason: finishReason === OPENAI_FINISH.LENGTH ? RESPONSES_INCOMPLETE_REASON.MAX_OUTPUT_TOKENS : RESPONSES_INCOMPLETE_REASON.CONTENT_FILTER };
  }
  const usage = completion.usage;
  if (!usage) delete body.usage;
  else {
    if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
      body.usage.input_tokens_details = { cached_tokens: usage.prompt_tokens_details.cached_tokens };
    }
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
      body.usage.output_tokens_details = { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens };
    }
  }
  return body;
}

/** Deliver a completed canonical Chat response; no upstream/model invocation. */
export function deliverFusionCompletion(completion, { sourceFormat, stream, includeUsage = false }) {
  // Antigravity's existing translator drops tool-call IDs; Gemini has no output translator.
  // ponytail: support only lossless client routes; add others when their translators preserve IDs.
  if (!SUPPORTED_FORMATS.has(sourceFormat)) {
    throw new TypeError(`Unsupported fusion output format: ${sourceFormat}`);
  }
  if (typeof stream !== "boolean" || typeof includeUsage !== "boolean") {
    throw new TypeError("stream and includeUsage must be booleans");
  }
  validateCompletion(completion, sourceFormat);
  const canonical = structuredClone(completion);
  if (sourceFormat !== FORMATS.OPENAI) {
    canonical.choices[0].message = liftReasoningAliases(canonical.choices[0].message);
  }
  const body = sourceFormat === FORMATS.OPENAI_RESPONSES
    ? responsesBody(canonical)
    : translateNonStreamingResponse(canonical, FORMATS.OPENAI, sourceFormat);
  if (sourceFormat === FORMATS.CLAUDE && canonical.usage) {
    const details = canonical.usage.prompt_tokens_details;
    const cached = details?.cached_tokens || 0;
    const created = details?.cache_creation_tokens || 0;
    body.usage.input_tokens -= cached + created;
    if (cached) body.usage.cache_read_input_tokens = cached;
    if (created) body.usage.cache_creation_input_tokens = created;
  }
  if (!stream) {
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const state = { ...initState(sourceFormat), targetFormat: FORMATS.OPENAI, created: canonical.created, model: canonical.model };
  const events = [];
  const emit = (chunk) => {
    for (const event of translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state) || []) {
      if (event != null) events.push(event);
    }
  };
  const chunk = (delta, finishReason = null, index = 0) => ({
    id: canonical.id,
    object: "chat.completion.chunk",
    created: canonical.created,
    model: canonical.model,
    choices: [{ index, delta, finish_reason: finishReason }],
  });

  if (sourceFormat === FORMATS.OPENAI) {
    emit({ ...chunk({}), choices: canonical.choices.map((choice) => ({
      index: choice.index,
      delta: {
        ...choice.message,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
      },
      finish_reason: null,
    })) });
    emit({ ...chunk({}), choices: canonical.choices.map((choice) => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })) });
    if (includeUsage && canonical.usage) emit({ ...chunk({}), choices: [], usage: canonical.usage });
  } else {
    const choice = canonical.choices[0];
    const message = choice.message;
    emit(chunk({ role: ROLE.ASSISTANT }));
    let outputIndex = 0;
    // Responses uses choice/tool indices as output indices; keep reasoning/text/tools distinct.
    if (message.reasoning_content) emit(chunk({ reasoning_content: message.reasoning_content }, null, outputIndex++));
    const textIndex = outputIndex;
    if (message.content) {
      // Native content is literal text, not an upstream <think> transport envelope.
      const parts = sourceFormat === FORMATS.OPENAI_RESPONSES ? message.content.split(/([<>])/) : [message.content];
      for (const content of parts) if (content) emit(chunk({ content }, null, outputIndex));
      outputIndex++;
    }
    for (const call of message.tool_calls || []) {
      emit(chunk({ tool_calls: [{ ...call, index: outputIndex++ }] }, null, textIndex));
    }
    emit({ ...chunk({}, choice.finish_reason), ...(canonical.usage ? { usage: canonical.usage } : {}) });
    emit(null);

    if (sourceFormat === FORMATS.CLAUDE) {
      // Completed calls are already validated: do not apply the upstream stream's Read/prefix repairs.
      const calls = new Map((message.tool_calls || []).map((call) => [call.id, call]));
      const blocks = new Map();
      for (const event of events) {
        if (event.type === "message_start") {
          event.message.id = body.id;
          event.message.usage = { ...body.usage, output_tokens: 0 };
        }
        if (event.type === "content_block_start" && event.content_block.type === CLAUDE_BLOCK.TOOL_USE && calls.has(event.content_block.id)) {
          const call = calls.get(event.content_block.id);
          event.content_block.name = call.function.name;
          blocks.set(event.index, call);
        }
        if (event.delta?.type === "input_json_delta" && blocks.has(event.index)) {
          event.delta.partial_json = blocks.get(event.index).function.arguments;
        }
      }
    } else {
      for (const event of events) {
        if (event.data.response) Object.assign(event.data.response, { id: body.id, model: body.model });
        if (event.event === "response.completed") {
          // Keep translated output item IDs/order, but use the completed JSON body's finish/usage metadata.
          Object.assign(event.data.response, { status: body.status, ...(body.usage ? { usage: body.usage } : {}), ...(body.incomplete_details ? { incomplete_details: body.incomplete_details } : {}) });
          if (body.status === RESPONSES_STATUS.INCOMPLETE) event.event = event.data.type = "response.incomplete";
        }
      }
    }
  }

  const sse = events.map((event) => formatSSE(event, sourceFormat)).join("") + (sourceFormat === FORMATS.OPENAI ? SSE_DONE : "");
  return new Response(sse, { headers: SSE_HEADERS_CORS });
}
