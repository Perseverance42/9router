import { describe, it, expect, vi } from "vitest";
import { handleFusionChat, estimateFusionRequest } from "../../open-sse/services/fusion.js";
import { FUSION_PANEL_INSTRUCTIONS, FUSION_TIGHT_PANEL_INSTRUCTIONS } from "../../open-sse/config/fusion.js";

const analysis = { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], verification_needed: [], usable_response_ids: ["response_1"] };
const completion = (message, finish_reason = "stop") => new Response(JSON.stringify({ id: "chatcmpl-test", model: "test", created: 1, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }] }));
const tool = { type: "function", function: { name: "read_file", parameters: { type: "object" } } };
const argumentsJSON = '{ "path": "a\\\\b", "exact": "not false", "n": 1e2 }';
const body = () => ({ messages: [{ role: "user", content: "Keep original style and history" }], tools: [tool] });
const run = (handleSingleModel, extra = {}) => handleFusionChat({ body: body(), models: ["p/panel"], judgeModel: "p/judge", handleSingleModel, ...extra });
function pipeline(seen = [], options = {}) {
  return vi.fn(async (request, model, execution) => {
    seen.push({ request, model, ...execution });
    if (execution.stage === "initial") return completion({ tool_calls: [{ function: { name: "consult_panel", arguments: JSON.stringify({ panel_ids: ["panel_1"], brief: "Observed facts, not assumptions" }) } }] }, "tool_calls");
    if (execution.stage === "panel") return completion({ content: options.prose || "Evidence is uncertain; do not delete", reasoning_content: "PRIVATE REASONING", reasoning: "ALSO PRIVATE", tool_calls: [{ function: { name: "read_file", arguments: argumentsJSON } }], ...options.panelMessage }, options.panelFinish || "stop");
    if (execution.stage === "analyst") {
      if (options.onAnalyst) return options.onAnalyst(request, execution);
      const summary = request.response_format.json_schema.schema.properties.panel_summaries;
      return completion({ content: JSON.stringify({ ...analysis, ...(summary ? { panel_summaries: { response_1: "Evidence is uncertain; do not delete" } } : {}) }), reasoning_content: "ANALYST PRIVATE" });
    }
    return completion({ content: "Final", reasoning_content: "PUBLIC REASONING" });
  });
}
const largeBody = () => ({ ...body(), messages: [{ role: "user", content: "h".repeat(45000) }], max_tokens: 1000 });
const shortLimits = async () => ({ contextWindow: 40000, maxOutput: 8192 });

describe("Fusion context budget", () => {
  it("always drops advisory reasoning, adds concise instructions and normal caps, without extra calls", async () => {
    const seen = [];
    const original = body();
    const saved = structuredClone(original);
    const result = await run(pipeline(seen), { body: original });
    expect(result.ok).toBe(true);
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel", "analyst", "synthesis"]);
    expect(seen[0].request.max_tokens).toBe(4096);
    expect(seen[1].request.max_tokens).toBe(8192);
    expect(JSON.stringify(seen[1].request)).toContain(FUSION_PANEL_INSTRUCTIONS);
    expect(JSON.stringify(seen[1].request)).not.toContain(FUSION_TIGHT_PANEL_INSTRUCTIONS);
    for (const entry of seen.slice(2)) {
      expect(JSON.stringify(entry.request)).not.toContain("PRIVATE");
      expect(JSON.stringify(entry.request)).not.toContain('"reasoning"');
    }
    expect(seen[2].request.response_format.json_schema.schema.properties.panel_summaries).toBeUndefined();
    expect(seen[3].request.max_tokens).toBeUndefined();
    expect(JSON.stringify(seen[3].request)).not.toContain(FUSION_PANEL_INSTRUCTIONS);
    expect((await result.json()).choices[0].message.reasoning_content).toBe("PUBLIC REASONING");
    expect(original).toEqual(saved);
  });

  it.each([[97, 43, 97], [43, 97, 43]])("respects max_completion_tokens precedence (%i, %i)", async (completionCap, tokenCap, expected) => {
    const seen = [];
    const original = { ...body(), max_completion_tokens: completionCap, max_tokens: tokenCap };
    expect((await run(pipeline(seen), { body: original })).ok).toBe(true);
    expect(seen[1].request.max_completion_tokens).toBe(expected);
    expect(seen[1].request.max_tokens).toBe(expected);
    expect(seen[3].request.max_completion_tokens).toBe(completionCap);
    expect(seen[3].request.max_tokens).toBe(tokenCap);
  });

  it.each([0, -1, "100"])("rejects invalid caller output limits (%s) instead of raising them", async (max_tokens) => {
    const fn = pipeline();
    expect((await run(fn, { body: { ...body(), max_tokens } })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps optional direct-answer caller limits unchanged", async () => {
    const original = { ...body(), max_completion_tokens: 12000 };
    const fn = vi.fn(async () => completion({ content: "Direct" }));
    expect((await run(fn, { body: original, tuning: { minPanels: 0, maxPanels: 1 } })).ok).toBe(true);
    expect(fn.mock.calls[0][0].max_completion_tokens).toBe(12000);
    expect(fn.mock.calls[0][0].max_tokens).toBeUndefined();
  });

  it("fails oversized original history before any provider dispatch without leaking prompts", async () => {
    const fn = pipeline();
    const result = await run(fn, { body: { messages: [{ role: "user", content: "SECRET".repeat(150000) }] } });
    expect(result.status).toBe(400);
    const data = await result.json();
    expect(data.error.code).toBe("fusion_context_budget");
    expect(data.error.details).toEqual({ stage: "initial", retryable: false });
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses the logical target callback for a short-context combo seat", async () => {
    const seen = [];
    const limits = vi.fn(async (model) => ({ contextWindow: model === "short-combo" ? 1000 : 200000, maxOutput: 8192 }));
    const result = await run(pipeline(seen), { models: ["short-combo"], getModelLimits: limits });
    expect((await result.json()).error).toMatchObject({ code: "fusion_context_budget", details: { stage: "panel", retryable: false } });
    expect(seen.map(({ stage }) => stage)).toEqual(["initial"]);
    expect(limits).toHaveBeenCalledWith("short-combo");
  });

  it("combines conditional prose summaries and evaluation in the existing analyst call, retaining exact action payloads", async () => {
    const seen = [];
    const original = largeBody();
    const saved = structuredClone(original);
    expect((await run(pipeline(seen, { prose: "p".repeat(36000) }), { body: original, getModelLimits: shortLimits })).ok).toBe(true);
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel", "analyst", "synthesis"]);
    expect(JSON.stringify(seen[1].request)).toContain(FUSION_TIGHT_PANEL_INSTRUCTIONS);
    expect(seen[1].request.max_tokens).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(seen[2].request)).not.toContain("h".repeat(100));
    expect(seen[2].request.response_format.json_schema.schema.required).toContain("panel_summaries");
    const context = JSON.parse(seen[3].request.messages.at(-1).content.split("\n").at(-1));
    expect(context.responses[0].content).toBe("Evidence is uncertain; do not delete");
    expect(context.responses[0].tool_calls[0]).toEqual({ name: "read_file", arguments: JSON.parse(argumentsJSON), arguments_json: argumentsJSON });
    expect(context.responses[0]).toMatchObject({ refusal: null, finish_reason: "stop", issues: [] });
    expect(context.analysis).toEqual(analysis);
    expect(seen[3].request.messages.some(({ content }) => content === original.messages[0].content)).toBe(true);
    expect(seen[3].request.tools).toEqual(original.tools);
    expect(seen[3].request.max_tokens).toBe(1000);
    expect(original).toEqual(saved);
  });

  it("retains refusal, finish reason and malformed tool arguments outside prose summaries", async () => {
    const seen = [];
    const fn = pipeline(seen, { prose: "p".repeat(36000), panelMessage: { refusal: "Do not execute", tool_calls: [{ function: { name: "read_file", arguments: "{broken" } }] }, panelFinish: "length" });
    expect((await run(fn, { body: largeBody(), getModelLimits: shortLimits })).ok).toBe(true);
    const context = JSON.parse(seen[3].request.messages.at(-1).content.split("\n").at(-1));
    expect(context.responses[0]).toMatchObject({ refusal: "Do not execute", finish_reason: "length", tool_calls: [{ name: "read_file", arguments: "{broken", arguments_json: "{broken" }] });
    expect(context.responses[0].issues[0]).toContain("Invalid JSON arguments");
  });

  it.each(["bad", "oversized"])("fails %s summaries once without retries or raw diagnostics", async (kind) => {
    const seen = [];
    const fn = pipeline(seen, { prose: "p".repeat(36000), onAnalyst: () => completion({ content: kind === "bad" ? "SECRET invalid JSON" : JSON.stringify({ ...analysis, panel_summaries: { response_1: "SECRET".repeat(10000) } }) }) });
    const result = await run(fn, { body: largeBody(), getModelLimits: shortLimits });
    const data = await result.json();
    expect(data.error).toMatchObject({ code: "fusion_context_budget", details: { stage: "analyst", retryable: false } });
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel", "analyst"]);
  });

  it("checks the analyst's own assembled request before dispatch", async () => {
    const seen = [];
    const result = await run(pipeline(seen, { prose: "p".repeat(100000) }), { body: largeBody(), getModelLimits: shortLimits });
    expect((await result.json()).error).toMatchObject({ code: "fusion_context_budget", details: { stage: "analyst" } });
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel"]);
  });

  it("rechecks synthesis with the actual analyst output", async () => {
    const seen = [];
    const fn = pipeline(seen, { prose: "p".repeat(36000), onAnalyst: () => completion({ content: JSON.stringify({ ...analysis, consensus: ["q".repeat(45000)], panel_summaries: { response_1: "Compact" } }) }) });
    const result = await run(fn, { body: largeBody(), getModelLimits: shortLimits });
    expect((await result.json()).error).toMatchObject({ code: "fusion_context_budget", details: { stage: "synthesis", retryable: false } });
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel", "analyst"]);
  });

  it("does not summarize structured JSON panel output", async () => {
    const seen = [];
    const original = { ...largeBody(), response_format: { type: "json_object" } };
    const result = await run(pipeline(seen, { prose: JSON.stringify({ evidence: "p".repeat(36000) }) }), { body: original, getModelLimits: shortLimits });
    expect((await result.json()).error.code).toBe("fusion_context_budget");
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel"]);
  });

  it("cancels combined analyst summarization without synthesis", async () => {
    const parent = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const seen = [];
    const pending = run(pipeline(seen, { prose: "p".repeat(36000), onAnalyst: () => { started(); return new Promise(() => {}); } }), { body: largeBody(), getModelLimits: shortLimits, signal: parent.signal });
    await ready;
    parent.abort();
    expect((await pending).status).toBe(499);
    expect(seen.map(({ stage }) => stage)).toEqual(["initial", "panel", "analyst"]);
    expect(seen[2].signal.aborted).toBe(true);
  });

  it("preserves excluded media for provider dispatch, where media costs can overflow upstream", async () => {
    const media = { type: "image_url", image_url: { url: `data:image/png;base64,${"a".repeat(50000)}` } };
    const original = { messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, media] }] };
    const fn = vi.fn(async (request) => {
      expect(request.messages.at(-1).content).toEqual(original.messages[0].content);
      return new Response(JSON.stringify({ error: { message: "Provider media context overflow" } }), { status: 400 });
    });
    const result = await run(fn, { body: original });
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await result.json()).error.code).toBe("fusion_upstream_error");
    expect(estimateFusionRequest(original).mediaEstimationUnsupported).toBe(true);
  });

  it("uses UTF-8 bytes and excludes media base64 while marking only media estimation unsupported", () => {
    expect(estimateFusionRequest({ messages: [{ content: "é".repeat(30) }] }).tokens).toBeGreaterThan(estimateFusionRequest({ messages: [{ content: "a".repeat(30) }] }).tokens);
    const media = (data) => ({ messages: [{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }] });
    expect(estimateFusionRequest(media("a".repeat(50000)))).toEqual(estimateFusionRequest(media("b")));
    expect(estimateFusionRequest(media("b")).mediaEstimationUnsupported).toBe(true);
    expect(estimateFusionRequest({ messages: [{ content: "plain" }] }).mediaEstimationUnsupported).toBe(false);
  });
});
