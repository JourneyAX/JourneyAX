"use client";

import React from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";
import type { OkfAnalysis } from "../../lib/api";
import { CHECK_LABELS } from "./okf-model";

export function ReadinessPanel({ analysis }: { analysis: OkfAnalysis | null }) {
  if (!analysis) return <div className="micro">Readiness is computed by the service once a draft exists.</div>;
  return (
    <div>
      <div className="between">
        <h4 style={{ margin: 0 }}>Release readiness</h4>
        <span className={`pill ${analysis.ready ? "p-active" : "p-draft"}`}>{analysis.ready ? "Ready" : "Not ready"}</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {analysis.checks.map((check) => (
          <li key={check.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
            {check.ok
              ? <CheckCircle2 size={14} color="#389e0d" aria-label="passed" />
              : <CircleDashed size={14} color="var(--jx-destructive)" aria-label="open" />}
            <span>{CHECK_LABELS[check.id] || check.id}</span>
            {check.detail && <span className="micro" style={{ color: "var(--jx-gray-500)" }}>— {check.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
