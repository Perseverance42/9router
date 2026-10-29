import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readRouteweaveConfig, normalizeText, admitModels, validateDecision, observeResponse, handleRouteweaveCombo } from "../../src/sse/services/routeweave.mjs";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { assertRouteweaveRoute } from "../../open-sse/services/routeweaveRoute.js";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

const models = ["openai/a", "openai/b"];
const rule = { text: true, tokens_per_byte: 1, template_tokens: 100, context_tokens: 10000, max_output_tokens: 1000 };
const body = { model: "opt-in", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
const config = { url: "http://sidecar", token: "service-only", mode: "active_required", allowlist: Object.fromEntries(models.map(m => [m, rule])) };
const log = { info() {}, warn() {}, debug() {} };
const answer = () => Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });
const decisionFor = p => ({ decision_id: "dec", request_id: p.request_id, mode: p.mode, candidate_snapshot_id: p.candidate_snapshot_id, policy_revision: "p1", status: "ranked", ranking: [...p.candidates].reverse().map(c => ({ candidate_id: c.id, score: 1 })), expires_at: new Date(Date.now() + 30000).toISOString() });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(mode = "active_required", override = {}) {
  const dispatched = [], outcomes = [], payloads = [];
  const options = {
    config: { ...config, mode }, body: structuredClone(body), models,
    nativeOptions: { log, comboStrategy: "smart", comboName: "opt-in", sessionId: "native-sticky", resolveSmartChoice: () => { throw Error("paid classifier must not run"); } },
    resolveModel: async id => ({ provider: id.split("/")[0] }),
    runCombo: handleComboChat,
    dispatch: async (b, id) => { dispatched.push(id); return answer(); },
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.authorization, "Bearer service-only");
      assert.equal(init.redirect, "error");
      const p = JSON.parse(init.body);
      if (url.endsWith("decisions")) { payloads.push(p); return Response.json(decisionFor(p)); }
      outcomes.push(p); return Response.json({ ok: true });
    }, ...override,
  };
  return { options, dispatched, outcomes, payloads };
}

test("disabled configuration is inert; opt-in needs explicit server secrets and allowlist", () => {
  assert.equal(readRouteweaveConfig("other", {}), null);
  assert.throws(() => readRouteweaveConfig("opt-in", { ROUTEWEAVE_COMBOS: "opt-in" }));
  const c = readRouteweaveConfig("opt-in", { ROUTEWEAVE_COMBOS: "opt-in", ROUTEWEAVE_URL: "http://localhost:9090", ROUTEWEAVE_MODE: "shadow", ROUTEWEAVE_SERVICE_TOKEN: "private", ROUTEWEAVE_ALLOWLIST: JSON.stringify(config.allowlist) });
  assert.equal(c.token, "private");
  assert.equal(c.decisionTimeoutMs, 35000);
  const env = { ROUTEWEAVE_COMBOS: "opt-in", ROUTEWEAVE_URL: c.url, ROUTEWEAVE_MODE: "active_required", ROUTEWEAVE_SERVICE_TOKEN: c.token, ROUTEWEAVE_ALLOWLIST: JSON.stringify(c.allowlist) };
  for (const timeout of ["", "0", "99", "60001", "1.5", "NaN", "Infinity"]) assert.throws(() => readRouteweaveConfig("opt-in", { ...env, ROUTEWEAVE_DECISION_TIMEOUT_MS: timeout }));
  assert.equal(readRouteweaveConfig("opt-in", { ...env, ROUTEWEAVE_DECISION_TIMEOUT_MS: "60000" }).decisionTimeoutMs, 60000);
  assert.throws(() => readRouteweaveConfig("opt-in", { ...env, ROUTEWEAVE_MODE: "unsupported" }));
});

test("normalizes text OpenAI and Claude only; rejects tools/media/continuity/extensions", () => {
  assert.deepEqual(normalizeText(body), body.messages);
  const developer = { role: "developer", content: "plain text instructions" };
  assert.deepEqual(normalizeText({ ...body, messages: [developer, ...body.messages] }), [developer, ...body.messages]);
  for (const messages of [[{ role: "user", content: " " }], [...body.messages, { role: "assistant", content: "prefill" }], Array.from({ length: 129 }, () => body.messages[0])]) assert.throws(() => normalizeText({ ...body, messages }));
  assert.deepEqual(normalizeText({ ...body, system: [{ type: "text", text: "system" }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), [{ role: "system", content: "system" }, { role: "user", content: "hi" }]);
  for (const extra of [{ tools: [] }, { previous_response_id: "x" }, { input: "x" }, { response_format: {} }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }] }, { messages: [{ role: "assistant", content: "x", tool_calls: [] }] }]) assert.throws(() => normalizeText({ ...body, ...extra }));
});

test("authoritative admission excludes unlisted and context-ineligible routes, never infers capabilities", () => {
  assert.deepEqual(admitModels(body, models, { [models[0]]: rule }).models, [models[0]]);
  assert.deepEqual(admitModels(body, models, { [models[0]]: { ...rule, context_tokens: 1 }, [models[1]]: rule }).models, [models[1]]);
  assert.throws(() => admitModels(body, models, {}));
  assert.throws(() => admitModels(body, models, { [models[0]]: { context_tokens: 10000 } }));
  assert.throws(() => admitModels({ ...body, max_tokens: undefined }, models, config.allowlist));
  assert.throws(() => admitModels({ ...body, max_tokens: undefined, max_completion_tokens: 100 }, models, config.allowlist));
  assert.throws(() => admitModels({ ...body, max_completion_tokens: 200 }, models, config.allowlist));
  assert.equal(admitModels({ ...body, max_completion_tokens: 100 }, models, config.allowlist).output, 100);
});

test("canonical route admission excludes Codex, resolved aliases, custom executors and Responses", async () => {
  for (const provider of ["codex", "cx", "openai-compatible-chat-private", "openai-compatible-responses-private", "opencode", "opencode-go", "gemini", "cursor"]) {
    const h = harness("active_required", { resolveModel: async () => ({ provider, model: "test" }) });
    assert.equal((await handleRouteweaveCombo(h.options)).status, 422);
    assert.equal(h.payloads.length, 0);
    assert.equal(h.dispatched.length, 0);
  }
  // Alias labels cannot hide the canonical provider returned by the gateway resolver.
  const alias = harness("active_required", { models: ["openai/friendly-alias"], resolveModel: async () => ({ provider: "codex", model: "gpt-5" }) });
  assert.equal((await handleRouteweaveCombo(alias.options)).status, 422);
  assert.equal(alias.dispatched.length, 0);
  for (const provider of ["openai", "anthropic"]) {
    assert.doesNotThrow(() => assertRouteweaveRoute({ provider, model: "text-model" }));
    assert.throws(() => assertRouteweaveRoute({ provider, model: "text-model" }, "openai-responses"));
    assert.throws(() => assertRouteweaveRoute({ provider, model: "text-model" }, "gemini"));
  }
});

test("decision validation binds request, mode, snapshot, expiry and complete permutation", () => {
  const p = { request_id: "req", mode: "active_required", candidate_snapshot_id: "pool", candidates: models.map(id => ({ id })) };
  const d = decisionFor(p);
  assert.deepEqual(validateDecision(d, p), [...models].reverse());
  for (const extra of [{ request_id: "other" }, { mode: "shadow" }, { candidate_snapshot_id: "other" }, { policy_revision: null }, { decision_id: "" }, { expires_at: new Date(0).toISOString() }, { ranking: [{ candidate_id: models[0], score: 1 }] }, { ranking: models.map(() => ({ candidate_id: models[0], score: 1 })) }, { ranking: [{ candidate_id: models[0], score: Infinity }, { candidate_id: models[1], score: 1 }] }]) assert.throws(() => validateDecision({ ...d, ...extra }, p));
});

test("active_required executes external order, bypasses native smart routing and reports actual serving route", async () => {
  const h = harness();
  const r = await handleRouteweaveCombo(h.options);
  assert.equal(h.outcomes.length, 0);
  await r.text(); await tick();
  assert.deepEqual(h.dispatched, [models[1]]);
  assert.equal(h.payloads.length, 1);
  assert.match(h.payloads[0].request_id, /^[\da-f-]{36}$/);
  assert.equal(h.payloads[0].context.hints.tools_present, false);
  assert.equal(h.outcomes[0].status, "succeeded");
  assert.equal(h.outcomes[0].served_candidate_id, models[1]);
  assert.equal(h.outcomes[0].mode, "active_required");
});

test("fallback and all attempts stay in admitted pool and preserve external order", async () => {
  const h = harness();
  h.options.dispatch = async (b, id) => { h.dispatched.push(id); return id === models[1] ? Response.json({ error: "unsupported parameter" }, { status: 400 }) : answer(); };
  const r = await handleRouteweaveCombo(h.options); await r.text(); await tick();
  assert.deepEqual(h.dispatched, [...models].reverse());
  assert.deepEqual(h.outcomes[0].attempts, [{ candidate_id: models[1], status: "failed", category: "incompatibility" }, { candidate_id: models[0], status: "succeeded" }]);
  assert.equal(h.outcomes[0].fallback_used, true);
  const limited = harness("active_advisory", { config: { ...config, mode: "active_advisory", allowlist: { [models[0]]: rule } } });
  limited.options.fetchImpl = async () => { throw Error("down"); };
  await (await handleRouteweaveCombo(limited.options)).text();
  assert.deepEqual(limited.dispatched, [models[0]]);
});

test("active_required fails before dispatch on sidecar failure; advisory skips native classifier", async () => {
  for (const mode of ["active_required", "active_advisory"]) {
    const h = harness(mode, { fetchImpl: async () => { throw Error("down"); } });
    const r = await handleRouteweaveCombo(h.options); await r.text();
    assert.deepEqual(h.dispatched, mode === "active_required" ? [] : [models[0]]);
    assert.equal(r.status, mode === "active_required" ? 503 : 200);
  }
});

test("sidecar wait is bounded and aborts before active_required dispatch", async () => {
  let aborted = false;
  const h = harness("active_required", { config: { ...config, decisionTimeoutMs: 100 }, fetchImpl: async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(init.signal.reason); }, { once: true });
  }) });
  // AbortSignal.timeout is unref'ed; keep the test process alive while it fires.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const started = Date.now();
    const r = await handleRouteweaveCombo(h.options);
    assert.equal(r.status, 503); assert.equal(aborted, true);
    assert.ok(Date.now() - started < 2000); assert.equal(h.dispatched.length, 0);
  } finally { clearTimeout(keepAlive); }
});

test("shadow records native order rather than recommendation; still hard-admitted", async () => {
  const h = harness("shadow");
  h.options.nativeOptions = { log, comboStrategy: "fallback" };
  await (await handleRouteweaveCombo(h.options)).text(); await tick();
  assert.deepEqual(h.dispatched, [models[0]]);
  assert.equal(h.outcomes[0].served_candidate_id, models[0]);
  assert.equal(h.outcomes[0].mode, "shadow");
});

test("unsupported requests, nested/fusion and invalid limits visibly fail closed in every mode", async () => {
  for (const mode of ["active_required", "shadow", "active_advisory"]) {
    for (const extra of [{ body: { ...body, tools: [] } }, { nativeOptions: { log, comboStrategy: "fusion" } }, { resolveModel: async () => ({ provider: null }) }, { config: { ...config, mode, allowlist: {} } }]) {
      const h = harness(mode, extra);
      const r = await handleRouteweaveCombo(h.options);
      assert.equal(r.status, 422); assert.equal(h.dispatched.length, 0); assert.equal(h.payloads.length, 0);
    }
  }
});

async function observed(chunks, { cancel = false, error = false, signal } = {}) {
  const statuses = [];
  const encoder = new TextEncoder();
  const source = new ReadableStream({ start(c) { chunks.forEach(s => c.enqueue(encoder.encode(s))); if (error) c.error(Error("broken")); else c.close(); } });
  const r = observeResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), signal, s => statuses.push(s));
  assert.equal(statuses.length, signal?.aborted ? 1 : 0);
  if (cancel) await r.body.cancel(); else await r.text().catch(() => {});
  return statuses;
}
const textEvent = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';

test("SSE success needs usable text plus terminal; EOF/empty/error/cancellation are not success", async () => {
  const finishEvent = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  assert.deepEqual(await observed([textEvent, finishEvent, "data: [DONE]\n\n"]), ["succeeded"]);
  assert.deepEqual(await observed([textEvent, "data: [DONE]\n\n"]), ["failed"]);
  assert.deepEqual(await observed([textEvent]), ["failed"]);
  assert.deepEqual(await observed([textEvent, "data: [DONE]\n\n", 'data: {"error":']), ["failed"]);
  assert.deepEqual(await observed(["data: [DONE]\n\n"]), ["failed"]);
  assert.deepEqual(await observed([textEvent, 'data: {"error":{"message":"failure"}}\n\n', "data: [DONE]\n\n"]), ["failed"]);
  assert.deepEqual(await observed([textEvent], { error: true }), ["failed"]);
  assert.deepEqual(await observed([textEvent, "data: [DONE]\n\n"], { cancel: true }), ["cancelled"]);
  assert.deepEqual(await observed([textEvent, "data: [DONE]\n\n"], { signal: AbortSignal.abort() }), ["cancelled"]);
  assert.deepEqual(await observed(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\r', '\n\r\n', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n', 'data: {"type":"message_stop"}\r\n\r\n']), ["succeeded"]);
  assert.deepEqual(await observed(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n', 'data: {"type":"message_stop"}\n\n']), ["failed"]);
});

test("stream outcome reports downstream cancellation, not a premature 200 success", async () => {
  const h = harness();
  h.options.dispatch = async () => new Response(`${textEvent}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  const r = await handleRouteweaveCombo(h.options);
  assert.equal(h.outcomes.length, 0);
  await r.body.cancel(); await tick();
  assert.equal(h.outcomes[0].status, "cancelled");
  assert.equal(h.outcomes[0].served_candidate_id, null);
  assert.equal(h.outcomes[0].attempts[0].status, "cancelled");
});

test("explicit max_tokens reaches every actual dispatch; completion-only/conflicting limits fail closed", async () => {
  const h = harness();
  h.options.dispatch = async b => { assert.equal(b.max_tokens, 100); return answer(); };
  await (await handleRouteweaveCombo(h.options)).text();
  for (const limits of [{ max_tokens: undefined, max_completion_tokens: 100 }, { max_tokens: 100, max_completion_tokens: 200 }]) {
    const invalid = harness("active_required", { body: { ...body, ...limits } });
    assert.equal((await handleRouteweaveCombo(invalid.options)).status, 422);
    assert.equal(invalid.dispatched.length, 0);
    assert.equal(invalid.payloads.length, 0);
  }
});

test("prefill cancellation reaches executor signal and stops all combo fallback", async () => {
  const controller = new AbortController();
  const h = harness("active_required", { signal: controller.signal });
  let attempts = 0, upstreamAborted = false;
  h.options.dispatch = async () => {
    attempts++;
    const streamController = createStreamController({ signal: controller.signal });
    const pending = new Promise((resolve, reject) => streamController.signal.addEventListener("abort", () => { upstreamAborted = true; reject(streamController.signal.reason); }, { once: true }));
    controller.abort();
    return pending;
  };
  const response = await handleRouteweaveCombo(h.options);
  await response.text(); await tick();
  assert.equal(upstreamAborted, true);
  assert.equal(attempts, 1);
  assert.equal(h.outcomes[0].status, "cancelled");
  assert.equal(h.outcomes[0].attempts[0].status, "cancelled");
});

test("cancellation after credential-like nonabortable wait prevents dispatch/fallback", async () => {
  const controller = new AbortController();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let attempted = 0;
  const pending = handleComboChat({ body, models, log, externalOrder: true, signal: controller.signal, handleSingleModel: async () => {
    await wait;
    controller.signal.throwIfAborted();
    attempted++;
    return answer();
  } });
  controller.abort(); release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempted, 0);
});

test("request abort cancels observed reader and tears down upstream stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const statuses = [];
  const upstream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(textEvent)); }, cancel() { cancelled = true; } });
  const response = observeResponse(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), controller.signal, s => statuses.push(s));
  const reader = response.body.getReader();
  await reader.read();
  controller.abort(); await tick();
  assert.equal(cancelled, true);
  assert.deepEqual(statuses, ["cancelled"]);
  assert.equal((await reader.read()).done, true);
});

test("feedback failure never fails completion", async () => {
  const h = harness();
  const original = h.options.fetchImpl;
  h.options.fetchImpl = (url, init) => url.endsWith("outcomes") ? Promise.reject(Error("offline")) : original(url, init);
  const r = await handleRouteweaveCombo(h.options);
  assert.match(await r.text(), /answer/); await tick();
});

test("gateway decisions and terminal outcomes conform to the actual RouteWeave app", { timeout: 20000 }, async () => {
  const source = process.env.ROUTEWEAVE_TEST_SOURCE || "/home/coding-agent/git/routeweave";
  const bun = process.env.ROUTEWEAVE_TEST_BUN || "bun";
  const child = spawn(bun, ["run", fileURLToPath(new URL("./routeweave-app-fixture.ts", import.meta.url)), source], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  };
  try {
    assert.deepEqual(await next(), { ready: true });
    const replies = [], outcomes = [], sent = [], exchanges = [];
    const waitOutcomes = async count => {
      const deadline = Date.now() + 2000;
      while (outcomes.length < count && Date.now() < deadline) await tick();
      assert.ok(outcomes.length >= count, `Missing conformant outcome; ${stderr}`);
    };
    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(init.body);
      const request = { path: new URL(url).pathname, payload, headers: init.headers };
      sent.push(request);
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const reply = await next();
      assert.equal(reply.status, 200, JSON.stringify(reply));
      // Capture actual adapter JSON and actual app responses; never persist authorization headers.
      exchanges.push({ method: "POST", path: request.path, request: payload, response: reply });
      if (request.path.endsWith("outcomes")) outcomes.push(payload);
      else replies.push(reply.body);
      return Response.json(reply.body, { status: reply.status });
    };
    const failures = [
      async () => { throw Error("synthetic private transport detail"); },
      async () => Response.json({ error: "limited" }, { status: 429 }),
      async () => Response.json({ error: "unsupported" }, { status: 400 }),
      async () => Response.json({ choices: [{ message: { content: "" } }] }),
    ];
    const categories = ["transport_failure", "rate_limit", "incompatibility", "empty_generation"];
    for (const [i, failed] of failures.entries()) {
      const h = harness("active_required", { config: { ...config, token: "c".repeat(40) }, fetchImpl });
      h.options.dispatch = (b, id) => id === models[0] ? failed() : answer();
      const response = await handleRouteweaveCombo(h.options);
      assert.equal(response.status, 200);
      await response.text();
      await waitOutcomes(i + 1);
      assert.equal(outcomes[i].attempts[0].category, categories[i]);
      assert.equal(outcomes[i].attempts[1].status, "succeeded");
      assert.equal(Object.hasOwn(outcomes[i].attempts[1], "category"), false);
    }
    const h = harness("shadow", { config: { ...config, mode: "shadow", token: "c".repeat(40) }, fetchImpl, nativeOptions: { log, comboStrategy: "fallback" }, dispatch: async () => Response.json({ error: "unsupported" }, { status: 400 }) });
    const response = await handleRouteweaveCombo(h.options);
    assert.equal(response.status, 400);
    await response.text();
    await waitOutcomes(5);
    assert.equal(outcomes[4].status, "failed");
    assert.equal(outcomes[4].served_candidate_id, null);
    assert.ok(outcomes[4].attempts.every(a => a.status === "failed" && a.category === "incompatibility"));
    const cancelled = harness("active_required", { config: { ...config, token: "c".repeat(40) }, fetchImpl, dispatch: async () => new Response(`${textEvent}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    await (await handleRouteweaveCombo(cancelled.options)).body.cancel();
    await waitOutcomes(6);
    assert.equal(outcomes[5].status, "cancelled");
    assert.equal(Object.hasOwn(outcomes[5].attempts[0], "category"), false);
    assert.ok(replies.every(d => d.policy_revision && d.candidate_snapshot_id && d.ranking.length === 2));
    assert.ok(!JSON.stringify(sent.map(r => r.payload)).includes("synthetic private transport detail"));
    assert.ok(sent.every(r => Object.keys(r.headers).sort().join(",") === "authorization,content-type"));
    if (process.env.ROUTEWEAVE_CONTRACT_FIXTURES) writeFileSync(process.env.ROUTEWEAVE_CONTRACT_FIXTURES, `${JSON.stringify({ exchanges }, null, 2)}\n`, { mode: 0o600 });
  } finally {
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
  }
});

test("System One core propagates cancellation through provider fetch without retries", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let received;
  globalThis.fetch = async (url, init) => {
    received = init.signal;
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  try {
    const pending = handleSystemoneCore({ body: { state: "hello", questions: {} }, modelInfo: { provider: "ollama", model: "test" }, credentials: { providerSpecificData: { baseUrl: "http://local" } }, signal: controller.signal });
    await tick();
    assert.ok(received);
    controller.abort();
    const result = await pending;
    assert.equal(received.aborted, true);
    assert.equal(result.success, false);
  } finally { globalThis.fetch = original; }
});
