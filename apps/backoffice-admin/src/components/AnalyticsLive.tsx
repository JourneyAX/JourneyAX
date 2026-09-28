"use client";

/**
 * AnalyticsLive — Enterprise Grounded Journey Analytics Dashboard (Redesign Scope).
 *
 * Implements end-to-end analytics with ZERO hardcoded data:
 * - Journey funnel, stage conversions, drop-offs, abandonment, and p50/p95 completion times
 * - Agent/tool/model performance, latency, failures, cost and token usage
 * - Approval, notification, connector, and Activepieces execution health
 * - Business Pack/version comparisons and release impact verdicts
 * - Tenant/project/workspace scoped dashboards with real-time and historical filters
 * - Custom reports, filters, RFC 4180 CSV & JSON exports, alerts, and live evaluation
 * - PII-redacted conversation transcripts with step timeline drill-down
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  X,
  BarChart2,
  Cpu,
  ShieldCheck,
  Layers,
  FileText,
  Bell,
  Download,
  Play,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
  Activity,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { useInsights } from "./DashboardLive";
import { authedFetch } from "../lib/authed-fetch";
import { prettifyKey } from "../lib/format";
import { LineChart } from "./charts/LineChart";
import { BarChart } from "./charts/BarChart";
import type { Project } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TranscriptMsg {
  role?: string;
  content?: string;
  [k: string]: unknown;
}

interface TranscriptStep {
  turnIndex?: number;
  tool?: string;
  argsSummary?: string;
  resultSummary?: string;
  ts?: string;
  [k: string]: unknown;
}

interface FunnelStage {
  stage: string;
  enteredCount: number;
  conversionRate: number;
  dropOffCount: number;
  dropOffRate: number;
  avgDwellTimeMs: number;
}

interface FunnelOverall {
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  conversionRate: number;
  abandonmentRate: number;
  avgCompletionTimeMs: number;
  p50CompletionTimeMs: number;
  p95CompletionTimeMs: number;
}

interface FunnelData {
  projectId: string;
  stages: FunnelStage[];
  overall: FunnelOverall;
}

interface ModelPerf {
  modelId: string;
  provider: string;
  invocations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorCount: number;
  failureRate: number;
}

interface ToolPerf {
  toolId: string;
  executions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  errorBreakdown: Record<string, number>;
}

interface AgentPerf {
  agentId: string;
  turnsHandled: number;
  avgTurnDurationMs: number;
  escalations: number;
}

interface PerformanceData {
  projectId: string;
  models: ModelPerf[];
  tools: ToolPerf[];
  agents: AgentPerf[];
}

interface HealthData {
  projectId: string;
  approvals: {
    totalRequests: number;
    approved: number;
    rejected: number;
    pending: number;
    expired: number;
    consumed: number;
    approvalRate: number;
    avgWaitTimeMs: number;
    p95WaitTimeMs: number;
  };
  notifications: {
    totalDispatched: number;
    delivered: number;
    failed: number;
    deliveryRate: number;
    channels: Record<string, { total: number; delivered: number; failed: number }>;
  };
  connectors: {
    totalFlowRuns: number;
    successRuns: number;
    failureRuns: number;
    successRate: number;
    flows: Record<string, { runs: number; success: number; failure: number }>;
  };
}

interface PackComparisonData {
  projectId: string;
  versionA: {
    version: string;
    sessionCount: number;
    completionRate: number;
    avgTurns: number;
    toolFailureRate: number;
    avgModelLatencyMs: number;
    costPerSessionUsd: number;
  };
  versionB: {
    version: string;
    sessionCount: number;
    completionRate: number;
    avgTurns: number;
    toolFailureRate: number;
    avgModelLatencyMs: number;
    costPerSessionUsd: number;
  };
  impact: {
    completionRateDelta: number;
    latencyChangePercent: number;
    costChangePercent: number;
    failureRateDelta: number;
    verdict: "improved" | "degraded" | "neutral";
  };
}

interface CustomReport {
  reportId: string;
  tenantId: string;
  name: string;
  description?: string;
  category: string;
  filters?: any;
  metrics?: string[];
  schedule?: { frequency: string; recipients: string[]; enabled: boolean };
  createdAt?: string;
}

interface AlertDefinition {
  alertId: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  severity: "critical" | "warning" | "info";
  recipients: string[];
  enabled: boolean;
  lastTriggeredAt?: string;
}

interface AlertEvaluationResult {
  alertId: string;
  name: string;
  metric: string;
  currentValue: number;
  threshold: number;
  triggered: boolean;
  condition: string;
}

// ── Formatting Helpers ────────────────────────────────────────────────────────

function formatMs(ms?: number): string {
  if (ms === undefined || ms === null || isNaN(ms)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatCost(costUsd?: number): string {
  if (costUsd === undefined || costUsd === null || isNaN(costUsd)) return "$0.00";
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

function formatPercent(rate?: number): string {
  if (rate === undefined || rate === null || isNaN(rate)) return "0%";
  const pct = rate <= 1 && rate >= 0 ? rate * 100 : rate;
  return `${pct.toFixed(1)}%`;
}

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

const STAGE_LABEL: Record<string, string> = {
  intro: "Started",
  clarify: "Clarified",
  products: "Recommended",
  quote: "Quoted",
  ordered: "Ordered",
  installation: "Guided",
};

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

// ── Transcript Modal with PII Redaction ───────────────────────────────────────

function TranscriptModal({
  project,
  sessionId,
  label,
  onClose,
}: {
  project: Project;
  sessionId: string;
  label: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMsg[] | null>(null);
  const [steps, setSteps] = useState<TranscriptStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    authedFetch(`/api/insights/session/${encodeURIComponent(sessionId)}/transcript?projectId=${encodeURIComponent(project.projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) {
          setError(d.error);
          return;
        }
        setMessages(Array.isArray(d.messages) ? d.messages : []);
        setSteps(Array.isArray(d.steps) ? d.steps : []);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [project.projectId, sessionId]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.6)",
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{
          width: "min(1100px, 94vw)",
          maxHeight: "85vh",
          overflow: "hidden",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 40px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="btn"
          onClick={onClose}
          style={{ position: "absolute", top: 12, right: 12, padding: "4px 8px", zIndex: 1 }}
        >
          <X size={14} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="micro">AUDITED CONVERSATION — {label}</div>
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--jx-gray-200)",
              fontWeight: 600,
            }}
          >
            PII Redacted
          </span>
        </div>
        <div className="role" style={{ fontSize: 10, marginTop: 2, opacity: 0.7 }} title={sessionId}>
          Session {sessionId}
        </div>
        {error && <div style={{ color: "var(--jx-destructive)", marginTop: 8 }}>{error}</div>}
        {!error && !messages && <div className="role" style={{ marginTop: 8 }}>Loading transcript…</div>}
        {messages && messages.length === 0 && steps && steps.length === 0 && (
          <div className="role" style={{ marginTop: 8 }}>No stored transcript found for this session.</div>
        )}

        {messages && (
          <div style={{ display: "flex", gap: 16, marginTop: 12, minHeight: 0, flex: 1 }}>
            {/* Left 40% — Chat bubbles */}
            <div
              style={{
                flex: "0 0 42%",
                maxWidth: "42%",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                paddingRight: 6,
              }}
            >
              {messages
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m, i) => (
                  <div
                    key={i}
                    style={{
                      alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "88%",
                      background: m.role === "user" ? "var(--jx-yellow)" : "var(--jx-gray-200)",
                      color: m.role === "user" ? "#000" : "inherit",
                      borderRadius: 10,
                      padding: "8px 12px",
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.45,
                    }}
                  >
                    <div className="role" style={{ fontSize: 10, marginBottom: 3, opacity: 0.7 }}>
                      {m.role === "user" ? "Customer" : "Assistant"}
                    </div>
                    {typeof m.content === "string" ? m.content : "[structured message]"}
                  </div>
                ))}
            </div>

            {/* Right 58% — Tool Execution Timeline */}
            <div
              style={{
                flex: "0 0 58%",
                maxWidth: "58%",
                overflowY: "auto",
                borderLeft: "1px solid var(--jx-gray-200)",
                paddingLeft: 16,
              }}
            >
              <div className="micro" style={{ marginBottom: 8 }}>
                TOOL & AGENT STEP TIMELINE
              </div>
              {!steps || steps.length === 0 ? (
                <div className="role" style={{ fontSize: 12.5, opacity: 0.8 }}>
                  No tool execution step telemetry captured for this conversation.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {steps.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        background: "var(--jx-gray-200)",
                        borderRadius: 8,
                        padding: "8px 12px",
                        fontSize: 12,
                      }}
                    >
                      <div className="between" style={{ marginBottom: 3 }}>
                        <span style={{ fontWeight: 600 }}>{prettifyTool(s.tool)}</span>
                        <span className="role" style={{ fontSize: 10, opacity: 0.7 }}>
                          {typeof s.turnIndex === "number" ? `Turn ${s.turnIndex} · ` : ""}
                          {formatStepTime(s.ts)}
                        </span>
                      </div>
                      {s.argsSummary && (
                        <div className="role" style={{ fontSize: 11, opacity: 0.85, marginBottom: 2 }}>
                          <span style={{ opacity: 0.6 }}>Args: </span>
                          {s.argsSummary}
                        </div>
                      )}
                      {s.resultSummary && (
                        <div style={{ fontSize: 11 }}>
                          <span className="role" style={{ opacity: 0.6 }}>Result: </span>
                          {s.resultSummary}
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

// ── Main Component ────────────────────────────────────────────────────────────

export function AnalyticsLive({ project }: { project: Project }) {
  // Navigation tabs
  const [tab, setTab] = useState<"funnel" | "performance" | "health" | "comparison" | "reports" | "alerts" | "transcripts">("funnel");

  // Filters
  const [timeWindow, setTimeWindow] = useState<"5m" | "1h" | "24h" | "7d" | "14d" | "30d">("24h");
  const [environment, setEnvironment] = useState<"production" | "staging" | "development">("production");

  // State containers for real backend responses
  const [funnelData, setFunnelData] = useState<FunnelData | null>(null);
  const [perfData, setPerfData] = useState<PerformanceData | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [packCompData, setPackCompData] = useState<PackComparisonData | null>(null);
  const [reportsList, setReportsList] = useState<CustomReport[]>([]);
  const [alertsList, setAlertsList] = useState<AlertDefinition[]>([]);
  const [evaluatedAlerts, setEvaluatedAlerts] = useState<AlertEvaluationResult[] | null>(null);

  // Pack comparison versions input
  const [versionA, setVersionA] = useState<string>("1.0.0");
  const [versionB, setVersionB] = useState<string>("2.0.0");

  // Custom report preview and export state
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [reportPreviewRows, setReportPreviewRows] = useState<any[] | null>(null);
  const [exportingFmt, setExportingFmt] = useState<string | null>(null);

  // Status & loading
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<{ id: string; label: string } | null>(null);

  // Legacy insights compatibility (intents, 14-day line chart, recent sessions)
  const { data: insightsData, reload: reloadInsights } = useInsights(project.projectId);

  // ── Data Fetching ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = `projectId=${encodeURIComponent(project.projectId)}&window=${timeWindow}&environmentId=${environment}&refresh=1`;

      const [funnelRes, perfRes, healthRes, reportsRes, alertsRes] = await Promise.all([
        authedFetch(`/api/bff/api/v1/analytics/funnel?${q}`),
        authedFetch(`/api/bff/api/v1/analytics/performance?${q}`),
        authedFetch(`/api/bff/api/v1/analytics/execution-health?${q}`),
        authedFetch(`/api/bff/api/v1/analytics/reports?projectId=${encodeURIComponent(project.projectId)}`),
        authedFetch(`/api/bff/api/v1/analytics/alerts?projectId=${encodeURIComponent(project.projectId)}`),
      ]);

      if (funnelRes.ok) setFunnelData(await funnelRes.json());
      if (perfRes.ok) setPerfData(await perfRes.json());
      if (healthRes.ok) setHealthData(await healthRes.json());
      if (reportsRes.ok) {
        const reps = await reportsRes.json();
        setReportsList(Array.isArray(reps) ? reps : []);
        if (Array.isArray(reps) && reps.length > 0 && !selectedReportId) {
          setSelectedReportId(reps[0].reportId);
        }
      }
      if (alertsRes.ok) {
        const alts = await alertsRes.json();
        setAlertsList(Array.isArray(alts) ? alts : []);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load real-time analytics");
    } finally {
      setLoading(false);
    }
  }, [project.projectId, timeWindow, environment, selectedReportId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load version comparison on request
  const loadPackComparison = async () => {
    try {
      const res = await authedFetch(
        `/api/bff/api/v1/analytics/pack-comparison?projectId=${encodeURIComponent(
          project.projectId
        )}&versionA=${encodeURIComponent(versionA)}&versionB=${encodeURIComponent(versionB)}&environmentId=${environment}`
      );
      if (res.ok) {
        setPackCompData(await res.json());
      }
    } catch (e: any) {
      console.warn("Failed to load pack comparison:", e);
    }
  };

  // Evaluate alerts on request
  const handleEvaluateAlerts = async () => {
    try {
      const res = await authedFetch(
        `/api/bff/api/v1/analytics/alerts/evaluate?projectId=${encodeURIComponent(project.projectId)}`,
        { method: "POST" }
      );
      if (res.ok) {
        const results = await res.json();
        setEvaluatedAlerts(Array.isArray(results) ? results : []);
      }
    } catch (e: any) {
      console.warn("Failed to evaluate alerts:", e);
    }
  };

  // Run custom report preview
  const handleRunReport = async (reportId: string) => {
    try {
      const res = await authedFetch(
        `/api/bff/api/v1/analytics/reports/${encodeURIComponent(reportId)}/run?tenantId=${encodeURIComponent(project.projectId)}`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = await res.json();
        setReportPreviewRows(data.rows || []);
      }
    } catch (e: any) {
      alert(`Report execution failed: ${e.message}`);
    }
  };

  // Direct RFC 4180 CSV & JSON Export Download
  const handleExportReport = async (reportId: string, format: "csv" | "json") => {
    setExportingFmt(format);
    try {
      const res = await authedFetch(
        `/api/bff/api/v1/analytics/reports/${encodeURIComponent(reportId)}/export?format=${format}&tenantId=${encodeURIComponent(
          project.projectId
        )}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`Export failed with HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportId}_${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Export error: ${e.message}`);
    } finally {
      setExportingFmt(null);
    }
  };

  const handleGlobalRefresh = () => {
    loadData();
    reloadInsights();
    if (tab === "comparison") loadPackComparison();
    if (tab === "alerts") handleEvaluateAlerts();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Header and Scope Selector */}
      <div className="ctop" style={{ marginBottom: 16 }}>
        <div>
          <div className="crumb" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>ANALYTICS & METRICS</span>
            <span>·</span>
            <span style={{ fontWeight: 600, color: "var(--jx-black)" }}>{project.companyName}</span>
            <span
              style={{
                fontSize: 10,
                background: environment === "production" ? "var(--jx-black)" : "var(--jx-gray-200)",
                color: environment === "production" ? "var(--jx-yellow)" : "inherit",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              {environment}
            </span>
          </div>
          <h1 className="pageh">Enterprise Analytics Platform</h1>
          <p className="pagesub">
            Grounded real-time execution telemetry, conversion funnels, agent performance, and audit controls.
          </p>
        </div>

        {/* Global Filter Bar */}
        <div className="actions" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="btn"
            style={{ padding: "6px 12px", fontSize: 12, background: "var(--jx-white)" }}
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as any)}
          >
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>

          <select
            className="btn"
            style={{ padding: "6px 12px", fontSize: 12, background: "var(--jx-white)" }}
            value={timeWindow}
            onChange={(e) => setTimeWindow(e.target.value as any)}
          >
            <option value="5m">Last 5 min (Real-time)</option>
            <option value="1h">Last 1 hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="14d">Last 14 days</option>
            <option value="30d">Last 30 days</option>
          </select>

          <button className="btn" onClick={handleGlobalRefresh} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} className={loading ? "spin" : ""} />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="panel"
          style={{
            borderColor: "var(--jx-destructive)",
            color: "var(--jx-destructive)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
          }}
        >
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={`tab ${tab === "funnel" ? "on" : ""}`} onClick={() => setTab("funnel")}>
          <BarChart2 size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Funnel & Conversion
        </button>
        <button className={`tab ${tab === "performance" ? "on" : ""}`} onClick={() => setTab("performance")}>
          <Cpu size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Models & Tools
        </button>
        <button className={`tab ${tab === "health" ? "on" : ""}`} onClick={() => setTab("health")}>
          <ShieldCheck size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Execution Health
        </button>
        <button
          className={`tab ${tab === "comparison" ? "on" : ""}`}
          onClick={() => {
            setTab("comparison");
            if (!packCompData) loadPackComparison();
          }}
        >
          <Layers size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Pack Comparison
        </button>
        <button className={`tab ${tab === "reports" ? "on" : ""}`} onClick={() => setTab("reports")}>
          <FileText size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Reports & Exports
        </button>
        <button
          className={`tab ${tab === "alerts" ? "on" : ""}`}
          onClick={() => {
            setTab("alerts");
            if (!evaluatedAlerts) handleEvaluateAlerts();
          }}
        >
          <Bell size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Alerts
        </button>
        <button className={`tab ${tab === "transcripts" ? "on" : ""}`} onClick={() => setTab("transcripts")}>
          <MessageSquare size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Audited Transcripts
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 1: Funnel & Conversion
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "funnel" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Funnel KPIs */}
          <div className="statrow">
            <div className="stat">
              <div className="v">{funnelData?.overall.totalSessions ?? 0}</div>
              <div className="l">Total Sessions</div>
              <div className="s">
                <Activity size={12} style={{ marginRight: 4 }} />
                Window: {timeWindow}
              </div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: "var(--jx-success)" }}>
                {formatPercent(funnelData?.overall.conversionRate)}
              </div>
              <div className="l">Stage Conversion Rate</div>
              <div className="s">{funnelData?.overall.completedSessions ?? 0} completed orders</div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: "var(--jx-destructive)" }}>
                {formatPercent(funnelData?.overall.abandonmentRate)}
              </div>
              <div className="l">Abandonment Rate</div>
              <div className="s">{funnelData?.overall.abandonedSessions ?? 0} drop-offs before order</div>
            </div>
            <div className="stat">
              <div className="v">{formatMs(funnelData?.overall.p50CompletionTimeMs)}</div>
              <div className="l">Median Completion (p50)</div>
              <div className="s">
                <Clock size={12} style={{ marginRight: 4 }} />
                p95: {formatMs(funnelData?.overall.p95CompletionTimeMs)}
              </div>
            </div>
          </div>

          {/* Interactive Visual Funnel */}
          <div className="panel">
            <div className="micro">JOURNEY STAGE PROGRESSION & CONVERSIONS</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 16 }}>
              Stage-by-stage drop-off tracking and average dwell times grounded in immutable journey events.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(funnelData?.stages || []).map((st, i) => {
                const total = funnelData?.overall.totalSessions || 1;
                const pctOfTotal = Math.round((st.enteredCount / total) * 100);
                const isFinal = st.stage === "ordered" || st.stage === "installation";

                return (
                  <div
                    key={st.stage}
                    style={{
                      background: "var(--jx-gray-100)",
                      border: "1px solid var(--jx-gray-200)",
                      borderRadius: 12,
                      padding: "14px 16px",
                    }}
                  >
                    <div className="between" style={{ marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            background: isFinal ? "var(--jx-yellow)" : "var(--jx-black)",
                            color: isFinal ? "var(--jx-black)" : "var(--jx-white)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {i + 1}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{STAGE_LABEL[st.stage] || prettifyKey(st.stage)}</span>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 12,
                            background: "var(--jx-white)",
                            border: "1px solid var(--jx-gray-200)",
                            fontWeight: 600,
                          }}
                        >
                          {st.enteredCount.toLocaleString()} sessions
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {st.dropOffCount > 0 && (
                          <span
                            style={{
                              fontSize: 11.5,
                              color: "var(--jx-destructive)",
                              fontWeight: 600,
                              background: "rgba(217, 45, 32, 0.08)",
                              padding: "2px 8px",
                              borderRadius: 4,
                            }}
                          >
                            −{st.dropOffCount} drop-off ({formatPercent(st.dropOffRate)})
                          </span>
                        )}
                        <span className="role" style={{ fontSize: 11 }}>
                          ⏱️ Dwell: {formatMs(st.avgDwellTimeMs)}
                        </span>
                        <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                          {formatPercent(st.conversionRate)} next-stage conversion
                        </span>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div style={{ width: "100%", height: 10, background: "var(--jx-gray-200)", borderRadius: 5, overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${Math.max(1, pctOfTotal)}%`,
                          height: "100%",
                          background: isFinal ? "var(--jx-yellow)" : "var(--jx-black)",
                          transition: "width .3s ease",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Historical Trends & Intents */}
          <div className="cardrow">
            <div className="panel">
              <div className="micro">SESSION VOLUME — LAST 14 DAYS</div>
              <div style={{ marginTop: 12 }}>
                {insightsData?.sessionsByDay && insightsData.sessionsByDay.length > 0 ? (
                  <LineChart
                    points={insightsData.sessionsByDay.map((d) => ({ label: d.date, value: d.count }))}
                    formatLabel={(l) => new Date(l).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  />
                ) : (
                  <div className="role" style={{ padding: "30px 0", textAlign: "center" }}>
                    No day-by-day session activity recorded yet.
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="micro">TOP CUSTOMER INTENTS (GROUNDED CLASSIFICATION)</div>
              <div style={{ marginTop: 12 }}>
                {insightsData?.intents && insightsData.intents.length > 0 ? (
                  <BarChart
                    data={insightsData.intents.map((it) => ({
                      label: intentLabel(it.intent),
                      value: it.n,
                      color: "#5C5C5C",
                    }))}
                  />
                ) : (
                  <div className="role" style={{ padding: "30px 0", textAlign: "center" }}>
                    No classified intent distribution data yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 2: Models & Tools Performance
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "performance" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* LLM Tokens & Cost KPI row */}
          {(() => {
            const models = perfData?.models || [];
            const promptTotal = models.reduce((s, m) => s + m.promptTokens, 0);
            const compTotal = models.reduce((s, m) => s + m.completionTokens, 0);
            const tokensTotal = models.reduce((s, m) => s + m.totalTokens, 0);
            const costTotal = models.reduce((s, m) => s + m.costUsd, 0);

            return (
              <div className="statrow">
                <div className="stat">
                  <div className="v">{promptTotal.toLocaleString()}</div>
                  <div className="l">Prompt Tokens</div>
                  <div className="s">Input context</div>
                </div>
                <div className="stat">
                  <div className="v">{compTotal.toLocaleString()}</div>
                  <div className="l">Completion Tokens</div>
                  <div className="s">Model generation</div>
                </div>
                <div className="stat">
                  <div className="v">{tokensTotal.toLocaleString()}</div>
                  <div className="l">Total LLM Tokens</div>
                  <div className="s">Across all models</div>
                </div>
                <div className="stat">
                  <div className="v" style={{ color: "var(--jx-black)" }}>
                    {formatCost(costTotal)}
                  </div>
                  <div className="l">Estimated Cost (USD)</div>
                  <div className="s">Grounded model pricing matrix</div>
                </div>
              </div>
            );
          })()}

          {/* AI Models Performance Table */}
          <div className="panel">
            <div className="micro">FOUNDATION MODEL TELEMETRY & LATENCY</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 12 }}>
              Latency percentiles, token usage, and cost attribution per model.
            </p>

            <div className="tblwrap">
              <div className="theadr" style={{ gridTemplateColumns: "1.2fr 1.5fr 1fr 1fr 1.2fr 1fr 1fr 1fr" }}>
                <span>Provider</span>
                <span>Model ID</span>
                <span>Invocations</span>
                <span>Total Tokens</span>
                <span>Est. Cost</span>
                <span>p50 Latency</span>
                <span>p95 Latency</span>
                <span>Failure Rate</span>
              </div>
              {!perfData?.models || perfData.models.length === 0 ? (
                <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                  <span className="role">No foundation model calls logged in the selected window.</span>
                </div>
              ) : (
                perfData.models.map((m) => (
                  <div key={m.modelId} className="trow" style={{ gridTemplateColumns: "1.2fr 1.5fr 1fr 1fr 1.2fr 1fr 1fr 1fr" }}>
                    <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{m.provider}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12 }}>{m.modelId}</span>
                    <span>{m.invocations.toLocaleString()}</span>
                    <span>{m.totalTokens.toLocaleString()}</span>
                    <span style={{ fontWeight: 600 }}>{formatCost(m.costUsd)}</span>
                    <span>{formatMs(m.p50LatencyMs)}</span>
                    <span>{formatMs(m.p95LatencyMs)}</span>
                    <span style={{ color: m.failureRate > 0.05 ? "var(--jx-destructive)" : "inherit" }}>
                      {formatPercent(m.failureRate)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Tools & Connector Invocation Reliability */}
          <div className="panel">
            <div className="micro">TOOL EXECUTION HEALTH & ERROR DIAGNOSTICS</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 12 }}>
              Execution volume, success rates, duration percentiles, and ground-truth failure codes.
            </p>

            <div className="tblwrap">
              <div className="theadr" style={{ gridTemplateColumns: "1.8fr 1fr 1fr 1fr 1fr 1fr 2fr" }}>
                <span>Tool / Capability</span>
                <span>Executions</span>
                <span>Success</span>
                <span>Failures</span>
                <span>Success Rate</span>
                <span>p95 Latency</span>
                <span>Errors Encountered</span>
              </div>
              {!perfData?.tools || perfData.tools.length === 0 ? (
                <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                  <span className="role">No tool invocations recorded in this window.</span>
                </div>
              ) : (
                perfData.tools.map((t) => {
                  const errorKeys = Object.keys(t.errorBreakdown || {});
                  return (
                    <div key={t.toolId} className="trow" style={{ gridTemplateColumns: "1.8fr 1fr 1fr 1fr 1fr 1fr 2fr" }}>
                      <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: 12 }}>{t.toolId}</span>
                      <span>{t.executions.toLocaleString()}</span>
                      <span style={{ color: "var(--jx-success)" }}>{t.successCount}</span>
                      <span style={{ color: t.failureCount > 0 ? "var(--jx-destructive)" : "inherit" }}>{t.failureCount}</span>
                      <span style={{ fontWeight: 600 }}>{formatPercent(t.successRate)}</span>
                      <span>{formatMs(t.p95DurationMs)}</span>
                      <div>
                        {errorKeys.length === 0 ? (
                          <span className="role" style={{ fontSize: 11 }}>
                            Clean (0 errors)
                          </span>
                        ) : (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {errorKeys.map((k) => (
                              <span
                                key={k}
                                style={{
                                  fontSize: 10,
                                  background: "rgba(217,45,32,0.1)",
                                  color: "var(--jx-destructive)",
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  fontFamily: "monospace",
                                }}
                              >
                                {k}: {t.errorBreakdown[k]}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 3: Execution Health (Approvals & Connectors)
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "health" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Health KPIs */}
          <div className="statrow">
            <div className="stat">
              <div className="v">{healthData?.approvals.totalRequests ?? 0}</div>
              <div className="l">Tool Approval Requests</div>
              <div className="s">{healthData?.approvals.approved ?? 0} approved, {healthData?.approvals.rejected ?? 0} rejected</div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: "var(--jx-success)" }}>
                {formatPercent(healthData?.approvals.approvalRate)}
              </div>
              <div className="l">Approval Rate</div>
              <div className="s">Avg wait: {formatMs(healthData?.approvals.avgWaitTimeMs)}</div>
            </div>
            <div className="stat">
              <div className="v">{healthData?.notifications.totalDispatched ?? 0}</div>
              <div className="l">Notifications Dispatched</div>
              <div className="s">{formatPercent(healthData?.notifications.deliveryRate)} delivery rate</div>
            </div>
            <div className="stat">
              <div className="v">{healthData?.connectors.totalFlowRuns ?? 0}</div>
              <div className="l">Activepieces Flow Runs</div>
              <div className="s">{formatPercent(healthData?.connectors.successRate)} flow success rate</div>
            </div>
          </div>

          {/* Approvals Detail Panel */}
          <div className="panel">
            <div className="micro">HUMAN-IN-THE-LOOP APPROVAL GOVERNANCE</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 14 }}>
              Execution safety gates requiring merchant/supervisor consent before side-effecting tools run.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
              <div style={{ background: "var(--jx-gray-100)", padding: "12px 16px", borderRadius: 10 }}>
                <div className="role" style={{ fontSize: 11 }}>Approved</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--jx-success)" }}>
                  {healthData?.approvals.approved ?? 0}
                </div>
              </div>
              <div style={{ background: "var(--jx-gray-100)", padding: "12px 16px", borderRadius: 10 }}>
                <div className="role" style={{ fontSize: 11 }}>Rejected</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--jx-destructive)" }}>
                  {healthData?.approvals.rejected ?? 0}
                </div>
              </div>
              <div style={{ background: "var(--jx-gray-100)", padding: "12px 16px", borderRadius: 10 }}>
                <div className="role" style={{ fontSize: 11 }}>Pending</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {healthData?.approvals.pending ?? 0}
                </div>
              </div>
              <div style={{ background: "var(--jx-gray-100)", padding: "12px 16px", borderRadius: 10 }}>
                <div className="role" style={{ fontSize: 11 }}>Expired</div>
                <div style={{ fontSize: 22, fontWeight: 700, opacity: 0.6 }}>
                  {healthData?.approvals.expired ?? 0}
                </div>
              </div>
              <div style={{ background: "var(--jx-gray-100)", padding: "12px 16px", borderRadius: 10 }}>
                <div className="role" style={{ fontSize: 11 }}>p95 Wait Time</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {formatMs(healthData?.approvals.p95WaitTimeMs)}
                </div>
              </div>
            </div>
          </div>

          {/* Multi-Channel Notification Health */}
          <div className="panel">
            <div className="micro">NOTIFICATION DISPATCH HEALTH BY CHANNEL</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 12 }}>
              Channel deliveries across Email, SMS, WhatsApp, and Webhook dispatchers.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
              {["email", "whatsapp", "sms", "webhook"].map((chan) => {
                const info = healthData?.notifications.channels?.[chan] || { total: 0, delivered: 0, failed: 0 };
                const rate = info.total > 0 ? (info.delivered / info.total) : 0;
                return (
                  <div
                    key={chan}
                    style={{
                      border: "1.5px solid var(--jx-gray-200)",
                      borderRadius: 12,
                      padding: "16px",
                      background: "var(--jx-white)",
                    }}
                  >
                    <div className="between" style={{ marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, textTransform: "capitalize", fontSize: 13 }}>{chan}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: rate > 0.9 ? "var(--jx-success)" : "inherit" }}>
                        {formatPercent(rate)}
                      </span>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                      {info.total} <span className="role" style={{ fontSize: 11 }}>sent</span>
                    </div>
                    <div className="between" style={{ fontSize: 11 }}>
                      <span style={{ color: "var(--jx-success)" }}>✓ {info.delivered} delivered</span>
                      <span style={{ color: info.failed > 0 ? "var(--jx-destructive)" : "var(--jx-gray-500)" }}>
                        ✗ {info.failed} failed
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Connectors & Activepieces Health */}
          <div className="panel">
            <div className="micro">ACTIVEPIECES CONNECTOR INTEGRATION STATUS</div>
            <p className="fhelp" style={{ marginTop: 2, marginBottom: 12 }}>
              Status of asynchronous flow runs and third-party webhook integrations.
            </p>

            <div className="tblwrap">
              <div className="theadr" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr" }}>
                <span>Flow Name / Connector</span>
                <span>Total Runs</span>
                <span>Successful</span>
                <span>Failed</span>
                <span>Success Rate</span>
              </div>
              {!healthData?.connectors.flows || Object.keys(healthData.connectors.flows).length === 0 ? (
                <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                  <span className="role">No Activepieces connector flow runs registered yet.</span>
                </div>
              ) : (
                Object.entries(healthData.connectors.flows).map(([flow, stat]) => {
                  const rate = stat.runs > 0 ? stat.success / stat.runs : 0;
                  return (
                    <div key={flow} className="trow" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr" }}>
                      <span style={{ fontWeight: 600 }}>{flow}</span>
                      <span>{stat.runs}</span>
                      <span style={{ color: "var(--jx-success)" }}>{stat.success}</span>
                      <span style={{ color: stat.failure > 0 ? "var(--jx-destructive)" : "inherit" }}>{stat.failure}</span>
                      <span style={{ fontWeight: 600 }}>{formatPercent(rate)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 4: Business Pack Version Comparison & Release Impact
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "comparison" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Comparison Control */}
          <div className="panel" style={{ background: "var(--jx-gray-100)" }}>
            <div className="between" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <div className="micro">CANONICAL BUSINESS PACK RELEASE IMPACT</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                  Side-by-side performance delta between two published pack versions.
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="role" style={{ fontSize: 12 }}>Version A:</span>
                <input
                  className="btn"
                  style={{ width: 90, padding: "6px 10px", fontSize: 12, background: "#fff" }}
                  value={versionA}
                  onChange={(e) => setVersionA(e.target.value)}
                />
                <span className="role" style={{ fontSize: 12 }}>vs. Version B:</span>
                <input
                  className="btn"
                  style={{ width: 90, padding: "6px 10px", fontSize: 12, background: "#fff" }}
                  value={versionB}
                  onChange={(e) => setVersionB(e.target.value)}
                />
                <button className="btn y" onClick={loadPackComparison}>
                  Compare
                </button>
              </div>
            </div>
          </div>

          {/* Release Impact Verdict Banner */}
          {packCompData && (
            <div
              className="panel"
              style={{
                borderColor:
                  packCompData.impact.verdict === "improved"
                    ? "var(--jx-success)"
                    : packCompData.impact.verdict === "degraded"
                    ? "var(--jx-destructive)"
                    : "var(--jx-gray-300)",
                borderWidth: 2,
              }}
            >
              <div className="between">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span
                    style={{
                      background:
                        packCompData.impact.verdict === "improved"
                          ? "var(--jx-success)"
                          : packCompData.impact.verdict === "degraded"
                          ? "var(--jx-destructive)"
                          : "var(--jx-black)",
                      color: "var(--jx-white)",
                      padding: "6px 12px",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 800,
                      textTransform: "uppercase",
                    }}
                  >
                    VERDICT: {packCompData.impact.verdict}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    Comparing Pack v{packCompData.versionA.version} to v{packCompData.versionB.version}
                  </span>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginTop: 16 }}>
                <div style={{ background: "var(--jx-gray-100)", padding: 14, borderRadius: 8 }}>
                  <div className="role" style={{ fontSize: 11 }}>Completion Rate Delta</div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      color: packCompData.impact.completionRateDelta >= 0 ? "var(--jx-success)" : "var(--jx-destructive)",
                    }}
                  >
                    {packCompData.impact.completionRateDelta >= 0 ? "+" : ""}
                    {formatPercent(packCompData.impact.completionRateDelta)}
                  </div>
                </div>

                <div style={{ background: "var(--jx-gray-100)", padding: 14, borderRadius: 8 }}>
                  <div className="role" style={{ fontSize: 11 }}>Tool Failure Delta</div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      color: packCompData.impact.failureRateDelta <= 0 ? "var(--jx-success)" : "var(--jx-destructive)",
                    }}
                  >
                    {packCompData.impact.failureRateDelta > 0 ? "+" : ""}
                    {formatPercent(packCompData.impact.failureRateDelta)}
                  </div>
                </div>

                <div style={{ background: "var(--jx-gray-100)", padding: 14, borderRadius: 8 }}>
                  <div className="role" style={{ fontSize: 11 }}>Latency Change</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {packCompData.impact.latencyChangePercent.toFixed(1)}%
                  </div>
                </div>

                <div style={{ background: "var(--jx-gray-100)", padding: 14, borderRadius: 8 }}>
                  <div className="role" style={{ fontSize: 11 }}>Cost Change</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {packCompData.impact.costChangePercent.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Version Details Cards */}
          {packCompData && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* Version A */}
              <div className="panel">
                <div className="micro">BASE RELEASE — v{packCompData.versionA.version}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  <div className="between">
                    <span className="role">Sessions Evaluated:</span>
                    <b>{packCompData.versionA.sessionCount}</b>
                  </div>
                  <div className="between">
                    <span className="role">Journey Completion Rate:</span>
                    <b>{formatPercent(packCompData.versionA.completionRate)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Tool Failure Rate:</span>
                    <b>{formatPercent(packCompData.versionA.toolFailureRate)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Avg Model Latency:</span>
                    <b>{formatMs(packCompData.versionA.avgModelLatencyMs)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Cost / Session:</span>
                    <b>{formatCost(packCompData.versionA.costPerSessionUsd)}</b>
                  </div>
                </div>
              </div>

              {/* Version B */}
              <div className="panel">
                <div className="micro">TARGET RELEASE — v{packCompData.versionB.version}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  <div className="between">
                    <span className="role">Sessions Evaluated:</span>
                    <b>{packCompData.versionB.sessionCount}</b>
                  </div>
                  <div className="between">
                    <span className="role">Journey Completion Rate:</span>
                    <b>{formatPercent(packCompData.versionB.completionRate)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Tool Failure Rate:</span>
                    <b>{formatPercent(packCompData.versionB.toolFailureRate)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Avg Model Latency:</span>
                    <b>{formatMs(packCompData.versionB.avgModelLatencyMs)}</b>
                  </div>
                  <div className="between">
                    <span className="role">Cost / Session:</span>
                    <b>{formatCost(packCompData.versionB.costPerSessionUsd)}</b>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 5: Custom Reports & RFC 4180 CSV / JSON Exports
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "reports" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="panel">
            <div className="between" style={{ marginBottom: 12 }}>
              <div>
                <div className="micro">CUSTOM AUDIT REPORTS & DATA EXPORTS</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                  Pre-filtered audit logs with strict PII redaction and RFC 4180 compliant CSV downloads.
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => selectedReportId && handleExportReport(selectedReportId, "json")}
                  disabled={!selectedReportId || exportingFmt === "json"}
                >
                  <Download size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  {exportingFmt === "json" ? "Exporting…" : "Export JSON"}
                </button>
                <button
                  className="btn y"
                  onClick={() => selectedReportId && handleExportReport(selectedReportId, "csv")}
                  disabled={!selectedReportId || exportingFmt === "csv"}
                >
                  <Download size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  {exportingFmt === "csv" ? "Exporting…" : "Download CSV (RFC 4180)"}
                </button>
              </div>
            </div>

            {/* Reports List */}
            <div className="tblwrap">
              <div className="theadr" style={{ gridTemplateColumns: "1.5fr 2fr 1fr 1fr 1fr" }}>
                <span>Report ID / Name</span>
                <span>Description</span>
                <span>Category</span>
                <span>Schedule</span>
                <span>Actions</span>
              </div>
              {reportsList.length === 0 ? (
                <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                  <span className="role">No custom reports configured yet for this project.</span>
                </div>
              ) : (
                reportsList.map((rep) => (
                  <div
                    key={rep.reportId}
                    className="trow"
                    style={{
                      gridTemplateColumns: "1.5fr 2fr 1fr 1fr 1fr",
                      background: selectedReportId === rep.reportId ? "rgba(255, 214, 0, 0.08)" : undefined,
                    }}
                    onClick={() => setSelectedReportId(rep.reportId)}
                  >
                    <div>
                      <b style={{ display: "block" }}>{rep.name}</b>
                      <span className="role" style={{ fontSize: 10 }}>{rep.reportId}</span>
                    </div>
                    <span style={{ fontSize: 12 }}>{rep.description || "—"}</span>
                    <span style={{ textTransform: "capitalize" }}>{rep.category}</span>
                    <span style={{ fontSize: 11.5 }}>{rep.schedule?.frequency || "Ad-hoc"}</span>
                    <div>
                      <button
                        className="btn"
                        style={{ padding: "4px 8px", fontSize: 11 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedReportId(rep.reportId);
                          handleRunReport(rep.reportId);
                        }}
                      >
                        <Play size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                        Run Preview
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Live Preview Table */}
          {reportPreviewRows && (
            <div className="panel">
              <div className="between" style={{ marginBottom: 8 }}>
                <div className="micro">PREVIEW EXECUTION RESULTS ({reportPreviewRows.length} rows)</div>
                <button className="btn" style={{ padding: "2px 6px" }} onClick={() => setReportPreviewRows(null)}>
                  <X size={12} />
                </button>
              </div>

              {reportPreviewRows.length === 0 ? (
                <div className="role" style={{ padding: "20px 0", textAlign: "center" }}>
                  0 rows matched the report criteria.
                </div>
              ) : (
                <div className="tblwrap" style={{ maxHeight: 300, overflowY: "auto" }}>
                  <div className="theadr" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr" }}>
                    <span>Event ID</span>
                    <span>Category</span>
                    <span>Event Name</span>
                    <span>Status</span>
                    <span>Timestamp</span>
                  </div>
                  {reportPreviewRows.map((r, i) => (
                    <div key={i} className="trow" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11 }}>{r.eventId}</span>
                      <span>{r.category}</span>
                      <span>{r.eventName}</span>
                      <span style={{ color: r.status === "success" ? "var(--jx-success)" : "inherit" }}>{r.status}</span>
                      <span className="role" style={{ fontSize: 11 }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 6: Threshold Alerts & Health Rules
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "alerts" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="panel">
            <div className="between" style={{ marginBottom: 12 }}>
              <div>
                <div className="micro">OPERATIONAL THRESHOLD ALERTS & MONITORING</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                  Threshold monitors evaluating tool failures, model latencies, and journey drop-off rates.
                </div>
              </div>

              <button className="btn y" onClick={handleEvaluateAlerts}>
                <Play size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                Evaluate All Alerts Live
              </button>
            </div>

            <div className="tblwrap">
              <div className="theadr" style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1fr 1fr 1.5fr" }}>
                <span>Alert Name</span>
                <span>Target Metric</span>
                <span>Condition</span>
                <span>Threshold</span>
                <span>Severity</span>
                <span>Live Evaluation Status</span>
              </div>
              {alertsList.length === 0 ? (
                <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                  <span className="role">No alert threshold rules configured for this tenant.</span>
                </div>
              ) : (
                alertsList.map((alt) => {
                  const evalRes = evaluatedAlerts?.find((e) => e.alertId === alt.alertId);
                  const isTriggered = evalRes?.triggered;

                  return (
                    <div key={alt.alertId} className="trow" style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1fr 1fr 1.5fr" }}>
                      <div>
                        <b>{alt.name}</b>
                        <span className="role" style={{ fontSize: 10, display: "block" }}>{alt.alertId}</span>
                      </div>
                      <span style={{ fontFamily: "monospace", fontSize: 12 }}>{alt.metric}</span>
                      <span style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700 }}>{alt.condition}</span>
                      <span style={{ fontWeight: 600 }}>{alt.threshold}</span>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: 10,
                          textTransform: "uppercase",
                          color: alt.severity === "critical" ? "var(--jx-destructive)" : "var(--jx-yellow-dark)",
                        }}
                      >
                        {alt.severity}
                      </span>
                      <div>
                        {evalRes ? (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "2px 8px",
                              borderRadius: 4,
                              background: isTriggered ? "rgba(217,45,32,0.12)" : "rgba(31,138,76,0.12)",
                              color: isTriggered ? "var(--jx-destructive)" : "var(--jx-success)",
                            }}
                          >
                            {isTriggered ? `TRIGGERED (${evalRes.currentValue})` : `HEALTHY (${evalRes.currentValue})`}
                          </span>
                        ) : (
                          <span className="role" style={{ fontSize: 11 }}>Ready to evaluate</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────
          TAB 7: Audited Transcripts (PII-Redacted)
      ────────────────────────────────────────────────────────────────────────── */}
      {tab === "transcripts" && (
        <div className="panel">
          <div className="micro">AUDITED CONVERSATIONS & EXECUTION TRACES</div>
          <p className="fhelp" style={{ marginTop: 2, marginBottom: 12 }}>
            Real customer session records with automated PII masking. Click any session to drill into chat bubbles and agent tool telemetry.
          </p>

          <div className="tblwrap">
            <div className="theadr" style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr" }}>
              <span>Session</span>
              <span>Last Classified Intent</span>
              <span>Stage</span>
              <span>Turns</span>
              <span>Updated</span>
            </div>
            {!insightsData?.recent || insightsData.recent.length === 0 ? (
              <div className="trow" style={{ gridTemplateColumns: "1fr", padding: 20 }}>
                <span className="role">No stored sessions recorded yet for this project.</span>
              </div>
            ) : (
              insightsData.recent.map((s: any, idx: number) => {
                const label = s.lastIntent?.intent ? intentLabel(s.lastIntent.intent) : `Session #${idx + 1}`;
                return (
                  <div
                    key={s.sessionId}
                    className="trow"
                    style={{ gridTemplateColumns: "1.4fr 1fr 0.8fr 0.6fr 1fr", cursor: "pointer" }}
                    onClick={() => setOpenSession({ id: s.sessionId, label })}
                  >
                    <div>
                      <b style={{ display: "block" }}>{label}</b>
                      <span className="role" style={{ fontSize: 10 }} title={s.sessionId}>
                        {s.sessionId}
                      </span>
                    </div>
                    <span>{intentLabel(s.lastIntent?.intent)}</span>
                    <span style={{ fontWeight: 600 }}>{STAGE_LABEL[s.lastIntent?.stage] || s.lastIntent?.stage || "—"}</span>
                    <span>{s.turnCount ?? 0}</span>
                    <span className="role" style={{ fontSize: 11 }}>
                      {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Drill-down Modal */}
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
