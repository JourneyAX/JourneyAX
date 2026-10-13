"use client";

import React from "react";
import { relationshipBadge, relationshipMakesClaim, relationshipWords, type Tone } from "./okf-model";

const TONE_CLASS: Record<Tone, string> = { ok: "p-active", warn: "p-draft", bad: "p-inactive", neutral: "p-draft" };
const BOX: React.CSSProperties = { maxHeight: 260, overflow: "auto", border: "1px solid var(--jx-gray-200)", borderRadius: 8 };

/**
 * How topics connect. A link only needs a person's confirmation if it asserts something a customer could rely on (a care instruction, a
 * fit); the rest only place a topic in the catalogue or suggest an add-on, so they are summarised, not flagged "unverified".
 */
export function RelationshipList({ content }: { content: any }) {
  const relationships: any[] = content?.relationships || [];
  if (!relationships.length) return <div className="micro">No relationships.</div>;
  const names = new Map<string, string>((content?.concepts || []).map((concept: any) => [concept.conceptId, concept.name]));
  const claims = relationships.filter((relationship) => relationshipMakesClaim(relationship) || (content?.verifications || []).some((record: any) => record.targetType === "relationship" && record.targetId === relationship.relationshipId));
  const claimIds = new Set(claims.map((relationship) => relationship.relationshipId));
  const plain = relationships.filter((relationship) => !claimIds.has(relationship.relationshipId));

  const row = (relationship: any) => {
    const badge = relationshipBadge(content, relationship);
    return (
      <div key={relationship.relationshipId} style={{ padding: "8px 10px", borderBottom: "1px solid var(--jx-gray-200)" }}>
        <div className="between">
          <span><b>{names.get(relationship.from) || relationship.from}</b> <span className="micro">{relationshipWords(relationship.type)}</span> <b>{names.get(relationship.to) || relationship.to}</b></span>
          <span className={`pill ${TONE_CLASS[badge.tone]}`} title={badge.detail}>{badge.label}</span>
        </div>
        <div className="micro" style={{ color: "var(--jx-gray-500)" }}>{relationship.strength} · {relationship.scope} · confidence {relationship.confidence}</div>
      </div>
    );
  };

  return (
    <div>
      <p className="micro" style={{ textTransform: "none", letterSpacing: 0, color: "var(--jx-gray-600)", margin: "0 0 6px" }}>
        {relationships.length} links in all. {claims.length === 0 ? "None of them" : `${claims.length}`} state{claims.length === 1 ? "s" : ""} something a customer could rely on and need a person&apos;s confirmation;
        the other {plain.length} only place topics in the catalogue or suggest add-ons, so there is nothing to verify.
      </p>
      {claims.length > 0 && <div style={BOX}>{claims.map(row)}</div>}
      {plain.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="micro" style={{ cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>Show the {plain.length} links that make no claim</summary>
          <div style={BOX}>{plain.map(row)}</div>
        </details>
      )}
    </div>
  );
}
