import { beforeEach, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ combos: [], settings: {}, keys: {}, aliases: {} }));
const mocks = vi.hoisted(() => ({ core: vi.fn(), credentials: vi.fn(), refresh: vi.fn(), lookup: vi.fn(), systemone: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getModelAliases: async () => fx.aliases,
  getComboByName: mocks.lookup,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError() {}, extractApiKey: () => "key", isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.refresh, updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.systemone }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const comboService = await import("../../open-sse/services/combo.js");
const { resetComboRotation } = comboService;
const { deliverFusionCompletion } = await import("../../open-sse/services/fusionOutput.js");
const { resolveSmartChoice } = await import("../../src/sse/services/systemoneRouter.js");
const completion = (message) => Response.json({
  id: "chatcmpl-test", model: "test", object: "chat.completion", created: 1,
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
});
const consult = (name = "consult_panel") => completion({ tool_calls: [{
  id: "consult", type: "function", function: { name, arguments: JSON.stringify({ panel_ids: ["panel_1"], brief: "Inspect the task" }) },
}] });
const analysis = { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], verification_needed: [], usable_response_ids: ["response_1"] };
const add = (name, models, cfg = {}) => {
  fx.combos.push({ name, models });
  fx.settings.comboStrategies[name] = cfg;
};
const chat = (patch = {}, signal, endpoint = "/v1/chat/completions") => handleChat(new Request(`http://localhost${endpoint}`, {
  method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: "Bearer key" },
  body: JSON.stringify({ model: "Main", messages: [{ role: "user", content: "Question" }], ...patch }),
}));
const modelsCalled = () => mocks.core.mock.calls.map(([x]) => x.modelInfo.model);

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  fx.combos = [];
  fx.aliases = {};
  mocks.lookup.mockImplementation(async (name) => fx.combos.find((c) => c.name === name) || null);
  mocks.systemone.mockResolvedValue({ success: false });
  fx.keys = { key: { isActive: true, access: { restricted: false, allow: [] } } };
  fx.settings = { comboStrategy: "fallback", comboStrategies: {},
    cavemanEnabled: true, headroomEnabled: true, rtkEnabled: true, customPromptEnabled: true };
  mocks.credentials.mockResolvedValue({ connectionId: "connection" });
  mocks.refresh.mockImplementation(async (_p, c) => c);
  mocks.core.mockImplementation(async ({ body, modelInfo }) => {
    if (modelInfo.model.endsWith("bad")) return { success: false, response: new Response("failed", { status: 500 }) };
    let response;
    if (body.response_format?.json_schema?.name === "fusion_analysis") response = completion({ content: JSON.stringify(analysis) });
    else if (body.tool_choice?.function?.name) response = consult(body.tool_choice.function.name);
    else response = completion({ content: `Answer ${modelInfo.model}` });
    if (body.stream) response = deliverFusionCompletion(await response.json(), { sourceFormat: "claude", stream: true });
    return { success: true, response };
  });
});

it("does not log stored provider failures for internal Fusion credential exhaustion", async () => {
  const secret = "SECRET_STORED_PROVIDER_FAILURE";
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
    mocks.credentials.mockResolvedValue({ allRateLimited: true, lastError: secret, retryAfterHuman: "soon", retryAfter: new Date(Date.now() + 1000).toISOString() });
    expect((await chat()).status).toBe(502);
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  } finally { output.mockRestore(); }
});

it("propagates internal logging context into a nested fallback combo", async () => {
  const secret = "SECRET_NESTED_COMBO_EXCEPTION";
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    add("Main", ["Panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
    add("Panel", ["openai/panel"]);
    const normal = mocks.core.getMockImplementation();
    mocks.core.mockImplementation(async (options) => {
      if (options.modelInfo.model === "panel") throw new Error(secret);
      return normal(options);
    });
    expect((await chat()).status).toBe(502);
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  } finally { output.mockRestore(); }
});

it.each(["fallback", "round-robin"])("keeps a combo panel as one slot with its %s strategy", async (strategy) => {
  add("Main", ["Panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  add("Panel", ["openai/panel-bad", "openai/panel-good"], { fallbackStrategy: strategy });
  expect((await chat()).status).toBe(200);
  expect(modelsCalled()).toEqual(["judge", "panel-bad", "panel-good", "judge", "judge"]);
  mocks.core.mockClear();
  expect((await chat()).status).toBe(200);
  expect(modelsCalled()).toEqual(strategy === "round-robin"
    ? ["judge", "panel-good", "judge", "judge"]
    : ["judge", "panel-bad", "panel-good", "judge", "judge"]);
  const initial = mocks.core.mock.calls[0][0].body.messages[0].content;
  expect(initial).toContain("panel_1: Panel");
  expect(initial).not.toContain("panel_2:");
});

it.each(["fallback", "round-robin"])("forwards explicit intent through nested %s leaves without flattening", async (strategy) => {
  add("Main", ["Panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Panel", ["openai/panel-bad(low)", "openai/panel-good(low)"], { fallbackStrategy: strategy });
  add("Judge", ["openai/judge(low)"], { fallbackStrategy: strategy });
  const previous = mocks.core.getMockImplementation();
  mocks.core.mockImplementation(async (options) => options.modelInfo.model.includes("panel-bad")
    ? { success: false, response: new Response("failed", { status: 500 }) } : previous(options));
  expect((await chat({ reasoning_effort: "high" })).status).toBe(200);
  for (const [options] of mocks.core.mock.calls) expect(options.reasoningIntent).toEqual({ mode: "level", level: "high", display: "summarized" });
  expect(modelsCalled()).toContain("panel-bad(low)");
  expect(modelsCalled()).toContain("panel-good(low)");
});

it.each([["high", { mode: "level", level: "high" }], ["8192", { mode: "budget", budget: 8192 }]])("routes a Fusion logical suffix %s as explicit caller intent", async (suffix, intent) => {
  add("Main", ["openai/panel(low)"], { fallbackStrategy: "fusion", judgeModel: "openai/judge(low)" });
  expect((await chat({ model: `Main(${suffix})`, reasoning_effort: "none" })).status).toBe(200);
  expect(mocks.core).toHaveBeenCalledTimes(4);
  for (const [options] of mocks.core.mock.calls) expect(options.reasoningIntent).toMatchObject(intent);
});

it("keeps configured concrete judge and panel modes when the caller has no intent", async () => {
  add("Main", ["openai/panel(high)"], { fallbackStrategy: "fusion", judgeModel: "openai/judge(low)" });
  expect((await chat()).status).toBe(200);
  expect(modelsCalled()).toEqual(["judge(low)", "panel(high)", "judge(low)", "judge(low)"]);
  for (const [options] of mocks.core.mock.calls) expect(options.reasoningIntent).toBeNull();
});

it.each(["top", "panel", "judge"])("keeps exact suffixed aliases ahead of Fusion suffix interpretation (%s)", async (kind) => {
  fx.aliases["Review(high)"] = { provider: "anthropic", model: "claude-sonnet-4" };
  add("Review", ["openai/wrong-panel"], { fallbackStrategy: "fusion", judgeModel: "openai/wrong-judge" });
  if (kind !== "top") add("Main", [kind === "panel" ? "Review(high)" : "openai/panel"], { fallbackStrategy: "fusion", judgeModel: kind === "judge" ? "Review(high)" : "openai/judge" });
  expect((await chat({ model: kind === "top" ? "Review(high)" : "Main" })).status).toBe(200);
  expect(modelsCalled()).toEqual(kind === "top" ? ["claude-sonnet-4"] : kind === "panel"
    ? ["judge", "claude-sonnet-4", "judge", "judge"] : ["claude-sonnet-4", "panel", "claude-sonnet-4", "claude-sonnet-4"]);
  const options = mocks.core.mock.calls.map(([options]) => options).find((options) => options.modelInfo.model === "claude-sonnet-4");
  expect(options.modelInfo.provider).toBe("anthropic");
  expect(options.reasoningIntent).toBe(kind === "top" ? undefined : null);
});

it("resolves literal parenthesized names before both aliases and Fusion suffix aliases", async () => {
  fx.aliases["Main(high)"] = { provider: "anthropic", model: "claude-sonnet-4" };
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  add("Main(high)", ["openai/literal"]);
  expect((await chat({ model: "Main(high)" })).status).toBe(200);
  expect(modelsCalled()).toEqual(["literal"]);
  expect(mocks.core.mock.calls[0][0].reasoningIntent).toBeUndefined();
});

it.each([["fusion", "unknown"], ["fallback", "high"]])("does not reinterpret unsupported suffixes or generic combos (%s/%s)", async (fallbackStrategy, suffix) => {
  add("Main", ["openai/panel"], { fallbackStrategy, judgeModel: "openai/judge" });
  mocks.core.mockResolvedValue({ success: false, response: Response.json({ error: { message: "Unknown model" } }, { status: 400 }) });
  expect((await chat({ model: `Main(${suffix})` })).status).toBe(400);
  expect(modelsCalled()).toEqual([`Main(${suffix})`]);
  expect(mocks.core.mock.calls[0][0].reasoningIntent).toBeUndefined();
});

it("routes a suffixed nested Fusion judge to its actual provider", async () => {
  add("Outer", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Inner(high)" });
  add("Inner", ["openai/inner-panel"], { fallbackStrategy: "fusion", judgeModel: "zai/glm-5.2" });
  expect((await chat({ model: "Outer" })).status).toBe(200);
  expect(mocks.core.mock.calls.some(([options]) => options.modelInfo.provider === "zai" && options.modelInfo.model === "glm-5.2")).toBe(true);
  expect(modelsCalled()).not.toContain("Inner(high)");
});

it("routes nested Fusion suffix aliases without flattening their panels", async () => {
  add("Main", ["Nested(8192)"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  add("Nested", ["openai/inner-panel"], { fallbackStrategy: "fusion", judgeModel: "openai/inner-judge" });
  expect((await chat()).status).toBe(200);
  const inner = mocks.core.mock.calls.map(([options]) => options).filter((options) => options.modelInfo.model.startsWith("inner-"));
  expect(inner).toHaveLength(4);
  for (const options of inner) expect(options.reasoningIntent).toMatchObject({ mode: "budget", budget: 8192 });
});

it("propagates only private generation ceilings into ChatCore", async () => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  expect((await chat()).status).toBe(200);
  expect(mocks.core.mock.calls.map(([options]) => options.maxOutputTokens)).toEqual([4096, 8192, 8192, undefined]);
});

it("resolves short model limits within a logical combo seat before panel dispatch", async () => {
  add("Main", ["Panel"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  add("Panel", ["openai/gpt-3.5-turbo"]);
  const response = await chat({ messages: [{ role: "user", content: "h".repeat(40000) }] });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatchObject({ code: "fusion_context_budget", details: { stage: "panel", retryable: false } });
  expect(modelsCalled()).toEqual(["judge"]);
});

it.each(["fallback", "round-robin"])("routes all judge stages through its combo's %s strategy", async (strategy) => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Judge", ["openai/judge-bad", "openai/judge-good"], { fallbackStrategy: strategy });
  expect((await chat()).status).toBe(200);
  expect(modelsCalled()).toEqual(strategy === "round-robin"
    ? ["judge-bad", "judge-good", "panel", "judge-good", "judge-bad", "judge-good"]
    : ["judge-bad", "judge-good", "panel", "judge-bad", "judge-good", "judge-bad", "judge-good"]);
});

it.each(["Panel", "Judge", "NestedJudge"])("checks the weakest reachable capability in %s before any dispatch", async (weak) => {
  add("Main", ["Panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Panel", ["openai/gpt-4o", ...(weak === "Panel" ? ["openai/text-only"] : [])]);
  add("Judge", [weak === "Judge" ? "openai/text-only" : "openai/gpt-4o"], {
    fallbackStrategy: "fusion", judgeModel: "NestedJudge",
  });
  add("NestedJudge", [weak === "NestedJudge" ? "openai/text-only" : "openai/gpt-4o"]);
  // An adapter must not hide a weak included member or expand internal calls.
  fx.settings.capacityAdapter = { vision: { enabled: true, models: ["openai/gpt-4o"] } };
  const result = await chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] });
  expect(result.status).toBe(400);
  expect((await result.json()).error).toMatchObject({ code: "fusion_preflight_error", details: { stage: "preflight", retryable: false } });
  expect(mocks.credentials).not.toHaveBeenCalled();
});

it("preserves internal formats, cancellation and disabled transforms through combo fallback", async () => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Judge", ["openai/judge-bad", "openai/judge-good"]);
  const parent = new AbortController();
  let release;
  const started = new Promise((r) => { release = r; });
  const previous = mocks.core.getMockImplementation();
  mocks.core.mockImplementation(async (options) => {
    if (options.modelInfo.model === "judge-good") { release(); return new Promise(() => {}); }
    return previous(options);
  });
  const pending = chat({}, parent.signal, "/v1/messages");
  await started;
  parent.abort();
  expect((await pending).status).toBe(499);
  expect(modelsCalled()).toEqual(["judge-bad", "judge-good"]);
  for (const [options] of mocks.core.mock.calls) {
    expect(options).toMatchObject({ internal: true, sourceFormatOverride: "openai", responseFormatOverride: "openai", cavemanEnabled: false, headroomEnabled: false, rtkEnabled: false, customPromptEnabled: false });
    expect(options.externalSignal.aborted).toBe(true);
  }
});

it.each(["panel", "judge"])("executes nested Fusion as a %s without consuming its caller's consultation tool", async (kind) => {
  add("Main", [kind === "panel" ? "Nested" : "openai/panel"], { fallbackStrategy: "fusion", judgeModel: kind === "judge" ? "Nested" : "openai/judge" });
  add("Nested", ["openai/inner-panel"], { fallbackStrategy: "fusion", judgeModel: "openai/inner-judge" });
  const result = await chat();
  expect(result.status).toBe(200);
  expect((await result.json()).choices[0].message.content).toContain("Answer");
  const inner = mocks.core.mock.calls.map(([x]) => x).filter((x) => x.modelInfo.model === "inner-judge");
  if (kind === "judge") {
    expect(inner[0].body.tools.map((t) => t.function.name)).toEqual(["consult_panel", "consult_panel_1"]);
    expect(inner[0].body.messages[0].content).toContain("invoke consult_panel_1 exactly once");
    expect(inner[0].body.tool_choice.function.name).toBe("consult_panel_1");
    expect(inner[2].body.tool_choice.function.name).toBe("consult_panel");
  }
});

it("preserves Claude streaming output through a nested Fusion judge", async () => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Nested" });
  add("Nested", ["openai/inner-panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Judge", ["openai/inner-judge"]);
  const result = await chat({ stream: true }, undefined, "/v1/messages");
  expect(result.status).toBe(200);
  const events = await result.text();
  expect(events).toContain("event: message_start");
  expect(events).toContain("Answer inner-judge");
  expect(events).toContain("event: message_stop");
  const final = mocks.core.mock.calls.at(-1)[0];
  expect(final).toMatchObject({ sourceFormatOverride: "openai", responseFormatOverride: "claude", internal: true });
});

it.each(["member", "judge"])("rejects a recursive %s edge in preflight", async (edge) => {
  add("Main", ["Nested"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  add("Nested", edge === "member" ? ["Main"] : ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: edge === "judge" ? "Main" : "openai/judge" });
  const result = await chat();
  expect(result.status).toBe(400);
  expect((await result.json()).error).toMatchObject({ code: "fusion_preflight_error", details: { stage: "preflight", retryable: false } });
  expect(mocks.credentials).not.toHaveBeenCalled();
});

it("bounds acyclic combo nesting before credential lookup", async () => {
  add("Main", ["Level0"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  for (let i = 0; i < 32; i++) add(`Level${i}`, [i === 31 ? "openai/panel" : `Level${i + 1}`]);
  const result = await chat();
  expect(result.status).toBe(400);
  expect((await result.json()).error).toMatchObject({ code: "fusion_preflight_error", details: { stage: "preflight", retryable: false } });
  expect(mocks.credentials).not.toHaveBeenCalled();
});

it.each(["openai/router", "", 123])("checks external Smart router access (%s) before credentials", async (routerModel) => {
  add("Main", ["Smart"], { fallbackStrategy: "fusion", judgeModel: "Smart" });
  add("Smart", ["openai/panel-a", "openai/panel-b"], { fallbackStrategy: "smart", routerModel });
  fx.keys.key.access = { restricted: true, allow: ["Main"] };
  expect((await chat()).status).toBe(403);
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.systemone).not.toHaveBeenCalled();
});

it("does not require separate access to an included Smart router", async () => {
  add("Main", ["Smart"], { fallbackStrategy: "fusion", judgeModel: "Smart" });
  add("Smart", ["openai/panel-a", "openai/panel-b"], { fallbackStrategy: "smart", routerModel: "openai/panel-a" });
  fx.keys.key.access = { restricted: true, allow: ["Main"] };
  expect((await chat()).status).toBe(200);
  expect(mocks.systemone).toHaveBeenCalled();
});

it.each(["lookup", "refresh", "core"])("cancels Smart router work during %s", async (step) => {
  add("Main", ["Smart"], { fallbackStrategy: "fusion", judgeModel: "Smart" });
  add("Smart", ["openai/panel-a", "openai/panel-b"], { fallbackStrategy: "smart", routerModel: "openai/router" });
  const parent = new AbortController();
  if (step === "lookup") mocks.credentials.mockImplementationOnce(async (_p, _e, _m, { signal }) => {
    expect(signal.aborted).toBe(false);
    parent.abort();
    return { connectionId: "connection" };
  });
  if (step === "refresh") mocks.refresh.mockImplementationOnce(async (_p, c, { signal }) => {
    expect(signal.aborted).toBe(false);
    parent.abort();
    return c;
  });
  if (step === "core") mocks.systemone.mockImplementationOnce(async ({ signal }) => {
    expect(signal.aborted).toBe(false);
    parent.abort();
    return { success: false };
  });
  expect((await chat({}, parent.signal)).status).toBe(499);
  expect(mocks.credentials).toHaveBeenCalledTimes(1);
  expect(mocks.credentials.mock.calls[0][3].signal.aborted).toBe(true);
  expect(mocks.refresh).toHaveBeenCalledTimes(step === "lookup" ? 0 : 1);
  expect(mocks.systemone).toHaveBeenCalledTimes(step === "core" ? 1 : 0);
  expect(mocks.core).not.toHaveBeenCalled();
});

it.each(["credentials", "upstream"])("retains Smart fail-open behavior on %s failure without cancellation", async (step) => {
  if (step === "credentials") mocks.credentials.mockResolvedValueOnce(null);
  else mocks.systemone.mockRejectedValueOnce(new Error("unavailable"));
  expect(await resolveSmartChoice({ body: { messages: [{ role: "user", content: "Question" }] }, models: ["openai/a", "openai/b"], routerModel: "openai/router" })).toBeNull();
  expect(mocks.systemone).toHaveBeenCalledTimes(step === "credentials" ? 0 : 1);
});

it("checks shared DAG subtrees once per request", async () => {
  add("Main", ["Level0a", "Level0b"], { fallbackStrategy: "fusion", judgeModel: "openai/judge" });
  for (let i = 0; i < 12; i++) {
    const children = i === 11 ? ["openai/panel"] : [`Level${i + 1}a`, `Level${i + 1}b`];
    add(`Level${i}a`, children);
    add(`Level${i}b`, children);
  }
  fx.settings.comboStrategies.Main.fusionTuning = { minPanels: 0, maxPanels: 0 };
  expect((await chat()).status).toBe(200);
  expect(mocks.lookup.mock.calls.length).toBeLessThan(110);
  mocks.lookup.mockClear();
  expect((await chat()).status).toBe(200);
  expect(mocks.lookup.mock.calls.length).toBeGreaterThan(24);
  expect(mocks.lookup.mock.calls.length).toBeLessThan(110);
});

it("bounds descendant lookups for a reconvergent logical judge combo on each request", async () => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Judge", fusionTuning: { minPanels: 0, maxPanels: 0 } });
  add("Judge", ["Level0a", "Level0b"]);
  for (let i = 0; i < 24; i++) {
    const children = i === 23 ? ["openai/judge"] : [`Level${i + 1}a`, `Level${i + 1}b`];
    add(`Level${i}a`, children);
    add(`Level${i}b`, children);
  }
  for (let request = 0; request < 2; request++) {
    mocks.lookup.mockClear();
    expect((await chat()).status).toBe(200);
    expect(mocks.lookup.mock.calls.length).toBeGreaterThan(49);
    expect(mocks.lookup.mock.calls.length).toBeLessThan(400);
  }
});

it.each([29, 30])("rechecks cached model-limit subtree depth on a deep incoming judge path (%i)", async (length) => {
  add("Main", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Judge", ["Shared", "Level0"]);
  add("Shared", ["Tail"]);
  add("Tail", ["openai/judge"]);
  for (let i = 0; i < length; i++) add(`Level${i}`, [i === length - 1 ? "Shared" : `Level${i + 1}`]);
  // Exercise limit resolution directly; public graph preflight independently rejects deep paths.
  const spy = vi.spyOn(comboService, "handleFusionChat").mockImplementationOnce(async ({ getModelLimits }) => {
    try {
      await getModelLimits("Judge");
      return new Response(null, { status: 200 });
    } catch {
      return new Response(null, { status: 400 });
    }
  });
  try {
    expect((await chat()).status).toBe(length === 29 ? 200 : 400);
    expect(mocks.lookup.mock.calls.length).toBeLessThan(150);
    expect(mocks.core).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each([29, 30])("checks cached subtree depth on a shallow-first DAG with %i intervening combos", async (length) => {
  add("Main", ["Shared", "Level0"], { fallbackStrategy: "fusion", judgeModel: "openai/judge", fusionTuning: { minPanels: 0, maxPanels: 0 } });
  add("Shared", ["Tail"]);
  add("Tail", ["openai/panel"]);
  for (let i = 0; i < length; i++) add(`Level${i}`, [i === length - 1 ? "Shared" : `Level${i + 1}`]);
  const result = await chat();
  expect(result.status).toBe(length === 29 ? 200 : 400);
  if (length === 30) {
    expect((await result.json()).error).toMatchObject({ code: "fusion_preflight_error", details: { stage: "preflight", retryable: false } });
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.core).not.toHaveBeenCalled();
    expect(mocks.systemone).not.toHaveBeenCalled();
  }
});

it("checks an incoming external edge even when its target subtree is cached", async () => {
  add("Main", ["Shared", "Nested"], { fallbackStrategy: "fusion", judgeModel: "Shared" });
  add("Shared", ["openai/panel"]);
  add("Nested", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Shared" });
  fx.keys.key.access = { restricted: true, allow: ["Main"] };
  expect((await chat()).status).toBe(403);
  expect(mocks.credentials).not.toHaveBeenCalled();
});

it("requires access to nested external judges but grants combo members", async () => {
  add("Main", ["Nested"], { fallbackStrategy: "fusion", judgeModel: "Nested" });
  add("Nested", ["openai/panel"], { fallbackStrategy: "fusion", judgeModel: "Judge" });
  add("Judge", ["openai/judge"]);
  fx.keys.key.access = { restricted: true, allow: ["Main"] };
  expect((await chat()).status).toBe(403);
  expect(mocks.credentials).not.toHaveBeenCalled();
  fx.keys.key.access.allow.push("Judge");
  expect((await chat()).status).toBe(200);
});
