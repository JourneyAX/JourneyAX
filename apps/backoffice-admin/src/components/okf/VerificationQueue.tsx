"use client";

import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { OkfAnalysis } from "../../lib/api";
import { STALENESS_LABELS, groupVerificationWork, type StalenessEntry, type WorkItem } from "./okf-model";

export interface VerifierRoleOption { roleId: string; label: string }

type Target = { targetType: "concept" | "relationship"; targetId: string };

/** The longest a list gets before it scrolls inside its own box, so the page never grows with the size of the catalogue. */
const BOUNDED: React.CSSProperties = { maxHeight: 200, overflow: "auto", border: "1px solid var(--jx-gray-200)", borderRadius: 8 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The things only a person can confirm, in plain words. The service lists only what could change what the assistant may say (the
 * category tree and "goes well with" suggestions assert nothing, so they are never here); this view groups that list by kind, safety
 * first, and by part of the shop, so a department can be handed to a named person in one click.
 */
export function VerificationQueue({
  analysis, content, roles, busy, onAssign, onAssignMany, onAttest, onConfigureRole,
}: {
  analysis: OkfAnalysis | null;
  content: any;
  roles: VerifierRoleOption[];
  busy: boolean;
  onAssign: (target: Target, verifiedBy: string, verifierRole: string) => void;
  onAssignMany?: (targets: Target[], verifiedBy: string, verifierRole: string) => void;
  onAttest: (recordId: string) => void;
  onConfigureRole: (roleId: string, principalIds: string[]) => void;
}) {
  const [verifier, setVerifier] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.roleId || "");
  const [roleMembers, setRoleMembers] = useState("");
  const { changed, groups } = groupVerificationWork((analysis?.staleness || []) as StalenessEntry[], content);
  const waiting = groups.reduce((sum, group) => sum + group.count, 0) + changed.length;
  const first = groups.filter((group) => !group.optional).reduce((sum, group) => sum + group.count, 0) + changed.length;
  const verified: any[] = (content?.verifications || []).filter((record: any) => record.status === "verified");
  const ready = Boolean(verifier.trim() && roleId) && !busy;
  const assignAll = (items: WorkItem[]) => {
    const targets = items.map(({ entry }) => ({ targetType: entry.targetType, targetId: entry.targetId }));
    if (onAssignMany) onAssignMany(targets, verifier, roleId);
    else targets.forEach((target) => onAssign(target, verifier, roleId));
  };
  const entryRow = (item: WorkItem) => (
    <div key={`${item.entry.targetType}:${item.entry.targetId}`} className="between" style={{ padding: "4px 8px", gap: 8, borderBottom: "1px solid var(--jx-gray-200)" }}>
      <span className="micro" style={{ textTransform: "none", letterSpacing: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
      <button className="btn" disabled={!ready} onClick={() => onAssign(item.entry, verifier, roleId)}>Assign</button>
    </div>
  );

  return (
    <div>
      <h4 style={{ margin: "0 0 4px" }}>Things only a person can confirm</h4>
      <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)", margin: "0 0 8px" }}>
        The assistant already shows products and prices from your catalogue. What it will not do is give advice that could cause harm if it were wrong (safety steps,
        care steps, installation and warranty details) until a named person has checked it against a manufacturer&apos;s document and confirmed it. Until then it says it
        cannot confirm that and offers a specialist. Nothing is broken: this is a safety lock. The category tree and &ldquo;goes well with&rdquo; suggestions are not advice, so they are not listed.
      </p>
      {waiting === 0 && <div className="micro">Nothing is waiting for a person.</div>}
      {waiting > 0 && (
        <p style={{ margin: "0 0 8px", fontSize: 13 }}>
          <b>{plural(waiting, "topic")} waiting.</b> {first > 0 ? `${first} matter first; the rest are document reviews that can be done over time.` : "All of them are document reviews that can be done over time."}
        </p>
      )}

      {waiting > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
          <label className="micro">Who will check these (person id)<input className="inp" value={verifier} onChange={(e) => setVerifier(e.target.value)} placeholder="human:…" /></label>
          <label className="micro">Their role
            <select className="inp" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.length === 0 && <option value="">No verifier roles set up</option>}
              {roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.label}</option>)}
            </select>
          </label>
        </div>
      )}

      {changed.length > 0 && (
        <details open style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Changed since it was confirmed ({changed.length})</summary>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)" }}>These were confirmed, then edited or expired, so the old confirmation no longer applies.</p>
          <div style={BOUNDED}>{changed.map((item) => (
            <div key={`${item.entry.targetType}:${item.entry.targetId}`} className="between" style={{ padding: "4px 8px", gap: 8, borderBottom: "1px solid var(--jx-gray-200)" }}>
              <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{item.label} · {STALENESS_LABELS[item.entry.reason]}</span>
              <button className="btn" disabled={!ready} onClick={() => onAssign(item.entry, verifier, roleId)}>Assign</button>
            </div>
          ))}</div>
        </details>
      )}

      {groups.map((group) => (
        <details key={group.topic} open={!group.optional} style={{ marginBottom: 8 }} data-topic={group.topic}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            {group.title} ({group.count}){group.optional && <span className="pill p-draft" style={{ marginLeft: 8 }}>can wait</span>}
          </summary>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)", margin: "2px 0 6px" }}>{group.why}</p>
          {group.areas.map((area) => (
            <div key={area.area} style={{ marginBottom: 6 }}>
              <div className="between" style={{ gap: 8 }}>
                <span>{area.area} <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>· {plural(area.items.length, "topic")}</span></span>
                <button className="btn" disabled={!ready} onClick={() => assignAll(area.items)}>Assign all {area.items.length}</button>
              </div>
              <details>
                <summary className="micro" style={{ cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>Show them</summary>
                <div style={BOUNDED}>{area.items.map(entryRow)}</div>
              </details>
            </div>
          ))}
        </details>
      ))}

      {verified.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Waiting for the checker&apos;s own confirmation ({verified.length})</summary>
          <div style={BOUNDED}>
            {verified.map((record) => (
              <div key={record.recordId} className="between" style={{ padding: "4px 8px", gap: 8, borderBottom: "1px solid var(--jx-gray-200)" }}>
                <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{record.targetId} · {record.verifiedBy} as {record.verifierRole}</span>
                <button className="btn" disabled={busy} onClick={() => onAttest(record.recordId)}><ShieldCheck size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Attest</button>
              </div>
            ))}
          </div>
          <p className="micro" style={{ color: "var(--jx-gray-500)" }}>Only the assigned checker, not the person who drafted this, can attest; the service enforces this.</p>
        </details>
      )}

      <details style={{ marginTop: 10 }}>
        <summary className="micro" style={{ cursor: "pointer", fontWeight: 700 }}>Who belongs to each role</summary>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input className="inp" value={roleMembers} onChange={(e) => setRoleMembers(e.target.value)} placeholder="human:alice, human:bob" />
          <button className="btn" disabled={busy || !roleId} onClick={() => onConfigureRole(roleId, roleMembers.split(",").map((item) => item.trim()).filter(Boolean))}>Save members</button>
        </div>
      </details>
    </div>
  );
}
