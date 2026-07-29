"use client";

/**
 * Business Rules — condition→action rules the Journey Agent must honour for the
 * SELECTED tenant. Active rules are injected into every conversation (the agent
 * reads project-service /rules/active each turn), so edits take effect on the
 * next chat with no deploy.
 *
 * Full CRUD: create, EDIT-IN-PLACE, toggle active, delete (with confirm). The
 * "Behind the scenes" panel shows the exact block the agent receives.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, ShieldCheck, PencilLine, X, Check, Eye } from "lucide-react";
import { SERVICES } from "../lib/api";

const API = SERVICES.project;

const SCOPES = ["recommendation", "conversation", "pricing", "compliance", "escalation"] as const;
type Scope = (typeof SCOPES)[number];

interface Rule {
  ruleId: string;
  projectId: string;
  name: string;
  scope: Scope;
  condition: string;
  action: string;
  priority: number;
  isActive: boolean;
}

const scopePill: Record<Scope, string> = {
  recommendation: "p-active",
  conversation: "p-draft",
  pricing: "p-offline",
  compliance: "p-offline",
  escalation: "p-inactive",
};

const EMPTY = { name: "", scope: "recommendation" as Scope, condition: "", action: "", priority: 100, isActive: true };

export function BusinessRules({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ ...EMPTY });
  const [showPreview, setShowPreview] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/projects/${projectId}/rules`, { headers: { "X-Tenant-ID": projectId } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRules(await res.json());
    } catch (e: any) {
      setError(`Could not load rules from project-service (${API}). Is it running? ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); setEditingId(null); }, [load]);

  async function toggleActive(rule: Rule) {
    setRules((rs) => rs.map((r) => (r.ruleId === rule.ruleId ? { ...r, isActive: !r.isActive } : r)));
    await fetch(`${API}/api/v1/projects/${projectId}/rules/${rule.ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Tenant-ID": projectId },
      body: JSON.stringify({ isActive: !rule.isActive }),
    }).catch(() => load());
  }

  async function remove(rule: Rule) {
    if (!window.confirm(`Delete rule "${rule.name}"? The agent stops honouring it on the next conversation.`)) return;
    setRules((rs) => rs.filter((r) => r.ruleId !== rule.ruleId));
    await fetch(`${API}/api/v1/projects/${projectId}/rules/${rule.ruleId}`, {
      method: "DELETE",
      headers: { "X-Tenant-ID": projectId },
    }).catch(() => load());
  }

  function startEdit(r: Rule) {
    setEditingId(r.ruleId);
    setEdit({ name: r.name, scope: r.scope, condition: r.condition, action: r.action, priority: r.priority, isActive: r.isActive });
  }

  async function saveEdit(ruleId: string) {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/v1/projects/${projectId}/rules/${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Tenant-ID": projectId },
        body: JSON.stringify(edit),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      await load();
    } catch (e: any) { setError(`Update failed: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function create() {
    if (!form.name || !form.condition || !form.action) {
      setError("Fill in the rule name, condition and action to add a rule.");
      return;
    }
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${API}/api/v1/projects/${projectId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-ID": projectId },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForm({ ...EMPTY });
      await load();
    } catch (e: any) { setError(`Create failed: ${e.message}`); }
    finally { setSaving(false); }
  }

  // Mirror of the agent's ConfigLoader.renderRulesBlock — the exact text injected.
  const activeRules = rules.filter((r) => r.isActive).sort((a, b) => a.priority - b.priority);
  const injectedBlock = activeRules.length
    ? `[BUSINESS RULES — configured in the back office. You MUST honour these]\n` +
      activeRules.map((r, i) => `${i + 1}. [${r.scope}] When ${r.condition} → ${r.action}`).join("\n")
    : "(no active rules — nothing is injected)";

  const editRow = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 0" }}>
      <div className="form-grid">
        <div><span className="flabel">Rule name</span>
          <input className="field" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
        <div><span className="flabel">Scope</span>
          <select className="field" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value as Scope })}>
            {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select></div>
        <div className="full"><span className="flabel">Condition — when does this apply?</span>
          <input className="field" value={edit.condition} onChange={(e) => setEdit({ ...edit, condition: e.target.value })} /></div>
        <div className="full"><span className="flabel">Action — what must the agent do?</span>
          <input className="field" value={edit.action} onChange={(e) => setEdit({ ...edit, action: e.target.value })} /></div>
        <div><span className="flabel">Priority (lower = first)</span>
          <input className="field" type="number" style={{ maxWidth: 120 }} value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })} /></div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn" onClick={() => setEditingId(null)}><X size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />Cancel</button>
        <button className="btn y" disabled={saving} onClick={() => editingId && saveEdit(editingId)}>
          <Check size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{saving ? "Saving…" : "Save rule"}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Business Rules</h1>
          <p className="pagesub">
            Condition → action rules the agent must honour for <b>{projectId}</b>. Active rules reach the agent
            on its very next conversation — no publish or deploy needed.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setShowPreview((v) => !v)}>
            <Eye size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {showPreview ? "Hide" : "Behind the scenes"}
          </button>
          <button className="btn" onClick={load}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>
      )}

      {/* Behind the scenes — the exact block the agent receives */}
      {showPreview && (
        <div className="panel" style={{ borderColor: "var(--jx-yellow)" }}>
          <div className="micro">HOW IT WORKS — every turn, the agent loads this project's ACTIVE rules and receives this exact block in its instructions:</div>
          <pre style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "12px 14px", fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", margin: 0 }}>
            {injectedBlock}
          </pre>
          <span className="fhelp">Toggle a rule off and it disappears from this block (and from the agent) immediately.</span>
        </div>
      )}

      {/* Create rule */}
      <div className="panel">
        <h4><Plus size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Add a new rule</h4>
        <div className="form-grid">
          <div><span className="flabel">Rule name</span>
            <input className="field" placeholder="e.g. Push bundle discount" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><span className="flabel">Scope</span>
            <select className="field" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as Scope })}>
              {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></div>
          <div className="full"><span className="flabel">Condition — when does this apply?</span>
            <input className="field" placeholder="e.g. Customer is configuring a Kitchen" value={form.condition}
              onChange={(e) => setForm({ ...form, condition: e.target.value })} /></div>
          <div className="full"><span className="flabel">Action — what must the agent do?</span>
            <input className="field" placeholder="e.g. Recommend only kitchen products" value={form.action}
              onChange={(e) => setForm({ ...form, action: e.target.value })} /></div>
        </div>
        <div className="between">
          <div className="row">
            <span className="flabel" style={{ marginBottom: 0 }}>Priority</span>
            <input className="field" type="number" style={{ width: 80 }} value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
            <span className="flabel" style={{ marginBottom: 0, marginLeft: 12 }}>Active</span>
            <div className={`switch ${form.isActive ? "on" : ""}`} onClick={() => setForm({ ...form, isActive: !form.isActive })} />
          </div>
          <button className="btn y" onClick={create} disabled={saving}>
            <Plus size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{saving ? "Saving…" : "Add rule"}
          </button>
        </div>
      </div>

      {/* Rules table */}
      <div className="panel">
        <div className="between">
          <h4><ShieldCheck size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Configured rules ({rules.length})</h4>
          <span className="micro">{rules.filter((r) => r.isActive).length} active</span>
        </div>

        <div className="tblwrap">
          <div className="theadr" style={{ gridTemplateColumns: "1.3fr 0.9fr 1.6fr 0.5fr 0.5fr" }}>
            <span>Rule</span><span>Scope</span><span>Condition → Action</span><span>Active</span><span></span>
          </div>

          {loading ? (
            <div className="trow" style={{ gridTemplateColumns: "1fr" }}>Loading…</div>
          ) : rules.length === 0 ? (
            <div className="trow" style={{ gridTemplateColumns: "1fr", color: "var(--jx-gray-500)" }}>
              No rules yet — add one above.
            </div>
          ) : (
            rules.map((r) =>
              editingId === r.ruleId ? (
                <div key={r.ruleId} style={{ borderBottom: "1px solid var(--jx-gray-200)" }}>{editRow}</div>
              ) : (
                <div key={r.ruleId} className="trow" style={{ gridTemplateColumns: "1.3fr 0.9fr 1.6fr 0.5fr 0.5fr" }}>
                  <div>
                    <b style={{ display: "block" }}>{r.name}</b>
                    <span className="micro">priority {r.priority}</span>
                  </div>
                  <span className={`pill ${scopePill[r.scope] || "p-offline"}`}>{r.scope}</span>
                  <div style={{ fontSize: 12.5, color: "var(--jx-gray-600)" }}>
                    <b style={{ color: "var(--jx-gray-700)" }}>When</b> {r.condition}
                    <br />
                    <b style={{ color: "var(--jx-gray-700)" }}>→</b> {r.action}
                  </div>
                  <div className={`switch ${r.isActive ? "on" : ""}`} onClick={() => toggleActive(r)} />
                  <div className="rowicons">
                    <button style={{ border: "none", background: "transparent", cursor: "pointer" }} onClick={() => startEdit(r)} aria-label="Edit rule" title="Edit">
                      <PencilLine size={15} />
                    </button>
                    <button style={{ border: "none", background: "transparent", cursor: "pointer" }} onClick={() => remove(r)} aria-label="Delete rule" title="Delete">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ),
            )
          )}
        </div>
      </div>
    </>
  );
}
