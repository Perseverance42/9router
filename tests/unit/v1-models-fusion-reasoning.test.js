import { beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateComboCapabilities, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getComboByName: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const panel = "openai/gpt-4o";
const judge = "zai/glm-5.2";
const reasoningFields = ["reasoning", "thinkingFormat", "thinkingCanDisable", "thinkingRange", "thinkingEffortSupported"];
function expected(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  return {
    ...Object.fromEntries(reasoningFields.map((key) => [key, caps[key]])),
    thinkingLevels: getThinkingLevels(provider, model),
  };
}
async function advertise(combos, comboStrategies = {}, extra = {}) {
  db.getCombos.mockResolvedValue(combos);
  db.getComboByName.mockImplementation(async (name) => combos.find((combo) => combo.name === name) || null);
  db.getSettings.mockResolvedValue({ comboStrategies, ...extra });
  return (await buildModelsList(["llm"])).filter((model) => model.owned_by === "combo");
}
const fusion = (judgeModel) => ({ fallbackStrategy: "fusion", judgeModel });

beforeEach(() => {
  db.getModelAliases.mockResolvedValue({});
  db.getProviderNodes.mockClear();
});

describe("/v1/models Fusion judge reasoning", () => {
  it("inherits every judge reasoning field and explicit levels, not panel capabilities or limits", async () => {
    const [model] = await advertise([{ name: "Fusion", models: [panel] }], { Fusion: fusion(judge) });
    expect(model.capabilities).toMatchObject(expected("zai", "glm-5.2"));
    const original = aggregateComboCapabilities([panel]);
    for (const key of Object.keys(original).filter((key) => !reasoningFields.includes(key))) {
      expect(model.capabilities[key]).toEqual(original[key]);
    }
    expect(model.context_length).toBe(getCapabilitiesForModel("openai", "gpt-4o").contextWindow);
    expect(model.max_completion_tokens).toBe(getCapabilitiesForModel("openai", "gpt-4o").maxOutput);
  });

  it.each([
    ["anthropic", "claude-sonnet-4"],
    ["gemini", "gemini-3-pro-preview"],
  ])("preserves the %s judge's budget range and disable contract", async (provider, modelId) => {
    const [model] = await advertise([{ name: "Fusion", models: [judge] }], { Fusion: fusion(`${provider}/${modelId}`) });
    expect(model.capabilities).toMatchObject(expected(provider, modelId));
  });

  it("clears stale panel reasoning when judge cannot reason", async () => {
    const [model] = await advertise([{ name: "Fusion", models: [judge] }], { Fusion: fusion(panel) });
    expect(model.capabilities).toMatchObject(expected("openai", "gpt-4o"));
    expect(model.capabilities.thinkingLevels).toBeNull();
  });

  it.each(["fallback", "round-robin"])("uses the %s judge adapter's first-member reasoning contract", async (strategy) => {
    const models = await advertise([
      { name: "Fusion", models: [panel] },
      { name: "Judge", models: [judge, panel] },
    ], { Fusion: fusion("Judge"), Judge: { fallbackStrategy: strategy } });
    expect(models[0].capabilities).toMatchObject(expected("zai", "glm-5.2"));
    // Generic adapters retain their existing advertisement, including absent effort metadata.
    expect(models[1].capabilities).toEqual(aggregateComboCapabilities([judge, panel]));
  });

  it("resolves nested Fusion through an ordinary judge adapter", async () => {
    const models = await advertise([
      { name: "Fusion", models: [panel] },
      { name: "Adapter", models: ["Nested", panel] },
      { name: "Nested", models: [panel] },
    ], { Fusion: fusion("Adapter"), Nested: fusion("cx/gpt-5.6") });
    expect(models[0].capabilities).toMatchObject(expected("codex", "gpt-5.6"));
    expect(models[2].capabilities).toMatchObject(expected("codex", "gpt-5.6"));
  });

  it("uses global Fusion strategy and blank judge defaults, respecting per-combo overrides", async () => {
    const models = await advertise([
      { name: "Fusion", models: [judge, panel] },
      { name: "Fallback", models: [panel, judge] },
    ], { Fusion: { judgeModel: "   " }, Fallback: { fallbackStrategy: "fallback" } }, { comboStrategy: "fusion" });
    expect(models[0].capabilities).toMatchObject(expected("zai", "glm-5.2"));
    expect(models[1].capabilities).toEqual(aggregateComboCapabilities([panel, judge]));
  });

  it("supports a trimmed judge with zero panels without inventing context limits", async () => {
    const [model] = await advertise([{ name: "Fusion", models: [] }], { Fusion: fusion(`  ${judge}  `) });
    expect(model.capabilities).toMatchObject(expected("zai", "glm-5.2"));
    expect(model.context_length).toBeUndefined();
    expect(model.max_completion_tokens).toBeUndefined();
    expect(model.capabilities.contextWindow).toBeUndefined();
  });

  it.each([
    ["NamedJudge", { NamedJudge: "cx/gpt-5.6(high)" }],
    ["cx/gpt-5.6(high)", {}],
    ["NamedJudge(high)", { "NamedJudge(high)": { provider: "codex", model: "gpt-5.6" } }],
  ])("resolves runtime aliases and strips leaf thinking suffixes: %s", async (target, aliases) => {
    db.getModelAliases.mockResolvedValue(aliases);
    const [model] = await advertise([{ name: "Fusion", models: [panel] }], { Fusion: fusion(target) });
    expect(model.capabilities).toMatchObject(expected("codex", "gpt-5.6"));
  });

  it("uses the exact suffixed alias rather than its unsuffixed collision", async () => {
    db.getModelAliases.mockResolvedValue({
      Review: "openai/gpt-4o",
      "Review(high)": "zai/glm-5.2",
    });
    const [model] = await advertise([{ name: "Fusion", models: [panel] }], { Fusion: fusion("Review(high)") });
    expect(model.capabilities).toMatchObject(expected("zai", "glm-5.2"));
    expect(model.capabilities.reasoning).not.toBe(getCapabilitiesForModel("openai", "gpt-4o").reasoning);
  });

  it("does not reinterpret a suffixed alias as its unsuffixed alias", async () => {
    db.getModelAliases.mockResolvedValue({ NamedJudge: { provider: "codex", model: "gpt-5.6" } });
    const [model] = await advertise([{ name: "Fusion", models: [judge] }], { Fusion: fusion("NamedJudge(high)") });
    expect(model.capabilities).toMatchObject(expected("openai", "NamedJudge"));
    expect(model.capabilities.thinkingLevels).toBeNull();
  });

  it("does not reinterpret a suffixed generic fallback combo as a judge combo", async () => {
    const models = await advertise([
      { name: "Fusion", models: [panel] },
      { name: "Nested", models: [judge] },
    ], { Fusion: fusion("Nested(high)") });
    expect(models[0].capabilities.reasoning).toBe(false);
    expect(models[0].capabilities.thinkingLevels).toBeNull();
  });

  it.each([false, true])("normalizes nested Fusion judge suffixes before inference (global: %s)", async (global) => {
    const models = await advertise([
      { name: "Outer", models: [panel] },
      { name: "Inner", models: [panel] },
    ], global ? { Outer: { judgeModel: "Inner(high)" }, Inner: { judgeModel: judge } }
      : { Outer: fusion("Inner(high)"), Inner: fusion(judge) }, global ? { comboStrategy: "fusion" } : {});
    expect(models[0].capabilities).toMatchObject(expected("zai", "glm-5.2"));
    expect(models[1].capabilities).toMatchObject(expected("zai", "glm-5.2"));
  });

  it("keeps an exact suffixed alias ahead of an existing bare Fusion combo", async () => {
    db.getModelAliases.mockResolvedValue({ "Review(high)": { provider: "anthropic", model: "claude-sonnet-4" } });
    const models = await advertise([
      { name: "Outer", models: [panel] },
      { name: "Review", models: [panel] },
    ], { Outer: fusion("Review(high)"), Review: fusion(judge) });
    expect(models[0].capabilities).toMatchObject(expected("anthropic", "claude-sonnet-4"));
    expect(models[1].capabilities).toMatchObject(expected("zai", "glm-5.2"));
  });

  it("keeps a literal suffixed combo ahead of an exact alias", async () => {
    db.getModelAliases.mockResolvedValue({ "Review(high)": { provider: "anthropic", model: "claude-sonnet-4" } });
    const models = await advertise([
      { name: "Outer", models: [panel] },
      { name: "Review(high)", models: [judge] },
      { name: "Review", models: [panel] },
    ], { Outer: fusion("Review(high)"), Review: fusion(panel) });
    expect(models[0].capabilities).toMatchObject(expected("zai", "glm-5.2"));
  });

  it("bounds normalized suffix cycles without leaking inferred leaf capabilities", async () => {
    const models = await advertise([
      { name: "A", models: [judge] }, { name: "B", models: [judge] },
    ], { A: fusion("B(high)"), B: fusion("A(8192)") });
    for (const model of models) {
      expect(model.capabilities.reasoning).toBe(false);
      expect(model.capabilities.thinkingLevels).toBeNull();
    }
  });

  it("bounds judge cycles without leaking panel defaults", async () => {
    const models = await advertise([
      { name: "A", models: [judge] },
      { name: "B", models: [judge] },
    ], { A: fusion("B"), B: fusion("A") });
    for (const model of models) {
      expect(model.capabilities.reasoning).toBe(false);
      expect(model.capabilities.thinkingFormat).toBeNull();
      expect(model.capabilities.thinkingLevels).toBeNull();
    }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("bounds depth with cached subtrees: %s, suffixes: %s", async (cached, suffixed) => {
    const chain = Array.from({ length: 33 }, (_, i) => ({ name: `C${i}`, models: [panel] }));
    const strategies = Object.fromEntries(chain.map((combo, i) => [combo.name, fusion(i === 32 ? judge : `C${i + 1}${suffixed ? "(high)" : ""}`)]));
    // Deepest-first populates the cache before the over-depth root.
    const models = await advertise(cached ? chain.toReversed() : chain, strategies);
    expect(models.find((model) => model.id === "C1").capabilities).toMatchObject(expected("zai", "glm-5.2"));
    expect(models.find((model) => model.id === "C0").capabilities.reasoning).toBe(false);
  });
});
