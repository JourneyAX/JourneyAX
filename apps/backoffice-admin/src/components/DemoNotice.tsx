"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Honest badge for console sections that are NOT yet wired to a live backend.
 * The content below it is illustrative demo markup — it does not reflect real,
 * per-project data and nothing on it persists. Removed as each section is wired.
 */
export function DemoNotice({ what }: { what?: string }) {
  return (
    <div
      className="panel"
      style={{
        display: "flex", alignItems: "center", gap: 10,
        borderColor: "var(--jx-yellow)", background: "rgba(255, 214, 0, 0.08)",
        marginBottom: 16,
      }}
    >
      <AlertTriangle size={16} style={{ color: "var(--jx-black)", flexShrink: 0 }} />
      <div style={{ fontSize: 12.5, color: "var(--jx-gray-700)", lineHeight: 1.5 }}>
        <b>Demo — not wired to live data.</b>{" "}
        {what || "The content below is illustrative and does not reflect this project. Nothing here persists yet."}
      </div>
    </div>
  );
}
