import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { getTargetFormat } from "./provider.js";

export function assertRouteweaveRoute({ provider, model }, executionFormat = null, body = null) {
  if (typeof model === "string" && /\([^()]+\)\s*$/.test(model)) throw Error("RouteWeave excludes thinking suffixes");
  // ponytail: only these registry routes use the inspected DefaultExecutor; audit others before admission.
  if (!["openai", "anthropic"].includes(provider)) throw Error("RouteWeave supports canonical openai/anthropic routes only; Codex and custom executors are excluded");
  const format = executionFormat || getModelTargetFormat(PROVIDER_ID_TO_ALIAS[provider] || provider, model) || getTargetFormat(provider);
  if (!["openai", "claude"].includes(format)) throw Error("RouteWeave excludes Responses and unverified upstream protocols");
  if (format === "claude" && body?.messages?.some(m => m.role === "developer")) throw Error("RouteWeave excludes developer instructions on Claude routes");
}

export function assertRouteweaveDispatch(expiresAt, signal) {
  signal?.throwIfAborted();
  if (expiresAt != null && expiresAt <= Date.now()) throw Error("RouteWeave decision expired before upstream fetch");
}
