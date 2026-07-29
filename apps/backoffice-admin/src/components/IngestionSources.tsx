"use client";

/**
 * Ingestion source editor + live run control (AUG-9).
 *
 * This is how EVERY tenant is onboarded — sources are configuration, never code.
 * Add a feed/PDF/help-centre/REST source, save it to the project, then run the
 * whole pipeline or a single stage and watch progress stream back.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Database, Plus, Play, Trash2, Save, RefreshCw, FileText, Globe, Server, Table } from "lucide-react";
import { authedFetch } from "../lib/authed-fetch";
import { projectApi, SOURCE_TYPES, INGEST_STAGES, type Project, type KnowledgeSourceItem } from "../lib/api";

const ICON: Record<string, React.ElementType> = {
  "csv-feed": Table, pdf: FileText, "kb-articles": Globe, "websphere-rest": Server, html: Globe,
};

const blank = (n: number): KnowledgeSourceItem => ({
  id: `source-${n}`, type: "csv-feed", enabled: true, role: "product", currency: "USD",
});

export function IngestionSources({ project, onSaved }: { project: Project; onSaved?: () => void }) {
  const [sources, setSources] = useState<KnowledgeSourceItem[]>(project.knowledgeSource?.sources || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { setSources(project.knowledgeSource?.sources || []); }, [project.projectId, project.knowledgeSource?.sources]);

  const patch = (i: number, p: Partial<KnowledgeSourceItem>) =>
    setSources((s) => s.map((x, idx) => (idx === i ? { ...x, ...p } : x)));

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await projectApi.update(project.projectId, {
        knowledgeSource: { ...(project.knowledgeSource || {}), sources: sources.filter((s) => s.id.trim()) },
      } as never);
      setSaved(true); onSaved?.(); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }

  /** Poll the job until it finishes so operators see live progress. */
  const track = useCallback((jobId: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const r = await authedFetch(`/api/knowledge/run?projectId=${encodeURIComponent(project.projectId)}&jobId=${jobId}`);
        if (!r.ok) return;
        const j = await r.json();
        setJob(j);
        if (j.status === "completed" || j.status === "failed") {
          if (poll.current) clearInterval(poll.current);
          setBusy(false);
        }
      } catch { /* keep polling */ }
    }, 2500);
  }, [project.projectId]);

  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  async function run(only?: string[]) {
    setBusy(true); setError(null); setJob(null);
    try {
      const r = await authedFetch(`/api/knowledge/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.projectId, only }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not start ingestion."); setBusy(false); return; }
      setJob({ status: "queued", jobId: d.jobId, log: [] });
      track(d.jobId);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const enabledCount = sources.filter((s) => s.enabled !== false).length;

  return (
    <div className="panel">
      <h4><Database size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Ingestion sources</h4>
      <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 12px" }}>
        Everything this project knows comes from the sources below — product feeds, PDFs, help-centre
        articles or a commerce REST API. Add them here and run the pipeline; no code changes, no scripts.
        <b> {enabledCount} of {sources.length} enabled.</b>
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sources.map((s, i) => {
          const Icon = ICON[s.type] || Globe;
          return (
            <div key={i} style={{ border: "1px solid var(--jx-gray-300)", borderRadius: 10, padding: "10px 12px", opacity: s.enabled === false ? 0.55 : 1 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1.2fr 0.9fr auto", gap: 10, alignItems: "end" }}>
                <div>
                  <span className="flabel"><Icon size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Type</span>
                  <select className="field" value={s.type} onChange={(e) => patch(i, { type: e.target.value as KnowledgeSourceItem["type"] })}>
                    {SOURCE_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <span className="flabel">Label</span>
                  <input className="field" value={s.label || ""} onChange={(e) => patch(i, { label: e.target.value })} placeholder="US product feed" />
                </div>
                <div>
                  <span className="flabel">Role</span>
                  <select className="field" value={s.role || "product"} onChange={(e) => patch(i, { role: e.target.value as KnowledgeSourceItem["role"] })}>
                    {["product", "inventory", "decoration", "sizing", "design", "articles"].map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", paddingBottom: 2 }}>
                  <label className="micro" style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                    <input type="checkbox" checked={s.enabled !== false} onChange={(e) => patch(i, { enabled: e.target.checked })} /> on
                  </label>
                  <button onClick={() => setSources((x) => x.filter((_, idx) => idx !== i))}
                    style={{ border: "1px solid var(--jx-gray-300)", background: "var(--jx-white)", borderRadius: 8, padding: "8px 9px", cursor: "pointer", color: "var(--jx-destructive)" }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <span className="flabel">{s.type === "kb-articles" ? "Sitemap URL" : s.type === "websphere-rest" ? "Store base URL" : "URL"}</span>
                <input className="field" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 }}
                  value={(s.type === "kb-articles" ? s.sitemapUrl : s.url) || ""}
                  onChange={(e) => patch(i, s.type === "kb-articles" ? { sitemapUrl: e.target.value } : { url: e.target.value })}
                  placeholder="https://…" />
              </div>

              {/* type-specific options */}
              {s.type === "csv-feed" && (
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: 14, marginTop: 8 }}>
                  <div>
                    <span className="flabel">Currency</span>
                    <select className="field" value={s.currency || "USD"} onChange={(e) => patch(i, { currency: e.target.value })}>
                      {["USD", "CAD", "EUR", "GBP", "AUD", "MXN"].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <label className="micro" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", alignSelf: "end", paddingBottom: 9 }}>
                    <input type="checkbox" checked={!!s.sublimation} onChange={(e) => patch(i, { sublimation: e.target.checked })} />
                    custom / sublimation feed
                  </label>
                </div>
              )}
              {(s.type === "pdf" || s.type === "kb-articles") && (
                <div style={{ marginTop: 8, maxWidth: 260 }}>
                  <span className="flabel">Knowledge type</span>
                  <select className="field" value={s.docType || (s.type === "pdf" ? "design" : "faq")} onChange={(e) => patch(i, { docType: e.target.value })}>
                    {["design", "decoration", "installation", "faq", "technical", "troubleshooting"].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}
              {s.type === "websphere-rest" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                  <div><span className="flabel">Store ID</span><input className="field" value={s.storeId || ""} onChange={(e) => patch(i, { storeId: e.target.value })} /></div>
                  <div><span className="flabel">Catalog ID</span><input className="field" value={s.catalogId || ""} onChange={(e) => patch(i, { catalogId: e.target.value })} /></div>
                </div>
              )}
            </div>
          );
        })}

        <button onClick={() => setSources((s) => [...s, blank(s.length + 1)])}
          style={{ alignSelf: "start", border: "1px dashed var(--jx-gray-400)", background: "var(--jx-white)", borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: 700 }}>
          <Plus size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Add source
        </button>
      </div>

      {error && <div style={{ marginTop: 10, color: "var(--jx-destructive)", fontSize: 12.5 }}>{error}</div>}

      {/* run controls */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button className="btn y" onClick={save} disabled={saving}>
          <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save sources"}
        </button>
        <button className="btn" onClick={() => run()} disabled={busy || !enabledCount}
          style={{ border: "1px solid var(--jx-black)", background: "var(--jx-black)", color: "#fff", borderRadius: 8, padding: "9px 14px", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 12.5 }}>
          <Play size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {busy ? "Running…" : "Run full ingestion"}
        </button>
        {INGEST_STAGES.map((st) => (
          <button key={st.id} onClick={() => run([st.id])} disabled={busy}
            style={{ border: "1px solid var(--jx-gray-300)", background: "var(--jx-white)", borderRadius: 8, padding: "8px 11px", cursor: busy ? "default" : "pointer", fontSize: 12 }}>
            {st.label}
          </button>
        ))}
      </div>

      {/* live job progress */}
      {job && (
        <div style={{ marginTop: 14, border: "1px solid var(--jx-gray-300)", borderRadius: 10, padding: "10px 12px", background: "var(--jx-gray-100)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700 }}>
            {job.status === "running" || job.status === "queued"
              ? <RefreshCw size={13} className="spin" /> : null}
            Status: {job.status}
            {job.result && <span className="micro" style={{ color: "var(--jx-gray-600)", fontWeight: 400 }}>· {JSON.stringify(job.result)}</span>}
          </div>
          {job.error && <div style={{ color: "var(--jx-destructive)", fontSize: 12, marginTop: 5 }}>{job.error}</div>}
          {!!(job.log || []).length && (
            <pre style={{ marginTop: 8, maxHeight: 220, overflow: "auto", fontSize: 11.5, lineHeight: 1.5, background: "var(--jx-white)", border: "1px solid var(--jx-gray-300)", borderRadius: 8, padding: 10 }}>
              {(job.log || []).slice(-40).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
