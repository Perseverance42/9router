export const FUSION_TOOL_NAME = "consult_panel";

const textSchema = { type: "string", minLength: 1, pattern: "\\S" };
const responseIdSchema = { type: "string", pattern: "^response_[1-9][0-9]*$" };
const responseIdsSchema = { type: "array", items: responseIdSchema, uniqueItems: true };

export const FUSION_ANALYST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "consensus", "contradictions", "partial_coverage", "unique_insights",
    "blind_spots", "verification_needed", "usable_response_ids",
  ],
  properties: {
    consensus: { type: "array", items: textSchema },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "stances"],
        properties: {
          topic: textSchema,
          stances: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["response_id", "stance"],
              properties: { response_id: responseIdSchema, stance: textSchema },
            },
          },
        },
      },
    },
    partial_coverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["response_ids", "point"],
        properties: { response_ids: responseIdsSchema, point: textSchema },
      },
    },
    unique_insights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["response_id", "insight"],
        properties: { response_id: responseIdSchema, insight: textSchema },
      },
    },
    blind_spots: { type: "array", items: textSchema },
    verification_needed: { type: "array", items: textSchema },
    usable_response_ids: responseIdsSchema,
  },
};

function objectWithKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${path} must be an object with exactly: ${keys.join(", ")}`);
  }
}

function nonemptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a nonempty string`);
  }
}

function array(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  // Array.from exposes sparse entries to the same validation as explicit undefined.
  return Array.from(value);
}

export function resolveFusionPolicy(models, tuning = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Fusion requires a nonempty model list");
  }
  const slots = Array.from(models, (model, index) => {
    nonemptyString(model, `models[${index}]`);
    return { id: `panel_${index + 1}`, model, index };
  });
  if (!tuning || typeof tuning !== "object" || Array.isArray(tuning)) {
    throw new Error("Fusion tuning must be an object");
  }
  const { minPanels = slots.length, maxPanels = slots.length } = tuning;
  if (!Number.isInteger(minPanels) || !Number.isInteger(maxPanels)
    || minPanels < 0 || minPanels > maxPanels || maxPanels > slots.length) {
    throw new Error(`Fusion bounds must be integers satisfying 0 <= minPanels <= maxPanels <= ${slots.length}`);
  }
  const instructions = [
    "Configured panel slots:",
    ...slots.map(({ id, model }) => `${id}: ${model}`),
    `Consultation bounds: minPanels=${minPanels}, maxPanels=${maxPanels}.`,
    minPanels === 0
      ? "A direct answer or application tool call without panel consultation is permitted."
      : `Consult at least ${minPanels} panel slots before answering or calling application tools; a direct path without consultation is not permitted.`,
    maxPanels === 0
      ? `Do not invoke ${FUSION_TOOL_NAME}; use the direct path.`
      : `If consulting, invoke ${FUSION_TOOL_NAME} exactly once with all selected panel_ids and a nonempty brief; all selected slots run in parallel.`,
    `Do not mix ${FUSION_TOOL_NAME} with application tool calls in the same turn.`,
  ].join("\n");
  return { slots, minPanels, maxPanels, instructions };
}

export function validateFusionSelection(args, policy) {
  objectWithKeys(args, ["panel_ids", "brief"], "Fusion selection");
  nonemptyString(args.brief, "brief");
  const ids = array(args.panel_ids, "panel_ids");
  if (ids.length === 0 || ids.length < policy.minPanels || ids.length > policy.maxPanels) {
    throw new Error(`panel_ids must be nonempty and contain ${policy.minPanels}..${policy.maxPanels} slots`);
  }
  const known = new Set(policy.slots.map((slot) => slot.id));
  const selected = new Set();
  for (const id of ids) {
    nonemptyString(id, "panel_ids entry");
    if (!known.has(id)) throw new Error(`Unknown panel ID: ${id}`);
    if (selected.has(id)) throw new Error(`Duplicate panel ID: ${id}`);
    selected.add(id);
  }
  return policy.slots.filter((slot) => selected.has(slot.id));
}

export function validateFusionAnalysis(value, responseIds) {
  const known = new Set();
  for (const id of array(responseIds, "responseIds")) {
    if (typeof id !== "string" || !/^response_[1-9][0-9]*$/.test(id)) {
      throw new Error(`Invalid response ID: ${String(id)}`);
    }
    if (known.has(id)) throw new Error(`Duplicate response ID: ${id}`);
    known.add(id);
  }
  const responseId = (id, path) => {
    if (typeof id !== "string" || !/^response_[1-9][0-9]*$/.test(id) || !known.has(id)) {
      throw new Error(`${path} must reference a known response ID`);
    }
  };
  const responseList = (ids, path) => {
    const list = array(ids, path);
    list.forEach((id) => responseId(id, path));
    if (new Set(list).size !== list.length) throw new Error(`${path} must contain unique response IDs`);
  };

  objectWithKeys(value, FUSION_ANALYST_SCHEMA.required, "Fusion analysis");
  for (const key of ["consensus", "blind_spots", "verification_needed"]) {
    array(value[key], key).forEach((item) => nonemptyString(item, `${key} entry`));
  }
  array(value.contradictions, "contradictions").forEach((item) => {
    objectWithKeys(item, ["topic", "stances"], "contradiction");
    nonemptyString(item.topic, "contradiction.topic");
    const stances = array(item.stances, "contradiction.stances");
    if (stances.length < 2) throw new Error("contradiction.stances requires at least two stances");
    stances.forEach((stance) => {
      objectWithKeys(stance, ["response_id", "stance"], "stance");
      responseId(stance.response_id, "stance.response_id");
      nonemptyString(stance.stance, "stance.stance");
    });
  });
  array(value.partial_coverage, "partial_coverage").forEach((item) => {
    objectWithKeys(item, ["response_ids", "point"], "partial_coverage entry");
    responseList(item.response_ids, "partial_coverage.response_ids");
    nonemptyString(item.point, "partial_coverage.point");
  });
  array(value.unique_insights, "unique_insights").forEach((item) => {
    objectWithKeys(item, ["response_id", "insight"], "unique_insights entry");
    responseId(item.response_id, "unique_insights.response_id");
    nonemptyString(item.insight, "unique_insights.insight");
  });
  responseList(value.usable_response_ids, "usable_response_ids");
  return value;
}
