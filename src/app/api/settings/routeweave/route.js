import { getSettings, updateSettings } from "@/lib/localDb";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { publicRouteweaveSettings, validateRouteweaveSettings } from "@/shared/utils/routeweaveSettings.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = { "Cache-Control": "no-store" };
const json = (body, status = 200) => Response.json(body, { status, headers });

export async function GET() {
  let state;
  try {
    const settings = await getSettings();
    state = publicRouteweaveSettings(process.env, settings.routeweave);
  } catch {
    return json({ error: "Unable to read RouteWeave settings" }, 500);
  }
  if (state.status !== "configured") return json(state);
  try {
    // Readiness never needs the service token; redirects cannot change the destination.
    const response = await proxyAwareFetch(`${state.url}/health/ready`, {
      method: "GET", redirect: "error", cache: "no-store", strictTls: true, routeweave: true,
      signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return json({ ...state, status: "not_ready" });
    }
    // Bound the unauthenticated probe; an unrelated HTTP 200 is not readiness.
    const reader = response.body?.getReader();
    if (!reader) return json({ ...state, status: "not_ready" });
    let text = "", bytes = 0;
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) throw Error("Readiness response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return json({ ...state, status: JSON.parse(text).status === "ready" ? "ready" : "not_ready" });
    } finally { void reader.cancel().catch(() => {}); }
  } catch {
    return json({ ...state, status: "unreachable", error: "RouteWeave readiness check failed or timed out" });
  }
}

export async function PUT(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "RouteWeave configuration must be valid JSON" }, 400); }
  let settings;
  try { settings = await getSettings(); } catch { return json({ error: "Unable to read RouteWeave settings" }, 500); }
  let config;
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("RouteWeave configuration must be an object");
    const currentToken = settings.routeweave == null ? process.env.ROUTEWEAVE_SERVICE_TOKEN : settings.routeweave.token;
    config = validateRouteweaveSettings({ ...body, token: body.token === "" ? currentToken : body.token });
  } catch (error) { return json({ error: error.message }, 400); }
  try {
    await updateSettings({ routeweave: config });
    return json(publicRouteweaveSettings(process.env, config));
  } catch { return json({ error: "Unable to save RouteWeave settings" }, 500); }
}

export async function DELETE() {
  try {
    // A null value removes the saved override without replacing other settings.
    await updateSettings({ routeweave: null });
    return json(publicRouteweaveSettings(process.env));
  } catch { return json({ error: "Unable to clear RouteWeave settings" }, 500); }
}
