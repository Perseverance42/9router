const MODES = new Set(["shadow", "active_advisory", "active_required"]);
const FIELDS = ["url", "uiUrl", "token", "allowlist", "mode", "decisionTimeoutMs"];
const ENV_FIELDS = {
  url: "ROUTEWEAVE_URL", uiUrl: "ROUTEWEAVE_UI_URL", token: "ROUTEWEAVE_SERVICE_TOKEN",
  allowlist: "ROUTEWEAVE_ALLOWLIST", mode: "ROUTEWEAVE_MODE", decisionTimeoutMs: "ROUTEWEAVE_DECISION_TIMEOUT_MS",
};
const DEFAULTS = { url: "", uiUrl: "", mode: "active_required", decisionTimeoutMs: 35_000, allowlist: {} };
const LIMIT_FIELDS = ["text", "tokens_per_byte", "template_tokens", "context_tokens", "max_output_tokens"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function configUrl(value, browser = false) {
  const name = browser ? "UI URL" : "backend URL";
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw Error(`RouteWeave ${name} must be a valid HTTP/S URL`);
  let url;
  try { url = new URL(value); } catch { throw Error(`RouteWeave ${name} must be a valid HTTP/S URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /^[^:]+:\/\/[^/]*@/.test(value) || value.includes("?") || value.includes("#")) throw Error(`RouteWeave ${name} must not contain credentials, a query, or a fragment`);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!browser && url.protocol === "http:" && !loopback) throw Error("RouteWeave backend URL requires HTTPS except on loopback");
  return url.href.replace(/\/$/, "");
}

export function validateRouteweaveSettings(value) {
  if (!object(value) || Object.keys(value).some(key => !FIELDS.includes(key))) throw Error("RouteWeave configuration contains unsupported fields");
  const url = configUrl(value.url);
  const uiUrl = value.uiUrl === undefined || value.uiUrl === "" ? "" : configUrl(value.uiUrl, true);
  const mode = value.mode ?? DEFAULTS.mode;
  if (!MODES.has(mode)) throw Error("RouteWeave mode must be shadow, active_advisory, or active_required");
  if (typeof value.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value.token)) throw Error("RouteWeave service token is required and must contain printable non-space ASCII characters");
  const decisionTimeoutMs = value.decisionTimeoutMs ?? DEFAULTS.decisionTimeoutMs;
  if (!Number.isSafeInteger(decisionTimeoutMs) || decisionTimeoutMs < 100 || decisionTimeoutMs > 60_000) throw Error("RouteWeave decision timeout must be 100–60000 ms");
  if (!object(value.allowlist) || !Object.keys(value.allowlist).length || Object.keys(value.allowlist).length > 256) throw Error("RouteWeave allowlist must contain 1–256 model entries");
  for (const [id, rule] of Object.entries(value.allowlist)) {
    if (!/^[^\s/]+\/[^\s]+$/.test(id) || id.length > 256 || !object(rule) || Object.keys(rule).length !== LIMIT_FIELDS.length || Object.keys(rule).some(key => !LIMIT_FIELDS.includes(key)) ||
        rule.text !== true || !Number.isFinite(rule.tokens_per_byte) || rule.tokens_per_byte <= 0 ||
        !Number.isSafeInteger(rule.template_tokens) || rule.template_tokens < 0 ||
        !Number.isSafeInteger(rule.context_tokens) || rule.context_tokens <= 0 ||
        !Number.isSafeInteger(rule.max_output_tokens) || rule.max_output_tokens <= 0) throw Error("RouteWeave allowlist entries require a model route and valid authoritative text/token limits");
  }
  return { url, uiUrl, token: value.token, allowlist: value.allowlist, mode, decisionTimeoutMs };
}

export function resolveRouteweaveConfig(env = process.env, saved) {
  if (saved !== undefined && saved !== null) return validateRouteweaveSettings(saved);
  let allowlist;
  try { allowlist = JSON.parse(env.ROUTEWEAVE_ALLOWLIST || "null"); } catch { throw Error("RouteWeave environment allowlist must be valid JSON"); }
  return validateRouteweaveSettings({
    url: env.ROUTEWEAVE_URL, uiUrl: env.ROUTEWEAVE_UI_URL, token: env.ROUTEWEAVE_SERVICE_TOKEN,
    allowlist, mode: env.ROUTEWEAVE_MODE || DEFAULTS.mode,
    decisionTimeoutMs: env.ROUTEWEAVE_DECISION_TIMEOUT_MS === undefined ? DEFAULTS.decisionTimeoutMs : Number(env.ROUTEWEAVE_DECISION_TIMEOUT_MS),
  });
}

// Never echo malformed input: URLs or allowlist values can themselves contain secrets.
export function publicRouteweaveSettings(env = process.env, saved) {
  const source = saved !== undefined && saved !== null ? "settings" : "env";
  const overriddenFields = source === "settings" ? Object.entries(ENV_FIELDS).filter(([, key]) => env[key] !== undefined).map(([field]) => field) : [];
  const base = { ...DEFAULTS, allowlist: {}, hasToken: false, source, overriddenFields };
  if (source === "env" && !Object.values(ENV_FIELDS).some(key => env[key] !== undefined && env[key] !== "")) return { ...base, status: "missing" };
  try {
    const { token, ...config } = resolveRouteweaveConfig(env, saved);
    return { ...config, hasToken: !!token, source, overriddenFields, status: "configured" };
  } catch (error) {
    return { ...base, status: "invalid", error: error.message };
  }
}

export function maskRouteweaveSettings(settings) {
  const { routeweave, ...rest } = settings;
  if (routeweave === undefined) return rest;
  // General settings never return this nested secret, including malformed historical values.
  return { ...rest, routeweave: routeweave === null ? null : publicRouteweaveSettings({}, routeweave) };
}
