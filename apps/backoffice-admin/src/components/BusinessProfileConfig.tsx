"use client";

import React, { useEffect, useState } from "react";
import { projectApi, type Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

/**
 * BusinessProfileConfig — the Business layer, edited (AUG-17).
 *
 * Defines WHAT KIND of business this tenant is and, critically, WHAT ITS
 * CUSTOMERS BUY FOR. That entity is the one genuinely vertical-specific idea in
 * the platform: a teamwear tenant's customers buy for a "team", a bathroom
 * tenant's for a "room", a workwear tenant's for a "site crew".
 *
 * Setting it here re-words the agent's own tools — so a new vertical is a config
 * change, not a code change.
 */
const ORDER_PATTERNS = [
  { v: "", label: "— not set —" },
  { v: "single-item", label: "Single item" },
  { v: "bulk-roster", label: "Bulk / roster" },
  { v: "project-bundle", label: "Project bundle" },
  { v: "replenishment", label: "Replenishment" },
];

const MAINTENANCE_OPS = [
  { op: "reindex", label: "Rebuild indexes", hint: "Safe and idempotent." },
  { op: "dedupe-sizing-groups", label: "Dedupe sizing groups", hint: "Merges duplicates, fixes a code used in two roles." },
  { op: "purge-directory", label: "Purge team directory", hint: "Removes ingested records. Customer-registered entries are kept." },
];

export function BusinessProfileConfig({ project }: { project: Project }) {
  const b: any = (project as any).business || {};
  const em: any = b.entityModel || {};

  const [form, setForm] = useState({
    type: b.type || "",
    sellsTo: b.sellsTo || "",
    orderPattern: b.orderPattern || "",
    customised: !!b.customised,
    approvalRequired: !!b.approvalRequired,
    entityKey: em.key || "",
    entityLabel: em.label || "",
    entityLabelPlural: em.labelPlural || "",
    askPrompt: em.askPrompt || "",
    hasDirectory: em.hasDirectory !== false,
    allowCreate: em.allowCreate !== false,
    confirmWithCustomer: (em.confirmWithCustomer || []).join(", "),
    captureFields: (em.captureFields || []).map((f: any) => f.label || f.key).join("\n"),
    audience: (b.audience || []).map((a: any) => `${a.role}${a.buysFor ? ` | ${a.buysFor}` : ""}`).join("\n"),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Maintenance state — dry run is the default, always.
  const [maintBusy, setMaintBusy] = useState<string | null>(null);
  const [maintResult, setMaintResult] = useState<any>(null);
  const [maintOp, setMaintOp] = useState<string | null>(null);

  useEffect(() => {
    const nb: any = (project as any).business || {};
    const nem: any = nb.entityModel || {};
    setForm({
      type: nb.type || "", sellsTo: nb.sellsTo || "", orderPattern: nb.orderPattern || "",
      customised: !!nb.customised, approvalRequired: !!nb.approvalRequired,
      entityKey: nem.key || "", entityLabel: nem.label || "", entityLabelPlural: nem.labelPlural || "",
      askPrompt: nem.askPrompt || "", hasDirectory: nem.hasDirectory !== false, allowCreate: nem.allowCreate !== false,
      confirmWithCustomer: (nem.confirmWithCustomer || []).join(", "),
      captureFields: (nem.captureFields || []).map((f: any) => f.label || f.key).join("\n"),
      audience: (nb.audience || []).map((a: any) => `${a.role}${a.buysFor ? ` | ${a.buysFor}` : ""}`).join("\n"),
    });
    setMaintResult(null);
  }, [project.projectId]);

  const set = (k: keyof typeof form) => (e: any) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const business: any = {
        type: form.type || undefined,
        sellsTo: form.sellsTo || undefined,
        orderPattern: form.orderPattern || undefined,
        customised: form.customised,
        approvalRequired: form.approvalRequired,
        audience: form.audience.split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
          const [role, buysFor] = l.split("|").map((x: string) => x.trim());
          return { role, buysFor: buysFor || undefined };
        }),
      };
      // Only send an entity model when it has a label — a half-defined entity
      // would make the agent ask about something that doesn't exist.
      if (form.entityLabel.trim()) {
        business.entityModel = {
          key: form.entityKey.trim() || form.entityLabel.trim().toLowerCase().replace(/\s+/g, "-"),
          label: form.entityLabel.trim(),
          labelPlural: form.entityLabelPlural.trim() || undefined,
          askPrompt: form.askPrompt.trim() || undefined,
          hasDirectory: form.hasDirectory,
          allowCreate: form.allowCreate,
          confirmWithCustomer: form.confirmWithCustomer.split(",").map((s: string) => s.trim()).filter(Boolean),
          captureFields: form.captureFields.split("\n").map((l: string) => l.trim()).filter(Boolean)
            .map((label: string) => ({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label })),
        };
      }
      await projectApi.update(project.projectId, { business } as any);
      setSaved(true);
    } catch (e: any) {
      setError(e.message || "Could not save.");
    } finally { setSaving(false); }
  }

  async function runMaintenance(op: string, dryRun: boolean) {
    setMaintBusy(op); setMaintResult(null); setMaintOp(op);
    try {
      const r = await authedFetch(`/api/knowledge/maintenance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.projectId, op, dryRun }),
      });
      setMaintResult(await r.json());
    } catch (e: any) {
      setMaintResult({ ok: false, details: { error: e.message } });
    } finally { setMaintBusy(null); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="between">
        <div>
          <h3 style={{ fontSize: 19, fontWeight: 700 }}>Business profile</h3>
          <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
            What kind of business this is, and what its customers buy for. The agent uses this to orient itself and to
            word its own questions — no code change per vertical.
          </p>
        </div>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}
      {saved && <div className="micro" style={{ color: "var(--jx-gray-600)" }}>Saved. Publish to apply to live conversations.</div>}

      <div className="panel">
        <h4>How this business sells</h4>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div>
            <span className="flabel">Business type</span>
            <input className="field" value={form.type} onChange={set("type")} placeholder="wholesale-decorator, retail, b2b-trade…" />
          </div>
          <div>
            <span className="flabel">Order pattern</span>
            <select className="field" value={form.orderPattern} onChange={set("orderPattern")}>
              {ORDER_PATTERNS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </div>
          <div className="full">
            <span className="flabel">Sells to</span>
            <input className="field" value={form.sellsTo} onChange={set("sellsTo")} placeholder="coaches, athletic directors and dealers" />
          </div>
          <div className="full">
            <span className="flabel">Typical buyers (one per line — role | buys for)</span>
            <textarea className="field" rows={3} value={form.audience} onChange={set("audience")}
              placeholder={"coach | their team roster\nathletic director | multiple programmes"} />
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <label className="micro" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={form.customised} onChange={set("customised")} /> Goods customised per order
            </label>
            <label className="micro" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={form.approvalRequired} onChange={set("approvalRequired")} /> Needs approval before production
            </label>
          </div>
        </div>
      </div>

      <div className="panel">
        <h4>What every order is for</h4>
        <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
          The one genuinely vertical-specific idea. Naming it re-words the agent&apos;s own lookup tools — set
          &quot;room&quot; and the agent asks which room; set &quot;site crew&quot; and it asks which crew.
        </p>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div>
            <span className="flabel">Call it a…</span>
            <input className="field" value={form.entityLabel} onChange={set("entityLabel")} placeholder="team" />
          </div>
          <div>
            <span className="flabel">Plural</span>
            <input className="field" value={form.entityLabelPlural} onChange={set("entityLabelPlural")} placeholder="teams" />
          </div>
          <div className="full">
            <span className="flabel">How the agent should ask for it</span>
            <textarea className="field" rows={2} value={form.askPrompt} onChange={set("askPrompt")}
              placeholder="Ask which school, college or club the order is for, and which sport." />
          </div>
          <div className="full">
            <span className="flabel">Details to capture (one per line)</span>
            <textarea className="field" rows={4} value={form.captureFields} onChange={set("captureFields")}
              placeholder={"School / club name\nState\nSport\nNumber of players\nTeam colours"} />
          </div>
          <div className="full">
            <span className="flabel">Must be confirmed with the customer, never asserted (comma separated)</span>
            <input className="field" value={form.confirmWithCustomer} onChange={set("confirmWithCustomer")}
              placeholder="team colours, logo or crest artwork" />
            <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
              These travel with the business definition, so the agent will always check them rather than stating them as fact.
            </p>
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <label className="micro" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={form.hasDirectory} onChange={set("hasDirectory")} /> A directory exists to search
            </label>
            <label className="micro" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={form.allowCreate} onChange={set("allowCreate")} /> Customers may add new ones
            </label>
          </div>
        </div>
      </div>

      <div className="panel">
        <h4>Data maintenance</h4>
        <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
          Repairs that used to require direct database access. Every run is permission-checked and shows what it would
          change before changing it.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {MAINTENANCE_OPS.map((m) => (
            <div key={m.op} className="between" style={{ borderTop: "1px solid var(--jx-gray-200)", paddingTop: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</div>
                <div className="micro" style={{ color: "var(--jx-gray-500)" }}>{m.hint}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button className="btn-ghost" disabled={!!maintBusy} onClick={() => runMaintenance(m.op, true)}>
                  {maintBusy === m.op ? "Checking…" : "Preview"}
                </button>
                <button
                  className="btn-ghost"
                  disabled={!!maintBusy}
                  onClick={() => {
                    if (confirm(`Run "${m.label}" for ${project.projectId}? This changes data.`)) runMaintenance(m.op, false);
                  }}
                >
                  Run
                </button>
              </div>
            </div>
          ))}
        </div>
        {maintResult && (
          <pre className="micro" style={{ marginTop: 12, background: "var(--jx-gray-50)", padding: 10, borderRadius: 8, overflowX: "auto" }}>
            {maintOp}: {JSON.stringify(maintResult, null, 1)}
          </pre>
        )}
      </div>
    </div>
  );
}
