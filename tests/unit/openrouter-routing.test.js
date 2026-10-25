import { describe, it, expect, vi } from "vitest";
import { applyOpenRouterRouting, normalizeOpenRouterRouting } from "../../open-sse/services/openrouterRouting.js";

const db = vi.hoisted(() => ({ settings: {}, updateSettings: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => db.settings,
  updateSettings: async update => { db.settings = { ...db.settings, ...update }; db.updateSettings(update); },
}));
import { GET, PUT } from "../../src/app/api/providers/[id]/overrides/route.js";

describe("OpenRouter routing policy", () => {
  it("leaves unconfigured requests unchanged", () => {
    const body = { model: "vendor/model" };
    expect(applyOpenRouterRouting(body, null, "completion")).toBe(body);
  });

  it.each(["completion", "embedding", "systemone"])("enforces ZDR and precision on %s without mutation", endpoint => {
    const body = Object.freeze({ provider: Object.freeze({ zdr: false, sort: "latency" }) });
    const policy = { zdr: true, quantizations: ["fp8", "bf16"] };
    expect(applyOpenRouterRouting(body, policy, endpoint).provider).toEqual({ zdr: true, sort: "latency", quantizations: ["fp8", "bf16"] });
    expect(body.provider.zdr).toBe(false);
  });

  it("narrows requested precision with family-aware matching", () => {
    expect(applyOpenRouterRouting({ provider: { quantizations: ["mxfp8", "fp4"] } }, { quantizations: ["fp8"] }, "completion").provider.quantizations).toEqual(["mxfp8"]);
    expect(applyOpenRouterRouting({ provider: { quantizations: ["fp4"] } }, { quantizations: ["nvfp4"] }, "completion").provider.quantizations).toEqual(["nvfp4"]);
    expect(() => applyOpenRouterRouting({ provider: { quantizations: ["fp4"] } }, { quantizations: ["bf16"] }, "completion")).toThrow(/conflict/);
  });

  it.each(["image", "video"])("blocks %s under ZDR unless explicitly excepted", endpoint => {
    const key = endpoint === "image" ? "allowImageWithoutZdr" : "allowVideoWithoutZdr";
    expect(() => applyOpenRouterRouting({}, { zdr: true }, endpoint)).toThrow(/blocked/);
    const body = { model: "vendor/model" };
    expect(applyOpenRouterRouting(body, { zdr: true, [key]: true, quantizations: ["fp8"] }, endpoint)).toBe(body);
    expect(() => applyOpenRouterRouting({ provider: { zdr: true } }, { zdr: true, [key]: true }, endpoint)).toThrow(/blocked/);
  });

  it("preserves inactive exceptions and rejects malformed policy/preferences", () => {
    expect(normalizeOpenRouterRouting({ zdr: false, allowImageWithoutZdr: true })).toEqual({ allowImageWithoutZdr: true });
    for (const value of [[], "bad", { quantizations: [] }, { quantizations: ["fp64"] }, { zdr: "true" }, { unexpected: true }]) {
      expect(() => normalizeOpenRouterRouting(value)).toThrow();
    }
    for (const provider of [[], "bad", { zdr: "true" }, { quantizations: [] }]) {
      expect(() => applyOpenRouterRouting({ provider }, null, "completion")).toThrow();
    }
  });
});

describe("provider override API", () => {
  const context = id => ({ params: Promise.resolve({ id }) });
  const put = (payload, id = "openrouter") => PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify(payload) }), context(id));

  it("preserves headers on routing saves and routing on header saves/reset", async () => {
    db.settings = { providerOverrides: { openrouter: { headers: { "X-Test": "value" } } } };
    expect((await put({ routing: { zdr: true } })).status).toBe(200);
    expect(db.settings.providerOverrides.openrouter).toEqual({ headers: { "X-Test": "value" }, routing: { zdr: true } });
    await put({ headers: {} });
    expect(db.settings.providerOverrides.openrouter).toEqual({ routing: { zdr: true } });
    expect((await (await GET(null, context("openrouter"))).json()).routing).toEqual({ zdr: true });
    await put({ routing: null });
    expect(db.settings.providerOverrides.openrouter).toBeUndefined();
  });

  it("rejects other providers, malformed JSON and invalid routing without clearing settings", async () => {
    db.settings = { providerOverrides: { openrouter: { routing: { zdr: true } } } };
    expect((await put({ routing: { zdr: true } }, "openai")).status).toBe(400);
    expect((await put({ routing: { quantizations: [] } })).status).toBe(400);
    expect((await PUT(new Request("http://localhost", { method: "PUT", body: "{" }), context("openrouter"))).status).toBe(400);
    expect(db.settings.providerOverrides.openrouter.routing.zdr).toBe(true);
  });
});
