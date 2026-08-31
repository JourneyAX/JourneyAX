"use client";

/**
 * NodeCanvas — generic, reusable canvas SHELL around @xyflow/react (React Flow).
 *
 * This component is NOT specific to any domain (rules, journeys, …). Two
 * consumers wrap it: the Merchandising/Business-Rules canvas and the Journey
 * logic canvas. NodeCanvas owns no persistence — nodes/edges/status are fully
 * controlled from outside; NodeCanvas is purely the presentational/interactive
 * shell (palette + canvas + inspector + header controls).
 *
 * ── PROP INTERFACE (read this before wiring a new consumer) ─────────────────
 *
 *   interface PaletteNodeDef {
 *     type: string;                       // node "kind" — consumer-defined
 *     label: string;
 *     description: string;
 *     defaultData: Record<string, any>;   // seeded onto node.data when dropped
 *   }
 *   interface PaletteGroup {
 *     label: string;
 *     nodes: PaletteNodeDef[];
 *   }
 *
 *   type CanvasStatus = 'draft' | 'in_review' | 'approved' | 'published';
 *
 *   interface NodeCanvasProps<NodeData = Record<string, any>, EdgeData = Record<string, any>> {
 *     // Controlled React Flow state — NodeCanvas holds no state of its own.
 *     nodes: Node<NodeData>[];
 *     edges: Edge<EdgeData>[];
 *     onNodesChange: OnNodesChange<Node<NodeData>>;
 *     onEdgesChange: OnEdgesChange<Edge<EdgeData>>;
 *     onConnect: OnConnect;
 *
 *     // Left palette — rendered from this prop, drag-and-drop-from-sidebar.
 *     paletteGroups: PaletteGroup[];
 *     // Called when a palette item is dropped on the canvas; the consumer is
 *     // responsible for actually appending the new node to its `nodes` array
 *     // (NodeCanvas computes the drop position in flow coordinates, nothing more).
 *     onAddNode: (type: string, position: { x: number; y: number }, defaultData: Record<string, any>) => void;
 *
 *     // Right inspector — opens automatically when a node is selected.
 *     renderInspector: (node: Node<NodeData> | null, onChange: (data: Partial<NodeData>) => void) => ReactNode;
 *
 *     // Header controls.
 *     onSaveDraft: () => Promise<void>;
 *     onPublish: () => Promise<void>;
 *     status: CanvasStatus;
 *     savingDraft?: boolean;   // optional external loading flags for the buttons
 *     publishing?: boolean;
 *
 *     title?: string;          // header title, defaults to "Canvas"
 *     subtitle?: string;       // header subtitle line
 *   }
 *
 * Usage: wrap the page in <ReactFlowProvider> only if you need useReactFlow()
 * yourself — NodeCanvas already provides its own internally, so a bare
 * <NodeCanvas {...props} /> works standalone.
 */
import React, { ReactNode, useCallback, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useReactFlow,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, UploadCloud, X } from "lucide-react";

export type CanvasStatus = "draft" | "in_review" | "approved" | "published";

export interface PaletteNodeDef {
  type: string;
  label: string;
  description: string;
  defaultData: Record<string, any>;
}

export interface PaletteGroup {
  label: string;
  nodes: PaletteNodeDef[];
}

export interface NodeCanvasProps<NodeData extends Record<string, any> = Record<string, any>, EdgeData extends Record<string, any> = Record<string, any>> {
  nodes: Node<NodeData>[];
  edges: Edge<EdgeData>[];
  onNodesChange: OnNodesChange<Node<NodeData>>;
  onEdgesChange: OnEdgesChange<Edge<EdgeData>>;
  onConnect: OnConnect;

  paletteGroups: PaletteGroup[];
  onAddNode: (type: string, position: { x: number; y: number }, defaultData: Record<string, any>) => void;

  renderInspector: (node: Node<NodeData> | null, onChange: (data: Partial<NodeData>) => void) => ReactNode;

  onSaveDraft: () => Promise<void>;
  onPublish: () => Promise<void>;
  status: CanvasStatus;
  savingDraft?: boolean;
  publishing?: boolean;

  title?: string;
  subtitle?: string;
}

const statusPill: Record<CanvasStatus, string> = {
  draft: "p-draft",
  in_review: "p-draft",
  approved: "p-active",
  published: "p-active",
};

const statusLabel: Record<CanvasStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
};

const DND_MIME = "application/journeyax-node-type";

function NodeCanvasInner<NodeData extends Record<string, any>, EdgeData extends Record<string, any>>(
  props: NodeCanvasProps<NodeData, EdgeData>,
) {
  const {
    nodes, edges, onNodesChange, onEdgesChange, onConnect,
    paletteGroups, onAddNode, renderInspector,
    onSaveDraft, onPublish, status, savingDraft, publishing,
    title = "Canvas", subtitle,
  } = props;

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savingLocal, setSavingLocal] = useState(false);
  const [publishingLocal, setPublishingLocal] = useState(false);

  const selectedNode = (nodes.find((n) => n.id === selectedId) as Node<NodeData> | undefined) || null;

  const handleDragStart = useCallback((e: React.DragEvent, nodeType: string) => {
    e.dataTransfer.setData(DND_MIME, nodeType);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData(DND_MIME);
    if (!nodeType) return;
    const def = paletteGroups.flatMap((g) => g.nodes).find((n) => n.type === nodeType);
    if (!def) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onAddNode(nodeType, position, def.defaultData);
  }, [paletteGroups, onAddNode, screenToFlowPosition]);

  const handleSaveDraft = useCallback(async () => {
    setSavingLocal(true);
    try { await onSaveDraft(); } finally { setSavingLocal(false); }
  }, [onSaveDraft]);

  const handlePublish = useCallback(async () => {
    setPublishingLocal(true);
    try { await onPublish(); } finally { setPublishingLocal(false); }
  }, [onPublish]);

  const isSaving = savingDraft ?? savingLocal;
  const isPublishing = publishing ?? publishingLocal;

  const handleInspectorChange = useCallback((data: Partial<NodeData>) => {
    if (!selectedId) return;
    onNodesChange([
      {
        type: "replace",
        id: selectedId,
        item: {
          ...(nodes.find((n) => n.id === selectedId) as Node<NodeData>),
          data: { ...(nodes.find((n) => n.id === selectedId)?.data as NodeData), ...data },
        },
      } as any,
    ]);
  }, [selectedId, nodes, onNodesChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0 }}>
      {/* Header — mirrors .ctop pattern used across the console */}
      <div className="ctop">
        <div>
          <h1 className="pageh">{title}</h1>
          {subtitle && <p className="pagesub">{subtitle}</p>}
        </div>
        <div className="actions">
          <span className={`pill ${statusPill[status]}`}>{statusLabel[status]}</span>
          <button className="btn" onClick={handleSaveDraft} disabled={isSaving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {isSaving ? "Saving…" : "Save Draft"}
          </button>
          <button className="btn y" onClick={handlePublish} disabled={isPublishing}>
            <UploadCloud size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {isPublishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>

      {/* Body: palette | canvas | inspector */}
      <div style={{ display: "grid", gridTemplateColumns: selectedNode ? "220px 1fr 300px" : "220px 1fr", gap: 14, flex: 1, minHeight: 560 }}>
        {/* Left: node palette */}
        <div className="panel" style={{ overflowY: "auto", gap: 16 }}>
          {paletteGroups.map((group) => (
            <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="micro">{group.label}</span>
              {group.nodes.map((n) => (
                <div
                  key={n.type}
                  className="node"
                  draggable
                  onDragStart={(e) => handleDragStart(e, n.type)}
                  title={n.description}
                  style={{ cursor: "grab" }}
                >
                  <b style={{ display: "block", fontSize: 12.5 }}>{n.label}</b>
                  <span style={{ fontSize: 11, color: "var(--jx-gray-500)" }}>{n.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Center: React Flow canvas */}
        <div
          ref={wrapperRef}
          className="panel"
          style={{ padding: 0, overflow: "hidden", position: "relative" }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--jx-gray-300)" />
            <MiniMap pannable zoomable style={{ background: "var(--jx-white)" }} />
            <Controls />
          </ReactFlow>
        </div>

        {/* Right: inspector — opens when a node is selected */}
        {selectedNode && (
          <div className="panel" style={{ overflowY: "auto" }}>
            <div className="between">
              <h4>Inspector</h4>
              <button
                style={{ border: "none", background: "transparent", cursor: "pointer" }}
                onClick={() => setSelectedId(null)}
                aria-label="Close inspector"
              >
                <X size={15} />
              </button>
            </div>
            {renderInspector(selectedNode, handleInspectorChange)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Public export — wraps the implementation in its own ReactFlowProvider so a
 * bare `<NodeCanvas {...props} />` works without the consumer setting one up. */
export function NodeCanvas<NodeData extends Record<string, any> = Record<string, any>, EdgeData extends Record<string, any> = Record<string, any>>(
  props: NodeCanvasProps<NodeData, EdgeData>,
) {
  return (
    <ReactFlowProvider>
      <NodeCanvasInner<NodeData, EdgeData> {...props} />
    </ReactFlowProvider>
  );
}
