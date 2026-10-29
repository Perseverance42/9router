const MAX_BYTES = 256 * 1024;
const evidence = new WeakMap();

export const getRouteweaveEvidence = response => evidence.get(response);
export function setRouteweaveEvidence(response, state) {
  evidence.set(response, state);
  return response;
}

const refused = d => !d?.error && (d?.choices?.some(c => c.finish_reason === "content_filter" || c.message?.refusal || c.delta?.refusal) || d?.stop_reason === "refusal" || d?.delta?.stop_reason === "refusal");
export function usableRouteweaveJson(d) {
  if (!d || d.error || d.type === "error" || refused(d)) return false;
  if (Array.isArray(d.choices)) return d.choices.length === 1 && d.choices.every(c => ["stop", "length"].includes(c.finish_reason) && !c.message?.tool_calls && !c.message?.function_call && typeof c.message?.content === "string" && c.message.content.trim());
  return ["end_turn", "max_tokens", "stop_sequence"].includes(d.stop_reason) && Array.isArray(d.content) && d.content.every(c => c.type === "text") && d.content.some(c => typeof c.text === "string" && c.text.trim());
}

// ponytail: canonical text Chat/Claude only; audit other terminal protocols before admission.
// Inspect before translation: synthetic translator terminals cannot prove upstream success.
export function inspectRouteweaveUpstream(response, signal, buffered = false) {
  const state = { status: "pending", noRetry: false };
  const wrapped = observeResponse(response, signal, status => { state.status = status; }, undefined, buffered, state);
  return { state, response: setRouteweaveEvidence(wrapped, state) };
}

export function observeResponse(response, signal, finish, upstream = getRouteweaveEvidence(response), buffered = false, rawState = null) {
  let ended = false;
  const settle = status => { if (!ended) { ended = true; signal?.removeEventListener("abort", aborted); finish(status); } };
  const aborted = () => { settle("cancelled"); void reader?.cancel(signal?.reason).catch(() => {}); };
  let reader;
  if (!response.body) { settle(signal?.aborted ? "cancelled" : "failed"); return response; }
  reader = response.body.getReader();
  const sse = (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "", json = "", bytes = 0, usable = false, terminal = false, finished = false, bad = !response.ok;
  const event = frame => {
    const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { terminal = true; return; }
    try {
      const d = JSON.parse(data);
      if (refused(d)) { bad = true; if (rawState) rawState.noRetry = true; }
      if (d.error || d.type === "error") bad = true;
      if (d.type === "message_stop") terminal = true;
      if (d.choices && (!Array.isArray(d.choices) || d.choices.length > 1)) bad = true;
      for (const c of d.choices || []) {
        if (c.delta?.tool_calls || c.delta?.function_call) bad = true;
        if (c.finish_reason != null) {
          if (["stop", "length"].includes(c.finish_reason)) finished = true;
          else bad = true;
        }
      }
      if (d.type === "content_block_start" && d.content_block?.type !== "text") bad = true;
      if (d.type === "content_block_delta" && d.delta?.type !== "text_delta") bad = true;
      if (d.type === "message_delta" && d.delta?.stop_reason != null) {
        if (["end_turn", "max_tokens", "stop_sequence"].includes(d.delta.stop_reason)) finished = true;
        else bad = true;
      }
      if (d.choices?.some(c => typeof c.delta?.content === "string" && c.delta.content.trim()) || (d.type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string" && d.delta.text.trim()) || (d.type === "content_block_start" && d.content_block?.type === "text" && typeof d.content_block.text === "string" && d.content_block.text.trim())) usable = true;
    } catch { bad = true; }
  };
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (sse && (pending + decoder.decode()).trim()) bad = true;
          if (!sse) {
            try {
              const d = JSON.parse(json + decoder.decode());
              if (rawState && refused(d)) rawState.noRetry = true;
              usable = !!usableRouteweaveJson(d); terminal = finished = usable;
            } catch { bad = true; }
          }
          const success = upstream ? upstream.status === "succeeded" && !bad && usable : !bad && terminal && usable && finished;
          settle(success ? "succeeded" : "failed");
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if ((!sse || buffered) && bytes > MAX_BYTES) throw Error("RouteWeave response too large");
        const chunk = decoder.decode(value, { stream: true });
        if (sse) {
          for (let offset = 0; offset < chunk.length; offset += 8192) {
            pending += chunk.slice(offset, offset + 8192);
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) {
              if (boundary.index > MAX_BYTES) throw Error("RouteWeave SSE frame too large");
              event(pending.slice(0, boundary.index).replace(/\r\n/g, "\n"));
              pending = pending.slice(boundary.index + boundary[0].length);
            }
            if (pending.length > MAX_BYTES) throw Error("RouteWeave SSE frame too large");
          }
        } else { json += chunk; }
        controller.enqueue(value);
      } catch (error) {
        settle(signal?.aborted ? "cancelled" : "failed");
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) { settle("cancelled"); await reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const wrapped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  return upstream ? setRouteweaveEvidence(wrapped, upstream) : wrapped;
}

export async function checkRouteweaveJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return { response, valid: false };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw Error("RouteWeave response too large");
      chunks.push(value);
    }
    const content = Buffer.concat(chunks);
    const data = JSON.parse(content.toString("utf8"));
    const state = getRouteweaveEvidence(response);
    const rebuilt = new Response(content, { status: response.status, statusText: response.statusText, headers: response.headers });
    if (state) setRouteweaveEvidence(rebuilt, state);
    return { response: rebuilt, valid: !!usableRouteweaveJson(data) && (!state || state.status === "succeeded"), noRetry: state ? state.noRetry : !!refused(data) };
  } catch {
    await reader.cancel().catch(() => {});
    return { response: Response.json({ error: { message: "Invalid RouteWeave upstream completion" } }, { status: 502 }), valid: false, noRetry: getRouteweaveEvidence(response)?.noRetry === true };
  }
}
