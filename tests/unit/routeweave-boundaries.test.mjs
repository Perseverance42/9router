import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Keep real translators, chatCore and DefaultExecutor; isolate persistence and network only.
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/src/sse/handlers/systemone.js")) {
    const stubs = {
      "../services/auth.js": 'export const getProviderCredentials=()=>globalThis.boundaryCredentials();export const markAccountUnavailable=async()=>({});export const clearAccountError=async()=>{};export const extractApiKey=()=>null;export const isValidApiKey=async()=>true;',
      "@/lib/localDb": 'export const getSettings=async()=>({});',
      "../services/model.js": 'export const getModelInfo=async()=>({provider:"openai",model:"a"});',
      "../services/keyAccess.js": 'export const getKeyAccessContext=async()=>({});export const enforceKeyAccessResolved=async()=>null;',
      "open-sse/handlers/systemoneCore.js": 'export const handleSystemoneCore=async()=>{throw Error("unexpected dispatch");};',
      "../services/tokenRefresh.js": 'export const checkAndRefreshToken=async(p,c)=>{globalThis.boundaryRefreshes++;return c;};',
      "../utils/logger.js": 'export const request=()=>{};export const debug=()=>{};export const info=()=>{};export const warn=()=>{};export const error=()=>{};export const maskKey=x=>x;',
    };
    if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("open-sse/")) return next(new URL(`../../${specifier}`, import.meta.url).href, context);
  }
  if (specifier.startsWith("ajv/")) return { url: 'data:text/javascript,export default class Ajv { compile(){throw Error("unexpected schema compilation");} }', shortCircuit: true };
  if (specifier === "node-machine-id") return { url: 'data:text/javascript,export const machineIdSync=()=>"test-machine";', shortCircuit: true };
  if (specifier === "uuid") return { url: 'data:text/javascript,export { randomUUID as v4 } from "node:crypto";export const v5=()=>{throw Error("unexpected uuid v5");};', shortCircuit: true };
  if (specifier === "undici") return { url: 'data:text/javascript,export class Agent { constructor(){throw Error("unexpected network agent");} }', shortCircuit: true };
  if (specifier.endsWith("/db/helpers/kvStore.js")) return { url: 'data:text/javascript,export const makeKv=()=>({get:async()=>null,set:async()=>{},remove:async()=>{},getAll:async()=>[]});', shortCircuit: true };
  if (specifier === "@/lib/usageDb.js") return { url: 'data:text/javascript,export const trackPendingRequest=()=>{};export const appendRequestLog=async()=>{};export const saveRequestDetail=async()=>{};export const saveUsageHistory=async()=>{};export const saveRequestUsage=async()=>{};', shortCircuit: true };
  if (context.parentURL?.endsWith("/executors/base.js") && specifier === "../utils/proxyFetch.js") return { url: 'data:text/javascript,export const proxyAwareFetch=(...args)=>globalThis.routeweaveBoundaryFetch(...args);', shortCircuit: true };
  return next(specifier, context);
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => globalThis.boundaryFetch(...args);
test.after(() => { globalThis.fetch = originalFetch; });
const { assertRouteweaveRoute } = await import("../../open-sse/services/routeweaveRoute.js");
const { inspectRouteweaveUpstream, observeResponse, setRouteweaveEvidence, checkRouteweaveJson } = await import("../../open-sse/services/routeweaveEvidence.js");
const { handleRouteweaveCombo } = await import("../../src/sse/services/routeweave.mjs");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const log = { info() {}, warn() {}, debug() {}, error() {} };
const body = { model: "combo", messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false };
const models = ["openai/a", "openai/b"];
const rule = { text: true, tokens_per_byte: 1, template_tokens: 100, context_tokens: 10000, max_output_tokens: 1000 };
const answer = { choices: [{ message: { content: "healthy" }, finish_reason: "stop" }] };
function harness(overrides = {}) {
  const calls = [], outcomes = [];
  return { calls, outcomes, options: { config: { url: "http://sidecar", token: "private", mode: "active_required", allowlist: Object.fromEntries(models.map(m => [m, rule])) }, body, models, nativeOptions: { log, comboStrategy: "fallback" }, runCombo: handleComboChat, resolveModel: async id => ({ provider: "openai", model: id.split("/")[1] }), dispatch: async (_, id) => { calls.push(id); return Response.json(answer); }, fetchImpl: async (url, init) => {
    const p = JSON.parse(init.body);
    if (url.endsWith("outcomes")) { outcomes.push(p); return Response.json({ ok: true }); }
    return Response.json({ decision_id: "d", request_id: p.request_id, mode: p.mode, candidate_snapshot_id: p.candidate_snapshot_id, policy_revision: "p", status: "ranked", ranking: p.candidates.map(c => ({ candidate_id: c.id, score: 1 })), expires_at: new Date(Date.now() + 30000).toISOString() });
  }, ...overrides } };
}

test("resolved thinking suffix and Claude developer pool fail before sidecar or dispatch", async () => {
  for (const resolved of [{ provider: "openai", model: "hidden(8192)" }, { provider: "anthropic", model: "claude" }]) {
    const h = harness({ body: { ...body, messages: [{ role: "developer", content: "keep me" }, ...body.messages] }, resolveModel: async () => resolved });
    assert.equal((await handleRouteweaveCombo(h.options)).status, 422);
    assert.deepEqual(h.calls, []);
  }
  assert.throws(() => assertRouteweaveRoute({ provider: "openai", model: "a(high)" }));
  // The actual translator drops developer; route admission must reject instead of classifying a different transcript.
  const translated = translateRequest("openai", "claude", "claude", { ...body, messages: [{ role: "developer", content: "keep me" }, ...body.messages] }, false, {}, "anthropic");
  assert.ok(!JSON.stringify(translated).includes("keep me"));
});

test("real chatCore skips synthetic warmup bypass under RouteWeave", async () => {
  let calls = 0;
  globalThis.routeweaveBoundaryFetch = async () => { calls++; return Response.json(answer); };
  const result = await handleChatCore({ body: { ...body, messages: [{ role: "user", content: "Warmup" }] }, userAgent: "claude-cli", modelInfo: { provider: "openai", model: "a" }, credentials: { apiKey: "test" }, log, routeweave: true, sourceFormatOverride: "openai" });
  assert.equal(calls, 1);
  await result.response.text();
});

const text = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
const stop = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
async function translatedStatus(raw, target, source) {
  const inspected = inspectRouteweaveUpstream(new Response(raw, { headers: { "content-type": "text/event-stream" } }));
  const transform = target === source ? createPassthroughStreamWithLogger(target, target === "claude" ? "anthropic" : "openai") : createSSETransformStreamWithLogger(target, source, target === "claude" ? "anthropic" : "openai");
  const translated = setRouteweaveEvidence(new Response(inspected.response.body.pipeThrough(transform), { headers: { "content-type": "text/event-stream" } }), inspected.state);
  const statuses = [];
  await observeResponse(translated, null, status => statuses.push(status)).text();
  return statuses;
}

test("real translators preserve upstream success and cannot launder errors or synthetic terminals", async () => {
  const claude = 'data: {"type":"message_start","message":{"id":"msg_test","model":"claude"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n';
  assert.deepEqual(await translatedStatus(claude, "claude", "openai"), ["succeeded"]);
  assert.deepEqual(await translatedStatus(text + stop + 'data: {"error":{"message":"bad"}}\n\ndata: [DONE]\n\n', "openai", "claude"), ["failed"]);
  assert.deepEqual(await translatedStatus(text + 'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n', "openai", "claude"), ["failed"]);
  assert.deepEqual(await translatedStatus(text + stop, "openai", "openai"), ["failed"]);
  assert.deepEqual(await translatedStatus(text + stop + "data: [DONE]\n\n", "openai", "claude"), ["succeeded"]);
});

test("real chatCore, executor, combo peek and translator carry upstream evidence to feedback", async () => {
  for (const raw of [text + stop + "data: [DONE]\n\n", text + stop, text + stop + 'data: {"error":{"message":"bad"}}\n\ndata: [DONE]\n\n']) {
    const h = harness({ body: { ...body, stream: true } });
    globalThis.routeweaveBoundaryFetch = async () => new Response(raw, { headers: { "content-type": "text/event-stream" } });
    h.options.dispatch = async (b, id, execution) => {
      const result = await handleChatCore({ body: { ...b }, modelInfo: { provider: "openai", model: id.split("/")[1] }, credentials: { apiKey: "test" }, log, routeweave: true, routeweaveExpiresAt: execution.expiresAt, sourceFormatOverride: "claude" });
      return result.response;
    };
    await (await handleRouteweaveCombo(h.options)).text();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.outcomes[0]?.status, raw === text + stop + "data: [DONE]\n\n" ? "succeeded" : "failed");
  }
  const claude = 'data: {"type":"message_start","message":{"id":"msg_test","model":"claude"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n';
  const h = harness({ body: { ...body, stream: true } });
  globalThis.routeweaveBoundaryFetch = async () => new Response(claude, { headers: { "content-type": "text/event-stream" } });
  h.options.dispatch = async b => (await handleChatCore({ body: { ...b }, modelInfo: { provider: "anthropic", model: "claude" }, credentials: { apiKey: "test" }, log, routeweave: true, sourceFormatOverride: "openai" })).response;
  await (await handleRouteweaveCombo(h.options)).text();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.outcomes[0]?.status, "succeeded");
});

test("RouteWeave JSON fallback rejects empty, error200 and unfinished results; native tools stay native", async () => {
  for (const payload of [{ choices: [{ message: { content: "" }, finish_reason: "stop" }] }, { error: { message: "bad" } }, { choices: [{ message: { content: "partial" }, finish_reason: null }] }, { content: [{ type: "text", text: "partial" }], stop_reason: null }]) {
    const h = harness();
    h.options.dispatch = async (_, id) => { h.calls.push(id); return Response.json(id === models[0] ? payload : answer); };
    assert.match(await (await handleRouteweaveCombo(h.options)).text(), /healthy/);
    assert.deepEqual(h.calls, models);
  }
  const tools = { choices: [{ message: { tool_calls: [{ id: "call", function: { name: "tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
  const nativeCalls = [];
  const native = await handleComboChat({ body, models, log, handleSingleModel: async (_, id) => { nativeCalls.push(id); return Response.json(tools); } });
  assert.deepEqual(await native.json(), tools);
  assert.equal(nativeCalls.length, 1);
});

test("real JSON translation cannot launder unfinished upstream content into success", async () => {
  const h = harness();
  globalThis.routeweaveBoundaryFetch = async () => Response.json({ choices: [{ message: { content: "partial" }, finish_reason: null }] });
  h.options.dispatch = async (b, id) => {
    h.calls.push(id);
    if (id === models[1]) return Response.json(answer);
    return (await handleChatCore({ body: { ...b }, modelInfo: { provider: "openai", model: "a" }, credentials: { apiKey: "test" }, clientRawRequest: { headers: { accept: "application/json" } }, log, routeweave: true, sourceFormatOverride: "claude" })).response;
  };
  assert.match(await (await handleRouteweaveCombo(h.options)).text(), /healthy/);
  assert.deepEqual(h.calls, models);
});

test("chatCore expiry during credential refresh prevents refresh retry fetch", async () => {
  const original = DefaultExecutor.prototype.refreshCredentials;
  let calls = 0, refreshed = 0;
  DefaultExecutor.prototype.refreshCredentials = async () => { refreshed++; await new Promise(resolve => setTimeout(resolve, 40)); return { accessToken: "refreshed" }; };
  globalThis.routeweaveBoundaryFetch = async () => { calls++; return Response.json({ error: { message: "expired credentials" } }, { status: 401 }); };
  try {
    const result = await handleChatCore({ body: { ...body }, modelInfo: { provider: "openai", model: "a" }, credentials: { apiKey: "test" }, log, routeweave: true, routeweaveExpiresAt: Date.now() + 30, sourceFormatOverride: "openai" });
    await result.response.text();
    assert.equal(refreshed, 1);
    assert.equal(calls, 1);
  } finally { DefaultExecutor.prototype.refreshCredentials = original; }
});

test("real Claude JSON terminal reasons survive translation without paid fallback", async () => {
  for (const reason of ["end_turn", "max_tokens", "stop_sequence"]) {
    let calls = 0;
    globalThis.routeweaveBoundaryFetch = async () => { calls++; return Response.json({ id: "msg", model: "claude", content: [{ type: "text", text: "healthy" }], stop_reason: reason }); };
    const h = harness();
    h.options.dispatch = async b => (await handleChatCore({ body: { ...b }, modelInfo: { provider: "anthropic", model: "claude" }, credentials: { apiKey: "test" }, log, routeweave: true, sourceFormatOverride: "openai" })).response;
    await (await handleRouteweaveCombo(h.options)).text();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, reason);
    assert.equal(h.outcomes[0]?.status, "succeeded", reason);
  }
});

test("raw non-streaming consumption rejects oversized JSON and buffered SSE before EOF", async () => {
  for (const contentType of ["application/json", "text/event-stream"]) {
    let cancelled = false;
    const raw = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(270000))); }, cancel() { cancelled = true; } }), { headers: { "content-type": contentType } });
    const inspected = inspectRouteweaveUpstream(raw, null, true);
    await assert.rejects(inspected.response.text(), /too large/);
    assert.equal(cancelled, true);
    assert.equal(inspected.state.status, "failed");
  }
});

test("RouteWeave preserves refusal and content-filter no-retry behavior without reporting success", async () => {
  for (const payload of [{ choices: [{ message: { refusal: "No" }, finish_reason: "content_filter" }] },
    { content: [], stop_reason: "refusal" }]) {
    const h = harness();
    h.options.dispatch = async (_, id) => { h.calls.push(id); return Response.json(payload); };
    await (await handleRouteweaveCombo(h.options)).text();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1);
    assert.equal(h.outcomes[0]?.status, "failed");
  }
  const h = harness({ body: { ...body, stream: true } });
  h.options.dispatch = async (_, id) => { h.calls.push(id); return new Response('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); };
  await (await handleRouteweaveCombo(h.options)).text();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.outcomes[0]?.status, "failed");
});

test("RouteWeave bounds the pre-content SSE prefix without changing native refusal handling", async () => {
  const h = harness({ body: { ...body, stream: true } });
  h.options.dispatch = async (_, id) => { h.calls.push(id); return id === models[0] ? new Response('data: {"padding":"' + "x".repeat(270000) + '"}\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json(answer); };
  assert.match(await (await handleRouteweaveCombo(h.options)).text(), /healthy/);
  assert.deepEqual(h.calls, models);
  const refusal = { choices: [{ message: { refusal: "No" }, finish_reason: "content_filter" }] };
  const calls = [];
  const native = await handleComboChat({ body, models, log, handleSingleModel: async (_, id) => { calls.push(id); return Response.json(refusal); } });
  assert.deepEqual(await native.json(), refusal);
  // Native behavior is deliberately retained, rather than applying RouteWeave's strict validator.
  assert.ok(calls.length >= 1);
});

test("System One abort during credential lookup prevents refresh after lookup returns", async () => {
  const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  globalThis.boundaryRefreshes = 0;
  globalThis.boundaryCredentials = () => new Promise(resolve => { release = resolve; entered(); });
  const controller = new AbortController();
  const pending = handleSystemone(new Request("http://localhost/v1/systemone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/a", state: "hello", questions: { a: "answer" } }), signal: controller.signal }));
  await started;
  controller.abort();
  assert.equal((await pending).status, 499);
  release({ apiKey: "test", connectionId: "test" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalThis.boundaryRefreshes, 0);
});

test("real DefaultExecutor checks expiry before initial fetch and retries; retry waits abort promptly", async () => {
  const executor = new DefaultExecutor("openai");
  executor.config = { ...executor.config, retry: { 503: { attempts: 1, delayMs: 1000 } } };
  const args = { model: "a", body, stream: false, credentials: { apiKey: "test" }, log };
  let calls = 0, cancelledBodies = 0;
  const retryResponse = () => new Response(new ReadableStream({ cancel() { cancelledBodies++; } }), { status: 503 });
  globalThis.routeweaveBoundaryFetch = async () => { calls++; return retryResponse(); };
  await assert.rejects(executor.execute({ ...args, routeweaveExpiresAt: Date.now() - 1 }), /expired/);
  assert.equal(calls, 0);
  await assert.rejects(executor.execute({ ...args, routeweaveExpiresAt: Date.now() + 30 }));
  assert.equal(calls, 1);
  assert.equal(cancelledBodies, 1);
  const controller = new AbortController();
  globalThis.routeweaveBoundaryFetch = async () => { calls++; controller.abort(); return retryResponse(); };
  const started = Date.now();
  await assert.rejects(executor.execute({ ...args, signal: controller.signal }));
  assert.ok(Date.now() - started < 500);
  assert.equal(calls, 2);
  assert.equal(cancelledBodies, 2);
});

test("service decisions and outcomes enforce TLS and DNS-bypass guards through real proxy fetch", { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => globalThis.boundaryFetch(...args);
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  try {
  const rule = { text: true, tokens_per_byte: 1, template_tokens: 100, context_tokens: 10000, max_output_tokens: 1000 };
  for (const endpoint of ["decisions", "outcomes"]) {
    for (const transport of ["tls", "dns"]) {
      let calls = 0;
      let failure;
      const config = { url: "https://sidecar.test", token: "service-only", mode: "active_required", allowlist: Object.fromEntries(models.map(id => [id, rule])) };
      globalThis.boundaryFetch = async () => {
        calls++;
        throw Object.assign(Error("certificate rejected"), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
      };
      const response = await handleRouteweaveCombo({
        config, body: { model: "combo", messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false }, models, nativeOptions: { log }, resolveModel: async id => ({ provider: "openai", model: id.split("/")[1] }),
        runCombo: handleComboChat, dispatch: async () => Response.json(answer),
        fetchImpl: async (url, init) => {
          const request = JSON.parse(init.body);
          if (!url.endsWith(endpoint)) return Response.json({ decision_id: "d", request_id: request.request_id, mode: request.mode, candidate_snapshot_id: request.candidate_snapshot_id, policy_revision: "p", status: "ranked", ranking: request.candidates.map(c => ({ candidate_id: c.id, score: 1 })), expires_at: new Date(Date.now() + 30000).toISOString() });
          try {
            assert.equal(init.strictTls, true);
            assert.equal(init.routeweave, true);
            return await proxyAwareFetch(transport === "dns" ? "https://cloudcode-pa.googleapis.com/v1/test" : url, init);
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      });
      const responseBody = await response.text();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(failure, `${endpoint}/${transport}: expected transport failure, got ${response.status}: ${responseBody}`);
      assert.match(failure.message, transport === "tls" ? /certificate rejected/ : /DNS bypass/);
      assert.equal(calls, transport === "tls" ? 1 : 0);
      assert.equal(response.status, endpoint === "decisions" ? 503 : 200);
    }
  }
  } finally { globalThis.fetch = originalFetch; }
});

test("all RouteWeave attempts reject manual DNS bypass even without decision expiry", async () => {
  let calls = 0; globalThis.boundaryFetch = async () => { calls++; return Response.json(answer); };
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  await assert.rejects(proxyAwareFetch("https://cloudcode-pa.googleapis.com/v1/test", { routeweave: true }), /DNS bypass/);
  assert.equal(calls, 0);
});


test("bounded JSON, buffered SSE and oversized frames reject before EOF and cancel reader", async () => {
  for (const [contentType, buffered] of [["application/json", false], ["text/event-stream", true], ["text/event-stream", false]]) {
    let cancelled = false;
    const inspected = inspectRouteweaveUpstream(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(" ".repeat(270000))); }, cancel() { cancelled = true; } }), { headers: { "content-type": contentType } }), null, buffered);
    await assert.rejects(inspected.response.text(), /too large/);
    assert.equal(cancelled, true); assert.equal(inspected.state.status, "failed");
  }
  assert.equal((await checkRouteweaveJson(Response.json({ choices: [], padding: "x".repeat(270000) }))).valid, false);
});


test("cancellation during JSON validation cannot select a success or refusal", async () => {
  for (const payload of [answer, { choices: [{ message: { refusal: "No" }, finish_reason: "content_filter" }] }]) {
    const controller = new AbortController();
    let calls = 0, selected = 0;
    const response = new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
    }, pull(stream) { controller.abort(); stream.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    await assert.rejects(handleComboChat({ body, models, log, routeweave: true, externalOrder: true,
      signal: controller.signal, onSelected: () => { selected++; },
      handleSingleModel: async () => { calls++; return response; },
    }), /abort/i);
    assert.equal(selected, 0);
    assert.equal(calls, 1);
  }
});

test("cancellation during SSE peeking cancels the abandoned body without selecting HTTP 200", async () => {
  for (const routeweave of [true, false]) {
    const controller = new AbortController();
    let calls = 0, selected = 0, cancelled = false;
    const response = new Response(new ReadableStream({ pull(stream) {
      stream.enqueue(new TextEncoder().encode(text));
      controller.abort();
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    await assert.rejects(handleComboChat({ body, models, log, routeweave, externalOrder: true,
      signal: controller.signal, onSelected: () => { selected++; },
      handleSingleModel: async () => { calls++; return response; },
    }), /abort/i);
    assert.equal(cancelled, true);
    assert.equal(selected, 0);
    assert.equal(calls, 1);
  }
});

test("core maps Error-valued client cancellation to 499, not backend failure", async () => {
  const controller = new AbortController();
  globalThis.routeweaveBoundaryFetch = async () => { controller.abort(Error("client disconnected")); throw controller.signal.reason; };
  const result = await handleChatCore({ body: structuredClone(body), modelInfo: { provider: "openai", model: "a" }, credentials: { apiKey: "test" }, log, signal: controller.signal, routeweave: true });
  assert.equal(result.response.status, 499);
});
