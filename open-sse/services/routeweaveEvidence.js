const MAX_BYTES = 256 * 1024;
const evidence = new WeakMap();

export const getRouteweaveEvidence = response => evidence.get(response);
export function setRouteweaveEvidence(response, state) {
  evidence.set(response, state);
  return response;
}

export function usableRouteweaveJson(d) {
  if (!d || d.error || d.type === "error") return false;
  if (Array.isArray(d.choices)) return d.choices.length === 1 && d.choices.every(c => ["stop", "length"].includes(c.finish_reason) && typeof c.message?.content === "string" && c.message.content.trim());
  return ["end_turn", "max_tokens", "stop_sequence"].includes(d.stop_reason) && d.content?.some(c => c.type === "text" && typeof c.text === "string" && c.text.trim());
}

// ponytail: canonical text Chat/Claude only; audit other terminal protocols before admission.
// One bounded reader before translation: translators cannot manufacture upstream evidence.
export function inspectRouteweaveUpstream(response, signal, buffered = false) {
  const state = { status: "pending" };
  return { state, response: setRouteweaveEvidence(observeResponse(response, signal, status => { state.status = status; }, undefined, buffered), state) };
}

export function observeResponse(response, signal, finish, upstream = getRouteweaveEvidence(response), buffered = false) {
  let ended = false;
  const settle = status => { if (!ended) { ended = true; signal?.removeEventListener("abort", aborted); finish(status); } };
  const aborted = () => { settle("cancelled"); void reader.cancel(signal?.reason).catch(() => {}); };
  if (!response.body) { settle(signal?.aborted ? "cancelled" : "failed"); return response; }
  const reader = response.body.getReader();
  const sse = (response.headers.get("content-type") || "").includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "", json = "", bytes = 0, usable = false, terminal = false, finished = false, bad = !response.ok;
  const event = frame => {
    const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { terminal = true; return; }
    try {
      const d = JSON.parse(data);
      if (d.error || d.type === "error") bad = true;
      if (d.type === "message_stop") terminal = true;
      for (const c of d.choices || []) {
        if (c.finish_reason != null) {
          if (["stop", "length"].includes(c.finish_reason)) finished = true;
          else bad = true;
        }
      }
      if (d.type === "message_delta" && d.delta?.stop_reason != null) {
        if (["end_turn", "max_tokens", "stop_sequence"].includes(d.delta.stop_reason)) finished = true;
        else bad = true;
      }
      if (d.choices?.some(c => typeof c.delta?.content === "string" && c.delta.content.trim()) || (d.type === "content_block_delta" && d.delta?.type === "text_delta" && d.delta.text?.trim()) || (d.type === "content_block_start" && d.content_block?.type === "text" && d.content_block.text?.trim())) usable = true;
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
            try { usable = !!usableRouteweaveJson(JSON.parse(json + decoder.decode())); terminal = finished = usable; } catch { bad = true; }
          }
          const success = upstream ? upstream.status === "succeeded" && !bad && usable : !bad && terminal && usable && finished;
          settle(success ? "succeeded" : "failed");
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if ((!sse || buffered) && bytes > MAX_BYTES) {
          settle("failed");
          void reader.cancel().catch(() => {});
          controller.error(Error("RouteWeave response too large"));
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        if (sse) {
          // Reject oversized frames without retaining an unbounded stream copy.
          for (let offset = 0; offset < chunk.length; offset += 8192) {
            pending += chunk.slice(offset, offset + 8192);
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(pending))) { event(pending.slice(0, boundary.index).replace(/\r\n/g, "\n")); pending = pending.slice(boundary.index + boundary[0].length); }
            if (pending.length > MAX_BYTES) { bad = true; pending = ""; }
          }
        } else { json += chunk; }
        controller.enqueue(value);
      } catch (error) { settle(signal?.aborted ? "cancelled" : "failed"); controller.error(error); }
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
    const valid = !!usableRouteweaveJson(data);
    const noRetry = !data.error && (data.choices?.some(c => c.finish_reason === "content_filter" || c.message?.refusal) || data.stop_reason === "refusal");
    const rebuilt = new Response(content, { status: response.status, statusText: response.statusText, headers: response.headers });
    const state = getRouteweaveEvidence(response);
    if (state) setRouteweaveEvidence(rebuilt, state);
    return { response: rebuilt, valid: valid && (!state || state.status === "succeeded"), noRetry };
  } catch {
    await reader.cancel().catch(() => {});
    return { response: Response.json({ error: { message: "Invalid RouteWeave upstream completion" } }, { status: 502 }), valid: false };
  }
}
