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

export function IntegrationsConfig({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const ct0 = project.integrations?.commercetools || { enabled: false };
  const plat0 = project.integrations?.platforms || {};

  const [platforms, setPlatforms] = useState<{ knowledge?: string; commerce?: string }>(plat0);
  const [ct, setCt] = useState({
    projectKey: ct0.projectKey || "",
    clientId: ct0.clientId || "",
    clientSecret: ct0.clientSecret || "",
    apiUrl: ct0.apiUrl || "https://api.australia-southeast1.gcp.commercetools.com",
    authUrl: ct0.authUrl || "https://auth.australia-southeast1.gcp.commercetools.com",
    searchLocale: ct0.searchLocale || "en-AU",
  });
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
      clientId: c.clientId || "",
      clientSecret: c.clientSecret || "",
      apiUrl: c.apiUrl || "https://api.australia-southeast1.gcp.commercetools.com",
      authUrl: c.authUrl || "https://auth.australia-southeast1.gcp.commercetools.com",
      searchLocale: c.searchLocale || "en-AU",
    });
    setTestResult(null);
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
        body: JSON.stringify(ct),
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
          <h4>commercetools connection</h4>
          <span className={`pill ${ctUsed ? 'p-active' : 'p-offline'}`}>{ctUsed ? 'In use' : 'Not selected above'}</span>
        </div>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
          Create an API client in the Merchant Center (scope <code>view_products</code>) and paste its credentials.
          Stored per-project in the database — never in code or env.
        </p>
        <div className="form-grid">
          <div><span className="flabel">Project key</span>
            <input className="field" value={ct.projectKey} onChange={(e) => setCt({ ...ct, projectKey: e.target.value })} placeholder="my-store-dev" /></div>
          <div><span className="flabel">Search locale</span>
            <input className="field" value={ct.searchLocale} onChange={(e) => setCt({ ...ct, searchLocale: e.target.value })} placeholder="en-AU" /></div>
          <div><span className="flabel">Client ID</span>
            <input className="field" value={ct.clientId} onChange={(e) => setCt({ ...ct, clientId: e.target.value })} /></div>
          <div><span className="flabel">Client secret</span>
            <input className="field" type="password" value={ct.clientSecret} onChange={(e) => setCt({ ...ct, clientSecret: e.target.value })} /></div>
          <div><span className="flabel">API URL</span>
            <input className="field" value={ct.apiUrl} onChange={(e) => setCt({ ...ct, apiUrl: e.target.value })} /></div>
          <div><span className="flabel">Auth URL</span>
            <input className="field" value={ct.authUrl} onChange={(e) => setCt({ ...ct, authUrl: e.target.value })} /></div>
        </div>
        <div className="between" style={{ marginTop: 12 }}>
          <span className="micro" style={{ color: testResult ? (testResult.ok ? '#1F8A4C' : '#B7392D') : 'var(--jx-gray-500)' }}>
            {testing ? 'Testing…' : testResult ? testResult.message : ''}
          </span>
          <button className="btn" onClick={testConnection} disabled={testing || !ct.projectKey || !ct.clientId || !ct.clientSecret}>
            <FlaskConical size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Test connection
          </button>
        </div>
      </div>
    </>
  );
}
