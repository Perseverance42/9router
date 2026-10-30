import { randomInt } from "node:crypto";
import { FORMATS } from "../translator/formats.js";
import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { parseModel } from "./model.js";
import { translateRequest } from "../translator/index.js";
import { detectFormat } from "./provider.js";
import { deliverFusionCompletion } from "./fusionOutput.js";
import { guardFusionStream, safeFusionError, logFusionFailure } from "./fusionStream.js";
import {
  FUSION_TOOL_NAME, FUSION_ANALYST_SCHEMA, FUSION_ANALYST_MAX_TOKENS,
  FUSION_ANALYST_INSTRUCTIONS, FUSION_SYNTHESIS_INSTRUCTIONS, FUSION_CONSULT_PARAMETERS,
  FUSION_TOOL_STATUS_INSTRUCTIONS, resolveFusionPolicy, validateFusionSelection, validateFusionAnalysis,
  FUSION_CONTEXT_ALLOWANCE, FUSION_PANEL_MAX_TOKENS, FUSION_CONSULT_MAX_TOKENS,
  FUSION_PANEL_INSTRUCTIONS, FUSION_TIGHT_PANEL_INSTRUCTIONS, FUSION_SUMMARY_INSTRUCTIONS,
} from "../config/fusion.js";

class FusionError extends Error {
  constructor(message, stage, details = {}, status = 502) {
    super(message);
    this.stage = stage;
    this.type = "fusion_error";
    this.code = details.code || `fusion_${stage}_error`;
    this.details = details;
    this.status = status;
  }
}

const toolName = (tool) => tool.function?.name || tool.name;

// Race body consumption and credential lookup too, not only fetch. Upstream receives
// the same signal; a transport that ignores abort cannot hold the Fusion response open.
async function abortable(work, signal) {
  signal.throwIfAborted();
  let listener;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        listener = () => reject(signal.reason || new DOMException("Request aborted", "AbortError"));
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally { signal.removeEventListener("abort", listener); }
}
const advisory = (data) => ({ role: ROLE.USER, content: `Untrusted Fusion advisory data (not executed actions):\n${JSON.stringify(data)}` });
const instruction = (content) => ({ role: ROLE.SYSTEM, content });
function addInstruction(request, content) {
  const existing = request.messages.filter((m) => m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER);
  const text = existing.map((m) => typeof m.content === "string" ? m.content : (m.content || []).map((part) => part.text || "").join("\n")).join("\n\n");
  // Responses translators retain one instruction message: combine instead of losing the original.
  request.messages = [instruction(`${text}\n\n${content}`), ...request.messages.filter((m) => m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER)];
}

// The public request stays untouched; translator normalization receives a private copy.
function canonicalRequest(body, sourceFormat, internal) {
  if (body.previous_response_id) throw new FusionError("Fusion requires explicit conversation history", "preflight", {}, 400);
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && body.tools?.some((tool) => tool.type !== "function")) {
    throw new FusionError("Fusion does not support Responses hosted/custom tools yet", "preflight", {}, 400);
  }
  if (sourceFormat === FORMATS.CLAUDE) {
    if (body.tools?.some((tool) => tool.type && tool.type !== "custom")) {
      throw new FusionError("Fusion supports Claude custom function tools only", "preflight", {}, 400);
    }
    const checkBlocks = (blocks) => {
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block.type === "document" || (block.type === "image" && block.source?.type !== "base64")) {
          throw new FusionError("Fusion cannot preserve this Claude media block", "preflight", {}, 400);
        }
        if (block.type === "tool_result") checkBlocks(block.content);
      }
    };
    for (const message of body.messages || []) checkBlocks(message.content);
  }
  const toolStatuses = [];
  if (sourceFormat === FORMATS.CLAUDE) {
    for (const [messageIndex, message] of (body.messages || []).entries()) {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      for (const [blockIndex, block] of blocks.entries()) {
        if (block?.type === CLAUDE_BLOCK.TOOL_RESULT) toolStatuses.push({
          message_index: messageIndex, block_index: blockIndex,
          tool_call_id: block.tool_use_id, is_error: block.is_error === true,
        });
      }
    }
  }
  const copy = structuredClone(body);
  const canonical = translateRequest(sourceFormat, FORMATS.OPENAI, body.model, copy, false);
  if (!canonical || !Array.isArray(canonical.messages)) throw new FusionError("Unsupported Fusion conversation format", "preflight", {}, 400);
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (canonical[key] !== undefined && (!Number.isInteger(canonical[key]) || canonical[key] <= 0)) {
      throw new FusionError("Fusion output limits must be positive integers", "preflight", {}, 400);
    }
  }
  if (toolStatuses.length) addInstruction(canonical, `${FUSION_TOOL_STATUS_INSTRUCTIONS}\n${JSON.stringify(toolStatuses)}`);
  if (canonical.n !== undefined && canonical.n !== 1) throw new FusionError("Fusion supports one completion per request", "preflight", {}, 400);
  // Responses format constraints are public constraints, not analyst output settings.
  if (body.text?.format && !canonical.response_format) canonical.response_format = structuredClone(body.text.format);
  if (sourceFormat === FORMATS.CLAUDE) {
    if (body.stop_sequences) canonical.stop = structuredClone(body.stop_sequences);
    if (body.output_config?.format) {
      const format = body.output_config.format;
      canonical.response_format = format.type === "json_schema"
        ? { type: "json_schema", json_schema: { name: "response", schema: format.schema } }
        : structuredClone(format);
    }
    if (body.tool_choice?.type === "none") canonical.tool_choice = "none";
    if (body.tool_choice?.disable_parallel_tool_use !== undefined) canonical.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && body.tool_choice?.type === "function") {
    canonical.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
  }
  const tools = canonical.tools || [];
  if (!Array.isArray(tools) || tools.some((tool) => tool.type !== "function" || !tool.function?.name)) {
    throw new FusionError("Fusion currently supports JSON function tools only", "preflight", {}, 400);
  }
  const names = tools.map(toolName);
  if (new Set(names).size !== names.length || (!internal && names.includes(FUSION_TOOL_NAME))) {
    throw new FusionError("Duplicate or reserved Fusion tool name", "preflight", {}, 400);
  }
  return canonical;
}

async function toolValidators(tools) {
  if (!tools.length) return new Map();
  const { default: Ajv } = await import("ajv/dist/2020.js");
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  return new Map(tools.map((tool) => [tool.function.name, ajv.compile(tool.function.parameters || { type: "object" })]));
}

function candidate(completion, tools, constraints = {}, validators = new Map()) {
  const choice = completion.choices?.[0];
  if (!choice?.message || typeof choice.message !== "object") throw new Error("Missing choices[0].message");
  const message = choice.message;
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error("Invalid tool_calls container");
  const issues = [];
  const names = new Set((tools || []).map(toolName));
  const calls = (message.tool_calls || []).map((call) => {
    const name = call.function?.name;
    const raw = call.function?.arguments;
    let args = raw;
    try { args = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { issues.push(`Invalid JSON arguments for ${name || "unknown tool"}`); }
    if (!names.has(name)) issues.push(`Unknown application tool: ${name || "missing name"}`);
    const validate = validators.get(name);
    if (validate && !validate(args)) issues.push(`Invalid arguments for ${name}: ${JSON.stringify(validate.errors)}`);
    return { name, arguments: args, ...(typeof raw === "string" ? { arguments_json: raw } : {}) };
  });
  if (constraints.tool_choice === "none" && calls.length) issues.push("Tools are disabled by the client");
  if (constraints.parallel_tool_calls === false && calls.length > 1) issues.push("Parallel calls are disabled by the client");
  const forced = constraints.tool_choice?.function?.name;
  if (forced && calls.some((call) => call.name !== forced)) issues.push(`Client requires tool ${forced}`);
  return {
    content: message.content ?? null,
    tool_calls: calls,
    refusal: message.refusal || null,
    finish_reason: choice.finish_reason || null,
    issues,
  };
}

function anonymize(responses) {
  const shuffled = [...responses];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((response, i) => ({ id: `response_${i + 1}`, ...response }));
}

// Text-only estimate, not a tokenizer. Exclude media payloads, but preserve them
// for dispatch; provider-specific media costs can still overflow upstream.
export function estimateFusionRequest(request) {
  let mediaEstimationUnsupported = false;
  const text = JSON.stringify(request, function (key, value) {
    if (key === "input_audio" && value && typeof value.data === "string") {
      mediaEstimationUnsupported = true;
      return { ...value, data: "[media: estimation unsupported]" };
    }
    if ((key === "data" && typeof value === "string" && this.type === "base64") || (key === "url" && typeof value === "string" && /^data:[^,]*;base64,/.test(value))) {
      mediaEstimationUnsupported = true;
      return "[media: estimation unsupported]";
    }
    if (value && typeof value === "object" && ["image_url", "input_audio", "video_url", "image", "audio", "file"].includes(value.type)) mediaEstimationUnsupported = true;
    return value;
  });
  return { tokens: Math.ceil(Buffer.byteLength(text, "utf8") / 3) + 32 + (request.messages?.length || 0) * 8, mediaEstimationUnsupported };
}

const positive = (value) => Number.isInteger(value) && value > 0;
const explicitOutput = (request) => positive(request.max_completion_tokens) ? request.max_completion_tokens
  : positive(request.max_tokens) ? request.max_tokens : undefined;
// ponytail: provider defaults vary; reserve at most 8192 until routing exposes actual translated output/reasoning defaults.
const outputReserve = (request, limits) => explicitOutput(request) ?? Math.min(limits.maxOutput, 8192);
function capOutput(request, cap) {
  const value = Math.max(1, Math.floor(Math.min(explicitOutput(request) ?? cap, cap)));
  request.max_tokens = value;
  if (request.max_completion_tokens !== undefined) request.max_completion_tokens = value;
}
const budgetError = (stage) => new FusionError("Fusion request exceeds the safe context budget", stage, { code: "fusion_context_budget" }, 400);

/** One bounded consultation: initial controller, parallel panel, analyst, native synthesis. */
export async function handleFusionChat({ body, models, handleSingleModel, log, judgeModel, tuning, signal, sourceFormat = detectFormat(body), outputFormat = sourceFormat, internal = false, preflight, getModelLimits, maxOutputTokens }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let stage = "preflight";
  let handedOff = false;
  let consultRequired = false;
  const checkAbort = () => controller.signal.throwIfAborted();
  const limitCache = new Map();
  const limitsFor = async (model) => {
    if (!limitCache.has(model)) limitCache.set(model, (async () => {
      const parsed = parseModel(model);
      // ponytail: unknown/local models inherit capability heuristics; use getModelLimits for configured limits.
      const fallback = getCapabilitiesForModel(parsed.provider, parsed.model);
      const resolved = await abortable(() => getModelLimits?.(model), controller.signal);
      return {
        contextWindow: positive(resolved?.contextWindow) ? resolved.contextWindow : fallback.contextWindow,
        maxOutput: positive(resolved?.maxOutput) ? resolved.maxOutput : fallback.maxOutput,
      };
    })());
    return limitCache.get(model);
  };
  const fits = async (request, model, extra = 0) => {
    const limits = await limitsFor(model);
    return estimateFusionRequest(request).tokens + outputReserve(request, limits) + extra <= Math.floor(limits.contextWindow * FUSION_CONTEXT_ALLOWANCE);
  };
  const invoke = async (request, model, callStage, outputFormat = FORMATS.OPENAI) => {
    checkAbort();
    const privateGeneration = ["panel", "analyst"].includes(callStage) || (callStage === "initial" && consultRequired);
    // Nested Fusion remains one advisory seat; retain its parent's private output ceiling.
    const ceiling = privateGeneration ? Math.min(explicitOutput(request) ?? Infinity, maxOutputTokens ?? Infinity) : maxOutputTokens;
    if (positive(ceiling)) {
      request = structuredClone(request);
      capOutput(request, ceiling);
    }
    if (!await fits(request, model)) throw budgetError(callStage);
    checkAbort();
    let response;
    try {
      response = await abortable(() => handleSingleModel(structuredClone(request), model, {
        internal: true, sourceFormat: FORMATS.OPENAI, outputFormat,
        signal: controller.signal, stage: callStage,
        ...(positive(ceiling) ? { maxOutputTokens: ceiling } : {}),
      }), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new FusionError("Upstream model call failed", callStage, { code: "fusion_upstream_error" });
    }
    checkAbort();
    if (!response?.ok) {
      let upstream;
      try { upstream = await abortable(() => response.json(), controller.signal); } catch { /* no safe structured error */ }
      const failure = safeFusionError(upstream?.error, callStage, "fusion_upstream_error", response?.status);
      throw new FusionError(failure.message, callStage, { ...failure.details, code: failure.code });
    }
    return response;
  };
  const complete = async (request, model, callStage) => {
    try {
      const response = await invoke({ ...request, stream: false }, model, callStage);
      const json = await abortable(() => response.json(), controller.signal);
      checkAbort();
      if (!json.choices?.[0]?.message) throw new Error("Missing choices[0].message");
      return json;
    } catch (error) {
      if (error instanceof FusionError || controller.signal.aborted) throw error;
      throw new FusionError("Invalid model completion", callStage, { code: "fusion_invalid_completion" });
    }
  };
  try {
    checkAbort();
    if (![FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES].includes(sourceFormat)) {
      throw new FusionError(`Unsupported Fusion client format: ${sourceFormat}`, stage, {}, 400);
    }
    const original = canonicalRequest(body, sourceFormat, internal);
    const publicNames = new Set((original.tools || []).map(toolName));
    let consultToolName = FUSION_TOOL_NAME;
    for (let suffix = 1; publicNames.has(consultToolName); suffix++) consultToolName = `${FUSION_TOOL_NAME}_${suffix}`;
    const policy = resolveFusionPolicy(models, tuning, consultToolName);
    consultRequired = policy.minPanels > 0;
    const judge = judgeModel?.trim() || models[0];
    if (!judge) throw new FusionError("Fusion requires an explicit judge when no panels are configured", stage, {}, 400);
    const publicTools = original.tools || [];
    const validators = await toolValidators(publicTools);
    const answerFormat = original.response_format;
    let answerValidator;
    if (answerFormat?.type === "json_schema") {
      const { default: Ajv } = await import("ajv/dist/2020.js");
      answerValidator = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(answerFormat.json_schema.schema);
    }
    const validateAnswer = (completion) => {
      const message = completion.choices[0].message;
      if (!message.tool_calls?.length && ["json_schema", "json_object"].includes(answerFormat?.type)) {
        let value;
        try { value = JSON.parse(message.content); } catch { throw new FusionError("Judge answer violates requested JSON output", stage, { code: "fusion_output_constraints" }); }
        if (answerFormat.type === "json_object" && (!value || typeof value !== "object" || Array.isArray(value))) {
          throw new FusionError("Judge answer must be a JSON object", stage, { code: "fusion_output_constraints" });
        }
        if (answerValidator && !answerValidator(value)) throw new FusionError("Judge answer violates requested output schema", stage, { code: "fusion_output_constraints" });
      }
    };
    const rejected = await abortable(() => preflight?.([...new Set([...models, judge])], original), controller.signal);
    checkAbort();
    if (rejected instanceof Response) return rejected;
    const base = { ...original, stream: false };
    delete base.stream_options;
    const initial = structuredClone(base);
    addInstruction(initial, `You are the Fusion controller. ${policy.instructions}\nWhen consulting, provide a self-contained brief of the objective, relevant observed facts, constraints and uncertainty. Do not fabricate history. Direct output must satisfy these original application requirements: ${JSON.stringify({ tool_choice: original.tool_choice, parallel_tool_calls: original.parallel_tool_calls, response_format: original.response_format })}. Internal consultation does not satisfy an application-tool requirement.`);
    initial.tools = [...publicTools];
    if (policy.maxPanels > 0) initial.tools.push({
      type: "function", function: {
        name: consultToolName,
        description: "Consult selected panel models concurrently in one batch. Supply all selected IDs and a self-contained task brief.",
        parameters: FUSION_CONSULT_PARAMETERS,
      },
    });
    initial.tool_choice = policy.minPanels > 0
      ? { type: "function", function: { name: consultToolName } }
      : (policy.maxPanels === 0 ? original.tool_choice : "auto");
    if (policy.maxPanels > 0) delete initial.response_format;
    // Optional consultation can return a public answer; do not cap that direct path.
    if (policy.minPanels > 0) capOutput(initial, Math.min(FUSION_CONSULT_MAX_TOKENS, (await limitsFor(judge)).maxOutput));
    stage = "initial";
    const first = await complete(initial, judge, stage);
    if (["length", "max_tokens"].includes(first.choices[0].finish_reason)) throw new FusionError("Initial judge completion was truncated", stage);
    const calls = first.choices[0].message.tool_calls || [];
    const consultations = calls.filter((call) => call.function?.name === consultToolName);
    if (!consultations.length) {
      if (policy.minPanels > 0) throw new FusionError("Judge skipped required panel consultation", stage);
      // Direct handling must obey the original public contract, not internal auto choice.
      validatePublicAction(first, original, validators);
      validateAnswer(first);
      return deliverFusionCompletion(first, { sourceFormat: outputFormat, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true });
    }
    if (consultations.length !== 1 || calls.length !== 1) throw new FusionError("Consultation must be one call without application calls", stage);
    let args;
    try { args = JSON.parse(consultations[0].function.arguments); }
    catch { throw new FusionError("Invalid consultation argument JSON", stage); }
    let selected;
    try { selected = validateFusionSelection(args, policy); }
    catch (error) { throw new FusionError(error.message, stage); }
    stage = "panel";
    const judgeLimits = await limitsFor(judge);
    const synthesisBase = structuredClone(original);
    addInstruction(synthesisBase, FUSION_SYNTHESIS_INSTRUCTIONS);
    const contextBase = { brief: args.brief, participation: { minPanels: policy.minPanels, maxPanels: policy.maxPanels, selectedPanels: selected.length }, responses: [] };
    synthesisBase.messages.push(advisory(contextBase));
    const availableAdvisoryBudget = Math.floor(judgeLimits.contextWindow * FUSION_CONTEXT_ALLOWANCE)
      - estimateFusionRequest(synthesisBase).tokens - outputReserve(original, judgeLimits);
    // Split constrained advisory space between evaluation and panel output; 8192 is a ceiling, not a minimum.
    const analysisCap = Math.min(FUSION_ANALYST_MAX_TOKENS, judgeLimits.maxOutput, Math.floor(availableAdvisoryBudget / 2));
    const sharedAdvisoryBudget = availableAdvisoryBudget - analysisCap;
    if (analysisCap < 1 || sharedAdvisoryBudget <= 0) throw budgetError(stage);
    const panelCaps = await Promise.all(selected.map(async ({ model }) => Math.min(
      FUSION_PANEL_MAX_TOKENS, (await limitsFor(model)).maxOutput, explicitOutput(original) ?? Infinity,
      Math.floor(sharedAdvisoryBudget / selected.length),
    )));
    if (panelCaps.some((cap) => cap < 1)) throw budgetError(stage);
    const tight = sharedAdvisoryBudget < selected.length * FUSION_PANEL_MAX_TOKENS;
    // Start every slot before awaiting any result. The first causal error aborts siblings.
    const pending = selected.map(async (slot, index) => {
      try {
        const request = structuredClone(base);
        capOutput(request, panelCaps[index]);
        addInstruction(request, FUSION_PANEL_INSTRUCTIONS);
        if (tight) addInstruction(request, FUSION_TIGHT_PANEL_INSTRUCTIONS);
        request.messages.push(advisory({ consultation_brief: args.brief }));
        const completion = await complete(request, slot.model, "panel");
        return candidate(completion, publicTools, original, validators);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failure = error instanceof FusionError ? error : new FusionError(error.message || "Invalid panel completion", "panel");
        failure.details = { ...failure.details, model: slot.model, slot: slot.id };
        if (!controller.signal.aborted) controller.abort(failure);
        throw failure;
      }
    });
    const settled = await Promise.allSettled(pending);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw controller.signal.reason || failed.reason;
    checkAbort();
    const responses = anonymize(settled.map((result) => result.value));
    const context = { brief: args.brief, participation: { minPanels: policy.minPanels, maxPanels: policy.maxPanels, selectedPanels: selected.length }, responses };
    stage = "analyst";
    const analysisRequest = {
      messages: [instruction(FUSION_ANALYST_INSTRUCTIONS), advisory(context)],
      stream: false, max_tokens: analysisCap,
      response_format: { type: "json_schema", json_schema: { name: "fusion_analysis", strict: false, schema: FUSION_ANALYST_SCHEMA } },
    };
    const prospective = structuredClone(synthesisBase);
    prospective.messages[prospective.messages.length - 1] = advisory(context);
    const needsSummaries = !await fits(prospective, judge, analysisCap);
    let summaryIds = [];
    let summaryBudget = 0;
    if (needsSummaries) {
      // Structured output and technical action payloads are immutable, not prose.
      const prose = (response) => {
        if (["json_schema", "json_object"].includes(answerFormat?.type)
          || typeof response.content !== "string" || !response.content.length) return false;
        try {
          JSON.parse(response.content);
          return false;
        } catch { /* ordinary prose */ }
        return true;
      };
      summaryIds = responses.filter(prose).map(({ id }) => id);
      const immutable = { ...context, responses: responses.map((response) => prose(response) ? { ...response, content: "" } : response) };
      const minimum = structuredClone(synthesisBase);
      minimum.messages[minimum.messages.length - 1] = advisory(immutable);
      summaryBudget = Math.floor(judgeLimits.contextWindow * FUSION_CONTEXT_ALLOWANCE)
        - estimateFusionRequest(minimum).tokens - outputReserve(original, judgeLimits) - analysisCap;
      if (!summaryIds.length || summaryBudget <= 0) throw budgetError(stage);
      const schema = structuredClone(FUSION_ANALYST_SCHEMA);
      schema.required.push("panel_summaries");
      schema.properties.panel_summaries = {
        type: "object", additionalProperties: false, required: summaryIds,
        properties: Object.fromEntries(summaryIds.map((id) => [id, { type: "string", minLength: 1, maxLength: summaryBudget * 3 }])),
      };
      analysisRequest.response_format.json_schema.schema = schema;
      addInstruction(analysisRequest, `${FUSION_SUMMARY_INSTRUCTIONS}\nSummarize only these response IDs: ${JSON.stringify(summaryIds)}. Shared summary token budget: ${summaryBudget}.`);
    }
    const evaluated = await complete(analysisRequest, judge, stage);
    if (["length", "max_tokens", "content_filter"].includes(evaluated.choices[0].finish_reason) || evaluated.choices[0].message.refusal) {
      if (needsSummaries) throw budgetError(stage);
      throw new FusionError("Analyst did not complete a valid evaluation", stage);
    }
    let analysis;
    try {
      const value = JSON.parse(evaluated.choices[0].message.content);
      if (needsSummaries) {
        const summaries = value.panel_summaries;
        if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)
          || Object.keys(summaries).length !== summaryIds.length
          || summaryIds.some((id) => typeof summaries[id] !== "string" || !summaries[id].trim())
          || estimateFusionRequest(summaries).tokens > summaryBudget) throw budgetError(stage);
        for (const response of responses) if (summaryIds.includes(response.id)) response.content = summaries[response.id];
        delete value.panel_summaries;
      }
      analysis = validateFusionAnalysis(value, responses.map(({ id }) => id));
      if (evaluated.choices[0].message.tool_calls?.length) throw new Error("Analyst must not call tools");
    } catch (error) {
      if (error instanceof FusionError) throw error;
      if (needsSummaries) throw budgetError(stage);
      throw new FusionError(`Invalid Fusion analysis: ${error.message}`, stage);
    }
    stage = "synthesis";
    const synthesis = structuredClone(original);
    synthesis.stream = body.stream === true;
    if (body.stream_options && synthesis.stream) synthesis.stream_options = structuredClone(body.stream_options);
    addInstruction(synthesis, FUSION_SYNTHESIS_INSTRUCTIONS);
    synthesis.messages.push(advisory({ ...context, analysis }));
    const requiresAction = original.tool_choice === "required" || typeof original.tool_choice === "object";
    if (!synthesis.stream || (!analysis.usable_response_ids.length && (requiresAction || answerFormat))) {
      const completion = await complete(synthesis, judge, stage);
      if (completion.choices[0].message.tool_calls?.length && ["length", "max_tokens", "content_filter"].includes(completion.choices[0].finish_reason)) {
        throw new FusionError("Truncated tool output", stage, { code: "fusion_tool_output_truncated" });
      }
      try {
        validatePublicAction(completion, original, validators, stage);
        validateAnswer(completion);
      } catch (error) {
        if (!analysis.usable_response_ids.length) {
          throw new FusionError("No usable action satisfies the client constraints", stage, { code: "fusion_no_usable_action", retryable: false });
        }
        throw error;
      }
      return deliverFusionCompletion(completion, { sourceFormat: outputFormat, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true });
    }
    const response = await invoke(synthesis, judge, stage, outputFormat);
    handedOff = true;
    // ponytail: streamed text/schema correctness is provider-enforced; buffer the
    // final completion when full precommit answer validation becomes necessary.
    return guardFusionStream(response, {
      sourceFormat: outputFormat, signal: controller.signal, log,
      validate: (completion) => validatePublicAction(completion, original, validators, stage),
      abort: (reason) => controller.abort(reason),
      detach: () => signal?.removeEventListener("abort", onAbort),
    });
  } catch (error) {
    const clientAborted = signal?.aborted;
    if (!controller.signal.aborted) controller.abort(error);
    const failure = safeFusionError(clientAborted ? null : error, stage, clientAborted ? "fusion_aborted" : `fusion_${stage}_error`);
    logFusionFailure(log, failure, outputFormat);
    return new Response(JSON.stringify({ error: failure }), {
      status: clientAborted ? 499 : error instanceof FusionError ? error.status : stage === "preflight" ? 400 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    // Active native synthesis keeps the parent signal until its stream terminates.
    if (!handedOff) signal?.removeEventListener("abort", onAbort);
  }
}

function validatePublicAction(completion, request, validators, stage = "initial") {
  const calls = completion.choices[0].message.tool_calls || [];
  const required = request.tool_choice === "required" || typeof request.tool_choice === "object";
  const named = request.tool_choice?.function?.name;
  if ((request.tool_choice === "none" && calls.length) || (required && !calls.length)
    || (named && calls.some((call) => call.function?.name !== named))
    || (request.parallel_tool_calls === false && calls.length > 1)) {
    throw new FusionError("Judge action violates client tool constraints", stage, { code: "fusion_tool_constraints" });
  }
  if (candidate(completion, request.tools, request, validators).issues.length) throw new FusionError("Judge returned invalid application calls", stage, { code: "fusion_invalid_tool_calls" });
}
