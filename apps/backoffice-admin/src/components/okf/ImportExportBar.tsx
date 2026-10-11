"use client";

import React, { useRef } from "react";
import { Download, Upload } from "lucide-react";
import type { OkfReleaseMeta } from "../../lib/api";

export function ImportExportBar({ releases, busy, onImport, onExport }: {
  releases: OkfReleaseMeta[];
  busy: boolean;
  onImport: (file: File) => void;
  onExport: (releaseId: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const latest = releases.find((release) => release.status === "ready");
  return (
    <div className="actions" style={{ alignItems: "center" }}>
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onImport(file);
        event.target.value = "";
      }} />
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}><Upload size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Import OKF bundle (.zip)</button>
      <button className="btn" disabled={busy || !latest} onClick={() => latest && onExport(latest.releaseId)}><Download size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />Export latest release</button>
      <span className="micro" style={{ color: "var(--jx-gray-500)" }}>Imports land as a draft and need validation and human verification before they can ship.</span>
    </div>
  );
}
