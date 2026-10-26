import { randomInt } from "node:crypto";
import { FORMATS } from "../translator/formats.js";
import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";
import { extractReasoningText } from "../translator/concerns/reasoning.js";
import { translateRequest } from "../translator/index.js";
import { detectFormat } from "./provider.js";
import { deliverFusionCompletion } from "./fusionOutput.js";
import { guardFusionStream } from "./fusionStream.js";
import {
  FUSION_TOOL_NAME, FUSION_ANALYST_SCHEMA, FUSION_ANALYST_MAX_TOKENS,
  FUSION_ANALYST_INSTRUCTIONS, FUSION_SYNTHESIS_INSTRUCTIONS, FUSION_CONSULT_PARAMETERS,
  FUSION_ERROR_MESSAGE_LIMIT, FUSION_TOOL_STATUS_INSTRUCTIONS, resolveFusionPolicy, validateFusionSelection, validateFusionAnalysis,
} from "../config/fusion.js";

class FusionError extends Error {
  constructor(message, stage, details = {}, status = 502) {
    super(message);
    this.stage = stage;
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
function canonicalRequest(body, sourceFormat) {
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
  if (new Set(names).size !== names.length || names.includes(FUSION_TOOL_NAME)) {
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
    return { name, arguments: args };
  });
  if (constraints.tool_choice === "none" && calls.length) issues.push("Tools are disabled by the client");
  if (constraints.parallel_tool_calls === false && calls.length > 1) issues.push("Parallel calls are disabled by the client");
  const forced = constraints.tool_choice?.function?.name;
  if (forced && calls.some((call) => call.name !== forced)) issues.push(`Client requires tool ${forced}`);
  return {
    content: message.content ?? null,
    tool_calls: calls,
    reasoning: extractReasoningText(message) || null,
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

/** One bounded consultation: initial controller, parallel panel, analyst, native synthesis. */
export async function handleFusionChat({ body, models, handleSingleModel, log, judgeModel, tuning, signal, sourceFormat = detectFormat(body), preflight }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let stage = "preflight";
  let handedOff = false;
  const checkAbort = () => controller.signal.throwIfAborted();
  const invoke = async (request, model, callStage, outputFormat = FORMATS.OPENAI) => {
    checkAbort();
    const response = await abortable(() => handleSingleModel(structuredClone(request), model, {
      internal: true, sourceFormat: FORMATS.OPENAI, outputFormat,
      signal: controller.signal, stage: callStage,
    }), controller.signal);
    checkAbort();
    if (!response?.ok) {
      let upstream;
      try { upstream = await abortable(() => response.json(), controller.signal); } catch { /* no safe structured error */ }
      const message = typeof upstream?.error?.message === "string" ? upstream.error.message : "Upstream model call failed";
      throw new FusionError(message.slice(0, FUSION_ERROR_MESSAGE_LIMIT), callStage, { model, upstream_status: response?.status });
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
      throw new FusionError(`Invalid ${callStage} completion: ${error.message}`, callStage, { model });
    }
  };
  try {
    checkAbort();
    const policy = resolveFusionPolicy(models, tuning);
    const judge = judgeModel?.trim() || models[0];
    if (!judge) throw new FusionError("Fusion requires an explicit judge when no panels are configured", stage, {}, 400);
    if (![FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES].includes(sourceFormat)) {
      throw new FusionError(`Unsupported Fusion client format: ${sourceFormat}`, stage, {}, 400);
    }
    const original = canonicalRequest(body, sourceFormat);
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
        try { value = JSON.parse(message.content); } catch { throw new FusionError("Judge answer violates requested JSON output", stage); }
        if (answerFormat.type === "json_object" && (!value || typeof value !== "object" || Array.isArray(value))) {
          throw new FusionError("Judge answer must be a JSON object", stage);
        }
        if (answerValidator && !answerValidator(value)) throw new FusionError("Judge answer violates requested output schema", stage);
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
        name: FUSION_TOOL_NAME,
        description: "Consult selected panel models concurrently in one batch. Supply all selected IDs and a self-contained task brief.",
        parameters: FUSION_CONSULT_PARAMETERS,
      },
    });
    initial.tool_choice = policy.minPanels > 0
      ? { type: "function", function: { name: FUSION_TOOL_NAME } }
      : (policy.maxPanels === 0 ? original.tool_choice : "auto");
    if (policy.maxPanels > 0) delete initial.response_format;
    stage = "initial";
    const first = await complete(initial, judge, stage);
    if (["length", "max_tokens"].includes(first.choices[0].finish_reason)) throw new FusionError("Initial judge completion was truncated", stage);
    const calls = first.choices[0].message.tool_calls || [];
    const consultations = calls.filter((call) => call.function?.name === FUSION_TOOL_NAME);
    if (!consultations.length) {
      if (policy.minPanels > 0) throw new FusionError("Judge skipped required panel consultation", stage);
      // Direct handling must obey the original public contract, not internal auto choice.
      validatePublicAction(first, original, validators);
      validateAnswer(first);
      return deliverFusionCompletion(first, { sourceFormat, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true });
    }
    if (consultations.length !== 1 || calls.length !== 1) throw new FusionError("Consultation must be one call without application calls", stage);
    let args;
    try { args = JSON.parse(consultations[0].function.arguments); }
    catch { throw new FusionError("Invalid consultation argument JSON", stage); }
    let selected;
    try { selected = validateFusionSelection(args, policy); }
    catch (error) { throw new FusionError(error.message, stage); }
    stage = "panel";
    // Start every slot before awaiting any result. The first causal error aborts siblings.
    const pending = selected.map(async (slot) => {
      try {
        const request = structuredClone(base);
        addInstruction(request, "Panel responses are advisory; propose application actions without executing them.");
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
      stream: false, max_tokens: FUSION_ANALYST_MAX_TOKENS,
      response_format: { type: "json_schema", json_schema: { name: "fusion_analysis", strict: false, schema: FUSION_ANALYST_SCHEMA } },
    };
    const evaluated = await complete(analysisRequest, judge, stage);
    if (["length", "max_tokens", "content_filter"].includes(evaluated.choices[0].finish_reason) || evaluated.choices[0].message.refusal) {
      throw new FusionError("Analyst did not complete a valid evaluation", stage);
    }
    let analysis;
    try {
      analysis = validateFusionAnalysis(JSON.parse(evaluated.choices[0].message.content), responses.map(({ id }) => id));
      if (evaluated.choices[0].message.tool_calls?.length) throw new Error("Analyst must not call tools");
    } catch (error) { throw new FusionError(`Invalid Fusion analysis: ${error.message}`, stage); }
    stage = "synthesis";
    const synthesis = structuredClone(original);
    synthesis.stream = body.stream === true;
    if (body.stream_options && synthesis.stream) synthesis.stream_options = structuredClone(body.stream_options);
    addInstruction(synthesis, FUSION_SYNTHESIS_INSTRUCTIONS);
    synthesis.messages.push(advisory({ ...context, analysis }));
    const requiresAction = original.tool_choice === "required" || typeof original.tool_choice === "object";
    if (!synthesis.stream || (!analysis.usable_response_ids.length && (requiresAction || answerFormat))) {
      const completion = await complete(synthesis, judge, stage);
      try {
        validatePublicAction(completion, original, validators, stage);
        validateAnswer(completion);
      } catch (error) {
        if (!analysis.usable_response_ids.length) {
          throw new FusionError("No usable action satisfies the client constraints", stage, { code: "fusion_no_usable_action", retryable: false });
        }
        throw error;
      }
      return deliverFusionCompletion(completion, { sourceFormat, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true });
    }
    const response = await invoke(synthesis, judge, stage, sourceFormat);
    handedOff = true;
    // ponytail: streamed text/schema correctness is provider-enforced; buffer the
    // final completion when full precommit answer validation becomes necessary.
    return guardFusionStream(response, {
      sourceFormat, signal: controller.signal,
      validate: (completion) => validatePublicAction(completion, original, validators, stage),
      abort: (reason) => controller.abort(reason),
      detach: () => signal?.removeEventListener("abort", onAbort),
    });
  } catch (error) {
    const clientAborted = signal?.aborted;
    if (!controller.signal.aborted) controller.abort(error);
    const failure = error instanceof FusionError ? error : new FusionError(error.message || "Fusion execution failed", stage, {}, stage === "preflight" ? 400 : 502);
    log?.warn?.("FUSION", `${failure.stage}: ${failure.message}`);
    return new Response(JSON.stringify({ error: {
      message: clientAborted ? "Request aborted" : failure.message,
      type: "fusion_error", code: clientAborted ? "fusion_aborted" : failure.details.code || `fusion_${failure.stage}_error`,
      details: { stage: failure.stage, ...failure.details },
    } }), { status: clientAborted ? 499 : failure.status, headers: { "Content-Type": "application/json" } });
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
    throw new FusionError("Judge action violates client tool constraints", stage);
  }
  if (candidate(completion, request.tools, request, validators).issues.length) throw new FusionError("Judge returned invalid application calls", stage);
}
