"use client";

/**
 * Merchandising — "control what the agent recommends," in merchandiser
 * language rather than rule-engine language.
 *
 * NOT a second system: this reads/writes the SAME `/rules` API Business
 * Rules already uses, scoped to `scope: 'recommendation'`. A rule here IS a
 * real condition→action rule, injected into every conversation on the
 * agent's very next turn (once published) — same live mechanism, just a
 * visual Trigger → Action canvas instead of a blank condition/action form.
 *
 * Canvas model: one Action node per rule. Zero or more Trigger nodes may
 * connect INTO an Action node; their sentences are joined with " AND " to
 * build the rule's `condition` string. The Action node's own fields compile
 * to the rule's `action` string. Both compiled strings follow the exact
 * same free-text convention BusinessRules.tsx uses (see its `injectedBlock`
 * preview: "When {condition} → {action}"), so rules created here are
 * indistinguishable from ones created in Business Rules.
 *
 * A rule that doesn't reconstruct into this Trigger(s)→Action shape (e.g.
 * hand-written in Business Rules) is rendered as a single read-only
 * "legacy rule" node so nothing silently disappears from the canvas.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
} from "@xyflow/react";
import { NodeCanvas, type PaletteGroup, type CanvasStatus } from "./canvas/NodeCanvas";
import { SERVICES } from "../lib/api";

const API = SERVICES.project;

// ── Server-side rule shape (mirrors project.types.ts BusinessRule) ─────────
interface Rule {
  ruleId: string;
  projectId: string;
  name: string;
  scope: string;
  condition: string;
  action: string;
  priority: number;
  isActive: boolean;
  status?: "draft" | "in_review" | "approved" | "published";
}

// ── Trigger vocabulary ──────────────────────────────────────────────────────
type TriggerField = "category" | "segment" | "inventory" | "season";
type TriggerOperator = "equals" | "contains" | "above" | "below" | "in";

const FIELD_LABEL: Record<TriggerField, string> = {
  category: "Category",
  segment: "Customer segment",
  inventory: "Inventory level",
  season: "Season/time",
};

// Ordered longest-word-first so parsing doesn't match "is" inside "is above".
const OPERATORS: { key: TriggerOperator; word: string }[] = [
  { key: "in", word: "is one of" },
  { key: "above", word: "is above" },
  { key: "below", word: "is below" },
  { key: "contains", word: "contains" },
  { key: "equals", word: "is" },
];
const OPERATOR_WORD: Record<TriggerOperator, string> = Object.fromEntries(OPERATORS.map((o) => [o.key, o.word])) as any;

interface TriggerData extends Record<string, unknown> {
  kind: "trigger";
  field: TriggerField;
  operator: TriggerOperator;
  value: string;
  label: string;
}

function triggerSentence(d: Pick<TriggerData, "field" | "operator" | "value">): string {
  return `${FIELD_LABEL[d.field]} ${OPERATOR_WORD[d.operator]} ${d.value.trim() || "…"}`;
}

/** Best-effort parse of one AND-segment back into a trigger. Returns null if it doesn't match the known grammar. */
function parseTriggerSegment(segment: string): { field: TriggerField; operator: TriggerOperator; value: string } | null {
  const s = segment.trim();
  for (const field of Object.keys(FIELD_LABEL) as TriggerField[]) {
    const label = FIELD_LABEL[field];
    if (!s.startsWith(label + " ")) continue;
    const rest = s.slice(label.length + 1);
    for (const { key, word } of OPERATORS) {
      if (rest === word || rest.startsWith(word + " ")) {
        const value = rest.slice(word.length).trim();
        if (!value) return null;
        return { field, operator: key, value };
      }
    }
  }
  return null;
}

// ── Action vocabulary ───────────────────────────────────────────────────────
type ActionType = "boost" | "feature" | "exclude" | "pin";

interface ActionData extends Record<string, unknown> {
  kind: "action";
  actionType: ActionType;
  percent: number; // boost
  position: number; // pin
  text: string; // free-text target for feature/exclude/pin
  label: string;
  ruleId?: string; // set once persisted
  status?: Rule["status"];
}

function actionSentence(d: Pick<ActionData, "actionType" | "percent" | "position" | "text">): string {
  const t = d.text.trim();
  switch (d.actionType) {
    case "boost":
      return `Increase rank by ${d.percent}%`;
    case "feature":
      return t ? `Feature "${t}" at the top of the recommendation list` : `Feature at the top of the recommendation list`;
    case "exclude":
      return t ? `Exclude "${t}" from recommendations` : `Exclude from recommendations`;
    case "pin":
      return t ? `Pin "${t}" to position ${d.position}` : `Pin to position ${d.position}`;
  }
}

function actionLabel(actionType: ActionType): string {
  return { boost: "Boost", feature: "Feature", exclude: "Exclude", pin: "Pin" }[actionType];
}

/** Best-effort parse of an action string back into structured action data. */
function parseAction(action: string): { actionType: ActionType; percent: number; position: number; text: string } | null {
  let m: RegExpMatchArray | null;
  if ((m = action.match(/^Increase rank by (\d+)%$/))) return { actionType: "boost", percent: Number(m[1]), position: 1, text: "" };
  if ((m = action.match(/^Feature "(.*)" at the top of the recommendation list$/))) return { actionType: "feature", percent: 20, position: 1, text: m[1] };
  if (action === "Feature at the top of the recommendation list") return { actionType: "feature", percent: 20, position: 1, text: "" };
  if ((m = action.match(/^Exclude "(.*)" from recommendations$/))) return { actionType: "exclude", percent: 20, position: 1, text: m[1] };
  if (action === "Exclude from recommendations") return { actionType: "exclude", percent: 20, position: 1, text: "" };
  if ((m = action.match(/^Pin "(.*)" to position (\d+)$/))) return { actionType: "pin", percent: 20, position: Number(m[2]), text: m[1] };
  if ((m = action.match(/^Pin to position (\d+)$/))) return { actionType: "pin", percent: 20, position: Number(m[1]), text: "" };
  return null;
}

interface LegacyData extends Record<string, unknown> {
  kind: "legacy";
  ruleId: string;
  name: string;
  condition: string;
  action: string;
  priority: number;
  isActive: boolean;
  status?: Rule["status"];
  label: string;
}

type NodeData = TriggerData | ActionData | LegacyData;

const PRIORITY_FOR: Record<ActionType, number> = { exclude: 10, feature: 50, boost: 100, pin: 100 };

// ── Palette ──────────────────────────────────────────────────────────────
const PALETTE: PaletteGroup[] = [
  {
    label: "Triggers",
    nodes: [
      { type: "trigger-category", label: "Category match", description: "Fires when the recommended item's category matches.", defaultData: { kind: "trigger", field: "category", operator: "equals", value: "" } },
      { type: "trigger-segment", label: "Customer segment", description: "Fires for a given customer segment.", defaultData: { kind: "trigger", field: "segment", operator: "equals", value: "" } },
      { type: "trigger-inventory", label: "Inventory level", description: "Fires based on stock level.", defaultData: { kind: "trigger", field: "inventory", operator: "below", value: "" } },
      { type: "trigger-season", label: "Season/time", description: "Fires during a season or time window.", defaultData: { kind: "trigger", field: "season", operator: "equals", value: "" } },
    ],
  },
  {
    label: "Actions",
    nodes: [
      { type: "action-boost", label: "Boost rank by %", description: "Nudge toward the top without hiding anything else.", defaultData: { kind: "action", actionType: "boost", percent: 20, position: 1, text: "" } },
      { type: "action-feature", label: "Feature at top", description: "Always surface this first.", defaultData: { kind: "action", actionType: "feature", percent: 20, position: 1, text: "" } },
      { type: "action-exclude", label: "Exclude from results", description: "Never recommend this.", defaultData: { kind: "action", actionType: "exclude", percent: 20, position: 1, text: "" } },
      { type: "action-pin", label: "Pin to position", description: "Lock this to an exact slot.", defaultData: { kind: "action", actionType: "pin", percent: 20, position: 1, text: "" } },
    ],
  },
];

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeq++}`;

export function Merchandising({ projectId }: { projectId: string }) {
  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/projects/${projectId}/rules`, { headers: { "X-Tenant-ID": projectId } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all: Rule[] = await res.json();
      const rules = all.filter((r) => r.scope === "recommendation");

      const nextNodes: Node<NodeData>[] = [];
      const nextEdges: Edge[] = [];
      let col = 0;

      for (const rule of rules) {
        const parsedAction = parseAction(rule.action);
        const segments = rule.condition.split(" AND ").map((s) => s.trim()).filter(Boolean);
        const parsedTriggers = segments.map(parseTriggerSegment);
        const allTriggersOk = parsedTriggers.length > 0 && parsedTriggers.every((t) => t !== null);

        const x = col * 320;
        col += 1;

        if (parsedAction && allTriggersOk) {
          const actionId = `action-${rule.ruleId}`;
          const actionData: ActionData = {
            kind: "action",
            ...parsedAction,
            label: `${actionLabel(parsedAction.actionType)}\n${actionSentence(parsedAction)}`,
            ruleId: rule.ruleId,
            status: rule.status || "published",
          };
          nextNodes.push({ id: actionId, type: "default", position: { x, y: 220 }, data: actionData });

          parsedTriggers.forEach((t, i) => {
            const triggerId = `trigger-${rule.ruleId}-${i}`;
            const triggerData: TriggerData = { kind: "trigger", ...(t as any), label: triggerSentence(t as any) };
            nextNodes.push({ id: triggerId, type: "default", position: { x, y: i * 90 }, data: triggerData });
            nextEdges.push({ id: `e-${triggerId}-${actionId}`, source: triggerId, target: actionId });
          });
        } else {
          const legacyData: LegacyData = {
            kind: "legacy",
            ruleId: rule.ruleId,
            name: rule.name,
            condition: rule.condition,
            action: rule.action,
            priority: rule.priority,
            isActive: rule.isActive,
            status: rule.status || "published",
            label: `Legacy rule\n${rule.name}`,
          };
          nextNodes.push({ id: `legacy-${rule.ruleId}`, type: "default", position: { x, y: 220 }, data: legacyData });
        }
      }

      setNodes(nextNodes);
      setEdges(nextEdges);
    } catch (e: any) {
      setError(`Could not load merchandising rules from project-service (${API}). Is it running? ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const onNodesChange: OnNodesChange<Node<NodeData>> = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );
  const onEdgesChange: OnEdgesChange<Edge> = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );
  const onConnect: OnConnect = useCallback((connection) => {
    // Only Trigger → Action connections make sense on this canvas.
    setNodes((nds) => {
      const source = nds.find((n) => n.id === connection.source);
      const target = nds.find((n) => n.id === connection.target);
      if (!source || !target || source.data.kind !== "trigger" || target.data.kind !== "action") return nds;
      setEdges((eds) => addEdge(connection, eds));
      return nds;
    });
  }, []);

  const onAddNode = useCallback((type: string, position: { x: number; y: number }, defaultData: Record<string, any>) => {
    const isAction = type.startsWith("action-");
    const id = nextId(isAction ? "action" : "trigger");
    const label = isAction
      ? `${actionLabel(defaultData.actionType)}\n${actionSentence(defaultData as any)}`
      : triggerSentence(defaultData as any);
    setNodes((nds) => [...nds, { id, type: "default", position, data: { ...defaultData, label } as NodeData }]);
  }, []);

  // ── Compile canvas → flat rules (same shape the /rules API already expects) ──
  const compileRules = useCallback(() => {
    const actionNodes = nodes.filter((n) => n.data.kind === "action") as Node<ActionData>[];
    const legacyNodes = nodes.filter((n) => n.data.kind === "legacy") as Node<LegacyData>[];

    const compiled = actionNodes.map((actionNode) => {
      const incomingTriggerIds = edges.filter((e) => e.target === actionNode.id).map((e) => e.source);
      const triggerNodes = nodes.filter((n) => incomingTriggerIds.includes(n.id) && n.data.kind === "trigger") as Node<TriggerData>[];
      const condition = triggerNodes.length
        ? triggerNodes.map((n) => triggerSentence(n.data)).join(" AND ")
        : "Always";
      const action = actionSentence(actionNode.data);
      const name = `${actionLabel(actionNode.data.actionType)}: ${condition}`.slice(0, 120);
      return {
        nodeId: actionNode.id,
        ruleId: actionNode.data.ruleId,
        status: actionNode.data.status,
        payload: {
          name,
          scope: "recommendation" as const,
          condition,
          action,
          priority: PRIORITY_FOR[actionNode.data.actionType],
          isActive: true,
        },
      };
    });

    return { compiled, legacyNodes };
  }, [nodes, edges]);

  /** Saves every action-node rule via the existing /rules endpoint. Returns each
   * rule's resolved ruleId + pre-save status so callers (e.g. publish) don't have
   * to read back the (asynchronously reloaded) node state afterwards. */
  async function saveDraft(): Promise<{ ruleId: string; status?: Rule["status"] }[]> {
    setError(null);
    const { compiled } = compileRules();
    const saved: { ruleId: string; status?: Rule["status"] }[] = [];
    try {
      for (const rule of compiled) {
        if (rule.ruleId) {
          const res = await fetch(`${API}/api/v1/projects/${projectId}/rules/${rule.ruleId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-Tenant-ID": projectId },
            body: JSON.stringify(rule.payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          saved.push({ ruleId: rule.ruleId, status: rule.status });
        } else {
          const res = await fetch(`${API}/api/v1/projects/${projectId}/rules`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Tenant-ID": projectId },
            body: JSON.stringify(rule.payload),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const created: { success: boolean; ruleId?: string } = await res.json();
          if (created.ruleId) saved.push({ ruleId: created.ruleId, status: "draft" });
        }
      }
      await load();
      return saved;
    } catch (e: any) {
      setError(`Could not save draft: ${e.message}`);
      throw e;
    }
  }

  async function publish() {
    setError(null);
    try {
      // Publish must save first so every action node on the canvas has a ruleId.
      const saved = await saveDraft();
      // Legacy (read-only) rules already have a ruleId — they just need publishing too.
      const legacyNodes = nodes.filter((n) => n.data.kind === "legacy") as Node<LegacyData>[];
      const legacyToPublish = legacyNodes
        .filter((n) => n.data.status !== "published")
        .map((n) => ({ ruleId: n.data.ruleId, status: n.data.status }));
      const toPublish = [...saved, ...legacyToPublish].filter((r) => r.status !== "published");
      for (const r of toPublish) {
        const res = await fetch(`${API}/api/v1/projects/${projectId}/rules/${r.ruleId}/publish`, {
          method: "POST",
          headers: { "X-Tenant-ID": projectId },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      await load();
    } catch (e: any) {
      setError(`Could not publish: ${e.message}`);
    }
  }

  const handleSaveDraft = useCallback(async () => {
    setSavingDraft(true);
    try { await saveDraft(); } finally { setSavingDraft(false); }
  }, [nodes, edges, projectId]);

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try { await publish(); } finally { setPublishing(false); }
  }, [nodes, edges, projectId]);

  // Canvas-level status pill: published only when every action/legacy node is published.
  const status: CanvasStatus = useMemo(() => {
    const relevant = nodes.filter((n) => n.data.kind === "action" || n.data.kind === "legacy") as Node<ActionData | LegacyData>[];
    if (relevant.length === 0) return "draft";
    if (relevant.every((n) => n.data.status === "published")) return "published";
    if (relevant.some((n) => n.data.status === "approved")) return "approved";
    if (relevant.some((n) => n.data.status === "in_review")) return "in_review";
    return "draft";
  }, [nodes]);

  const renderInspector = useCallback((node: Node<NodeData> | null, onChange: (data: Partial<NodeData>) => void) => {
    if (!node) return null;
    const d = node.data;

    if (d.kind === "trigger") {
      const recompute = (patch: Partial<TriggerData>) => {
        const merged = { ...d, ...patch };
        onChange({ ...patch, label: triggerSentence(merged) } as Partial<NodeData>);
      };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div><span className="flabel">Field</span>
            <select className="field" value={d.field} onChange={(e) => recompute({ field: e.target.value as TriggerField })}>
              {(Object.keys(FIELD_LABEL) as TriggerField[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
            </select>
          </div>
          <div><span className="flabel">Operator</span>
            <select className="field" value={d.operator} onChange={(e) => recompute({ operator: e.target.value as TriggerOperator })}>
              {OPERATORS.map((o) => <option key={o.key} value={o.key}>{o.word}</option>)}
            </select>
          </div>
          <div><span className="flabel">Value</span>
            <input className="field" placeholder="e.g. Outdoor Gear" value={d.value} onChange={(e) => recompute({ value: e.target.value })} />
          </div>
          <p className="fhelp" style={{ margin: 0 }}>Reads as: <b>{triggerSentence(d)}</b></p>
        </div>
      );
    }

    if (d.kind === "action") {
      const recompute = (patch: Partial<ActionData>) => {
        const merged = { ...d, ...patch };
        onChange({ ...patch, label: `${actionLabel(merged.actionType)}\n${actionSentence(merged)}` } as Partial<NodeData>);
      };
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div><span className="flabel">Action type</span>
            <select className="field" value={d.actionType} onChange={(e) => recompute({ actionType: e.target.value as ActionType })}>
              <option value="boost">Boost rank by %</option>
              <option value="feature">Feature at top</option>
              <option value="exclude">Exclude from results</option>
              <option value="pin">Pin to position</option>
            </select>
          </div>
          {d.actionType === "boost" && (
            <div><span className="flabel">Boost percent: {d.percent}%</span>
              <input type="range" min={0} max={100} step={5} value={d.percent} style={{ width: "100%" }}
                onChange={(e) => recompute({ percent: Number(e.target.value) })} />
            </div>
          )}
          {d.actionType === "pin" && (
            <div><span className="flabel">Position</span>
              <input className="field" type="number" min={1} style={{ maxWidth: 120 }} value={d.position}
                onChange={(e) => recompute({ position: Number(e.target.value) })} />
            </div>
          )}
          {(d.actionType === "feature" || d.actionType === "exclude" || d.actionType === "pin") && (
            <div><span className="flabel">Target (optional — product/category/SKU)</span>
              <input className="field" placeholder="e.g. Outdoor Gear, or a specific SKU" value={d.text}
                onChange={(e) => recompute({ text: e.target.value })} />
            </div>
          )}
          <p className="fhelp" style={{ margin: 0 }}>Reads as: <b>{actionSentence(d)}</b></p>
          {d.status && <span className="micro">status: {d.status}</span>}
        </div>
      );
    }

    // legacy — read-only
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="fhelp" style={{ margin: 0 }}>
          This rule doesn't match the Trigger → Action canvas shape (likely created or edited in Business Rules). It's shown
          read-only here so it isn't lost — edit it in Business Rules for finer control.
        </p>
        <div><span className="flabel">Name</span><div style={{ fontSize: 13 }}>{d.name}</div></div>
        <div><span className="flabel">Condition</span><div style={{ fontSize: 13 }}>{d.condition}</div></div>
        <div><span className="flabel">Action</span><div style={{ fontSize: 13 }}>{d.action}</div></div>
        <span className="micro">status: {d.status || "published"} · priority {d.priority} · {d.isActive ? "active" : "inactive"}</span>
      </div>
    );
  }, []);

  return (
    <>
      <p className="pagesub" style={{ marginTop: -6, marginBottom: 10 }}>
        Control what the agent recommends for <b>{projectId}</b> by wiring Trigger nodes into Action nodes — takes effect on
        the agent's very next conversation once published, no redeploy.
      </p>
      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)", marginBottom: 12 }}>{error}</div>}
      {loading ? (
        <div className="panel">Loading…</div>
      ) : (
        <NodeCanvas<NodeData>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          paletteGroups={PALETTE}
          onAddNode={onAddNode}
          renderInspector={renderInspector}
          onSaveDraft={handleSaveDraft}
          onPublish={handlePublish}
          status={status}
          savingDraft={savingDraft}
          publishing={publishing}
          title="Merchandising"
          subtitle="Drag a Trigger and an Action onto the canvas, connect them, and fill in the inspector — the connected pair compiles into one condition → action rule."
        />
      )}
    </>
  );
}
