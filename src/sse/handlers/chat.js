import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels, resolveFusionTarget } from "../services/model.js";
import { captureThinking, parseSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import { DEFAULT_SYSTEMONE_ROUTER_MODEL } from "open-sse/services/systemoneRouter.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  let { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  const fusionTarget = await resolveFusionTarget(modelStr, settings);
  modelStr = fusionTarget.model;
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr, { allowEmpty: true });
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        ...fusionExecutionContext(body, clientRawRequest, request, apiKey, keyAccess, comboModels, { comboPath: [modelStr], reasoningIntent: fusionTarget.intent ? { ...captureThinking(body, true), ...fusionTarget.intent } : undefined }),
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[modelStr] || {};
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null);
}

function fusionExecutionContext(body, clientRawRequest, request, apiKey, keyAccess, comboModels, execution = {}) {
  const signal = execution.signal || request?.signal;
  const modelLimits = new Map();
  return {
    signal,
    sourceFormat: execution.sourceFormat || (request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) || undefined : undefined),
    outputFormat: execution.outputFormat,
    internal: execution.internal,
    maxOutputTokens: execution.maxOutputTokens,
    reasoningIntent: execution.reasoningIntent,
    getModelLimits: async (target) => {
      const visit = async (model, path = []) => {
        signal?.throwIfAborted();
        const settings = await getSettings();
        model = (await resolveFusionTarget(model, settings)).model;
        if (path.includes(model)) throw new Error("Invalid Fusion model limits");
        if (modelLimits.has(model)) {
          const cached = modelLimits.get(model);
          if (path.length + cached.depth > 32) throw new Error("Invalid Fusion model limits");
          return cached;
        }
        const info = await getModelInfo(model);
        if (info.provider) {
          const limits = { ...getCapabilitiesForModel(info.provider, info.model), depth: 0 };
          modelLimits.set(model, limits);
          return limits;
        }
        if (path.length >= 32) throw new Error("Invalid Fusion model limits");
        const children = await getComboModels(model, { allowEmpty: true });
        const config = settings.comboStrategies?.[model] || {};
        const judge = (config.fallbackStrategy || settings.comboStrategy) === "fusion" ? config.judgeModel?.trim() || children?.[0] : null;
        const members = [...new Set([...(children || []), ...(judge ? [judge] : [])])];
        if (!members.length) throw new Error("Invalid Fusion model limits");
        // Finish each subtree before visiting siblings so reconvergent DAGs reuse it.
        const limits = [];
        for (const child of members) limits.push(await visit(child, [...path, model]));
        // One logical combo output: conservative ceilings, never a sum of seat outputs.
        const result = {
          contextWindow: Math.min(...limits.map((limit) => limit.contextWindow)),
          maxOutput: Math.min(...limits.map((limit) => limit.maxOutput)),
          depth: Math.max(...limits.map((limit) => limit.depth)) + 1,
        };
        modelLimits.set(model, result);
        return result;
      };
      return visit(target);
    },
    // The outer Fusion checks the entire reachable graph, including nested judges,
    // before dispatch. Runtime routing keeps each combo as one logical target.
    preflight: execution.internal ? undefined : async (models, canonical) => {
      const required = detectRequiredCapabilities(canonical);
      const settings = await getSettings();
      // Cache maximum remaining combo depth so deeper incoming DAG paths stay bounded.
      const completed = new Map();
      const visit = async (targets, members, path) => {
        let maxDepth = 0;
        for (const requestedTarget of targets) {
          signal?.throwIfAborted();
          const target = (await resolveFusionTarget(requestedTarget, settings)).model;
          // A combo grants its members, not an independently configured judge.
          if (!members.includes(requestedTarget)) {
            const denied = await enforceKeyAccess(keyAccess, target);
            if (denied) return denied;
          }
          if (path.includes(target)) throw new Error(`Cyclic or too deeply nested combo: ${target}`);
          if (completed.has(target)) {
            const depth = completed.get(target);
            if (path.length + depth > 32) throw new Error(`Cyclic or too deeply nested combo: ${target}`);
            maxDepth = Math.max(maxDepth, depth);
            continue;
          }
          let depth = 0;
          const info = await getModelInfo(target);
          if (!info.provider) {
            const children = await getComboModels(target, { allowEmpty: true });
            if (!children) throw new Error(`Invalid Fusion target: ${target}`);
            if (path.length >= 32) throw new Error(`Cyclic or too deeply nested combo: ${target}`);
            const cfg = settings.comboStrategies?.[target] || {};
            const strategy = cfg.fallbackStrategy || settings.comboStrategy || "fallback";
            if (strategy === "smart" && children.length > 1) {
              const router = (typeof cfg.routerModel === "string" && cfg.routerModel.trim()) || DEFAULT_SYSTEMONE_ROUTER_MODEL;
              if (!children.includes(router)) {
                const denied = await enforceKeyAccess(keyAccess, router);
                if (denied) return denied;
              }
            }
            const judge = strategy === "fusion" ? cfg.judgeModel?.trim() || children[0] : null;
            const childDepth = await visit([...new Set([...children, ...(judge ? [judge] : [])])], children, [...path, target]);
            if (childDepth instanceof Response) return childDepth;
            depth = childDepth + 1;
          } else {
            const caps = getCapabilitiesForModel(info.provider, info.model);
            for (const capability of ["vision", "pdf", "audioInput", "videoInput"]) {
              if (required.has(capability) && !caps[capability]) throw new Error(`Fusion target ${target} lacks ${capability}`);
            }
          }
          completed.set(target, depth);
          maxDepth = Math.max(maxDepth, depth);
        }
        return maxDepth;
      };
      return visit(models, comboModels, execution.comboPath || []);
    },
    handleSingleModel: (b, m, stageExecution) => handleSingleModelChat(
      b, m, { endpoint: clientRawRequest?.endpoint, headers: { ...clientRawRequest?.headers }, body: structuredClone(b) },
      request, apiKey, null, { ...execution, ...stageExecution },
    ),
  };
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, execution = {}) {
  if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
  if (parseSuffix(modelStr).override) {
    const target = await resolveFusionTarget(modelStr, await getSettings());
    modelStr = target.model;
    if (target.intent && !execution.reasoningIntent) execution = { ...execution, reasoningIntent: { ...captureThinking(body, true), ...target.intent } };
  }
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr, { allowEmpty: true });
    if (comboModels) {
      const path = execution.comboPath || [];
      if (path.includes(modelStr) || path.length >= 32) return errorResponse(400, `Cyclic or too deeply nested combo: ${modelStr}`);
      execution = { ...execution, comboPath: [...path, modelStr] };
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = execution.internal ? comboModels : await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          ...fusionExecutionContext(body, clientRawRequest, request, apiKey, keyAccess, comboModels, execution),
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, execution),
          adapterAdded
        ),
        autoSwitch: !execution.internal,
        internal: execution.internal,
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              signal: execution.signal,
              log,
            })
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, signal: execution.signal });
    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        if (!execution.internal) log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials, { signal: execution.signal });
    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }, { signal: execution.signal }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = execution.internal ? null : (chatSettings.providerThinking || {})[provider] || null;
    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
    const result = await handleChatCore({
      externalSignal: execution.signal,
      internal: execution.internal === true,
      maxOutputTokens: execution.maxOutputTokens,
      reasoningIntent: execution.reasoningIntent,
      responseFormatOverride: execution.outputFormat,
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !execution.internal && !!chatSettings.ccFilterNaming,
      rtkEnabled: !execution.internal && !!chatSettings.rtkEnabled,
      headroomEnabled: !execution.internal && !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !execution.internal && !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !execution.internal && !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      customPromptEnabled: !execution.internal && !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      pxpipeEnabled: !execution.internal && !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: execution.sourceFormat || (request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null),
      onCredentialsRefreshed: async (newCreds, options = {}) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        }, { signal: options.preserveRotatedToken ? undefined : execution.signal });
      },
      onRequestSuccess: async () => {
        if (execution.signal?.aborted) return;
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
    if (result.success) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    if (execution.signal?.aborted) return errorResponse(499, "Request aborted");
    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
