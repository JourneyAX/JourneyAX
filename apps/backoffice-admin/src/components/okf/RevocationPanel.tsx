"use client";

import React, { useState } from "react";
import { OctagonAlert } from "lucide-react";
import type { OkfReleaseMeta, OkfRevocationSummary } from "../../lib/api";
import { revocationTone, splitRevocations } from "./okf-model";

export function RevocationPanel({
  revocations, releases, concepts, busy, onCreate, onLift,
}: {
  revocations: OkfRevocationSummary[];
  releases: OkfReleaseMeta[];
  concepts: Array<{ conceptId: string; name: string }>;
  busy: boolean;
  onCreate: (input: { releaseId: string; conceptIds: string[]; reason: string; expiresAt: string }) => void;
  onLift: (revocationId: string, correctedReleaseId: string, reason: string) => void;
}) {
  const ready = releases.filter((release) => release.status === "ready");
  const [releaseId, setReleaseId] = useState(ready[0]?.releaseId || "");
  const [conceptId, setConceptId] = useState(concepts[0]?.conceptId || "");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [corrected, setCorrected] = useState<Record<string, string>>({});
  const { active, history } = splitRevocations(revocations);

  return (
    <div>
      <h4 style={{ margin: "0 0 6px" }}><OctagonAlert size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />Emergency revocation</h4>
      <p className="micro" style={{ color: "var(--jx-gray-600)" }}>Withdraws guidance from a published release immediately, without waiting for a new release. Lifting requires a corrected release.</p>

      {active.map((item) => (
        <div key={item.revocationId} className="node" style={{ marginBottom: 6 }}>
          <div className="between"><b>{item.created.conceptIds.length} concept(s) withdrawn</b><span className={`pill p-${revocationTone(item.status) === "bad" ? "inactive" : "draft"}`}>active</span></div>
          <div className="micro">{item.created.reason} · by {item.created.createdBy} · expires {new Date(item.created.expiresAt).toLocaleString()}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <select className="inp" value={corrected[item.revocationId] || ""} onChange={(e) => setCorrected({ ...corrected, [item.revocationId]: e.target.value })}>
              <option value="">Corrected release…</option>
              {ready.filter((release) => release.releaseId !== item.created.releaseId).map((release) => <option key={release.releaseId} value={release.releaseId}>{release.version}</option>)}
            </select>
            <button className="btn" disabled={busy || !corrected[item.revocationId]} onClick={() => onLift(item.revocationId, corrected[item.revocationId], "Corrected guidance published")}>Lift</button>
          </div>
        </div>
      ))}
      {active.length === 0 && <div className="micro">No active revocations.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
        <label className="micro">Release
          <select className="inp" value={releaseId} onChange={(e) => setReleaseId(e.target.value)}>{ready.map((release) => <option key={release.releaseId} value={release.releaseId}>{release.version}</option>)}</select>
        </label>
        <label className="micro">Concept
          <select className="inp" value={conceptId} onChange={(e) => setConceptId(e.target.value)}>{concepts.map((concept) => <option key={concept.conceptId} value={concept.conceptId}>{concept.name}</option>)}</select>
        </label>
        <label className="micro">Reason<input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="micro">Expires<input className="inp" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></label>
      </div>
      <button className="btn" style={{ marginTop: 6 }} disabled={busy || !releaseId || !conceptId || !reason.trim() || !expiresAt}
        onClick={() => onCreate({ releaseId, conceptIds: [conceptId], reason: reason.trim(), expiresAt: new Date(expiresAt).toISOString() })}>Revoke now</button>

      {history.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="micro" style={{ cursor: "pointer" }}>History ({history.length})</summary>
          {history.map((item) => (
            <div key={item.revocationId} className="micro" style={{ padding: "3px 0" }}>{item.status} · {item.created.reason}{item.closedBy?.correctedReleaseId ? ` · corrected by ${item.closedBy.correctedReleaseId}` : ""}</div>
          ))}
        </details>
      )}
    </div>
  );
}
