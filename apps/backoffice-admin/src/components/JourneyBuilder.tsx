"use client";

/**
 * Journey Builder — a visual canvas for the Journey Agent's flow logic.
 *
 * This is a THIN COMPILER, not a new interpreter: the agent runtime still only
 * ever reads `persona.journeyGuidance` (free-text prose) every turn, exactly as
 * it does today via the plain textarea in AiOrchestration.tsx. This canvas gives
 * admins a structured way to BUILD that prose — dragging Trigger / Condition /
 * Action / Tool nodes onto a graph, wiring them together, and compiling the
 * graph into the same readable guidance block a human could type by hand.
 *
 * Two fields are saved side by side on `persona`, via the SAME project-update
 * (PATCH) call AiOrchestration.tsx already uses:
 *   - `journeyGraph`    — the raw editable graph (nodes/edges/positions), so
 *                         re-opening this canvas loads real nodes instead of
 *                         trying to reverse-engineer them from prose.
 *   - `journeyGuidance` — the compiled prose, regenerated from the graph on
 *                         every save. A human can still hand-edit this value
 *                         afterward in AiOrchestration.tsx's textarea; that
 *                         edit just won't roundtrip back into node positions
 *                         (expected — prose → graph is not attempted).
 *
 * Publish reuses the EXISTING project-wide publish pipeline
 * (`POST /api/v1/projects/:projectId/publish`, `projectApi.publish`) — there is
 * no separate "journey graph" publish/version concept.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
} from "@xyflow/react";
import { Route } from "lucide-react";
import { NodeCanvas, type PaletteGroup, type CanvasStatus } from "./canvas/NodeCanvas";
import { projectApi, CAPABILITY_CATALOG, type Project } from "../lib/api";

// ── Node data shape ──────────────────────────────────────────────────────
// Every node carries a `kind` (which of our logical node types it is) plus a
// display `label`, and then type-specific fields. We deliberately keep every
// node's React Flow `type` as the default renderer ("default", showing
// `data.label`) — NodeCanvas doesn't register custom node components, so a
// custom `node.type` string would render as a blank/broken node.
interface JourneyNodeData {
  kind: string;          // 'trigger.start' | 'trigger.intent' | 'condition.branch' | 'action.ask' | 'action.recommend' | 'action.handoff' | 'tool.<capabilityId>'
  label: string;
  [key: string]: any;
}

type JNode = Node<JourneyNodeData>;
type JEdge = Edge;

// ── Palette ───────────────────────────────────────────────────────────────

const PALETTE_GROUPS: PaletteGroup[] = [
  {
    label: "Triggers",
    nodes: [
      {
        type: "trigger.start",
        label: "Journey start",
        description: "Entry point — fires at the beginning of every conversation.",
        defaultData: { kind: "trigger.start", label: "Journey start" },
      },
      {
        type: "trigger.intent",
        label: "Intent detected",
        description: "Fires when the customer's message matches an intent/keyword.",
        defaultData: { kind: "trigger.intent", label: "Intent detected", intent: "" },
      },
    ],
  },
  {
    label: "Conditions",
    nodes: [
      {
        type: "condition.branch",
        label: "Branch",
        description: "Split the flow on a plain-English condition.",
        defaultData: { kind: "condition.branch", label: "Branch", condition: "" },
      },
    ],
  },
  {
    label: "Actions",
    nodes: [
      {
        type: "action.ask",
        label: "Ask clarifying question",
        description: "Ask the customer a targeted question (max 3 per journey).",
        defaultData: { kind: "action.ask", label: "Ask clarifying question", text: "" },
      },
      {
        type: "action.recommend",
        label: "Show recommendations",
        description: "Present a curated plan. Connect Tool nodes to power it.",
        defaultData: { kind: "action.recommend", label: "Show recommendations", text: "" },
      },
      {
        type: "action.handoff",
        label: "Hand off to human",
        description: "Escalate the conversation to a human operator.",
        defaultData: { kind: "action.handoff", label: "Hand off to human", text: "" },
      },
    ],
  },
  {
    label: "Tools",
    nodes: CAPABILITY_CATALOG.map((c) => ({
      type: `tool.${c.id}`,
      label: c.label,
      description: c.description,
      defaultData: { kind: `tool.${c.id}`, label: c.label, description: c.description, capabilityId: c.id },
    })),
  },
];

// ── Compiler: graph → prose ──────────────────────────────────────────────
// Walks the graph starting from each Trigger node, following edges forward.
// Sequential chains (trigger → action → action → …) stay at one indent level;
// a Condition ("Branch") node is the only thing that increases indent, one
// level per branch. Tool nodes wired directly under a "Show recommendations"
// action are folded into that action's line ("...using: roster, teamOrder")
// rather than getting their own line.
export function compileGraphToGuidance(nodes: JNode[], edges: JEdge[]): string {
  if (!nodes.length) return "";

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source)!.push(e.target);
  }
  const childrenOf = (id: string): JNode[] =>
    (adjacency.get(id) || []).map((cid) => nodesById.get(cid)).filter((n): n is JNode => !!n);

  function renderChain(node: JNode, indent: number, isFirst: boolean, lines: string[], visited: Set<string>): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const pad = "  ".repeat(indent);
    const kind = node.data.kind;

    if (kind === "condition.branch") {
      lines.push(`${pad}If ${node.data.condition?.trim() || "…"}:`);
      for (const child of childrenOf(node.id)) renderChain(child, indent + 1, true, lines, visited);
      return;
    }

    if (kind === "action.ask") {
      lines.push(`${pad}${isFirst ? "Ask" : "Then ask"}: "${node.data.text?.trim() || "…"}"`);
      for (const child of childrenOf(node.id)) renderChain(child, indent, false, lines, visited);
      return;
    }

    if (kind === "action.recommend") {
      const children = childrenOf(node.id);
      const toolChildren = children.filter((c) => c.data.kind?.startsWith("tool."));
      const otherChildren = children.filter((c) => !c.data.kind?.startsWith("tool."));
      toolChildren.forEach((c) => visited.add(c.id));
      const capIds = toolChildren.map((c) => c.data.capabilityId).filter(Boolean);
      const verb = isFirst ? "Show recommendations" : "Then show recommendations";
      const extra = node.data.text?.trim() ? ` — ${node.data.text.trim()}` : "";
      const using = capIds.length ? ` using: ${capIds.join(", ")}` : "";
      lines.push(`${pad}${verb}${extra}${using}`);
      for (const child of otherChildren) renderChain(child, indent, false, lines, visited);
      return;
    }

    if (kind === "action.handoff") {
      const extra = node.data.text?.trim() ? ` — ${node.data.text.trim()}` : "";
      lines.push(`${pad}${isFirst ? "Hand off to a human" : "Then hand off to a human"}${extra}`);
      for (const child of childrenOf(node.id)) renderChain(child, indent, false, lines, visited);
      return;
    }

    if (kind?.startsWith("tool.")) {
      lines.push(`${pad}${isFirst ? "Use" : "Then use"}: ${node.data.label || node.data.capabilityId}`);
      for (const child of childrenOf(node.id)) renderChain(child, indent, false, lines, visited);
      return;
    }

    // Unknown node kind — skip it but keep walking its children so the rest
    // of the chain still compiles.
    for (const child of childrenOf(node.id)) renderChain(child, indent, isFirst, lines, visited);
  }

  const triggers = nodes.filter((n) => n.data.kind?.startsWith("trigger."));
  const blocks: string[] = [];
  for (const trigger of triggers) {
    const header =
      trigger.data.kind === "trigger.intent"
        ? `When the customer's intent matches "${trigger.data.intent?.trim() || "…"}":`
        : `When the journey starts:`;
    const visited = new Set<string>([trigger.id]);
    const lines: string[] = [];
    for (const child of childrenOf(trigger.id)) renderChain(child, 1, true, lines, visited);
    blocks.push([header, ...lines].join("\n"));
  }
  return blocks.join("\n\n");
}

// ── Inspector ────────────────────────────────────────────────────────────

function Inspector({ node, onChange }: { node: JNode | null; onChange: (data: Partial<JourneyNodeData>) => void }) {
  if (!node) return null;
  const kind = node.data.kind;

  if (kind === "trigger.start") {
    return <p className="micro" style={{ color: "var(--jx-gray-500)" }}>Entry point — fires at the start of every conversation. No configuration needed.</p>;
  }

  if (kind === "trigger.intent") {
    return (
      <div>
        <span className="flabel">Intent / keyword</span>
        <input
          className="field"
          value={node.data.intent || ""}
          onChange={(e) => onChange({ intent: e.target.value })}
          placeholder='e.g. "team order"'
        />
      </div>
    );
  }

  if (kind === "condition.branch") {
    return (
      <div>
        <span className="flabel">Condition (plain English)</span>
        <textarea
          className="field"
          rows={3}
          value={node.data.condition || ""}
          onChange={(e) => onChange({ condition: e.target.value })}
          placeholder="e.g. the customer mentioned a budget under $500"
        />
      </div>
    );
  }

  if (kind === "action.ask") {
    return (
      <div>
        <span className="flabel">Question to ask</span>
        <textarea
          className="field"
          rows={3}
          value={node.data.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="What sport and how many players?"
        />
      </div>
    );
  }

  if (kind === "action.recommend") {
    return (
      <div>
        <span className="flabel">Notes (optional)</span>
        <textarea
          className="field"
          rows={3}
          value={node.data.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Any extra guidance for this recommendation step"
        />
        <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 8 }}>
          Connect Tool nodes downstream of this node to specify which capabilities power the recommendation.
        </p>
      </div>
    );
  }

  if (kind === "action.handoff") {
    return (
      <div>
        <span className="flabel">Handoff note</span>
        <textarea
          className="field"
          rows={3}
          value={node.data.text || ""}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="e.g. when the customer asks for a refund"
        />
      </div>
    );
  }

  if (kind?.startsWith("tool.")) {
    return (
      <div>
        <span className="flabel">Capability</span>
        <p style={{ fontWeight: 700, fontSize: 12.5, margin: "4px 0" }}>{node.data.label}</p>
        <p className="micro" style={{ color: "var(--jx-gray-500)" }}>{node.data.description}</p>
        <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 10 }}>
          Read-only — this node is fixed to the <code>{node.data.capabilityId}</code> capability.
        </p>
      </div>
    );
  }

  return null;
}

// ── Component ────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(type: string) {
  idCounter += 1;
  return `${type}-${Date.now()}-${idCounter}`;
}

export function JourneyBuilder({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState<CanvasStatus>("draft");

  const [nodes, setNodes, onNodesChange] = useNodesState<JNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<JEdge>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await projectApi.get(projectId);
      setProject(p);
      const graph = p.persona?.journeyGraph;
      setNodes((graph?.nodes as JNode[]) || []);
      setEdges((graph?.edges as JEdge[]) || []);
      setStatus(p.activeVersion ? "published" : "draft");
    } catch (e: any) {
      setError(e.message || "Failed to load project.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onAddNode = useCallback(
    (type: string, position: { x: number; y: number }, defaultData: Record<string, any>) => {
      const node: JNode = {
        id: nextId(type),
        type: "default",
        position,
        data: { ...defaultData } as JourneyNodeData,
      };
      setNodes((nds) => [...nds, node]);
    },
    [setNodes],
  );

  const renderInspector = useCallback(
    (node: JNode | null, onChange: (data: Partial<JourneyNodeData>) => void) => (
      <Inspector node={node} onChange={onChange} />
    ),
    [],
  );

  const compiledGuidance = useMemo(() => compileGraphToGuidance(nodes, edges), [nodes, edges]);

  const saveDraft = useCallback(async () => {
    setSavingDraft(true);
    setError(null);
    try {
      await projectApi.update(projectId, {
        persona: {
          journeyGraph: { nodes, edges },
          journeyGuidance: compiledGuidance,
        },
      });
      setStatus((s) => (s === "published" ? "published" : "draft"));
    } catch (e: any) {
      setError(e.message || "Save failed.");
    } finally {
      setSavingDraft(false);
    }
  }, [projectId, nodes, edges, compiledGuidance]);

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    try {
      // Publish must ship the LATEST graph/guidance, not whatever the last Save
      // Draft call persisted — save first, then publish the resulting draft.
      await projectApi.update(projectId, {
        persona: {
          journeyGraph: { nodes, edges },
          journeyGuidance: compiledGuidance,
        },
      });
      await projectApi.publish(projectId);
      setStatus("published");
    } catch (e: any) {
      setError(e.message || "Publish failed.");
    } finally {
      setPublishing(false);
    }
  }, [projectId, nodes, edges, compiledGuidance]);

  if (loading) return <div className="panel">Loading journey builder…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0 }}>
      {error && (
        <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>
          {error}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 620 }}>
        <NodeCanvas<JourneyNodeData>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          paletteGroups={PALETTE_GROUPS}
          onAddNode={onAddNode}
          renderInspector={renderInspector}
          onSaveDraft={saveDraft}
          onPublish={publish}
          status={status}
          savingDraft={savingDraft}
          publishing={publishing}
          title="Journey Logic"
          subtitle={`Build the flow for ${project?.companyName || projectId} — compiles into Journey guidance on save.`}
        />
      </div>
      <div className="panel">
        <h4><Route size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Compiled preview</h4>
        <p className="micro" style={{ color: "var(--jx-gray-500)", margin: "4px 0 8px" }}>
          This is the exact text that will be saved into Journey guidance (AI Orchestration tab) on Save Draft / Publish.
          You can still hand-edit it there afterward.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "var(--jx-gray-100)", padding: 12, borderRadius: 8, margin: 0 }}>
          {compiledGuidance || "— add a Trigger node and connect actions to it to see compiled guidance —"}
        </pre>
      </div>
    </div>
  );
}
