"use client";

/**
 * Analytics — REAL funnel + intent distribution from agent sessions (B5).
 * Same /api/insights source as the dashboard; deeper cuts, no mock charts.
 */
import React from "react";
import { RefreshCw } from "lucide-react";
import { useInsights } from "./DashboardLive";
import type { Project } from "../lib/api";

const STAGE_LABEL: Record<string, string> = {
  intro: "Started", clarify: "Clarified", products: "Recommended", quote: "Quoted", ordered: "Ordered", installation: "Guided",
};

export function AnalyticsLive({ project }: { project: Project }) {
  const { data, error, loading, reload } = useInsights(project.projectId);

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Analytics</h1>
          <p className="pagesub">Conversion + intent analytics for <b>{project.companyName}</b> — live from agent sessions.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      {data && (
        <div className="cardrow">
          {/* Conversion funnel with drop-off */}
          <div className="panel">
            <div className="micro">CONVERSION FUNNEL</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
              {data.funnel.map((f, i) => {
                const max = data.funnel[0]?.reached || 1;
                const prev = i > 0 ? data.funnel[i - 1].reached : f.reached;
                const pct = Math.round((f.reached / max) * 100);
                const drop = prev > 0 ? Math.round(((prev - f.reached) / prev) * 100) : 0;
                return (
                  <div key={f.stage}>
                    <div className="between" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      <span>{STAGE_LABEL[f.stage] || f.stage}</span>
                      <span>
                        <b>{f.reached.toLocaleString()}</b>
                        {i > 0 && drop > 0 && <span className="role" style={{ marginLeft: 8, fontSize: 11 }}>−{drop}% drop-off</span>}
                      </span>
                    </div>
                    <div style={{ width: "100%", height: 12, background: "var(--jx-gray-200)", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: f.stage === "ordered" ? "var(--jx-yellow)" : "var(--jx-black)", transition: "width .3s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <span className="fhelp">A session counts for every stage at or before the furthest it reached.</span>
          </div>

          {/* Intent distribution */}
          <div className="panel">
            <div className="micro">TOP CUSTOMER INTENTS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              {data.intents.length === 0 && <span className="role">No classified intents yet.</span>}
              {data.intents.map((it) => {
                const max = data.intents[0]?.n || 1;
                return (
                  <div key={it.intent}>
                    <div className="between" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                      <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{it.intent}</span>
                      <b>{it.n.toLocaleString()}</b>
                    </div>
                    <div style={{ width: "100%", height: 8, background: "var(--jx-gray-200)", borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ width: `${Math.round((it.n / max) * 100)}%`, height: "100%", background: "#5C5C5C" }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <span className="fhelp">From the intent resolver's per-turn classification (last intent per session).</span>
          </div>
        </div>
      )}
    </>
  );
}
