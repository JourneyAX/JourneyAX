"use client";

import React, { useState } from 'react';
import { onboardCustomer } from '../lib/api';
import { authedFetch } from '../lib/authed-fetch';

/**
 * OnboardWizard — creates a new customer (org) + its first tenant/workspace
 * (project) in one step, then hands back the new projectId so the console can
 * switch to it. Detailed config (catalogue scope, connectors, LLM, prompts,
 * rules) is done afterwards in the per-tenant tabs.
 */
export function OnboardWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [form, setForm] = useState({
    companyName: '',
    domain: '',
    ownerFullName: '',
    ownerEmail: '',
    currency: 'AUD',
    primaryColor: '#FFD600',
    accentColor: '#0A0A0A',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Brand probe: look the site up, then let the operator confirm/override.
  // Nothing found is auto-applied silently — findings are shown as editable
  // fields plus any warnings the probe raised.
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<any>(null);
  const [useLogo, setUseLogo] = useState(true);

  async function lookup() {
    if (!form.domain.trim()) return;
    setProbing(true); setError(null); setProbe(null);
    try {
      const r = await authedFetch('/api/onboarding/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: form.domain.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setProbe(data);
      setForm((f) => ({
        ...f,
        companyName: f.companyName || data.siteName || '',
        primaryColor: data.primaryColor || f.primaryColor,
      }));
    } catch (e: any) {
      setError(`Couldn't read that site: ${e.message}`);
    } finally { setProbing(false); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const canSubmit = form.companyName && form.domain && form.ownerFullName && form.ownerEmail && !busy;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const { projectId } = await onboardCustomer({
        ...form,
        logoUrl: useLogo ? (probe?.logoUrl || probe?.faviconUrl || undefined) : undefined,
        sources: (probe?.suggestedSources || []).map((s: any, i: number) => ({
          id: `source-${i + 1}`, type: s.type, label: s.label, role: s.role || 'product',
          enabled: true, sitemapUrl: s.sitemapUrl, url: s.url,
        })),
      });
      onCreated(projectId);
    } catch (e: any) {
      setError(e.message || 'Failed to onboard customer.');
    } finally {
      setBusy(false);
    }
  }


  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '520px', background: 'var(--jx-white)', borderRadius: '16px', padding: '26px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--jx-black)' }}>Onboard a customer</h2>
        <p style={{ fontSize: '13px', color: 'var(--jx-gray-600)', marginTop: '4px', marginBottom: '18px' }}>
          Creates the organization (billing) and its first workspace. You'll configure catalogue, connectors, LLM and prompts next, in the workspace tabs.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
          <div>
            <span className="flabel">Company name</span>
            <input className="field" value={form.companyName} onChange={set('companyName')} placeholder="Caroma" autoFocus />
          </div>
          <div>
            <span className="flabel">Website</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="field" style={{ flex: 1, width: 'auto' }} value={form.domain} onChange={set('domain')}
                placeholder="caroma.com"
                onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
              />
              <button
                onClick={lookup} disabled={!form.domain.trim() || probing}
                style={{ border: '1px solid var(--jx-gray-300)', background: 'var(--jx-white)', color: 'var(--jx-gray-800)', padding: '0 14px', borderRadius: '9px', fontSize: '13px', fontWeight: 600, cursor: form.domain.trim() && !probing ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}
              >
                {probing ? 'Reading…' : 'Look up'}
              </button>
            </div>
            <p className="micro" style={{ color: 'var(--jx-gray-500)', marginTop: 4 }}>
              Reads the site for its name, logo and catalogue. Everything found is shown below for you to confirm.
            </p>
          </div>

          {probe && (
            <div style={{ border: '1px solid var(--jx-gray-200)', borderRadius: 10, padding: 12, background: 'var(--jx-gray-50)' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {(probe.logoUrl || probe.faviconUrl) ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={probe.logoUrl || probe.faviconUrl} alt="Logo found on the site"
                    style={{ width: 44, height: 44, objectFit: 'contain', background: 'var(--jx-white)', border: '1px solid var(--jx-gray-200)', borderRadius: 8, opacity: useLogo ? 1 : 0.35 }}
                  />
                ) : (
                  <div className="micro" style={{ color: 'var(--jx-gray-500)' }}>No logo found</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {(probe.logoUrl || probe.faviconUrl) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={useLogo} onChange={(e) => setUseLogo(e.target.checked)} />
                      Use this logo
                    </label>
                  )}
                  {probe.siteName && <div className="micro" style={{ color: 'var(--jx-gray-600)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{probe.siteName}</div>}
                </div>
              </div>

              {probe.suggestedSources?.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--jx-gray-200)', paddingTop: 9 }}>
                  <span className="flabel" style={{ margin: 0 }}>Knowledge source to create</span>
                  {probe.suggestedSources.map((s: any, i: number) => (
                    <div key={i} className="micro" style={{ color: 'var(--jx-gray-600)', marginTop: 4, wordBreak: 'break-all' }}>
                      {s.label} — <code>{s.sitemapUrl || s.url}</code>
                    </div>
                  ))}
                  <p className="micro" style={{ color: 'var(--jx-gray-500)', marginTop: 6 }}>
                    Saved to the Knowledge tab; ingestion is started manually from there.
                  </p>
                </div>
              )}

              {probe.warnings?.length > 0 && probe.warnings.map((w: string, i: number) => (
                <div key={i} className="micro" style={{ color: '#8A6D00', marginTop: 8 }}>{w}</div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <span className="flabel">Owner name</span>
              <input className="field" value={form.ownerFullName} onChange={set('ownerFullName')} placeholder="Jane Smith" />
            </div>
            <div style={{ flex: 1 }}>
              <span className="flabel">Owner email</span>
              <input className="field" value={form.ownerEmail} onChange={set('ownerEmail')} placeholder="jane@caroma.com" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <span className="flabel">Currency</span>
              <select className="field" value={form.currency} onChange={set('currency')}>
                <option>AUD</option><option>USD</option><option>GBP</option><option>EUR</option><option>NZD</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className="flabel">Brand colour</span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="color" value={form.primaryColor} onChange={set('primaryColor')} style={{ width: '42px', height: '38px', border: '1px solid var(--jx-gray-300)', borderRadius: '8px', background: 'none', cursor: 'pointer' }} />
                <input className="field" style={{ flex: 1, width: 'auto' }} value={form.primaryColor} onChange={set('primaryColor')} />
              </div>
            </div>
          </div>

          {error && (
            <div style={{ fontSize: '12.5px', color: '#B7392D', background: 'rgba(183,57,45,0.08)', border: '1px solid rgba(183,57,45,0.25)', borderRadius: '8px', padding: '9px 11px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '6px' }}>
            <button onClick={onClose} disabled={busy} style={{ border: '1px solid var(--jx-gray-300)', background: 'var(--jx-white)', color: 'var(--jx-gray-700)', padding: '10px 16px', borderRadius: '9px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={submit} disabled={!canSubmit} style={{ border: 'none', background: canSubmit ? 'var(--jx-yellow)' : 'var(--jx-gray-200)', color: 'var(--jx-black)', padding: '10px 18px', borderRadius: '9px', fontSize: '13px', fontWeight: 700, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
              {busy ? 'Creating…' : 'Create workspace →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
