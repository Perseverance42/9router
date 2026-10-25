import { describe, expect, it } from "vitest";
import {
  normalizeOpenRouterComboRouting,
  resolveOpenRouterComboRouting,
  applyOpenRouterRouting,
} from "../../open-sse/services/openrouterRouting.js";

describe("OpenRouter combo policy", () => {
  const provider = Object.freeze({ zdr: true, quantizations: Object.freeze(["fp8"]), allowImageWithoutZdr: true });

  it("inherits omitted fields without modifying provider settings", () => {
    expect(resolveOpenRouterComboRouting(provider, null)).toEqual(provider);
    expect(provider.quantizations).toEqual(["fp8"]);
  });

  it("replaces precision or explicitly removes its default", () => {
    expect(resolveOpenRouterComboRouting(provider, { quantizations: ["bf16"] }).quantizations).toEqual(["bf16"]);
    expect(resolveOpenRouterComboRouting(provider, { quantizations: [] }).quantizations).toBeUndefined();
    expect(provider.quantizations).toEqual(["fp8"]);
  });

  it("requires ZDR and cannot weaken provider ZDR", () => {
    expect(resolveOpenRouterComboRouting({}, { zdr: true }).zdr).toBe(true);
    expect(resolveOpenRouterComboRouting(provider, {}).zdr).toBe(true);
  });

  it("can tighten exceptions but cannot add provider-disallowed exceptions", () => {
    expect(resolveOpenRouterComboRouting(provider, { allowImageWithoutZdr: false }).allowImageWithoutZdr).toBeFalsy();
    expect(resolveOpenRouterComboRouting(provider, { allowVideoWithoutZdr: true }).allowVideoWithoutZdr).toBeFalsy();
    expect(resolveOpenRouterComboRouting(provider, {}).allowImageWithoutZdr).toBe(true);
  });

  it("narrows caller precision after combo resolution", () => {
    const policy = resolveOpenRouterComboRouting(provider, { quantizations: ["bf16", "fp16"] });
    expect(applyOpenRouterRouting({ provider: { quantizations: ["fp16", "fp4"] } }, policy, "completion").provider).toEqual({ zdr: true, quantizations: ["fp16"] });
    expect(() => applyOpenRouterRouting({ provider: { quantizations: ["fp4"] } }, policy, "completion")).toThrow(/conflict/);
  });

  it("keeps explicit unrestricted and block distinct from inheritance", () => {
    expect(normalizeOpenRouterComboRouting({ quantizations: [], allowImageWithoutZdr: false })).toEqual({ quantizations: [], allowImageWithoutZdr: false });
    for (const value of [[], "bad", { quantizations: ["invalid"] }, { zdr: "true" }, { unexpected: true }]) {
      expect(() => normalizeOpenRouterComboRouting(value)).toThrow();
    }
  });
});
