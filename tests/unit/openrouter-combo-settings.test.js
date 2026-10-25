import { expect, it, vi } from "vitest";
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ comboOpenrouterRouting: { privateId: { zdr: true } }, comboStrategy: "fallback" }),
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
import { GET, PATCH } from "../../src/app/api/settings/route.js";

it("projects combo policies only through combo CRUD, not generic settings", async () => {
  const data = await (await GET()).json();
  expect(data.comboOpenrouterRouting).toBeUndefined();
  expect(data.comboStrategy).toBe("fallback");
  const response = await PATCH(new Request("http://localhost/api/settings", {
    method: "PATCH", body: JSON.stringify({ comboOpenrouterRouting: {} }),
  }));
  expect(response.status).toBe(400);
});
