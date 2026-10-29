"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const STATUS = {
  missing: ["Needs configuration", "bg-amber-500"],
  invalid: ["Configuration invalid", "bg-red-500"],
  ready: ["Backend ready", "bg-green-500"],
  not_ready: ["Backend not ready", "bg-amber-500"],
  unreachable: ["Backend unreachable", "bg-red-500"],
};

export default function RouteweaveConnection({ compact = false }) {
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState({ url: "", uiUrl: "", token: "", mode: "active_required", decisionTimeoutMs: 35000, allowlist: "{}" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load(replaceForm = true) {
    const response = await fetch("/api/settings/routeweave", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Unable to load RouteWeave settings");
    setConnection(data);
    if (replaceForm) setForm({ url: data.url || "", uiUrl: data.uiUrl || "", token: "", mode: data.mode || "active_required", decisionTimeoutMs: data.decisionTimeoutMs || 35000, allowlist: JSON.stringify(data.allowlist || {}, null, 2) });
  }
  // load updates state only after the settings fetch resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load().catch(cause => setError(cause.message)); }, []);

  async function save(event) {
    event.preventDefault();
    if (!connection || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      let allowlist;
      try { allowlist = JSON.parse(form.allowlist); } catch { throw Error("Candidate allowlist must be valid JSON."); }
      const response = await fetch("/api/settings/routeweave", { method: "PUT", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, decisionTimeoutMs: Number(form.decisionTimeoutMs), allowlist }) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Unable to save RouteWeave settings");
      field("token", "");
      await load(); setMessage("Connection saved. Only combos selecting RouteWeave use it.");
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError("");
    try { await load(!connection); } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm("Remove the saved RouteWeave connection? Environment settings will apply again. Without valid environment settings, RouteWeave combos will stop accepting requests.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/settings/routeweave", { method: "DELETE", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error("Unable to remove saved RouteWeave connection");
      await load(); setMessage("Saved connection removed. Server environment fallback applies.");
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  const [label, color] = error ? ["Status unavailable", "bg-red-500"] : STATUS[connection?.status] || [connection ? "Status unknown" : "Checking backend…", "bg-text-muted"];
  const link = connection?.uiUrl || connection?.url;
  const safeLink = typeof link === "string" && /^https?:\/\//i.test(link) ? link : null;
  const field = (name, value) => setForm(previous => ({ ...previous, [name]: value }));
  const inputClass = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main";

  return (
    <section id="routeweave-connection" aria-label="RouteWeave backend" className="rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold text-text-main">RouteWeave backend</h2><Link href="/dashboard/routeweave" className="mt-1 inline-flex items-center gap-2 rounded-full border border-border px-2 py-1 text-xs text-text-muted"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${color}`} /><span role="status">{label}</span></Link></div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {safeLink && <a href={safeLink} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-primary/30 px-3 py-2 font-medium text-primary hover:bg-primary/10">Open RouteWeave ↗</a>}
          {compact ? <Link href="/dashboard/routeweave" className="font-medium text-primary">Configure backend</Link> : <button type="button" disabled={busy} onClick={check} className="text-primary disabled:opacity-50">Check saved connection</button>}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
      {connection?.error && <p className="mt-3 text-sm text-text-muted">{connection.error}</p>}
      {!compact && <>
        <p className="mt-3 text-sm text-text-muted">One connection shared by RouteWeave combos. Readiness checks do not classify messages or call completion models. Backend readiness does not verify credentials, candidate limits or live inference.</p>
        {connection?.source === "env" && <p className="mt-2 text-xs text-text-muted">Using server environment configuration. Saving here replaces it with dashboard-managed settings.</p>}
        <form onSubmit={save}><fieldset disabled={busy || !connection} className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="text-sm text-text-main">Backend URL<input required type="url" value={form.url} onChange={e => field("url", e.target.value)} placeholder="https://routeweave.example.com" className={`${inputClass} mt-1`} /><span className="mt-1 block text-xs text-text-muted">Server-to-server address. HTTPS required outside loopback; use an HTTPS proxy or local tunnel for a private HTTP service.</span></label>
          <label className="text-sm text-text-main">Configuration UI URL (optional)<input type="url" value={form.uiUrl} onChange={e => field("uiUrl", e.target.value)} placeholder="Defaults to backend URL" className={`${inputClass} mt-1`} /><span className="mt-1 block text-xs text-text-muted">Browser-reachable address when the backend uses an internal hostname. No service token is included in the link.</span></label>
          <label className="text-sm text-text-main">Consumer service token<input type="password" autoComplete="new-password" value={form.token} onChange={e => field("token", e.target.value)} placeholder={connection?.hasToken ? "Configured — leave blank to keep" : "Dedicated RouteWeave consumer token"} className={`${inputClass} mt-1`} /><span className="mt-1 block text-xs text-text-muted">Not the operator login secret. Stored in plaintext on the server and included in privileged database exports; never returned by this settings API.</span></label>
          <label className="text-sm text-text-main">Mode<select value={form.mode} onChange={e => field("mode", e.target.value)} className={`${inputClass} mt-1`}><option value="active_required">Required — fail closed</option><option value="active_advisory">Advisory — admitted-order fallback</option><option value="shadow">Shadow — observe, dispatch configured order</option></select></label>
          <label className="text-sm text-text-main">Decision timeout (milliseconds)<input type="number" required min="100" max="60000" step="1" value={form.decisionTimeoutMs} onChange={e => field("decisionTimeoutMs", e.target.value)} className={`${inputClass} mt-1`} /></label>
          <div className="sm:col-span-2"><label htmlFor="routeweave-allowlist" className="text-sm text-text-main">Authoritative candidate limits (JSON)</label><textarea id="routeweave-allowlist" required rows={9} spellCheck={false} value={form.allowlist} onChange={e => field("allowlist", e.target.value)} className={`${inputClass} mt-1 font-mono text-xs`} /><p className="mt-1 text-xs text-text-muted">Exact gateway model IDs mapped to certified limits: text, context_tokens, max_output_tokens, tokens_per_byte and template_tokens. Unknown candidates are excluded; limits are operator assertions, not inferred capabilities.</p><pre className="mt-2 overflow-auto rounded-lg bg-surface-2 p-3 text-xs text-text-muted">{'{"openai/example":{"text":true,"context_tokens":32768,"max_output_tokens":4096,"tokens_per_byte":1,"template_tokens":1024}}'}</pre><p className="mt-1 text-xs text-text-muted">Illustrative values only. Verify bounds for your actual routes before enabling traffic.</p></div>
          <div className="sm:col-span-2"><button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Working…" : "Save connection"}</button>{connection?.source === "settings" && <button type="button" onClick={clear} className="ml-3 text-sm text-red-500">Remove saved connection</button>}{message && <p role="status" className="mt-2 text-sm text-text-muted">{message}</p>}</div>
        </fieldset></form>
      </>}
    </section>
  );
}
