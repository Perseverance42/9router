import { randomUUID } from "node:crypto";
import { observeResponse } from "../../../open-sse/services/routeweaveEvidence.js";
export { observeResponse } from "../../../open-sse/services/routeweaveEvidence.js";
import { assertRouteweaveRoute } from "../../../open-sse/services/routeweaveRoute.js";

import { resolveRouteweaveConfig } from "../../shared/utils/routeweaveSettings.mjs";
const MAX_BYTES = 256 * 1024;
const MAX_CANDIDATES = 32;
const DEFAULT_DECISION_TIMEOUT_MS = 35_000;
const FEEDBACK_TIMEOUT_MS = 1000;

function decisionTimeout(value = DEFAULT_DECISION_TIMEOUT_MS) {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) throw Error("RouteWeave decision timeout must be 100–60000 ms");
  return timeout;
}
let feedbackPending = 0;

function failure(message, status = 503) {
  return Response.json({ error: { type: "routeweave_error", message } }, { status });
}

// Called only after resolving the saved per-combo RouteWeave strategy.
export function readRouteweaveConfig(env = process.env, saved) {
  return resolveRouteweaveConfig(env, saved);
}

export function assertRouteweaveTransforms(settings, headers, provider) {
  const flags = ["rtkEnabled", "headroomEnabled", "cavemanEnabled", "ponytailEnabled"].map(key => settings[key]);
  const optOut = headers?.get?.("x-9router-token-saver")?.toLowerCase() === "off" ||
    Object.entries(headers || {}).some(([k, v]) => k.toLowerCase() === "x-9router-token-saver" && typeof v === "string" && v.toLowerCase() === "off");
  const thinkingMode = settings.providerThinking?.[provider]?.mode;
  if ((!optOut && flags.some(Boolean)) || settings.customPromptEnabled || settings.pxpipeEnabled || (thinkingMode && thinkingMode !== "auto"))
    throw Error("RouteWeave requires untransformed requests; disable effective token savers, custom prompt, PXPIPE and thinking for its candidates");
}

// Deliberately closed request vocabulary: unknown workflow extensions must not become text classifications.
export function normalizeText(body) {
  const allowed = new Set(["model", "messages", "system", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "stop", "stop_sequences", "n"]);
  if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== "object" || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== "include_usage") || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean"))) throw Error("Unsupported RouteWeave stream options");
  if (Object.keys(body).some(k => !allowed.has(k)) || (body.n !== undefined && body.n !== 1)) throw Error("RouteWeave supports plain text requests only; tools, media, continuity and extensions are unsupported");
  const text = content => {
    if (typeof content === "string") return content;
    if (Array.isArray(content) && content.every(p => p && Object.keys(p).every(k => ["type", "text"].includes(k)) && p.type === "text" && typeof p.text === "string")) return content.map(p => p.text).join("");
    throw Error("Unsupported RouteWeave content shape");
  };
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw Error("Invalid RouteWeave transcript");
  const messages = body.messages.map(m => {
    if (!m || Object.keys(m).some(k => !["role", "content"].includes(k)) || !["system", "developer", "user", "assistant"].includes(m.role)) throw Error("Unsupported RouteWeave message");
    return { role: m.role, content: text(m.content) };
  });
  if (body.system !== undefined) messages.unshift({ role: "system", content: text(body.system) });
  if (messages.at(-1).role !== "user" || !messages.at(-1).content.trim()) throw Error("RouteWeave requires a nonempty final user message");
  if (messages.filter(m => m.role === "user").length > 128) throw Error("Too many RouteWeave user messages");
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw Error("RouteWeave input too large");
  return messages;
}

export function admitModels(body, models, allowlist) {
  if (!models.length || models.length > MAX_CANDIDATES || new Set(models).size !== models.length) throw Error("Invalid RouteWeave candidate pool");
  const output = body.max_tokens;
  if (!Number.isSafeInteger(output) || output <= 0 || (body.max_completion_tokens !== undefined && body.max_completion_tokens !== output)) throw Error("RouteWeave requires positive max_tokens and matching max_completion_tokens when supplied");
  const bytes = Buffer.byteLength(JSON.stringify(body));
  let input = 0;
  const admitted = models.filter(id => {
    const rule = Object.hasOwn(allowlist, id) ? allowlist[id] : null;
    if (!rule) return false;
    // Operator certifies tokenizer/template bounds for this exact execution route. No capability defaults.
    if (rule.text !== true || !Number.isFinite(rule.tokens_per_byte) || rule.tokens_per_byte <= 0 || !Number.isSafeInteger(rule.template_tokens) || rule.template_tokens < 0 || !Number.isSafeInteger(rule.context_tokens) || rule.context_tokens <= 0 || !Number.isSafeInteger(rule.max_output_tokens) || rule.max_output_tokens <= 0) throw Error("Invalid authoritative RouteWeave model limits");
    const estimate = Math.ceil(bytes * rule.tokens_per_byte) + rule.template_tokens;
    if (!Number.isSafeInteger(estimate)) throw Error("Invalid RouteWeave token bound");
    if (estimate + output > rule.context_tokens || output > rule.max_output_tokens) return false;
    input = Math.max(input, estimate);
    return true;
  });
  if (!admitted.length) throw Error("No RouteWeave candidate satisfies authoritative limits");
  return { models: admitted, input, output };
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); throw signal.reason; }
  let abort;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  })]); } finally { signal.removeEventListener("abort", abort); }
}

async function readBounded(response, signal, limit = MAX_BYTES) {
  if (!response.body) throw Error("Empty RouteWeave response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("RouteWeave response too large");
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export function validateDecision(d, request, now = Date.now()) {
  const ids = request.candidates.map(c => c.id);
  const order = Array.isArray(d?.ranking) ? d.ranking.map(r => r?.candidate_id) : null;
  const expiry = Date.parse(d?.expires_at);
  if (d?.request_id !== request.request_id || d?.mode !== request.mode || d?.candidate_snapshot_id !== request.candidate_snapshot_id || typeof d?.decision_id !== "string" || !d.decision_id.length || d.decision_id.length > 256 || typeof d.policy_revision !== "string" || !d.policy_revision.length || d.status !== "ranked" || !Number.isFinite(expiry) || expiry <= now || expiry > now + 60_000 || !Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some(id => !ids.includes(id)) || d.ranking.some(r => !Number.isFinite(r.score))) throw Error("Invalid or expired RouteWeave decision");
  return order;
}

function post(config, endpoint, payload, signal, fetchImpl) {
  return fetchImpl(`${config.url}/v1/${endpoint}`, { method: "POST", redirect: "error", strictTls: true, routeweave: true, headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify(payload), signal });
}

function feedback(config, payload, fetchImpl) {
  // ponytail: bounded best-effort in-memory delivery (32); add durable delivery only when required.
  if (feedbackPending >= 32) { console.warn("RouteWeave outcome queue full"); return; }
  feedbackPending++;
  void post(config, "outcomes", payload, AbortSignal.timeout(FEEDBACK_TIMEOUT_MS), fetchImpl)
    .then(async r => { await r.body?.cancel(); if (!r.ok) console.warn("RouteWeave outcome rejected", r.status); })
    .catch(() => console.warn("RouteWeave outcome delivery failed"))
    .finally(() => { feedbackPending--; });
}

export async function handleRouteweaveCombo({ config, body, models, signal, nativeOptions, runCombo, dispatch, resolveModel, fetchImpl = fetch }) {
  const started = Date.now();
  let pool, messages;
  try {
    messages = normalizeText(body);
    pool = admitModels(body, models, config.allowlist);
    for (const id of pool.models) {
      if (typeof id !== "string" || /\([^()]+\)\s*$/.test(id)) throw Error("RouteWeave excludes thinking suffixes");
      const resolved = await resolveModel(id);
      if (typeof id !== "string" || !id.includes("/") || !resolved?.provider) throw Error("RouteWeave requires flat concrete model routes");
      assertRouteweaveRoute(resolved, null, body);
    }
    signal?.throwIfAborted();
  } catch (e) { return signal?.aborted ? failure("RouteWeave request cancelled", 499) : failure(e.message, 422); }
  const payload = { request_id: randomUUID(), mode: config.mode, context: { messages, hints: { input_modalities: ["text"], output_modalities: ["text"], tools_present: false } }, requirements: { estimated_input_tokens: pool.input, reserved_output_tokens: pool.output, required_features: [], continuity: "unlocked" }, candidate_snapshot_id: randomUUID(), candidates: pool.models.map(id => ({ id })) };
  let decision = null, order = pool.models;
  try {
    const budget = decisionTimeout(config.decisionTimeoutMs);
    const deadline = performance.now() + budget;
    const timeout = AbortSignal.timeout(budget);
    const decisionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const pending = post(config, "decisions", payload, decisionSignal, fetchImpl);
    pending.then(r => { if (decisionSignal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    const r = await abortable(pending, decisionSignal);
    if (!r.ok) { void r.body?.cancel().catch(() => {}); throw Error("RouteWeave unavailable"); }
    const d = await readBounded(r, decisionSignal);
    const ranking = validateDecision(d, payload);
    decisionSignal.throwIfAborted();
    if (performance.now() >= deadline) throw Error("RouteWeave decision timed out");
    order = ranking;
    decision = d;
  } catch {
    if (signal?.aborted) return failure("RouteWeave request cancelled", 499);
    console.warn("RouteWeave decision unavailable or invalid");
    if (config.mode === "active_required") return failure("RouteWeave decision unavailable or invalid");
  }
  const attempts = [];
  let selected = null;
  const report = status => {
    if (!decision) return;
    if (!attempts.length && status !== "cancelled") status = "not_executed";
    else if (status === "succeeded" && !selected) status = "failed";
    const served = status === "succeeded" ? selected : null;
    feedback(config, { decision_id: decision.decision_id, mode: config.mode, status, attempts: attempts.map((a, i) => {
      const attemptStatus = a.candidate_id === selected || (status === "cancelled" && i === attempts.length - 1) ? status : "failed";
      return { candidate_id: a.candidate_id, status: attemptStatus, ...(attemptStatus === "failed" ? { category: a.category || (a.candidate_id === selected ? "provider_error" : "empty_generation") } : {}) };
    }), served_candidate_id: served, latency_ms: Date.now() - started, fallback_used: attempts.length > 1 }, fetchImpl);
  };
  if (signal?.aborted) { report("cancelled"); return failure("RouteWeave request cancelled", 499); }
  try {
    const external = config.mode !== "shadow";
    // Advisory failures stay within the admitted pool and never invoke the native paid smart classifier.
    const response = await runCombo({ ...nativeOptions, body, signal, routeweave: true, models: external ? order : pool.models, comboStrategy: "fallback", externalOrder: true, autoSwitch: false, sessionId: null, resolveSmartChoice: null, onSelected: id => { selected = id; }, handleSingleModel: async (b, id) => {
      if (signal?.aborted) throw Error("Request cancelled");
      if (!pool.models.includes(id) || attempts.length >= MAX_CANDIDATES) throw Error("RouteWeave dispatch outside admitted pool");
      if (decision && config.mode !== "shadow" && Date.parse(decision.expires_at) <= Date.now()) throw Error("RouteWeave decision expired before dispatch");
      // Recheck immutable admission immediately before each fallback.
      admitModels(b, [id], config.allowlist);
      const attempt = { candidate_id: id };
      attempts.push(attempt);
      try {
        const expiresAt = decision && external ? Date.parse(decision.expires_at) : null;
        const response = await dispatch(b, id, { signal, expiresAt });
        if (!response.ok) attempt.category = response.status === 429 ? "rate_limit" : response.status === 408 || response.status === 504 ? "timeout" : response.status === 503 ? "temporarily_unavailable" : response.status >= 400 && response.status < 500 ? "incompatibility" : "provider_error";
        return response;
      } catch (error) {
        attempt.category = error?.name === "TimeoutError" ? "timeout" : "transport_failure";
        throw error;
      }
    } });
    return observeResponse(response, signal, report);
  } catch { report(signal?.aborted ? "cancelled" : attempts.length ? "failed" : "not_executed"); return failure(signal?.aborted ? "RouteWeave request cancelled" : "RouteWeave completion failed", signal?.aborted ? 499 : 503); }
}
