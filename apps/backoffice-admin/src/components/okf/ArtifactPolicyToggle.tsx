"use client";

import React from "react";

export function ArtifactPolicyToggle({ required, disabled, onChange }: { required: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <input type="checkbox" checked={required} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <b>Require an exported, verified artifact before activation</b>
        <span className="micro" style={{ display: "block", color: "var(--jx-gray-600)" }}>
          Releases stay in the database either way; the artifact is an immutable, portable copy. Runtime never reads it per turn.
        </span>
      </span>
    </label>
  );
}
