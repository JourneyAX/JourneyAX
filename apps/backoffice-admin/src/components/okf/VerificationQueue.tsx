"use client";

import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { OkfAnalysis } from "../../lib/api";
import { groupStaleness } from "./okf-model";

export interface VerifierRoleOption { roleId: string; label: string }

export function VerificationQueue({
  analysis, content, roles, busy, onAssign, onAttest, onConfigureRole,
}: {
  analysis: OkfAnalysis | null;
  content: any;
  roles: VerifierRoleOption[];
  busy: boolean;
  onAssign: (target: { targetType: "concept" | "relationship"; targetId: string }, verifiedBy: string, verifierRole: string) => void;
  onAttest: (recordId: string) => void;
  onConfigureRole: (roleId: string, principalIds: string[]) => void;
}) {
  const [verifier, setVerifier] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.roleId || "");
  const [roleMembers, setRoleMembers] = useState("");
  const groups = groupStaleness(analysis?.staleness || []);
  const verified: any[] = (content?.verifications || []).filter((record: any) => record.status === "verified");

  return (
    <div>
      <h4 style={{ margin: "0 0 6px" }}>Verification queue</h4>
      {groups.length === 0 && <div className="micro">Every claim has a current verification.</div>}
      {groups.map((group) => (
        <div key={group.reason} style={{ marginBottom: 8 }}>
          <div className="micro" style={{ fontWeight: 700 }}>{group.label} ({group.entries.length})</div>
          {group.entries.map((entry) => (
            <div key={`${entry.targetType}:${entry.targetId}`} className="between" style={{ padding: "4px 0", gap: 8 }}>
              <span className="micro" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.targetType} · {entry.targetId}</span>
              <button className="btn" disabled={busy || !verifier.trim() || !roleId} onClick={() => onAssign(entry, verifier, roleId)}>Assign verifier</button>
            </div>
          ))}
        </div>
      ))}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
        <label className="micro">Verifier (principal id)<input className="inp" value={verifier} onChange={(e) => setVerifier(e.target.value)} placeholder="human:…" /></label>
        <label className="micro">Verifier role
          <select className="inp" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.label}</option>)}
          </select>
        </label>
      </div>

      {verified.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="micro" style={{ fontWeight: 700 }}>Awaiting the verifier's own attestation</div>
          {verified.map((record) => (
            <div key={record.recordId} className="between" style={{ padding: "4px 0", gap: 8 }}>
              <span className="micro">{record.targetId} · {record.verifiedBy} as {record.verifierRole}</span>
              <button className="btn" disabled={busy} onClick={() => onAttest(record.recordId)}><ShieldCheck size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Attest</button>
            </div>
          ))}
          <p className="micro" style={{ color: "var(--jx-gray-500)" }}>Only the assigned verifier — not the draft author — can attest; the service enforces this.</p>
        </div>
      )}

      <details style={{ marginTop: 10 }}>
        <summary className="micro" style={{ cursor: "pointer", fontWeight: 700 }}>Assign verifier-role members</summary>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input className="inp" value={roleMembers} onChange={(e) => setRoleMembers(e.target.value)} placeholder="human:alice, human:bob" />
          <button className="btn" disabled={busy || !roleId} onClick={() => onConfigureRole(roleId, roleMembers.split(",").map((item) => item.trim()).filter(Boolean))}>Save members</button>
        </div>
      </details>
    </div>
  );
}
