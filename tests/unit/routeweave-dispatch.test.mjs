import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";

// Exercise the actual HTTP handler and RouteWeave service, without DB/provider I/O.
// Native combo execution is a deterministic seam; sidecar fetch remains real service code.
const key = Symbol.for("routeweave.dispatch.test");
const fixture = {};
globalThis[key] = fixture;
const shared = 'const f = globalThis[Symbol.for("routeweave.dispatch.test")];\n';
const mocks = new Map([
  ["open-sse/index.js", ""],
  ["@/lib/localDb", "export const getSettings = async () => f.settings;"],
  ["../services/auth.js", `
    export const extractApiKey = r => r.headers.get("authorization")?.replace(/^Bearer /, "") || null;
    export const isValidApiKey = async () => true;
    export const getProviderCredentials = async (...args) => { f.credentials.push(args); return { connectionId: "account", accessToken: "secret" }; };
    export const markAccountUnavailable = async () => ({ shouldFallback: false });
    export const clearAccountError = async () => {};`],
  ["../services/model.js", `
    export const getComboModels = async id => f.combos[id] || null;
    export const getModelInfo = async id => { const slash = id.indexOf("/"); return slash < 0 ? { provider: null, model: id } : { provider: id.slice(0, slash), model: id.slice(slash + 1) }; };`],
  ["open-sse/handlers/chatCore.js", `export const handleChatCore = async options => {
    f.core.push(options);
    return { success: true, response: Response.json({ choices: [{ message: { content: options.body.model }, finish_reason: "stop" }] }) };
  };`],
  ["open-sse/services/combo.js", `
    export const detectRequiredCapabilities = () => new Set();
    export const handleFusionChat = async options => { f.fusion.push(options); return Response.json({ strategy: "fusion" }); };
    export const handleComboChat = async options => {
      f.native.push(options);
      if (options.comboStrategy === "smart" && options.resolveSmartChoice) await options.resolveSmartChoice(options.body, options.models);
      const selected = options.models[0];
      options.onSelected?.(selected);
      return options.handleSingleModel(options.body, selected);
    };`],
  ["open-sse/services/capacityAdapter.js", `
    export const augmentModelsWithCapacityAdapter = models => models;
    export const withCapacityAdapterStripping = fn => fn;
    export const getActiveAdapterStrategy = () => "fallback";`],
  ["../services/keyAccess.js", `
    export const getKeyAccessContext = async () => null;
    export const enforceKeyAccess = async () => null;
    export const filterAdapterModels = async (_key, models) => models;`],
  ["../services/systemoneRouter.js", "export const resolveSmartChoice = async options => { f.classifier.push(options); return null; };"],
  ["../services/tokenRefresh.js", "export const checkAndRefreshToken = async (_p, credentials) => credentials; export const updateProviderCredentials = async () => {};"],
  ["../services/antigravityQuota.js", "export const handleAntigravityQuotaError = async () => null; export const clearAntigravityStrikes = () => {};"],
  ["../utils/logger.js", "export const debug = () => {}; export const info = debug; export const warn = debug; export const error = debug; export const maskKey = k => k;"],
  ["@/lib/headroom/detect", 'export const DEFAULT_HEADROOM_URL = "http://headroom.invalid";'],
  ["@/lib/pxpipe/loader.js", "export const getTransform = async () => null;"],
  ["@/lib/pxpipe/events.js", "export const appendPxpipeEvent = () => {};"],
  ["open-sse/utils/error.js", `export const errorResponse = (status, message) => Response.json({ error: { message } }, { status }); export const unavailableResponse = errorResponse;`],
  ["open-sse/utils/upstreamHeaders.js", "export const upstreamResponseHeaders = () => ({});"],
  ["open-sse/utils/bypassHandler.js", "export const handleBypassRequest = () => null;"],
  ["open-sse/config/runtimeConfig.js", "export const HTTP_STATUS = { UNAUTHORIZED: 401, BAD_REQUEST: 400, NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503 };"],
  ["open-sse/translator/formats.js", 'export const detectFormatByEndpoint = () => "openai";'],
  ["open-sse/services/projectId.js", "export const getProjectIdForConnection = async () => null;"],
  ["open-sse/providers/capabilities.js", "export const getCapabilitiesForModel = () => ({});"],
  ["open-sse/utils/modelMarkers.js", "export const stripModelContextMarker = model => ({ model, contextMarker: null });"],
  ["open-sse/utils/sessionManager.js", 'export const resolveSessionIdentity = () => ({ sessionId: "session" });'],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (mocks.has(specifier)) return { url: `data:text/javascript,${encodeURIComponent(shared + mocks.get(specifier))}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`../../src/${specifier.slice(2)}.js`.replace(/\.js\.js$/, ".js"), import.meta.url).href, context);
    if (specifier.startsWith("open-sse/")) return next(new URL(`../../${specifier}`, import.meta.url).href, context);
    return next(specifier, context);
  },
});
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { readRouteweaveConfig } = await import("../../src/sse/services/routeweave.mjs");
const savedFetch = globalThis.fetch;
const envKeys = ["ROUTEWEAVE_COMBOS", "ROUTEWEAVE_URL", "ROUTEWEAVE_SERVICE_TOKEN", "ROUTEWEAVE_MODE", "ROUTEWEAVE_ALLOWLIST", "ROUTEWEAVE_DECISION_TIMEOUT_MS"];
const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const models = ["openai/first", "openai/selected"];
const allowlist = Object.fromEntries(models.map(id => [id, { text: true, tokens_per_byte: 1, template_tokens: 32, context_tokens: 8192, max_output_tokens: 1024 }]));

beforeEach(() => {
  Object.assign(fixture, {
    settings: { comboStrategies: { target: { fallbackStrategy: "routeweave" } } },
    combos: { target: [...models] },
    decisions: [], feedback: [], native: [], fusion: [], classifier: [], core: [], credentials: [],
    cancel: null,
  });
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, {
    ROUTEWEAVE_COMBOS: "unrelated",
    ROUTEWEAVE_URL: "http://routeweave.invalid",
    ROUTEWEAVE_SERVICE_TOKEN: "service-secret",
    ROUTEWEAVE_ALLOWLIST: JSON.stringify(allowlist),
  });
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(options.headers.authorization, "Bearer service-secret");
    if (String(url).endsWith("/outcomes")) { fixture.feedback.push(payload); return Response.json({}); }
    assert.ok(String(url).endsWith("/decisions"), `Unexpected network request: ${url}`);
    fixture.decisions.push(payload);
    if (fixture.cancel) {
      fixture.cancel.abort();
      options.signal.throwIfAborted();
    }
    return Response.json({
      request_id: payload.request_id, mode: payload.mode,
      candidate_snapshot_id: payload.candidate_snapshot_id,
      decision_id: "decision", policy_revision: "policy", status: "ranked",
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      ranking: [...payload.candidates].reverse().map((c, i) => ({ candidate_id: c.id, score: 1 - i / 10 })),
    });
  };
});
after(() => {
  hooks.deregister();
  globalThis.fetch = savedFetch;
  delete globalThis[key];
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

async function chat(model = "target", { signal, headers = {} } = {}) {
  const request = new Request("http://gateway.invalid/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, signal,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 64, stream: false }),
  });
  const response = await handleChat(request);
  const body = await response.json();
  return { response, body };
}

function assertSelected(model = models[1]) {
  assert.equal(fixture.decisions.length, 1);
  assert.equal(fixture.core.length, 1);
  assert.equal(fixture.core[0].body.model, model);
  assert.equal(fixture.core[0].routeweave, true);
  assert.ok(fixture.core[0].routeweaveExpiresAt > Date.now());
}

test("saved per-combo RouteWeave strategy activates without an environment name match", async () => {
  const { response } = await chat();
  assert.equal(response.status, 200);
  assertSelected();
  assert.equal(fixture.decisions[0].mode, "active_required");
  assert.deepEqual(fixture.native[0].models, [...models].reverse());
  assert.equal(fixture.native[0].comboStrategy, "fallback");
});

test("environment defaults to required mode and ignores the obsolete combo list", () => {
  const config = readRouteweaveConfig({
    ROUTEWEAVE_URL: "http://routeweave.invalid/", ROUTEWEAVE_SERVICE_TOKEN: "token",
    ROUTEWEAVE_COMBOS: "a-different-name", ROUTEWEAVE_ALLOWLIST: JSON.stringify(allowlist),
  });
  assert.equal(config.mode, "active_required");
  assert.equal(config.url, "http://routeweave.invalid");
  assert.deepEqual(config.allowlist, allowlist);
});

for (const strategy of ["fallback", "smart", "fusion"]) {
  test(`environment name list cannot override saved ${strategy} strategy`, async () => {
    fixture.settings.comboStrategies.target.fallbackStrategy = strategy;
    process.env.ROUTEWEAVE_COMBOS = "target";
    const { response } = await chat();
    assert.equal(response.status, 200);
    assert.equal(fixture.decisions.length, 0);
    if (strategy === "fusion") assert.equal(fixture.fusion.length, 1);
    else {
      assert.equal(fixture.native[0].comboStrategy, strategy);
      assert.equal(fixture.core[0].body.model, models[0]);
      assert.equal(fixture.core[0].routeweave, false);
      assert.equal(fixture.classifier.length, strategy === "smart" ? 1 : 0);
    }
  });
  test(`malformed RouteWeave connection configuration does not affect saved ${strategy}`, async () => {
    fixture.settings.comboStrategies.target.fallbackStrategy = strategy;
    process.env.ROUTEWEAVE_COMBOS = "target";
    process.env.ROUTEWEAVE_URL = ":not-a-url";
    process.env.ROUTEWEAVE_ALLOWLIST = "invalid-json";
    delete process.env.ROUTEWEAVE_SERVICE_TOKEN;
    const { response } = await chat();
    assert.equal(response.status, 200);
    assert.equal(fixture.decisions.length, 0);
    assert.equal(strategy === "fusion" ? fixture.fusion.length : fixture.core.length, 1);
  });
}

test("malformed configuration fails only a selected RouteWeave combo", async () => {
  process.env.ROUTEWEAVE_URL = "invalid";
  const { response } = await chat();
  assert.equal(response.status, 503);
  assert.equal(fixture.decisions.length, 0);
  assert.equal(fixture.credentials.length, 0);
  assert.equal((await chat(models[0])).response.status, 200);
});

test("global comboStrategy routeweave cannot activate a combo without its saved strategy", async () => {
  fixture.settings.comboStrategy = "routeweave";
  fixture.settings.comboStrategies = {};
  process.env.ROUTEWEAVE_COMBOS = "target";
  process.env.ROUTEWEAVE_URL = "invalid";
  const { response } = await chat();
  assert.equal(response.status, 200);
  assert.equal(fixture.decisions.length, 0);
  assert.equal(fixture.native[0].comboStrategy, "fallback");
  assert.equal(fixture.core[0].routeweave, false);
});

test("ordinary outer fallback reaches the saved inner RouteWeave strategy", async () => {
  fixture.combos.outer = ["target"];
  fixture.settings.comboStrategies.outer = { fallbackStrategy: "fallback" };
  const { response } = await chat("outer");
  assert.equal(response.status, 200);
  assertSelected();
  assert.equal(fixture.native[0].comboName, "outer");
  assert.equal(fixture.native[1].comboName, "target");
});

test("RouteWeave shadow never runs the native smart classifier", async () => {
  process.env.ROUTEWEAVE_MODE = "shadow";
  fixture.settings.comboStrategy = "smart";
  fixture.settings.comboStrategies.target.routerModel = "paid/classifier";
  const { response } = await chat();
  assert.equal(response.status, 200);
  assert.equal(fixture.decisions[0].mode, "shadow");
  assert.equal(fixture.classifier.length, 0);
  assert.equal(fixture.native[0].resolveSmartChoice, null);
  assert.equal(fixture.native[0].comboStrategy, "fallback");
  assert.equal(fixture.core[0].body.model, models[0]);
  assert.equal(fixture.core[0].routeweave, true);
  assert.equal(fixture.core[0].routeweaveExpiresAt, null);
});

test("active_required cancellation during the decision returns 499 before provider dispatch", async () => {
  const controller = new AbortController();
  fixture.cancel = controller;
  const { response } = await chat("target", { signal: controller.signal });
  assert.equal(response.status, 499);
  assert.equal(fixture.decisions.length, 1);
  assert.equal(fixture.native.length, 0);
  assert.equal(fixture.credentials.length, 0);
  assert.equal(fixture.core.length, 0);
});

for (const name of ["x-9router-token-saver", "X-9Router-Token-Saver"]) {
  test(`request header ${name}: off permits globally enabled token savers`, async () => {
    fixture.settings.rtkEnabled = true;
    const { response } = await chat("target", { headers: { [name]: "off" } });
    assert.equal(response.status, 200);
    assertSelected();
    assert.equal(fixture.core[0].clientRawRequest.headers["x-9router-token-saver"], "off");
  });
}

test("automatic thinking and case-insensitive saver opt-out preserve untransformed requests", async () => {
  fixture.settings.rtkEnabled = true;
  fixture.settings.providerThinking = { openai: { mode: "auto" } };
  const { response } = await chat("target", { headers: { "x-9router-token-saver": "OFF" } });
  assert.equal(response.status, 200);
  assertSelected();
});

test("unrelated providerThinking settings do not block admitted candidates", async () => {
  fixture.settings.providerThinking = { gemini: { type: "enabled", budget_tokens: 1000 } };
  const { response } = await chat();
  assert.equal(response.status, 200);
  assertSelected();
  assert.equal(fixture.core[0].providerThinking, null);
});

for (const [name, settings] of [
  ["effective RTK", { rtkEnabled: true }],
  ["candidate thinking", { providerThinking: { openai: { mode: "high" } } }],
  ["custom prompt", { customPromptEnabled: true }],
  ["PXPIPE", { pxpipeEnabled: true }],
]) {
  test(`${name} rejects RouteWeave before sidecar or provider dispatch`, async () => {
    Object.assign(fixture.settings, settings);
    const { response } = await chat();
    assert.equal(response.status, 422);
    assert.equal(fixture.decisions.length, 0);
    assert.equal(fixture.credentials.length, 0);
    assert.equal(fixture.core.length, 0);
  });
}

