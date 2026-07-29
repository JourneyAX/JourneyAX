"use client";

/**
 * Journey Builder — a LIVE view of this project's configured journey (B5).
 * Rendered entirely from the project's actual config: persona, journey guidance,
 * enabled capabilities, and context dimensions. Editing happens in AI
 * Orchestration; this screen shows how those pieces compose into the journey.
 */
import React from "react";
import { Route, Puzzle, Compass, MessageSquare, ArrowRight, PencilLine } from "lucide-react";
import { CAPABILITY_CATALOG, type Project } from "../lib/api";

export function JourneyMap({ project, onEdit }: { project: Project; onEdit: () => void }) {
  const caps = project.capabilities?.length ? project.capabilities : CAPABILITY_CATALOG.map((c) => c.id);
  const enabled = CAPABILITY_CATALOG.filter((c) => caps.includes(c.id));
  const dims = project.contextDimensions || [];
  const guidance = project.persona?.journeyGuidance?.trim();

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Journey Builder</h1>
          <p className="pagesub">
            How <b>{project.companyName}</b>'s journey is composed — live from this project's published configuration.
          </p>
        </div>
        <div className="actions">
          <button className="btn y" onClick={onEdit}>
            <PencilLine size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Edit in AI Orchestration
          </button>
        </div>
      </div>

      {/* The journey pipeline — always-on understanding + configured capabilities */}
      <div className="panel">
        <div className="micro"><Route size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />JOURNEY PIPELINE (capabilities the agent can use — order is decided by the agent per conversation, not scripted)</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
          <span className="node on" style={{ fontWeight: 700 }}>Understand &amp; clarify <span className="micro" style={{ marginLeft: 6 }}>always on</span></span>
          <ArrowRight size={14} style={{ color: "var(--jx-gray-400)" }} />
          {enabled.map((c, i) => (
            <React.Fragment key={c.id}>
              <span className="node" title={c.description}>{c.label}</span>
              {i < enabled.length - 1 && <ArrowRight size={14} style={{ color: "var(--jx-gray-400)" }} />}
            </React.Fragment>
          ))}
        </div>
        {enabled.length !== CAPABILITY_CATALOG.length && (
          <span className="fhelp">Disabled for this project: {CAPABILITY_CATALOG.filter((c) => !caps.includes(c.id)).map((c) => c.label).join(", ")}.</span>
        )}
      </div>

      <div className="cardrow">
        {/* Journey guidance — the goals */}
        <div className="panel">
          <div className="micro"><Compass size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />JOURNEY GUIDANCE (goals, not a script)</div>
          {guidance
            ? <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--jx-gray-700)", whiteSpace: "pre-wrap" }}>{guidance}</p>
            : <span className="role">No journey guidance configured yet — the agent runs on platform defaults. Add goals in AI Orchestration.</span>}
        </div>

        {/* Context dimensions the agent extracts */}
        <div className="panel">
          <div className="micro"><Puzzle size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />CONTEXT DIMENSIONS (what the agent listens for)</div>
          {dims.length === 0 && <span className="role">None configured — a "space" dimension is auto-derived from catalogue rooms.</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {dims.map((d) => (
              <div key={d.key} className="node">
                <b style={{ fontSize: 12.5 }}>{d.label || d.key}</b>
                {d.scoping && <span className="pill p-draft" style={{ marginLeft: 8 }}>scoping</span>}
                <div className="chips" style={{ marginTop: 6 }}>
                  {(d.values || []).map((v) => <span key={v} className="chip" style={{ cursor: "default", padding: "4px 10px", fontSize: 11 }}>{v}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Persona summary */}
      <div className="panel">
        <div className="micro"><MessageSquare size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />PERSONA</div>
        <div className="between">
          <div>
            <b style={{ fontSize: 14 }}>{project.persona?.systemName || "Unnamed agent"}</b>
            <p className="role" style={{ marginTop: 4, maxWidth: 720 }}>
              {project.persona?.systemPromptOverrides?.trim() || "No persona overrides — platform default voice."}
            </p>
          </div>
          <span className="pill p-active">model: {project.ai?.model || "platform default"}</span>
        </div>
      </div>
    </>
  );
}
