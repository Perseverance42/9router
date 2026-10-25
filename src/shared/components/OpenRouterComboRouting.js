"use client";

import { useEffect, useState } from "react";
import { resolveProviderId } from "@/shared/constants/providers";
import { OPENROUTER_PRECISION_PRESETS, OPENROUTER_QUANTIZATIONS } from "open-sse/config/openrouterRouting.js";
import { normalizeOpenRouterComboRouting, resolveOpenRouterComboRouting } from "open-sse/services/openrouterRouting.js";

const SELECT_CLASS = "w-full rounded border border-border bg-bg px-2 py-1.5 text-xs";

// Resolve aliases and nested combos without mistaking a model's vendor for its connection.
export function hasOpenRouterMember(models, aliases = {}, comboByName = {}, seen = new Set()) {
  return models.some((model) => {
    if (typeof model !== "string" || seen.has(model)) return false;
    const next = new Set(seen).add(model);
    const nested = comboByName[model];
    if (nested) return hasOpenRouterMember(Array.isArray(nested) ? nested : nested.models || [], aliases, comboByName, next);
    const alias = aliases[model];
    if (alias) return hasOpenRouterMember([typeof alias === "string" ? alias : `${alias.provider}/${alias.model}`], aliases, comboByName, next);
    return resolveProviderId(model.split("/")[0]) === "openrouter";
  });
}

export function useOpenRouterComboRouting({ isOpen, combo, models, activeProviders = [], modelAliases = {}, comboByName }) {
  const [routing, setRouting] = useState(combo?.openrouterRouting ?? null);
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState("");
  const [policy, setPolicy] = useState(undefined);
  const [policyError, setPolicyError] = useState("");
  const [retry, setRetry] = useState(0);
  const active = combo?.kind !== "video" && activeProviders.some((c) => c.provider === "openrouter" && c.isActive !== false);
  const needsMetadata = active && models.some((m) => typeof m === "string" && !m.includes("/"));

  useEffect(() => {
    if (!isOpen || !needsMetadata) return;
    let cancelled = false;
    Promise.all([fetch("/api/models/alias"), comboByName ? null : fetch("/api/combos")])
      .then(async ([aliasesRes, combosRes]) => {
        if (!aliasesRes.ok || (combosRes && !combosRes.ok)) throw new Error("Failed to resolve OpenRouter combo members.");
        const aliases = await aliasesRes.json();
        const combos = combosRes ? await combosRes.json() : null;
        if (!cancelled) {
          setMetadata({ aliases: aliases.aliases || {}, combos: comboByName || Object.fromEntries((combos?.combos || []).map((c) => [c.name, c.models])) });
          setMetadataError("");
        }
      }).catch((error) => { if (!cancelled) setMetadataError(error.message); });
    return () => { cancelled = true; };
  }, [isOpen, needsMetadata, comboByName, retry]);

  const visible = active && hasOpenRouterMember(models, { ...modelAliases, ...metadata?.aliases }, comboByName || metadata?.combos);
  const unresolved = needsMetadata && (!metadata || !!metadataError);
  useEffect(() => {
    if (!isOpen || !visible) return;
    let cancelled = false;
    fetch("/api/providers/openrouter/overrides")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load inherited OpenRouter policy.");
        const data = await res.json();
        if (!("routing" in data)) throw new Error("OpenRouter policy response is missing routing.");
        if (!cancelled) {
          setPolicy(data.routing ?? null);
          setPolicyError("");
        }
      }).catch((error) => { if (!cancelled) setPolicyError(error.message); });
    return () => { cancelled = true; };
  }, [isOpen, visible, retry]);

  return { routing, onChange: setRouting, policy, visible, blocked: unresolved || (visible && (policy === undefined || !!policyError)),
    error: (needsMetadata ? metadataError : "") || (visible ? policyError : ""), pending: unresolved || (visible && policy === undefined), onRetry: () => {
      setMetadata(null);
      setMetadataError("");
      setPolicy(undefined);
      setPolicyError("");
      setRetry((n) => n + 1);
    } };
}

export default function OpenRouterComboRouting({ routing, onChange, policy, visible, blocked, pending, error, onRetry, disabled }) {
  const [custom, setCustom] = useState(false);
  if (!visible && !pending && !error) return null;
  const effective = policy === undefined ? null : resolveOpenRouterComboRouting(policy, routing) || {};
  const formats = routing?.quantizations;
  const preset = formats === undefined ? "inherit" : Object.keys(OPENROUTER_PRECISION_PRESETS).find((key) => JSON.stringify(OPENROUTER_PRECISION_PRESETS[key]) === JSON.stringify(formats)) || "custom";
  const patch = (key, value) => {
    const next = { ...routing };
    if (value === undefined) delete next[key]; else next[key] = value;
    onChange(normalizeOpenRouterComboRouting(next));
  };
  return (
    <section className="rounded-lg border border-border p-3 space-y-3" aria-label="OpenRouter routing overrides">
      <div className="text-sm font-medium">OpenRouter routing</div>
      <p className="text-xs text-text-muted">Applies only to OpenRouter members, not other providers in this combo. This is not a combo-wide ZDR guarantee.</p>
      <p className="text-xs text-text-muted">Precision filters apply only to supported upstream routes. Nested combos may override precision again; ZDR requirements and blocked exceptions accumulate.</p>
      {error ? <div role="alert" className="text-xs text-red-500">{error} <button type="button" onClick={onRetry} className="underline">Retry</button></div> : pending && <p role="status" className="text-xs text-text-muted">Loading inherited routing policy…</p>}
      {visible && <fieldset disabled={blocked || disabled} className="space-y-3 disabled:opacity-60">
        <label className="block text-xs">Precision
          <select className={SELECT_CLASS} value={custom ? "custom" : preset} onChange={(e) => {
            const value = e.target.value;
            setCustom(value === "custom");
            patch("quantizations", value === "inherit" ? undefined : value === "custom" ? (formats?.length ? formats : effective?.quantizations?.length ? effective.quantizations : ["fp8"]) : OPENROUTER_PRECISION_PRESETS[value]);
          }}>
            <option value="inherit">Inherit provider</option>
            <option value="unrestricted">Unrestricted</option>
            <option value="eightBit">8-bit and above</option>
            <option value="sixteenBit">16-bit and above</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {(custom || preset === "custom") && <div className="flex flex-wrap gap-2" role="group" aria-label="Allowed precision formats">
          {OPENROUTER_QUANTIZATIONS.map((format) => <label key={format} className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={formats?.includes(format) || false} disabled={formats?.length === 1 && formats.includes(format)} onChange={(e) => patch("quantizations", e.target.checked ? [...(formats || []), format] : formats.filter((f) => f !== format))} />{format === "unknown" ? "unknown (unreported precision)" : format}
          </label>)}
        </div>}
        <label className="block text-xs">Zero data retention
          <select className={SELECT_CLASS} value={policy?.zdr ? "required" : routing?.zdr === true ? "require" : "inherit"} disabled={policy?.zdr === true} onChange={(e) => patch("zdr", e.target.value === "require" ? true : undefined)}>
            {policy?.zdr ? <option value="required">Required by provider</option> : <><option value="inherit">Inherit provider</option><option value="require">Require ZDR</option></>}
          </select>
        </label>
        <p className="text-xs text-text-muted">Exceptions matter only when ZDR is required. Video generation is incompatible with ZDR; dedicated image-generation enforcement is unverified.</p>
        {[["allowImageWithoutZdr", "Image without ZDR"], ["allowVideoWithoutZdr", "Video without ZDR"]].map(([key, label]) => <label key={key} className="block text-xs">{label}{policy?.[key] !== true && " — no provider exception"}
          <select className={SELECT_CLASS} disabled={policy?.[key] !== true} value={routing?.[key] === undefined ? "inherit" : String(routing[key])} onChange={(e) => patch(key, e.target.value === "inherit" ? undefined : e.target.value === "true")}>
            <option value="inherit">Inherit provider</option><option value="false">Block</option><option value="true">Allow</option>
          </select>
        </label>)}
        {effective && <p className="text-xs text-text-muted">Effective OpenRouter policy: precision {effective.quantizations?.length ? effective.quantizations.join(", ") : "unrestricted"}; ZDR {effective.zdr ? "required" : "not required"}; image exception {effective.allowImageWithoutZdr ? "allowed" : "blocked"}; video exception {effective.allowVideoWithoutZdr ? "allowed" : "blocked"}.</p>}
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setCustom(false); onChange(null); }}>Reset to inherited</button>
      </fieldset>}
    </section>
  );
}
