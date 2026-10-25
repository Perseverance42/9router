import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ settings: {}, combos: {}, routing: {} }));
const mocks = vi.hoisted(() => ({ handleChatCore: vi.fn(), getComboRouting: vi.fn() }));

vi.mock("@/lib/localDb", () => ({ getSettings: async () => fx.settings }));
vi.mock("@/lib/db/index.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: async (name) => fx.combos[name] || null,
  getComboRouting: mocks.getComboRouting,
  getModelInfo: async (name) => {
    const slash = name.indexOf("/");
    return slash < 0 ? { provider: null } : { provider: name.slice(0, slash), model: name.slice(slash + 1) };
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "conn", connectionName: "mock" }),
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  extractClientApiKey: () => null,
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_access, models) => models,
}));
vi.mock("@/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const chat = (model) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
}));
const success = () => ({
  success: true,
  response: Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
});
const failure = () => ({
  success: false, status: 500, error: "upstream error",
  response: Response.json({ error: { message: "upstream error" } }, { status: 500 }),
});
const calls = () => mocks.handleChatCore.mock.calls.map(([args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  fx.settings = {
    comboStrategy: "fallback",
    providerOverrides: {
      openrouter: {
        headers: { "X-Title": "runtime-test" },
        connectTimeout: 1234,
        routing: { quantizations: ["fp16"], allowImageWithoutZdr: true },
      },
      openai: { headers: { "X-Test": "other-provider" } },
    },
  };
  fx.combos = { Main: ["openrouter/vendor/model"] };
  fx.routing = { Main: { zdr: true, quantizations: ["fp8"], allowImageWithoutZdr: false } };
  mocks.getComboRouting.mockImplementation(async (name) => fx.routing[name] || null);
  mocks.handleChatCore.mockImplementation(async () => success());
});

describe("OpenRouter combo policy reaches chatCore at runtime", () => {
  it("merges combo routing with provider overrides without mutating saved settings", async () => {
    const saved = structuredClone(fx.settings);
    expect((await chat("Main")).status).toBe(200);
    expect(mocks.getComboRouting).toHaveBeenCalledWith("Main");
    expect(calls()).toHaveLength(1);
    expect(calls()[0].providerOverrides).toEqual({
      ...saved.providerOverrides.openrouter,
      routing: { zdr: true, quantizations: ["fp8"] },
    });
    expect(fx.settings).toEqual(saved);
  });

  it("leaves direct model requests on the original provider overrides", async () => {
    await chat("Main");
    expect((await chat("openrouter/vendor/model")).status).toBe(200);
    expect(calls()[1].providerOverrides).toBe(fx.settings.providerOverrides.openrouter);
    expect(calls()[1].providerOverrides.routing).toEqual({
      quantizations: ["fp16"], allowImageWithoutZdr: true,
    });
    expect(mocks.getComboRouting).toHaveBeenCalledTimes(1);
  });

  it("does not pass OpenRouter combo policy to a non-OpenRouter fallback", async () => {
    fx.combos.Main.push("openai/model");
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) =>
      modelInfo.provider === "openrouter" ? failure() : success());
    expect((await chat("Main")).status).toBe(200);
    expect(calls().map(({ modelInfo }) => modelInfo.provider)).toEqual(["openrouter", "openai"]);
    expect(calls()[0].providerOverrides.routing).toEqual({ zdr: true, quantizations: ["fp8"] });
    expect(calls()[1].providerOverrides).toBe(fx.settings.providerOverrides.openai);
    expect(calls()[1].providerOverrides).not.toHaveProperty("routing");
  });

  it("keeps nested routing on its branch and out of sibling fallbacks and later requests", async () => {
    fx.combos.Main = ["Inner", "openrouter/vendor/sibling"];
    fx.combos.Inner = ["openrouter/vendor/inner"];
    fx.routing.Inner = { quantizations: [], allowImageWithoutZdr: true };
    const saved = structuredClone({ settings: fx.settings, routing: fx.routing });
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) =>
      modelInfo.model === "vendor/inner" ? failure() : success());

    expect((await chat("Main")).status).toBe(200);
    expect((await chat("openrouter/vendor/direct")).status).toBe(200);
    expect(calls().map(({ modelInfo }) => modelInfo.model)).toEqual([
      "vendor/inner", "vendor/sibling", "vendor/direct",
    ]);
    expect(calls()[0].providerOverrides.routing).toEqual({ zdr: true });
    expect(calls()[1].providerOverrides.routing).toEqual({ zdr: true, quantizations: ["fp8"] });
    expect(calls()[2].providerOverrides).toBe(fx.settings.providerOverrides.openrouter);
    expect({ settings: fx.settings, routing: fx.routing }).toEqual(saved);
  });
});
