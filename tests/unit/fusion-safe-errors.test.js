import { describe, it, expect, vi } from "vitest";
import { guardFusionStream } from "../../open-sse/services/fusionStream.js";
import { handleFusionChat } from "../../open-sse/services/fusion.js";

const secret = "SECRET_PROMPT_HEADER_ARGS_STACK";
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const done = "data: [DONE]\n\n";
const completion = (message) => Response.json({ choices: [{ message, finish_reason: "stop" }] });
const analysis = { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], verification_needed: [], usable_response_ids: ["response_1"] };
const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } } }];
const toolFrame = (name = "read_file", args = '{"path":"ok"}') => frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } }] });
const finish = (reason = "tool_calls") => frame({ choices: [{ delta: {}, finish_reason: reason }] });
async function guarded(text, options = {}) {
  const parent = new AbortController();
  const log = { warn: vi.fn() };
  const response = guardFusionStream(new Response(text), { sourceFormat: "openai", validate() {}, signal: parent.signal, abort: (error) => parent.abort(error), detach() {}, log, ...options });
  return { text: await response.text(), log };
}
async function run(synthesis, body = {}, extra = {}) {
  const log = { warn: vi.fn() };
  const result = await handleFusionChat({
    body: { model: "fusion", messages: [{ role: "user", content: secret }], tools, stream: true, ...body },
    models: ["p/a"], judgeModel: "p/j", tuning: { minPanels: 1, maxPanels: 1 }, log,
    handleSingleModel: async (_body, _model, { stage }) => {
      if (stage === "initial") return completion({ tool_calls: [{ function: { name: "consult_panel", arguments: JSON.stringify({ panel_ids: ["panel_1"], brief: "Evaluate" }) } }] });
      if (stage === "panel") return completion({ content: "Advice" });
      if (stage === "analyst") return completion({ content: JSON.stringify(analysis) });
      return typeof synthesis === "function" ? synthesis() : new Response(synthesis);
    }, ...extra,
  });
  return { status: result.status, text: await result.text(), log };
}
function expectSafe(result, code) {
  expect(result.text).toContain(`"code":"${code}"`);
  expect(result.text).not.toContain(secret);
  expect(JSON.stringify(result.log.warn.mock.calls)).not.toContain(secret);
  expect(result.log.warn).toHaveBeenCalled();
  const metadata = JSON.parse(result.log.warn.mock.calls.at(-1)[1]);
  expect(Object.keys(metadata).every((key) => ["format", "stage", "code", "retryable", "upstream_status"].includes(key))).toBe(true);
}

describe("Fusion safe error categories", () => {
  it.each([
    [frame({ choices: [{ delta: { content: "partial" } }] }), "fusion_stream_incomplete"],
    [`data: {${secret}\n\n`, "fusion_invalid_stream"],
    [`garbage: ${secret}\n\n`, "fusion_invalid_stream"],
    [frame({ error: { message: secret, code: secret, details: { token: secret } } }), "fusion_upstream_error"],
    [toolFrame() + finish("length") + done, "fusion_tool_output_truncated"],
  ])("separates stream failures without leaking upstream data", async (text, code) => {
    expectSafe(await guarded(text), code);
  });

  it.each(["openai", "claude", "openai-responses"])("preserves known nested errors in %s envelopes", async (sourceFormat) => {
    const error = { type: "fusion_error", code: "fusion_no_usable_action", message: secret, details: { retryable: false, upstream_status: 429, stage: secret, args: secret } };
    const event = sourceFormat === "openai-responses" ? { type: "response.failed", response: { error } } : { type: "error", error };
    const result = await guarded(frame(event), { sourceFormat });
    expectSafe(result, "fusion_no_usable_action");
    expect(result.text).toContain('"stage":"synthesis"');
    expect(result.text).toContain('"upstream_status":429');
    expect(result.text.startsWith("event: error")).toBe(sourceFormat === "claude");
  });

  it("recognizes an SSE error event even without an error wrapper", async () => {
    expectSafe(await guarded(`event: error\n${frame({ message: secret })}`), "fusion_upstream_error");
  });

  it("cascades an actual guarded child stream", async () => {
    const child = await guarded(toolFrame() + finish("length") + done);
    expectSafe(await guarded(child.text), "fusion_tool_output_truncated");
  });

  it.each([
    [{ tool_choice: "required" }, finish("stop") + done, "fusion_tool_constraints"],
    [{ tool_choice: "none" }, toolFrame() + finish() + done, "fusion_tool_constraints"],
    [{ tool_choice: { type: "function", function: { name: "read_file" } } }, toolFrame(secret) + finish() + done, "fusion_tool_constraints"],
    [{ parallel_tool_calls: false }, toolFrame() + frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "read_file", arguments: '{"path":"ok"}' } }] } }] }) + finish() + done, "fusion_tool_constraints"],
    [{}, toolFrame(secret) + finish() + done, "fusion_invalid_tool_calls"],
    [{}, toolFrame("read_file", secret) + finish() + done, "fusion_invalid_tool_calls"],
    [{}, toolFrame("read_file", '{"path":42}') + finish() + done, "fusion_invalid_tool_calls"],
  ])("uses the real public tool validator", async (body, text, code) => {
    expectSafe(await run(text, body), code);
  });

  it("does not confuse truncated text with truncated tool output", async () => {
    const text = frame({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }) + done;
    const result = await guarded(text);
    expect(result.text).toBe(text);
    expect(result.log.warn).not.toHaveBeenCalled();
  });

  it("reports output constraints without echoing JSON parse errors", async () => {
    expectSafe(await run(() => completion({ content: secret }), { stream: false, response_format: { type: "json_object" } }), "fusion_output_constraints");
  });

  it("reports a transport read error without echoing its message", async () => {
    const result = await guarded(new ReadableStream({ start(output) { output.error(new Error(secret)); } }));
    expectSafe(result, "fusion_upstream_error");
  });

  it("does not reject a valid schema-checked tool call", async () => {
    const text = toolFrame() + finish() + done;
    const result = await run(text);
    expect(result.text).toBe(text);
    expect(result.log.warn).not.toHaveBeenCalled();
  });

  it.each([true, false])("sanitizes and preserves only known HTTP error metadata: %s", async (known) => {
    const result = await run(() => Response.json({ error: {
      type: "fusion_error", code: known ? "fusion_no_usable_action" : secret, message: secret,
      details: { retryable: false, upstream_status: 429, token: secret },
    } }, { status: 502 }));
    expectSafe(result, known ? "fusion_no_usable_action" : "fusion_upstream_error");
    expect(result.text).toContain(`"upstream_status":${known ? 429 : 502}`);
    expect(result.text).toContain(`"retryable":${!known}`);
  });

  it("sanitizes thrown providers and invalid completion JSON", async () => {
    expectSafe(await run(() => { throw new Error(secret); }), "fusion_upstream_error");
    expectSafe(await run(() => new Response(secret), { stream: false }), "fusion_invalid_completion");
  });

  it("keeps pre-stream tool truncation distinct from constraints", async () => {
    expectSafe(await run(() => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "read_file", arguments: secret } }] }, finish_reason: "length" }] }), { stream: false }), "fusion_tool_output_truncated");
  });

  it("rejects malformed known metadata without echoing it", async () => {
    const result = await guarded(frame({ error: { type: "fusion_error", code: "fusion_stream_incomplete", message: secret, details: { retryable: secret, upstream_status: secret } } }));
    expectSafe(result, "fusion_stream_incomplete");
    expect(result.text).toContain('"retryable":true');
    expect(result.text).not.toContain("upstream_status");
  });

  it("sanitizes schema compilation errors", async () => {
    const result = await run(done, { tools: [{ type: "function", function: { name: secret, parameters: { type: secret } } }] });
    expectSafe(result, "fusion_preflight_error");
  });

  it("cancels a pending reader without leaking the abort reason", async () => {
    const parent = new AbortController();
    const log = { warn: vi.fn() };
    const response = guardFusionStream(new Response(new ReadableStream({ start() {} })), {
      sourceFormat: "openai", signal: parent.signal, validate() {}, abort() {}, detach() {}, log,
    });
    const pending = response.text();
    parent.abort(new Error(secret));
    expectSafe({ text: await pending, log }, "fusion_aborted");
  });
});
