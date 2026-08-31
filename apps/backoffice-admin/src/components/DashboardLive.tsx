"use client";

/**
 * Dashboard — REAL per-project journey metrics (B5).
 * Everything on this screen comes from the agent's own session persistence
 * (journeyx.sessions via /api/insights) and the knowledge corpus. No mock data.
 */
import React, { useEffect, useState } from "react";
import { RefreshCw, MessageSquare, Database, FileText, Activity } from "lucide-react";
import type { Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

export interface Insights {
  sessions: { total: number; last7d: number; last24h: number; totalTurns: number };
  funnel: { stage: string; reached: number }[];
  intents: { intent: string; n: number }[];
  recent: any[];
  quotes: any[];
  knowledgeDocs: number;
  /** Sessions touched per day, last 14 days (real, from analytics-service — see computeInsights). */
  sessionsByDay?: { date: string; count: number }[];
}

export function useInsights(projectId: string) {
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* `force` makes Refresh mean refresh. Both the browser and the server cache
   * these figures, so without an explicit bypass the button would appear to do
   * nothing — the worst kind of control. */
  const load = React.useCallback(async (force?: boolean) => {
    setLoading(true);
    try {
      const r = await authedFetch(
        `/api/insights?projectId=${encodeURIComponent(projectId)}${force ? '&refresh=1' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setError(null);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: () => load(true) };
}

const STAGE_LABEL: Record<string, string> = {
  intro: "Started", clarify: "Clarified", products: "Recommended", quote: "Quoted", ordered: "Ordered", installation: "Guided",
};

export function DashboardLive({ project }: { project: Project }) {
  const { data, error, loading, reload } = useInsights(project.projectId);

  const kpi = (icon: React.ReactNode, value: React.ReactNode, label: string, sub: string) => (
    <div className="stat">
      <div className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>{value}</div>
      <div className="l">{label}</div>
      <div className="s" style={{ display: "flex", alignItems: "center", gap: 5 }}>{icon}{sub}</div>
    </div>
  );

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Dashboard</h1>
          <p className="pagesub">Live journey metrics for <b>{project.companyName}</b> — from real agent sessions.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>Could not load insights: {error}</div>}

      {data && (
        <>
          <div className="statrow">
            {kpi(<MessageSquare size={12} />, data.sessions.total.toLocaleString(), "Journeys (all time)", `${data.sessions.last7d} in the last 7 days`)}
            {kpi(<Activity size={12} />, data.sessions.last24h.toLocaleString(), "Journeys (24h)", "sessions touched today")}
            {kpi(<FileText size={12} />, data.sessions.totalTurns.toLocaleString(), "Conversation turns", "across all sessions")}
            {kpi(<Database size={12} />, data.knowledgeDocs.toLocaleString(), "Knowledge documents", "grounding this project's agent")}
          </div>

          {/* Mini funnel */}
          <div className="panel">
            <div className="micro">JOURNEY FUNNEL (sessions reaching each stage)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              {data.funnel.map((f) => {
                const max = data.funnel[0]?.reached || 1;
                const pct = Math.round((f.reached / max) * 100);
                return (
                  <div key={f.stage}>
                    <div className="between" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      <span>{STAGE_LABEL[f.stage] || f.stage}</span>
                      <b>{f.reached.toLocaleString()} · {pct}%</b>
                    </div>
                    <div style={{ width: "100%", height: 10, background: "var(--jx-gray-200)", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: f.stage === "ordered" ? "var(--jx-yellow)" : "var(--jx-black)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent activity — real sessions */}
          <div className="panel">
            <div className="micro">RECENT SESSIONS</div>
            <div className="tblwrap" style={{ marginTop: 8 }}>
              <div className="theadr" style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr" }}>
                <span>Session</span><span>Last intent</span><span>Stage</span><span>Turns</span><span>Updated</span>
              </div>
              {data.recent.length === 0 && <div className="trow" style={{ gridTemplateColumns: "1fr" }}><span className="role">No sessions yet — start a journey on the storefront.</span></div>}
              {data.recent.map((s: any) => (
                <div key={s.sessionId} className="trow" style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr" }}>
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sessionId}</b>
                  <span className="role">{s.lastIntent?.intent || "—"}</span>
                  <span><span className={`pill ${s.lastIntent?.stage === "ordered" ? "p-active" : "p-offline"}`}>{s.lastIntent?.stage || s.state?.phase || "—"}</span></span>
                  <span className="role">{s.turnCount ?? 0}</span>
                  <span className="role">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
