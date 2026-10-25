import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCombos: vi.fn(),
  updateSettings: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getCombos: mocks.getCombos,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: mocks.resetComboRotation }));
vi.mock("bcryptjs", () => ({ default: {} }));

const { PATCH } = await import("../../src/app/api/settings/route.js");
const patch = (comboStrategies) => PATCH({ json: async () => ({ comboStrategies }) });
const fusion = (fusionTuning) => ({ fallbackStrategy: "fusion", fusionTuning });

describe("Fusion participation settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue([
      { name: "panel", models: ["provider/a", "provider/a", "provider/b"] },
      { name: "empty", models: [] },
    ]);
    mocks.updateSettings.mockImplementation(async (body) => body);
  });

  it.each([
    { minPanels: 3, maxPanels: 3 },
    { minPanels: 0, maxPanels: 3 },
    { minPanels: 0, maxPanels: 0 },
    { minPanels: 1, maxPanels: 2 },
    { minPanels: 0 },
    { maxPanels: 3 },
  ])("persists valid slot bounds %j without dropping legacy tuning", async (bounds) => {
    const strategy = fusion({ panelTimeoutMs: 5000, judgeTimeoutMs: 9000, ...bounds });
    const response = await patch({ panel: strategy });
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ comboStrategies: { panel: strategy } });
    expect(mocks.resetComboRotation).toHaveBeenCalledOnce();
  });

  it.each([
    { minPanels: -1, maxPanels: 3 },
    { minPanels: 0, maxPanels: -1 },
    { minPanels: 2, maxPanels: 1 },
    { minPanels: 0, maxPanels: 4 },
    { minPanels: 0.5, maxPanels: 3 },
    { minPanels: 0, maxPanels: 2.5 },
    { minPanels: "0", maxPanels: 3 },
    { minPanels: 0, maxPanels: null },
    { minPanels: false, maxPanels: 3 },
    { maxPanels: 2 }, // Missing min defaults to the three slots, not zero.
    { minPanels: 4 },
  ])("rejects invalid bounds %j before writing settings", async (bounds) => {
    const response = await patch({ panel: fusion(bounds) });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("0 <= minPanels <= maxPanels <= 3");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
  });

  it("accepts zero bounds for a combo with no slots", async () => {
    expect((await patch({ empty: fusion({ minPanels: 0, maxPanels: 0 }) })).status).toBe(200);
    expect((await patch({ empty: fusion({ minPanels: 0, maxPanels: 1 }) })).status).toBe(400);
  });

  it("rejects bounds for an unknown Fusion combo", async () => {
    expect((await patch({ missing: fusion({ minPanels: 0, maxPanels: 1 }) })).status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("leaves unrelated strategies and timeout-only legacy Fusion settings untouched", async () => {
    const strategies = {
      roundRobin: { fallbackStrategy: "round-robin", fusionTuning: { minPanels: "legacy" } },
      smart: { fallbackStrategy: "smart", confidenceThreshold: 80 },
      legacy: fusion({ panelTimeoutMs: 5000 }),
      defaults: { fallbackStrategy: "fusion" },
    };
    expect((await patch(strategies)).status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ comboStrategies: strategies });
    expect(mocks.getCombos).not.toHaveBeenCalled();
  });

  it("does not load combos for unrelated settings updates", async () => {
    expect((await PATCH({ json: async () => ({ theme: "dark" }) })).status).toBe(200);
    expect(mocks.getCombos).not.toHaveBeenCalled();
  });
});
