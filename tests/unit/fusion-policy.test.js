import { describe, it, expect } from "vitest";

import {
  FUSION_TOOL_NAME,
  FUSION_ANALYST_SCHEMA,
  resolveFusionPolicy,
  validateFusionSelection,
  validateFusionAnalysis,
} from "../../open-sse/config/fusion.js";

const models = ["p/a", "p/b", "p/a"];
const emptyAnalysis = () => ({
  consensus: [], contradictions: [], partial_coverage: [], unique_insights: [],
  blind_spots: [], verification_needed: [], usable_response_ids: [],
});
const analysis = () => ({
  consensus: ["Shared finding"],
  contradictions: [{
    topic: "Cost",
    stances: [
      { response_id: "response_1", stance: "Cheap" },
      { response_id: "response_2", stance: "Expensive" },
    ],
  }],
  partial_coverage: [{ response_ids: ["response_2"], point: "Region-specific" }],
  unique_insights: [{ response_id: "response_1", insight: "Hidden fee" }],
  blind_spots: ["Tax"],
  verification_needed: ["Current price"],
  usable_response_ids: ["response_1", "response_2"],
});

describe("fusion policy", () => {
  it("preserves duplicate models as distinct slots and defaults both bounds to N", () => {
    const policy = resolveFusionPolicy(models);
    expect(policy.slots).toEqual([
      { id: "panel_1", model: "p/a", index: 0 },
      { id: "panel_2", model: "p/b", index: 1 },
      { id: "panel_3", model: "p/a", index: 2 },
    ]);
    expect(policy.minPanels).toBe(3);
    expect(policy.maxPanels).toBe(3);
    expect(FUSION_TOOL_NAME).toBe("consult_panel");
    for (const label of ["panel_1: p/a", "panel_2: p/b", "panel_3: p/a"]) {
      expect(policy.instructions).toContain(label);
    }
    expect(policy.instructions).toContain("minPanels=3, maxPanels=3");
    expect(policy.instructions).toContain("exactly once");
    expect(policy.instructions).toContain("all selected panel_ids");
    expect(policy.instructions).toContain("parallel");
    expect(policy.instructions).toContain("Do not mix consult_panel with application tool calls");
    expect(policy.instructions).toContain("direct path without consultation is not permitted");
  });

  it("permits the direct path only with a zero minimum and keeps configured slots", () => {
    const optional = resolveFusionPolicy(models, { minPanels: 0, maxPanels: 2 });
    expect(optional.instructions).toContain("without panel consultation is permitted");
    const direct = resolveFusionPolicy(models, { minPanels: 0, maxPanels: 0 });
    expect(direct.slots).toHaveLength(3);
    expect(direct.instructions).toContain("Do not invoke consult_panel");
    expect(() => validateFusionSelection({ panel_ids: [], brief: "help" }, direct)).toThrow();
    expect(() => validateFusionSelection({ panel_ids: ["panel_1"], brief: "help" }, direct)).toThrow();
  });

  it.each([undefined, null, [], "p/a", [""], [" "], [null], [false], [0], [{}], ["p/a", undefined], Array(1)].map((value) => [value]))(
    "rejects invalid models rather than filtering: %j", (value) => {
      expect(() => resolveFusionPolicy(value)).toThrow();
    },
  );

  it.each([
    { minPanels: -1 }, { minPanels: 1.5 }, { maxPanels: 1.5 },
    { minPanels: "1" }, { maxPanels: null }, { minPanels: NaN },
    { maxPanels: Infinity }, { minPanels: 2, maxPanels: 1 },
    { minPanels: 0, maxPanels: 4 }, { maxPanels: 2 }, null, [],
  ].map((tuning) => [tuning]))("rejects invalid bounds/tuning: %j", (tuning) => {
    expect(() => resolveFusionPolicy(models, tuning)).toThrow();
  });

  it("returns selected slots in configured order, not requested order", () => {
    const policy = resolveFusionPolicy(models, { minPanels: 1, maxPanels: 2 });
    expect(validateFusionSelection({ panel_ids: ["panel_3", "panel_1"], brief: "Check cost" }, policy))
      .toEqual([policy.slots[0], policy.slots[2]]);
  });

  it.each([
    null, [], {}, { panel_ids: ["panel_1"] },
    { panel_ids: ["panel_1"], brief: "help", extra: true },
    { panel_ids: [], brief: "help" },
    { panel_ids: "panel_1", brief: "help" },
    { panel_ids: ["panel_1", "panel_1"], brief: "help" },
    { panel_ids: ["panel_4"], brief: "help" },
    { panel_ids: [null], brief: "help" },
    { panel_ids: ["panel_1"], brief: " " },
    { panel_ids: ["panel_1"], brief: 1 },
    { panel_ids: ["panel_1", "panel_2", "panel_3"], brief: "help" },
  ].map((args) => [args]))("rejects invalid selections: %j", (args) => {
    const policy = resolveFusionPolicy(models, { minPanels: 1, maxPanels: 2 });
    expect(() => validateFusionSelection(args, policy)).toThrow();
  });

  it("enforces a positive minimum even when IDs are known", () => {
    expect(() => validateFusionSelection({ panel_ids: ["panel_1"], brief: "help" }, resolveFusionPolicy(models)))
      .toThrow();
  });
});

describe("fusion analysis", () => {
  it("exports a closed schema with all seven required arrays", () => {
    expect(FUSION_ANALYST_SCHEMA.additionalProperties).toBe(false);
    expect(FUSION_ANALYST_SCHEMA.required).toEqual(Object.keys(emptyAnalysis()));
    const props = FUSION_ANALYST_SCHEMA.properties;
    for (const key of FUSION_ANALYST_SCHEMA.required) expect(props[key].type).toBe("array");
    expect(props.contradictions.items.additionalProperties).toBe(false);
    expect(props.contradictions.items.properties.stances.minItems).toBe(2);
    expect(props.contradictions.items.properties.stances.items.additionalProperties).toBe(false);
    expect(props.partial_coverage.items.additionalProperties).toBe(false);
    expect(props.unique_insights.items.additionalProperties).toBe(false);
    expect(props.usable_response_ids.uniqueItems).toBe(true);
    expect(props.partial_coverage.items.properties.response_ids.uniqueItems).toBe(true);
    expect(props.usable_response_ids.items.pattern).toBe("^response_[1-9][0-9]*$");
  });

  it("accepts complete analyses and empty arrays, returning the validated value", () => {
    const value = analysis();
    expect(validateFusionAnalysis(value, ["response_1", "response_2"])).toBe(value);
    expect(validateFusionAnalysis(emptyAnalysis(), [])).toEqual(emptyAnalysis());
    value.partial_coverage[0].response_ids = [];
    expect(validateFusionAnalysis(value, ["response_1", "response_2"])).toBe(value);
  });

  it.each([
    (v) => { delete v.consensus; },
    (v) => { v.extra = []; },
    (v) => { v.consensus = "finding"; },
    (v) => { v.consensus = [""]; },
    (v) => { v.blind_spots = [" "]; },
    (v) => { v.verification_needed = [null]; },
    (v) => { v.consensus = Array(1); },
    (v) => { v.contradictions[0].extra = true; },
    (v) => { v.contradictions[0].topic = ""; },
    (v) => { v.contradictions[0].stances.pop(); },
    (v) => { v.contradictions[0].stances[0].stance = ""; },
    (v) => { v.contradictions[0].stances[0].extra = true; },
    (v) => { v.partial_coverage[0].point = ""; },
    (v) => { v.partial_coverage[0].extra = true; },
    (v) => { v.partial_coverage[0].response_ids = ["response_1", "response_1"]; },
    (v) => { v.unique_insights[0].insight = false; },
    (v) => { delete v.unique_insights[0].response_id; },
    (v) => { v.unique_insights[0].extra = true; },
    (v) => { v.usable_response_ids = ["response_1", "response_1"]; },
    (v) => { v.usable_response_ids = ["response_0"]; },
    (v) => { v.usable_response_ids = ["response_01"]; },
    (v) => { v.usable_response_ids = ["response_3"]; },
    (v) => { v.contradictions[0].stances[0].response_id = "response_3"; },
    (v) => { v.partial_coverage[0].response_ids = ["response_3"]; },
    (v) => { v.unique_insights[0].response_id = "response_3"; },
  ])("rejects invalid analysis shape, content or references (%#)", (mutate) => {
    const value = analysis();
    mutate(value);
    expect(() => validateFusionAnalysis(value, ["response_1", "response_2"])).toThrow();
  });

  it.each([null, [], "text", 1].map((value) => [value]))("rejects non-object analyses: %j", (value) => {
    expect(() => validateFusionAnalysis(value, [])).toThrow();
  });

  it.each([undefined, ["response_0"], ["response_01"], ["response_1", "response_1"], [null]].map((ids) => [ids]))(
    "rejects invalid known response IDs: %j", (ids) => {
      expect(() => validateFusionAnalysis(emptyAnalysis(), ids)).toThrow();
    },
  );
});
