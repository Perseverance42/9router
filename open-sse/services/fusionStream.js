import { FORMATS } from "../translator/formats.js";
import { CLAUDE_EVENT, CLAUDE_DELTA, CLAUDE_BLOCK, RESPONSES_EVENT, RESPONSES_ITEM } from "../translator/schema/index.js";
import { buildStreamErrorBytes } from "../utils/streamHelpers.js";

// Only these categories may cross a nested Fusion boundary. Never reuse an
// upstream message, tool name, schema error, or arbitrary details in diagnostics.
const SAFE_ERRORS = Object.freeze({
  fusion_stream_incomplete: ["Fusion synthesis stream ended before completion", true],
  fusion_invalid_stream: ["Fusion synthesis returned invalid SSE framing", true],
  fusion_upstream_error: ["Fusion upstream model call failed", true],
  fusion_aborted: ["Fusion request cancelled", false],
  fusion_tool_output_truncated: ["Fusion synthesis tool output was truncated", true],
  fusion_tool_constraints: ["Fusion action violates client tool constraints", false],
  fusion_invalid_tool_calls: ["Fusion returned invalid application tool calls", false],
  fusion_output_constraints: ["Fusion answer violates client output constraints", false],
  fusion_no_usable_action: ["No usable action satisfies the client constraints", false],
  fusion_invalid_completion: ["Fusion model returned an invalid completion", true],
  fusion_preflight_error: ["Invalid Fusion request or configuration", false],
  fusion_initial_error: ["Fusion initial consultation failed", true],
  fusion_panel_error: ["Fusion panel evaluation failed", true],
  fusion_analyst_error: ["Fusion analyst evaluation failed", true],
  fusion_synthesis_error: ["Fusion synthesis failed", true],
});
const STAGES = ["preflight", "initial", "panel", "analyst", "synthesis"];
export function safeFusionError(error, stage = "synthesis", fallback = "fusion_upstream_error", upstreamStatus) {
  stage = STAGES.includes(stage) ? stage : "synthesis";
  const known = error?.type === "fusion_error" && typeof error.code === "string" && Object.hasOwn(SAFE_ERRORS, error.code);
  const code = known ? error.code : fallback;
  const [message, retryable] = SAFE_ERRORS[code];
  const status = error?.details?.upstream_status;
  const validStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;
  return { message, type: "fusion_error", code, details: {
    stage, retryable: known && typeof error.details?.retryable === "boolean" ? error.details.retryable : retryable,
    ...(validStatus(status) && known ? { upstream_status: status }
      : validStatus(upstreamStatus) ? { upstream_status: upstreamStatus } : {}),
  } };
}
export function logFusionFailure(log, error, format) {
  log?.warn?.("FUSION", JSON.stringify({
    format: [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES].includes(format) ? format : "unknown",
    stage: error.details.stage, code: error.code, retryable: error.details.retryable,
    ...(error.details.upstream_status !== undefined ? { upstream_status: error.details.upstream_status } : {}),
  }));
}
const streamFailure = (code, error) => Object.assign(new Error(), safeFusionError(error, "synthesis", code));

// Text streams natively. Hold the tail starting with the first tool event until
// complete names/arguments can be validated, so internal calls never reach clients.
export function guardFusionStream(response, { sourceFormat, validate, signal, abort, detach: detachParent, log }) {
  const reader = response.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const detach = () => { signal.removeEventListener("abort", onAbort); detachParent(); };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const calls = new Map();
  let buffer = "";
  let held = "";
  let holding = false;
  let terminal = false;
  let truncated = false;
  const callAt = (index) => {
    if (!calls.has(index)) calls.set(index, { type: "function", function: { name: "", arguments: "" } });
    return calls.get(index);
  };
  const inspect = (frame) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) {
        if (line && !/^(?:event:|id:|retry:|:)/.test(line)) throw streamFailure("fusion_invalid_stream");
        continue;
      }
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") { holding = true; terminal = true; continue; }
      let event;
      try { event = JSON.parse(data); } catch { throw streamFailure("fusion_invalid_stream"); }
      if (!event || typeof event !== "object" || Array.isArray(event)) throw streamFailure("fusion_invalid_stream");
      if (event.error || event.type === RESPONSES_EVENT.FAILED || event.type === "error"
        || /^event:\s*(?:error|response\.failed)\s*$/m.test(frame)) {
        throw streamFailure("fusion_upstream_error", event.error || event.response?.error || event);
      }
      if (event.type === CLAUDE_EVENT.MESSAGE_STOP || event.type === RESPONSES_EVENT.COMPLETED || event.type === RESPONSES_EVENT.INCOMPLETE) terminal = true;
      const finish = event.choices?.[0]?.finish_reason || event.delta?.stop_reason;
      if (["length", "max_tokens", "content_filter"].includes(finish) || event.type === RESPONSES_EVENT.INCOMPLETE) truncated = true;
      if (event.choices?.some((choice) => choice.finish_reason)
        || [CLAUDE_EVENT.MESSAGE_DELTA, CLAUDE_EVENT.MESSAGE_STOP, RESPONSES_EVENT.COMPLETED, RESPONSES_EVENT.INCOMPLETE, RESPONSES_EVENT.FAILED].includes(event.type)) holding = true;
      if (sourceFormat === FORMATS.OPENAI) {
        for (const part of event.choices?.[0]?.delta?.tool_calls || []) {
          holding = true;
          const call = callAt(part.index ?? 0);
          if (part.id) call.id = part.id;
          call.function.name += part.function?.name || "";
          call.function.arguments += part.function?.arguments || "";
        }
      } else if (sourceFormat === FORMATS.CLAUDE) {
        if (event.type === CLAUDE_EVENT.CONTENT_BLOCK_START && event.content_block?.type === CLAUDE_BLOCK.TOOL_USE) {
          holding = true;
          const call = callAt(event.index);
          call.id = event.content_block.id;
          call.function.name = event.content_block.name;
          if (Object.keys(event.content_block.input || {}).length) call.function.arguments = JSON.stringify(event.content_block.input);
        }
        if (event.delta?.type === CLAUDE_DELTA.INPUT_JSON) callAt(event.index).function.arguments += event.delta.partial_json || "";
      } else {
        if (event.type === RESPONSES_EVENT.OUTPUT_ITEM_ADDED && event.item?.type === RESPONSES_ITEM.FUNCTION_CALL) {
          holding = true;
          const call = callAt(event.output_index);
          call.id = event.item.call_id;
          call.function.name = event.item.name;
          call.function.arguments = event.item.arguments || "";
        }
        if (event.type === RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA) callAt(event.output_index).function.arguments += event.delta || "";
        if (event.type === RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DONE) callAt(event.output_index).function.arguments = event.arguments;
      }
    }
  };
  return new Response(new ReadableStream({
    async pull(output) {
      try {
        while (true) {
          signal.throwIfAborted();
          let emitted = false;
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end + 2);
            buffer = buffer.slice(end + 2);
            try { inspect(frame); }
            catch (error) { throw streamFailure("fusion_invalid_stream", error); }
            if (holding) held += frame;
            else { output.enqueue(encoder.encode(frame)); emitted = true; }
          }
          if (done || terminal) {
            if (done && buffer.trim()) throw streamFailure("fusion_invalid_stream");
            if (!terminal) throw streamFailure("fusion_stream_incomplete");
            if (calls.size && truncated) throw streamFailure("fusion_tool_output_truncated");
            if (sourceFormat === FORMATS.CLAUDE) {
              for (const call of calls.values()) call.function.arguments ||= "{}";
            }
            try { validate({ choices: [{ message: { tool_calls: [...calls.values()] } }] }); }
            catch (error) { throw streamFailure("fusion_invalid_tool_calls", error); }
            if (held) output.enqueue(encoder.encode(held));
            detach();
            reader.cancel().catch(() => {});
            output.close();
            return;
          }
          if (emitted) return;
        }
      } catch (error) {
        const failure = signal.aborted
          ? safeFusionError(null, "synthesis", "fusion_aborted")
          : safeFusionError(error);
        logFusionFailure(log, failure, sourceFormat);
        detach();
        abort(error);
        reader.cancel(error).catch(() => {});
        output.enqueue(buildStreamErrorBytes(failure.code === "fusion_aborted" ? 499 : 502, failure.message, sourceFormat, failure));
        output.close();
      }
    },
    cancel(reason) {
      logFusionFailure(log, safeFusionError(null, "synthesis", "fusion_aborted"), sourceFormat);
      detach(); abort(reason); return reader.cancel(reason);
    },
  }), { status: response.status, headers: response.headers });
}
