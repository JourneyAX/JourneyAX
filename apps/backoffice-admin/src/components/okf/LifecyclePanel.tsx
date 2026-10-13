"use client";

import React from "react";
import { ArrowRight, CheckCircle2, CircleDashed, CircleDot, XCircle } from "lucide-react";
import type { KnowledgeLifecycle } from "../../lib/api";
import { NEXT_STEP, diffSentence, lifecycleSteps, type StepState } from "./insight-model";

const ICON: Record<StepState, React.ReactNode> = {
  done: <CheckCircle2 size={15} color="#389e0d" aria-label="up to date" />,
  current: <CircleDot size={15} color="#d48806" aria-label="needs action" />,
  todo: <CircleDashed size={15} color="var(--jx-gray-500)" aria-label="not started" />,
  blocked: <XCircle size={15} color="var(--jx-destructive)" aria-label="blocked" />,
};

/** Draft → release → staged → live, and exactly what differs between them. */
export function LifecyclePanel({ lifecycle }: { lifecycle: KnowledgeLifecycle | null }) {
  if (!lifecycle) return <div className="micro">Where the knowledge stands is shown once the service has loaded it.</div>;
  const steps = lifecycleSteps(lifecycle);
  const next = NEXT_STEP[lifecycle.nextStep];
  const draftChange = diffSentence(lifecycle.changes.draftVsStaged, "the staged release", "The draft");
  const activation = diffSentence(lifecycle.changes.stagedVsActive, "what is live", "The staged release");
  return (
    <section aria-label="Draft, staged and live knowledge">
      <div className="between">
        <h4 style={{ margin: 0 }}>From draft to customers</h4>
        <span className={`pill ${next.tone === "ok" ? "p-active" : "p-draft"}`}>{next.label}</span>
      </div>
      <ol style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
        {steps.map((step, index) => (
          <li key={step.id} className="node" style={{ position: "relative" }} data-step={step.id} data-state={step.state}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {ICON[step.state]}
              <b>{step.title}</b>
              {index < steps.length - 1 && <ArrowRight size={12} style={{ marginLeft: "auto", color: "var(--jx-gray-400)" }} aria-hidden="true" />}
            </div>
            <div style={{ marginTop: 4 }}>{step.summary}</div>
            {step.detail && <div className="micro" style={{ marginTop: 2, textTransform: "none", letterSpacing: 0 }}>{step.detail}</div>}
          </li>
        ))}
      </ol>
      <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)", margin: "8px 0 0" }}>{next.detail}</p>
      {draftChange && !lifecycle.changes.draftVsStaged?.identical && <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>{draftChange}</p>}
      {activation && !lifecycle.changes.stagedVsActive?.identical && <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>{activation}</p>}
      {lifecycle.active && lifecycle.active.knowledge === null && lifecycle.staged && (
        <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-destructive)", margin: "6px 0 0" }}>
          The live pack ({lifecycle.active.packVersion}) carries no business knowledge: customers are being served without it.
        </p>
      )}
    </section>
  );
}
