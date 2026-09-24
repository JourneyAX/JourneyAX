"use client";

/**
 * Integrations & Adapters — the REAL per-project platform switch (B3, P5-07).
 *
 * Replaces the old static "Connected" board. Configures:
 *  1. Which platform backs each agent domain (knowledge/commerce →
 *     standalone | commercetools) — resolved at runtime by the adapter registry
 *     from the PUBLISHED config, so switching platforms is config, not code.
 *  2. The commercetools connection (projectKey, clientId/secret, api/auth URLs,
 *     search locale) — stored on the project, never in env.
 *  3. Test connection — a live OAuth + product query against commercetools.
 *
 * Remember: the runtime reads the PUBLISHED config. Save here, then Publish
 * (header) for the agent to actually switch.
 */
import React, { useEffect, useState } from "react";
import { Plug, Save, FlaskConical } from "lucide-react";
import { projectApi, type Project } from "../lib/api";
import { Connectors } from "./Connectors";

const DOMAINS: { id: 'knowledge' | 'commerce'; label: string; hint: string }[] = [
  { id: 'knowledge', label: 'Knowledge / retrieval', hint: "What the agent's searchKnowledge queries — the grounding source for recommendations." },
  { id: 'commerce', label: 'Commerce / cart', hint: 'Catalogue, pricing, cart & checkout actions.' },
];

const PLATFORM_OPTIONS = [
  { id: 'standalone', label: 'JourneyAX (internal)', available: true },
  { id: 'commercetools', label: 'commercetools', available: true },
  { id: 'shopify', label: 'Shopify', available: false },
  { id: 'woocommerce', label: 'WooCommerce', available: false },
];

export function IntegrationsConfig({ project, onSaved, onNavigate }: { project: Project; onSaved: () => void; onNavigate?: (tab: "integrations" | "channels") => void }) {
  const ct0 = project.integrations?.commercetools || { enabled: false };
  const plat0 = project.integrations?.platforms || {};

  const [platforms, setPlatforms] = useState<{ knowledge?: string; commerce?: string }>(plat0);
  const [ct, setCt] = useState({
    projectKey: ct0.projectKey || "",
    connectionRef: ct0.connectionRef || "",
    flowId: ct0.flowId || "",
    pieceId: ct0.pieceId || "@activepieces/piece-commercetools",
    searchLocale: ct0.searchLocale || "en-AU",
  });
  const [installedConnections, setInstalledConnections] = useState<
    { connectionRef: string; name: string }[]
  >([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = project.integrations?.commercetools || ({} as any);
    setPlatforms(project.integrations?.platforms || {});
    setCt({
      projectKey: c.projectKey || "",
      connectionRef: c.connectionRef || "",
      flowId: c.flowId || "",
      pieceId: c.pieceId || "@activepieces/piece-commercetools",
      searchLocale: c.searchLocale || "en-AU",
    });
    setTestResult(null);

    // Fetch server-verified installed connections owned by this tenant
    setLoadingConnections(true);
    fetch(`/api/integrations/connections?projectId=${project.projectId}`)
      .then((res) => (res.ok ? res.json() : { connections: [] }))
      .then((data) => {
        setInstalledConnections(data.connections || []);
      })
      .catch(() => {
        setInstalledConnections([]);
      })
      .finally(() => {
        setLoadingConnections(false);
      });
  }, [project.projectId]);

  const ctUsed = platforms.knowledge === 'commercetools' || platforms.commerce === 'commercetools';

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await projectApi.update(project.projectId, {
        integrations: {
          platforms,
          commercetools: { enabled: ctUsed, ...ct },
        },
      });
      setSaved(true); onSaved();
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setError(e.message || 'Save failed.'); }
    finally { setSaving(false); }
  }

  async function testConnection() {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/integrations/test-commercetools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectKey: ct.projectKey,
          connectionRef: ct.connectionRef,
          flowId: ct.flowId,
          pieceId: ct.pieceId,
        }),
      });
      const data = await res.json();
      setTestResult({ ok: res.ok && data.ok, message: data.message || (res.ok ? 'Connected.' : `HTTP ${res.status}`) });
    } catch (e: any) { setTestResult({ ok: false, message: e.message }); }
    finally { setTesting(false); }
  }


  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Integrations &amp; Adapters</h1>
          <p className="pagesub">
            Which platform backs each agent capability for <b>{project.companyName}</b>. Saved to the draft —
            <b> Publish</b> (header) to switch the live runtime.
          </p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "#B7392D", color: "#B7392D" }}>{error}</div>}

      {/* Connectors gallery — visual front door for the dropdown-driven config below */}
      <Connectors onNavigate={onNavigate} />

      {/* Per-domain platform switch */}
      <div className="panel">
        <h4><Plug size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Platform per capability</h4>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          The agent resolves these at runtime from the published config — switching platform is configuration, not code.
        </p>
        <div className="form-grid">
          {DOMAINS.map((d) => (
            <div key={d.id}>
              <span className="flabel">{d.label}</span>
              <select
                className="field"
                value={platforms[d.id] || 'standalone'}
                onChange={(e) => setPlatforms((p) => ({ ...p, [d.id]: e.target.value }))}
              >
                {PLATFORM_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.available}>
                    {o.label}{!o.available ? ' (coming soon)' : ''}
                  </option>
                ))}
              </select>
              <span className="micro" style={{ color: "var(--jx-gray-500)" }}>{d.hint}</span>
            </div>
          ))}
        </div>
      </div>

      {/* commercetools connection */}
      <div className="panel" style={{ opacity: ctUsed ? 1 : 0.65 }}>
        <div className="between">
          <h4>commercetools connection (Activepieces plane)</h4>
          <span className={`pill ${ctUsed ? 'p-active' : 'p-offline'}`}>{ctUsed ? 'In use' : 'Not selected above'}</span>
        </div>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          Select an installed Activepieces connection reference. Provider credentials and tokens remain strictly within Activepieces and are never exposed to the browser.
        </p>
        <div className="form-grid">
          <div><span className="flabel">Project key</span>
            <input className="field" value={ct.projectKey} onChange={(e) => setCt({ ...ct, projectKey: e.target.value })} placeholder="my-store-dev" /></div>
          <div><span className="flabel">Search locale</span>
            <input className="field" value={ct.searchLocale} onChange={(e) => setCt({ ...ct, searchLocale: e.target.value })} placeholder="en-AU" /></div>
          <div>
            <span className="flabel">Activepieces Connection Reference</span>
            <select
              className="field"
              value={ct.connectionRef}
              onChange={(e) => setCt({ ...ct, connectionRef: e.target.value })}
              disabled={loadingConnections}
            >
              <option value="">
                {loadingConnections
                  ? "Loading connections…"
                  : installedConnections.length === 0
                  ? "-- No installed connections found for tenant --"
                  : "-- Select installed connection --"}
              </option>
              {installedConnections.map((c) => (
                <option key={c.connectionRef} value={c.connectionRef}>
                  {c.name || c.connectionRef} ({c.connectionRef})
                </option>
              ))}
            </select>
          </div>
          <div><span className="flabel">Activepieces Flow ID (optional)</span>
            <input className="field" value={ct.flowId} onChange={(e) => setCt({ ...ct, flowId: e.target.value })} placeholder="flow_ct_sync" /></div>
        </div>
        <div className="between" style={{ marginTop: 12 }}>
          <span className="micro" style={{ color: testResult ? (testResult.ok ? '#1F8A4C' : '#B7392D') : 'var(--jx-gray-500)' }}>
            {testing ? 'Testing…' : testResult ? testResult.message : ''}
          </span>
          <button className="btn" onClick={testConnection} disabled={testing || !ct.connectionRef}>
            <FlaskConical size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Test connection
          </button>
        </div>
      </div>
    </>
  );
}
