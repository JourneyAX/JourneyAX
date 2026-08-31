"use client";

/**
 * Analytics — REAL funnel + intent distribution from agent sessions (B5).
 * Same /api/insights source as the dashboard; deeper cuts, no mock charts.
 *
 * Conversations drill-down: the "recent sessions" list already carries a real
 * sessionId — this fetches that session's actual stored transcript (the same
 * `messages[]` SessionStore writes every turn) rather than adding a second,
 * separate log store. "What did the customer actually ask" answered from data
 * that was already there, not a new logging pipeline.
 */
import React, { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useInsights } from "./DashboardLive";
import { authedFetch } from "../lib/authed-fetch";
import { prettifyKey } from "../lib/format";
import { LineChart } from "./charts/LineChart";
import { BarChart } from "./charts/BarChart";
import type { Project } from "../lib/api";

interface TranscriptMsg { role?: string; content?: string; [k: string]: unknown }
interface TranscriptStep { turnIndex?: number; tool?: string; argsSummary?: string; resultSummary?: string; ts?: string; [k: string]: unknown }

// "searchKnowledge" → "Search Knowledge" (best-effort humanization of camelCase tool names)
function prettifyTool(tool?: string): string {
  if (!tool) return "Tool call";
  const spaced = tool.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const words = spaced.split(" ").filter(Boolean);
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
}

function formatStepTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function TranscriptModal({ project, sessionId, label, onClose }: { project: Project; sessionId: string; label: string; onClose: () => void }) {
  const [messages, setMessages] = useState<TranscriptMsg[] | null>(null);
  const [steps, setSteps] = useState<TranscriptStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    authedFetch(`/api/insights/session/${encodeURIComponent(sessionId)}/transcript?projectId=${encodeURIComponent(project.projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) { setError(d.error); return; }
        setMessages(Array.isArray(d.messages) ? d.messages : []);
        setSteps(Array.isArray(d.steps) ? d.steps : []);
      })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [project.projectId, sessionId]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="panel" style={{ width: "min(1100px, 94vw)", maxHeight: "80vh", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <button className="btn" onClick={onClose} style={{ position: "absolute", top: 12, right: 12, padding: "4px 8px", zIndex: 1 }}>
          <X size={14} />
        </button>
        <div className="micro">CONVERSATION — {label}</div>
        <div className="role" style={{ fontSize: 10, marginTop: 2, opacity: 0.7 }} title={sessionId}>Session {sessionId}</div>
        {error && <div style={{ color: "var(--jx-destructive)", marginTop: 8 }}>{error}</div>}
        {!error && !messages && <div className="role" style={{ marginTop: 8 }}>Loading…</div>}
        {messages && messages.length === 0 && steps && steps.length === 0 && <div className="role" style={{ marginTop: 8 }}>No stored transcript for this session.</div>}

        {messages && (
          <div style={{ display: "flex", gap: 16, marginTop: 12, minHeight: 0, flex: 1 }}>
            {/* Left 40% — chat bubble transcript (unchanged) */}
            <div style={{ flex: "0 0 40%", maxWidth: "40%", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
              {messages.filter((m) => m.role === "user" || m.role === "assistant").map((m, i) => (
                <div key={i} style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  background: m.role === "user" ? "var(--jx-yellow)" : "var(--jx-gray-200)",
                  color: m.role === "user" ? "#000" : "inherit",
                  borderRadius: 10, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap",
                }}>
                  <div className="role" style={{ fontSize: 10, marginBottom: 3, opacity: 0.7 }}>{m.role === "user" ? "Customer" : "Assistant"}</div>
                  {typeof m.content === "string" ? m.content : "[structured message]"}
                </div>
              ))}
            </div>

            {/* Right 60% — step timeline */}
            <div style={{ flex: "0 0 60%", maxWidth: "60%", overflowY: "auto", borderLeft: "1px solid var(--jx-gray-200)", paddingLeft: 16 }}>
              <div className="micro" style={{ marginBottom: 8 }}>AGENT STEPS</div>
              {(!steps || steps.length === 0) ? (
                <div className="role" style={{ fontSize: 12.5, opacity: 0.8 }}>
                  No step data captured for this conversation. Step tracking was added after this session ran, so older sessions won&apos;t have it.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {steps.map((s, i) => (
                    <div key={i} style={{
                      background: "var(--jx-gray-200)",
                      borderRadius: 10,
                      padding: "8px 12px",
                      fontSize: 12.5,
                    }}>
                      <div className="between" style={{ marginBottom: 3 }}>
                        <span style={{ fontWeight: 600 }}>{prettifyTool(s.tool)}</span>
                        <span className="role" style={{ fontSize: 10, opacity: 0.7 }}>
                          {typeof s.turnIndex === "number" ? `Turn ${s.turnIndex} · ` : ""}{formatStepTime(s.ts)}
                        </span>
                      </div>
                      {s.argsSummary && (
                        <div className="role" style={{ fontSize: 11.5, opacity: 0.85, marginBottom: 2 }}>
                          <span style={{ opacity: 0.6 }}>Args: </span>{s.argsSummary}
                        </div>
                      )}
                      {s.resultSummary && (
                        <div style={{ fontSize: 11.5 }}>
                          <span className="role" style={{ opacity: 0.6 }}>Result: </span>{s.resultSummary}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  intro: "Started", clarify: "Clarified", products: "Recommended", quote: "Quoted", ordered: "Ordered", installation: "Guided",
};

// Real intent keys as classified by IntentResolver
// (apps/agent-commerce-service/src/pipeline/intent-resolver.ts) — labels for
// unmapped/future keys fall back to prettifyKey() below.
const INTENT_LABEL: Record<string, string> = {
  bathroom_remodel: "Bathroom remodel",
  leak_repair: "Leak repair",
  product_recommendation: "Product recommendation",
  installation_help: "Installation help",
  quote_order: "Quote / order",
  design_inspiration: "Design inspiration",
  general_question: "General question",
  unknown: "Unclassified",
};

function intentLabel(intent?: string): string {
  if (!intent) return "—";
  return INTENT_LABEL[intent] || prettifyKey(intent);
}

/** Readable row label: last classified intent > "Session #N" (never the raw UUID as the primary label). */
function sessionLabel(s: any, index: number): string {
  if (s?.lastIntent?.intent) return intentLabel(s.lastIntent.intent);
  return `Session #${index + 1}`;
}

export function AnalyticsLive({ project }: { project: Project }) {
  const { data, error, loading, reload } = useInsights(project.projectId);
  const [openSession, setOpenSession] = useState<{ id: string; label: string } | null>(null);

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
            <div style={{ marginTop: 8 }}>
              {data.intents.length === 0 && <span className="role">No classified intents yet.</span>}
              {data.intents.length > 0 && (
                <BarChart
                  data={data.intents.map((it) => ({ label: intentLabel(it.intent), value: it.n, color: "#5C5C5C" }))}
                />
              )}
            </div>
            <span className="fhelp">From the intent resolver's per-turn classification (last intent per session).</span>
          </div>

          {/* Sessions trend — real day-by-day session activity, last 14 days */}
          <div className="panel">
            <div className="micro">SESSIONS — LAST 14 DAYS</div>
            <div style={{ marginTop: 12 }}>
              {data.sessionsByDay && data.sessionsByDay.length > 0 ? (
                <LineChart
                  points={data.sessionsByDay.map((d) => ({ label: d.date, value: d.count }))}
                  formatLabel={(l) => new Date(l).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                />
              ) : (
                <span className="role">No day-by-day session data available yet.</span>
              )}
            </div>
            <span className="fhelp">Sessions touched per day (grouped by last-updated date), from the same session store as the funnel above.</span>
          </div>

          {/* Conversations — click a session to read its real transcript */}
          <div className="panel" style={{ gridColumn: "1 / -1" }}>
            <div className="micro">CONVERSATIONS</div>
            <p className="fhelp" style={{ marginTop: 2 }}>What customers are actually asking — click a session to read the real conversation.</p>
            <div className="tblwrap" style={{ marginTop: 8 }}>
              <div className="theadr" style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr" }}>
                <span>Session</span><span>Last intent</span><span>Stage</span><span>Turns</span><span>Updated</span>
              </div>
              {data.recent.length === 0 && <div className="trow" style={{ gridTemplateColumns: "1fr" }}><span className="role">No sessions yet — start a journey on the storefront.</span></div>}
              {data.recent.map((s: any, i: number) => {
                const label = sessionLabel(s, i);
                return (
                  <div
                    key={s.sessionId}
                    className="trow"
                    style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr", cursor: "pointer" }}
                    onClick={() => setOpenSession({ id: s.sessionId, label })}
                  >
                    <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.sessionId}>
                      {label}
                      <span className="role" style={{ fontWeight: 400, fontSize: 10, marginLeft: 6, opacity: 0.6 }}>
                        {s.sessionId.slice(0, 8)}…
                      </span>
                    </b>
                    <span className="role">{intentLabel(s.lastIntent?.intent)}</span>
                    <span><span className={`pill ${s.lastIntent?.stage === "ordered" ? "p-active" : "p-offline"}`}>{STAGE_LABEL[s.lastIntent?.stage || s.state?.phase] || s.lastIntent?.stage || s.state?.phase || "—"}</span></span>
                    <span className="role">{s.turnCount ?? 0}</span>
                    <span className="role">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {openSession && (
        <TranscriptModal
          project={project}
          sessionId={openSession.id}
          label={openSession.label}
          onClose={() => setOpenSession(null)}
        />
      )}
    </>
  );
}
