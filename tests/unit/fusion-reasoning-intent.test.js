import { expect, it } from "vitest";
import "../translator/registerAll.js";
import { handleFusionChat } from "../../open-sse/services/fusion.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { captureThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const analysis = { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], verification_needed: [], usable_response_ids: ["response_1"] };
const completion = (message) => new Response(JSON.stringify({ id: "test", model: "test", created: 1, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }] }));
const tool = { type: "function", function: { name: "read_file", parameters: { type: "object" } } };
const messages = [{ role: "user", content: "Question" }, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call_1", content: "Result" }];
const translate = (body, intent, model = "claude-sonnet-4(low)", target = "claude", provider = "anthropic") => translateRequest("openai", target, model, structuredClone(body), false, null, provider, null, [], null, null, { reasoningIntent: intent });

it.each([
  ["openai", { model: "Fusion", messages, tools: [tool], reasoning_effort: "high" }, { mode: "level", level: "high", display: "summarized" }],
  ["openai-responses", { model: "Fusion", input: "Question", reasoning: { effort: "none", summary: "none" } }, { mode: "none" }],
  ["openai-responses", { model: "Fusion", input: "Question", reasoning: { effort: "high", summary: "detailed" } }, { mode: "level", level: "high", summary: "detailed", display: "summarized" }],
  ["claude", { model: "Fusion", messages: [{ role: "user", content: "Question" }], max_tokens: 20000, thinking: { type: "adaptive", display: "summarized" } }, { mode: "auto", display: "summarized" }],
  ["claude", { model: "Fusion", messages: [{ role: "user", content: "Question" }], max_tokens: 20000, thinking: { type: "enabled", budget_tokens: 8192, display: "omitted" } }, { mode: "budget", budget: 8192, display: "omitted" }],
])("captures %s intent before logical canonicalization and forwards all four stages", async (sourceFormat, body, intent) => {
  const saved = structuredClone(body);
  const seen = [];
  const result = await handleFusionChat({ body, sourceFormat, models: ["openai/panel"], judgeModel: "openai/judge", handleSingleModel: async (request, _model, execution) => {
    seen.push({ request, execution, translated: translate(request, execution.reasoningIntent) });
    if (execution.stage === "initial") return completion({ tool_calls: [{ id: "consult", type: "function", function: { name: "consult_panel", arguments: JSON.stringify({ panel_ids: ["panel_1"], brief: "Question" }) } }] });
    if (execution.stage === "panel") return completion({ content: "Advice", reasoning_content: "PRIVATE_PANEL_REASONING" });
    if (execution.stage === "analyst") return completion({ content: JSON.stringify(analysis) });
    return completion({ content: "Answer" });
  } });
  expect(result.status, await result.text()).toBe(200);
  expect(body).toEqual(saved);
  expect(seen.map(({ execution }) => execution.stage)).toEqual(["initial", "panel", "analyst", "synthesis"]);
  for (const { request, execution, translated } of seen) {
    expect(execution.reasoningIntent).toEqual(intent);
    expect(request.reasoningIntent).toBeUndefined();
    expect(translated.thinking.type).toBe(intent.mode === "none" ? "disabled" : "enabled");
    if (intent.mode === "budget") expect(translated.thinking.budget_tokens).toBe(8192);
    if (intent.mode === "level") expect(translated.thinking.budget_tokens).toBeGreaterThan(1024);
    if (intent.display) expect(translated.thinking.display).toBe(intent.display);
    expect(JSON.stringify(request)).not.toContain("PRIVATE_PANEL_REASONING");
  }
  expect(seen[2].request.tools).toBeUndefined();
  expect(seen[2].request.response_format.json_schema.name).toBe("fusion_analysis");
});

it("preserves summary/display intent without changing generic suffix precedence or defaults", () => {
  const body = { messages: [{ role: "user", content: "Question" }], reasoning: { effort: "high", summary: "detailed" } };
  const intent = captureThinking(body, true);
  expect(translate(body, intent).thinking.display).toBe("summarized");
  expect(translate(body, captureThinking({ reasoning: { effort: "high", summary: "none" } }, true)).thinking.display).toBe("omitted");
  expect(translate(body, intent, "gpt-5.6-luna(low)", "openai-responses", "opencode-go").reasoning).toEqual({ effort: "high", summary: "detailed" });
  expect(translate(body, undefined).thinking.budget_tokens).toBe(1024);
  expect(translate({ messages: body.messages }, undefined, "claude-sonnet-4").thinking).toBeUndefined();
});

it("uses Kiro's existing translator for private intent rather than a stray thinking field", () => {
  const body = { messages: [{ role: "user", content: "Question" }] };
  const enabled = translate(body, { mode: "budget", budget: 8192 }, "claude-sonnet-4(none)", "kiro", "kiro");
  expect(JSON.stringify(enabled)).toContain("<max_thinking_length>8192</max_thinking_length>");
  expect(enabled.thinking).toBeUndefined();
  const disabled = translate(body, { mode: "none" }, "claude-sonnet-4(high)", "kiro", "kiro");
  expect(JSON.stringify(disabled)).not.toContain("<thinking_mode>");
});

it.each([
  [{ thinkingConfig: { thinkingBudget: 0 } }, "none"],
  [{ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, "auto"],
  [{ generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }, "budget"],
  [{ generationConfig: { thinkingConfig: { thinkingLevel: "high" } } }, "level"],
])("maps captured Gemini-native intent at the physical leaf", (body, mode) => {
  const intent = captureThinking(body, true);
  expect(intent.mode).toBe(mode);
  const translated = translate({ messages: [{ role: "user", content: "Question" }] }, intent, "gemini-2.5-flash(low)", "gemini", "gemini");
  const config = translated.generationConfig.thinkingConfig;
  expect(config.thinkingBudget).toBe(mode === "none" ? 0 : mode === "auto" ? -1 : mode === "budget" ? 8192 : 24576);
});
