import { describe, it, expect, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";
import { FUSION_TOOL_STATUS_INSTRUCTIONS } from "../../open-sse/config/fusion.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const log = { info() {}, warn() {} };
const analysis = {
  consensus: [], contradictions: [], partial_coverage: [], unique_insights: [],
  blind_spots: [], verification_needed: [], usable_response_ids: ["response_1"],
};
const response = (message, finish = "stop") => new Response(JSON.stringify({
  id: "chatcmpl-test", model: "test", object: "chat.completion", created: 1,
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
}));
const consult = (ids = ["panel_1", "panel_2"]) => response({ tool_calls: [{
  id: "internal", type: "function", function: { name: "consult_panel", arguments: JSON.stringify({ panel_ids: ids, brief: "Diagnose the observed failure before editing." }) },
}] }, "tool_calls");
const base = { messages: [{ role: "user", content: "Diagnose this" }], tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }] };
const run = (handleSingleModel, extra = {}) => handleFusionChat({ body: structuredClone(base), models: ["p/a", "p/b"], judgeModel: "p/judge", handleSingleModel, log, ...extra });

function successful(seen = []) {
  return vi.fn(async (body, model, execution) => {
    seen.push({ body, model, execution });
    if (execution.stage === "initial") return consult();
    if (execution.stage === "panel") return response({ content: `Advice ${model}` });
    if (execution.stage === "analyst") return response({ content: JSON.stringify(analysis) });
    return response({ content: "FINAL" });
  });
}

describe("Fusion controller", () => {
  it("runs initial, parallel panel, analyst and native synthesis with isolated stage constraints", async () => {
    const seen = [];
    const fn = successful(seen);
    const result = await run(fn, { body: { ...structuredClone(base), stream: true, stream_options: { include_usage: true }, tool_choice: "required" } });
    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(seen.map((x) => x.execution.stage)).toEqual(["initial", "panel", "panel", "analyst", "synthesis"]);
    expect(seen[0].body.tool_choice.function.name).toBe("consult_panel");
    expect(seen[0].body.stream).toBe(false);
    for (const entry of seen.slice(1, 3)) {
      expect(entry.body.tools).toEqual(base.tools);
      expect(entry.body.stream_options).toBeUndefined();
      expect(entry.body.tool_choice).toBe("required");
    }
    expect(seen[3].body.tools).toBeUndefined();
    expect(seen[3].body.messages).toHaveLength(2);
    expect(JSON.stringify(seen[3].body)).not.toContain('"model":"p/a"');
    expect(seen[4].body.stream).toBe(true);
    expect(seen[4].body.tool_choice).toBe("required");
    expect(seen[4].body.messages.some((m) => m.content === "Diagnose this")).toBe(true);
  });

  it("permits a completed direct answer only when minimum is zero", async () => {
    const fn = vi.fn(async () => response({ content: "Direct" }));
    expect((await run(fn)).status).toBe(502);
    fn.mockClear();
    const res = await run(fn, { tuning: { minPanels: 0, maxPanels: 2 } });
    expect((await res.json()).choices[0].message.content).toBe("Direct");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("dispatches a selected subset once and never starts a panel sequentially", async () => {
    let release;
    const barrier = new Promise((r) => { release = r; });
    let started = 0;
    const fn = successful();
    fn.mockImplementation(async (_body, _model, { stage }) => {
      if (stage === "initial") return consult();
      if (stage === "panel") { if (++started === 2) release(); await barrier; return response({ content: "ok" }); }
      if (stage === "analyst") return response({ content: JSON.stringify(analysis) });
      return response({ content: "done" });
    });
    expect((await run(fn)).ok).toBe(true);
    expect(started).toBe(2);
  });

  it("rejects invalid selections without calling any panel", async () => {
    for (const ids of [["panel_1"], ["panel_1", "panel_1"], ["panel_1", "unknown"]]) {
      const fn = vi.fn(async () => consult(ids));
      expect((await run(fn)).status).toBe(502);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("aborts siblings on the primary technical error without waiting for ignored cancellation", async () => {
    let siblingSignal;
    const fn = vi.fn(async (_b, model, { stage, signal }) => {
      if (stage === "initial") return consult();
      if (model === "p/a") return new Response(JSON.stringify({ error: { message: "provider exploded" } }), { status: 503 });
      siblingSignal = signal;
      return new Promise(() => {});
    });
    const result = await run(fn);
    expect(result.status).toBe(502);
    expect(siblingSignal.aborted).toBe(true);
    expect((await result.json()).error).toEqual({ message: "Fusion upstream model call failed", type: "fusion_error", code: "fusion_upstream_error", details: { stage: "panel", retryable: true, upstream_status: 503 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("client cancellation stops all work before analysis", async () => {
    const parent = new AbortController();
    let release;
    const started = new Promise((r) => { release = r; });
    const fn = vi.fn(async (_b, _m, { stage }) => {
      if (stage === "initial") return consult();
      release();
      return new Promise(() => {});
    });
    const pending = run(fn, { signal: parent.signal });
    await started;
    parent.abort();
    expect((await pending).status).toBe(499);
    expect(fn.mock.calls.every(([, , e]) => e.signal.aborted)).toBe(true);
  });

  it("passes tool-only, malformed candidate arguments and exposed reasoning to evaluation", async () => {
    let data;
    const fn = vi.fn(async (_b, _m, { stage }) => {
      if (stage === "initial") return consult();
      if (stage === "panel") return response({ reasoning_content: "Visible summary", tool_calls: [{ function: { name: "read_file", arguments: "{broken" } }] }, "tool_calls");
      if (stage === "analyst") { data = _b.messages[1].content; return response({ content: JSON.stringify(analysis) }); }
      return response({ content: "Cannot diagnose yet" });
    });
    expect((await run(fn)).ok).toBe(true);
    expect(data).toContain("Visible summary");
    expect(data).toContain("Invalid JSON arguments");
    expect(data).not.toContain("p/a");
  });

  it("invalid analysis stops synthesis rather than stripping fences or repairing JSON", async () => {
    const fn = successful();
    fn.mockImplementation(async (_b, _m, { stage }) => {
      if (stage === "initial") return consult();
      if (stage === "panel") return response({ content: "advice" });
      return response({ content: "```json\n{}\n```" });
    });
    const res = await run(fn);
    expect(res.status).toBe(502);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("supports explicit judges without panel slots and rejects missing judges before dispatch", async () => {
    const fn = vi.fn(async () => response({ content: "Direct" }));
    expect((await run(fn, { models: [], judgeModel: "p/judge" })).ok).toBe(true);
    fn.mockClear();
    expect((await run(fn, { models: [], judgeModel: undefined })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects Claude evidence and server tools that cannot survive canonicalization", async () => {
    for (const patch of [
      { tools: [{ type: "web_search_20250305", name: "web_search" }] },
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.test/image" } }] }] },
      { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", data: "data" } }] }] },
    ]) {
      const fn = successful();
      expect((await run(fn, { sourceFormat: "claude", body: { messages: [{ role: "user", content: "Question" }], ...patch } })).status).toBe(400);
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("preserves all instruction messages and shares anonymous ordering across judging", async () => {
    const seen = [];
    const result = await run(successful(seen), { body: { ...base, messages: [
      { role: "system", content: "First rule" }, { role: "developer", content: "Second rule" }, ...base.messages,
    ] } });
    expect(result.ok).toBe(true);
    for (const entry of seen.filter(({ execution }) => execution.stage !== "analyst")) {
      expect(JSON.stringify(entry.body.messages)).toContain("First rule");
      expect(JSON.stringify(entry.body.messages)).toContain("Second rule");
    }
    const advisory = (entry) => JSON.parse(entry.body.messages.at(-1).content.split("\n").slice(1).join("\n"));
    expect(advisory(seen[3]).responses).toEqual(advisory(seen[4]).responses);
  });

  it("returns a stable no-action error for impossible streamed JSON constraints without retry", async () => {
    const fn = vi.fn(async (_body, _model, { stage }) => {
      if (stage === "initial") return consult();
      if (stage === "panel") return response({ content: "Unusable" });
      if (stage === "analyst") return response({ content: JSON.stringify({ ...analysis, usable_response_ids: [] }) });
      return response({ content: "Cannot answer" });
    });
    const result = await run(fn, { body: { ...base, stream: true, response_format: { type: "json_object" } } });
    expect(result.status).toBe(502);
    expect((await result.json()).error).toMatchObject({ code: "fusion_no_usable_action", details: { retryable: false } });
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("preserves Claude tool failure status, IDs and content through every history-bearing stage", async () => {
    const seen = [];
    const body = { messages: [
      { role: "user", content: "Inspect the tool results" },
      { role: "assistant", content: [
        { type: "tool_use", id: "ok_call", name: "read_file", input: {} },
        { type: "tool_use", id: "failed_call", name: "read_file", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "ok_call", content: "Successful read", is_error: false },
        { type: "tool_result", tool_use_id: "failed_call", content: "Permission denied", is_error: true },
      ] },
    ] };
    const result = await run(successful(seen), { sourceFormat: "claude", body });
    expect(result.ok).toBe(true);
    for (const { body: request, execution } of seen) {
      if (execution.stage === "analyst") continue;
      const results = request.messages.filter((message) => message.role === "tool");
      expect(results).toEqual([
        { role: "tool", tool_call_id: "ok_call", content: "Successful read" },
        { role: "tool", tool_call_id: "failed_call", content: "Permission denied" },
      ]);
      expect(request.messages[0].role).toBe("system");
      expect(request.messages[0].content).toContain(FUSION_TOOL_STATUS_INSTRUCTIONS);
      expect(request.messages[0].content).toContain(JSON.stringify([
        { message_index: 2, block_index: 0, tool_call_id: "ok_call", is_error: false },
        { message_index: 2, block_index: 1, tool_call_id: "failed_call", is_error: true },
      ]));
    }
    expect(body.messages[2].content[1].content).toBe("Permission denied");
  });

  it("distinguishes failed metadata from successful tool text imitating the old failure marker", async () => {
    const captured = [];
    for (const isError of [true, false]) {
      const seen = [];
      const body = { messages: [
        { role: "user", content: "Inspect" },
        { role: "assistant", content: [{ type: "tool_use", id: "same_call", name: "read_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "same_call", is_error: isError,
          content: isError ? "Permission denied" : "[Tool execution failed (is_error=true)]\nPermission denied" }] },
      ] };
      expect((await run(successful(seen), { sourceFormat: "claude", body })).ok).toBe(true);
      captured.push(seen);
      for (const { body: request, execution } of seen) {
        if (execution.stage === "analyst") {
          expect(request.messages[0].content).not.toContain(FUSION_TOOL_STATUS_INSTRUCTIONS);
          continue;
        }
        const metadata = JSON.stringify([{ message_index: 2, block_index: 0, tool_call_id: "same_call", is_error: isError }]);
        expect(request.messages[0].content).toContain(metadata);
        expect(request.messages.find((message) => message.role === "tool").content).toBe(body.messages[2].content[0].content);
        for (const target of ["openai", "claude", "openai-responses"]) {
          const translated = translateRequest("openai", target, "model", structuredClone(request), false);
          const trusted = target === "openai" ? translated.messages[0].content
            : target === "claude" ? translated.system.map((part) => part.text).join("\n") : translated.instructions;
          expect(trusted).toContain(FUSION_TOOL_STATUS_INSTRUCTIONS);
          expect(trusted).toContain(metadata);
        }
      }
    }
    expect(captured[0][0].body.messages[0].content).not.toBe(captured[1][0].body.messages[0].content);
  });

  it("allocates bounded consultation names across deep inherited collisions", async () => {
    const tools = Array.from({ length: 100 }, (_, i) => ({ type: "function", function: {
      name: i === 0 ? "consult_panel" : `consult_panel_${i}`, parameters: { type: "object" },
    } }));
    tools.push({ type: "function", function: { name: "consult_panel" + "_internal".repeat(6), parameters: { type: "object" } } });
    const fn = vi.fn(async (body) => {
      const name = body.tools.at(-1).function.name;
      expect(name).toBe("consult_panel_100");
      expect(name.length).toBeLessThanOrEqual(64);
      expect(new Set(body.tools.map((t) => t.function.name)).size).toBe(body.tools.length);
      return response({ content: "Direct" });
    });
    expect((await run(fn, { internal: true, body: { ...base, tools }, tuning: { minPanels: 0, maxPanels: 2 } })).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never mutates the original or shares panel request graphs", async () => {
    const original = structuredClone(base);
    const bodies = [];
    const fn = successful();
    fn.mockImplementation(async (b, _m, { stage }) => {
      if (stage === "initial") return consult();
      if (stage === "panel") { bodies.push(b); b.messages[0].content = "changed"; return response({ content: "advice" }); }
      if (stage === "analyst") return response({ content: JSON.stringify(analysis) });
      expect(b.messages.find((m) => m.role === "user").content).toBe("Diagnose this");
      return response({ content: "done" });
    });
    await run(fn, { body: original });
    expect(original).toEqual(base);
    expect(bodies[0].messages).not.toBe(bodies[1].messages);
  });
});
