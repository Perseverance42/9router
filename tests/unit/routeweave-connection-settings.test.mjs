import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { maskRouteweaveSettings, publicRouteweaveSettings, resolveRouteweaveConfig, validateRouteweaveSettings } from "../../src/shared/utils/routeweaveSettings.mjs";

const key = Symbol.for("routeweave.connection.settings.test");
const fixture = { settings: {}, updates: [], fetches: [] };
globalThis[key] = fixture;
const shared = 'const f = globalThis[Symbol.for("routeweave.connection.settings.test")];\n';
const mocks = new Map([
  ["@/lib/localDb", `export const getSettings = async () => f.settings;
    export const updateSettings = async updates => { f.updates.push(updates); return f.settings = { ...f.settings, ...updates }; };
    export const exportDb = async () => ({ settings: f.settings });
    export const importDb = async payload => { f.settings = payload.settings; };
    export const validateApiKey = async () => false;`],
  ["next/server", "export const NextResponse = { json: (body, init) => Response.json(body, init), next: () => new Response(null, { status: 200 }) };"],
  ["@/shared/utils/machineId", 'export const getConsistentMachineId = async () => "trusted-cli";'],
  ["@/lib/auth/dashboardSession", `export const verifyDashboardAuthToken = async token => token === "valid-session";
    export const verifyDashboardPassword = async password => password === "valid-password";`],
  ["@/lib/auth/trustedPeer", "export const hasTrustedPeerHeaders = () => false;"],
  ["bcryptjs", "export default {};"],
  ["@/lib/network/outboundProxy", "export const applyOutboundProxyEnv = () => {};"],
  ["open-sse/services/combo.js", "export const resetComboRotation = () => {};"],
  ["open-sse/utils/proxyFetch.js", "export const proxyAwareFetch = (...args) => f.transport(...args);"],
]);
const helper = new URL("../../src/shared/utils/routeweaveSettings.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/shared/utils/routeweaveSettings.mjs") return { url: helper, shortCircuit: true };
    if (mocks.has(specifier)) return { url: `mock:connection-settings:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const prefix = "mock:connection-settings:";
    if (url.startsWith(prefix)) return { format: "module", source: shared + mocks.get(url.slice(prefix.length)), shortCircuit: true };
    return nextLoad(url, context);
  },
});
const endpoint = await import("../../src/app/api/settings/routeweave/route.js");
const general = await import("../../src/app/api/settings/route.js");
const database = await import("../../src/app/api/settings/database/route.js");
const { proxy: guard } = await import("../../src/dashboardGuard.js");
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("ROUTEWEAVE_")).map(key => [key, process.env[key]]));
const allowlist = { "openai/model": { text: true, tokens_per_byte: 1, template_tokens: 32, context_tokens: 8192, max_output_tokens: 1024 } };
const config = { url: "http://localhost:9090", uiUrl: "http://192.168.56.108:3000", token: "private-service-token", allowlist, mode: "active_required", decisionTimeoutMs: 35000 };
const env = { ROUTEWEAVE_URL: "https://env.example", ROUTEWEAVE_SERVICE_TOKEN: "environment-secret", ROUTEWEAVE_ALLOWLIST: JSON.stringify(allowlist) };
const request = body => new Request("http://localhost/api/settings/routeweave", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("ROUTEWEAVE_")) delete process.env[key];
  Object.assign(fixture, { settings: { unrelated: { keep: true } }, updates: [], fetches: [] });
  globalThis.fetch = () => { throw Error("Readiness must use explicit proxyAwareFetch, not global fetch"); };
  fixture.transport = async (url, options) => { fixture.fetches.push({ url, options }); return Response.json({ status: "ready" }); };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (key.startsWith("ROUTEWEAVE_")) delete process.env[key];
  Object.assign(process.env, originalEnv);
  hooks.deregister();
  delete globalThis[key];
});

test("saved config replaces the whole environment config; null restores fallback", () => {
  assert.deepEqual(resolveRouteweaveConfig(env, config), config);
  assert.equal(resolveRouteweaveConfig(env).token, "environment-secret");
  assert.equal(resolveRouteweaveConfig(env, null).url, "https://env.example");
  assert.throws(() => resolveRouteweaveConfig(env, {}));
  assert.throws(() => resolveRouteweaveConfig(env, false));
  const state = publicRouteweaveSettings(env, config);
  assert.equal(state.source, "settings");
  assert.deepEqual(state.overriddenFields, ["url", "token", "allowlist"]);
  assert.equal(state.hasToken, true);
  assert.ok(!JSON.stringify(state).includes(config.token));
});

test("backend URLs require HTTPS except loopback; UI URLs never send credentials", () => {
  for (const url of ["https://routeweave.example/base/", "http://127.42.1.2:9090", "http://[::1]:9090", "http://localhost:9090"]) {
    assert.equal(validateRouteweaveSettings({ ...config, url }).url, url.replace(/\/$/, ""));
  }
  for (const url of ["http://192.168.56.108", "http://routeweave.example", "http://127.example", "http://[::2]", "http://[:::1]", "https://user:password@example.com", "https://@example.com", "https://example.com?", "https://example.com#", "https://example.com/?token=secret", "file:///tmp/routeweave", "https://example.com/\n"]) {
    assert.throws(() => validateRouteweaveSettings({ ...config, url }), undefined, url);
  }
  for (const uiUrl of ["javascript:alert(1)", "https://user:password@example.com", "http://example.com?token=secret"]) assert.throws(() => validateRouteweaveSettings({ ...config, uiUrl }));
  assert.equal(validateRouteweaveSettings(config).uiUrl, "http://192.168.56.108:3000");
});

test("strict config and authoritative limits reject malformed values", () => {
  for (const patch of [{ mode: "native" }, { token: "" }, { token: "a\nb" }, { token: "a b" }, { decisionTimeoutMs: "100" }, { decisionTimeoutMs: 99 }, { decisionTimeoutMs: 60001 }, { decisionTimeoutMs: 1.5 }, { extra: true }, { allowlist: [] }, { allowlist: {} }]) assert.throws(() => validateRouteweaveSettings({ ...config, ...patch }));
  for (const patch of [{ text: false }, { tokens_per_byte: 0 }, { tokens_per_byte: Infinity }, { template_tokens: -1 }, { context_tokens: 0 }, { max_output_tokens: 1.5 }, { surprise: true }]) assert.throws(() => validateRouteweaveSettings({ ...config, allowlist: { "openai/model": { ...allowlist["openai/model"], ...patch } } }));
  assert.throws(() => validateRouteweaveSettings({ ...config, allowlist: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`openai/model${i}`, allowlist["openai/model"]])) }));
  assert.equal(validateRouteweaveSettings({ ...config, decisionTimeoutMs: 100 }).decisionTimeoutMs, 100);
  assert.equal(resolveRouteweaveConfig({ ...env, ROUTEWEAVE_DECISION_TIMEOUT_MS: "60000" }).decisionTimeoutMs, 60000);
});

test("invalid and missing public state never echo malformed secret-bearing values", () => {
  assert.equal(publicRouteweaveSettings({}).status, "missing");
  for (const saved of [{ ...config, url: "https://username:private-service-token@example.com" }, { ...config, allowlist: { "private-service-token": {} } }, { ...config, token: "private-service-token\n" }]) {
    const state = publicRouteweaveSettings({}, saved);
    assert.equal(state.status, "invalid");
    assert.ok(!JSON.stringify(state).includes("private-service-token"));
    assert.ok(!JSON.stringify(maskRouteweaveSettings({ routeweave: saved })).includes("private-service-token"));
  }
});

test("unknown historical and encrypted-looking keys fail closed and never reach responses", async () => {
  const saved = { ...config, tokenEncrypted: "opaque-historical-secret" };
  fixture.settings.routeweave = saved;
  assert.throws(() => resolveRouteweaveConfig(env, saved), /unsupported fields/);
  for (const response of [await endpoint.GET(), await general.GET()]) {
    const body = await response.json();
    assert.equal(body.routeweave?.status || body.status, "invalid");
    assert.ok(!JSON.stringify(body).includes(config.token));
    assert.ok(!JSON.stringify(body).includes(saved.tokenEncrypted));
  }
  assert.equal((await endpoint.PUT(request(saved))).status, 400);
  assert.equal(fixture.updates.length, 0);
  assert.equal(fixture.fetches.length, 0);
});

test("GET readiness explicitly uses proxyAwareFetch with bounded, redirect-safe TLS guards and no credentials", async () => {
  fixture.settings.routeweave = config;
  const response = await endpoint.GET();
  const state = await response.json();
  assert.equal(state.status, "ready");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!JSON.stringify(state).includes(config.token));
  const { url, options } = fixture.fetches[0];
  assert.equal(url, "http://localhost:9090/health/ready");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(options.strictTls, true);
  assert.equal(options.routeweave, true);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers, undefined);
  fixture.transport = async () => Response.json({ ready: false });
  assert.equal((await (await endpoint.GET()).json()).status, "not_ready");
  fixture.transport = async () => new Response("x".repeat(4097));
  assert.equal((await (await endpoint.GET()).json()).status, "unreachable");
  fixture.transport = async () => new Response("secret body", { status: 503 });
  assert.equal((await (await endpoint.GET()).json()).status, "not_ready");
  fixture.transport = async () => { throw Error(config.token); };
  const failed = await (await endpoint.GET()).json();
  assert.equal(failed.status, "unreachable");
  assert.ok(!JSON.stringify(failed).includes(config.token));
});

test("GET checks neither missing nor invalid config", async () => {
  assert.equal((await (await endpoint.GET()).json()).status, "missing");
  fixture.settings.routeweave = { ...config, url: "http://remote.example" };
  assert.equal((await (await endpoint.GET()).json()).status, "invalid");
  assert.equal(fixture.fetches.length, 0);
  Object.assign(process.env, env);
  fixture.settings.routeweave = null;
  assert.equal((await (await endpoint.GET()).json()).source, "env");
});

test("PUT preserves unrelated settings, retains the effective blank token, and masks response", async () => {
  let response = await endpoint.PUT(request(config));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "configured");
  assert.deepEqual(fixture.settings.unrelated, { keep: true });
  assert.deepEqual(fixture.updates[0], { routeweave: config });
  response = await endpoint.PUT(request({ ...config, token: "", mode: "shadow" }));
  assert.equal(response.status, 200);
  assert.equal(fixture.settings.routeweave.token, config.token);
  assert.ok(!JSON.stringify(await response.json()).includes(config.token));
  fixture.settings.routeweave = null;
  Object.assign(process.env, env);
  response = await endpoint.PUT(request({ ...config, token: "" }));
  assert.equal(response.status, 200);
  assert.equal(fixture.settings.routeweave.token, env.ROUTEWEAVE_SERVICE_TOKEN);
  fixture.settings.routeweave = null;
  delete process.env.ROUTEWEAVE_SERVICE_TOKEN;
  response = await endpoint.PUT(request({ ...config, token: "" }));
  assert.equal(response.status, 400);
  const count = fixture.updates.length;
  response = await endpoint.PUT(request({ ...config, url: "http://remote.example" }));
  assert.equal(response.status, 400);
  assert.equal(fixture.updates.length, count);
  response = await endpoint.PUT(new Request("http://localhost", { method: "PUT", body: "{" }));
  assert.equal(response.status, 400);
});

test("DELETE clears saved override and restores environment fallback without losing unrelated settings", async () => {
  fixture.settings.routeweave = config;
  Object.assign(process.env, env);
  const response = await endpoint.DELETE();
  const state = await response.json();
  assert.equal(state.source, "env");
  assert.equal(state.url, "https://env.example");
  assert.equal(fixture.settings.routeweave, null);
  assert.deepEqual(fixture.settings.unrelated, { keep: true });
  assert.ok(!JSON.stringify(state).includes(env.ROUTEWEAVE_SERVICE_TOKEN));
});

test("connection and database routes preserve dashboard authentication and privileged export", async () => {
  fixture.settings.routeweave = config;
  const guarded = (path, { session, cli } = {}) => {
    const req = new Request(`http://localhost${path}`, { headers: cli ? { "x-9r-cli-token": cli } : {} });
    req.nextUrl = new URL(req.url);
    req.cookies = { get: name => name === "auth_token" && session ? { value: session } : undefined };
    return guard(req);
  };
  for (const path of ["/api/settings", "/api/settings/routeweave", "/api/settings/database"]) {
    assert.equal((await guarded(path)).status, 401);
    assert.equal((await guarded(path, { cli: "forged" })).status, 401);
    assert.equal((await guarded(path, { session: "valid-session" })).status, 200);
    assert.equal((await guarded(path, { cli: "trusted-cli" })).status, 200);
  }
  fixture.settings.requireLogin = false;
  assert.equal((await guarded("/api/settings/routeweave")).status, 200);
  assert.equal((await guarded("/api/settings/database")).status, 401);
  assert.equal((await database.GET(new Request("http://localhost"))).status, 401);
  const exported = await database.GET(new Request("http://localhost", { headers: { "x-9r-password": "valid-password" } }));
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).settings.routeweave.token, config.token);
});

test("general GET/PATCH mask nested token; generic routeweave assignment is rejected", async () => {
  fixture.settings.routeweave = config;
  for (const response of [await general.GET(), await general.PATCH(request({ theme: "dark" }))]) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.routeweave.hasToken, true);
    assert.ok(!JSON.stringify(body).includes(config.token));
  }
  const count = fixture.updates.length;
  for (const routeweave of [config, null, "secret"]) assert.equal((await general.PATCH(request({ routeweave }))).status, 400);
  assert.equal(fixture.updates.length, count);
});
