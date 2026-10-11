"use client";

import React from "react";
import { relationshipBadge, type Tone } from "./okf-model";

const TONE_CLASS: Record<Tone, string> = { ok: "p-active", warn: "p-draft", bad: "p-inactive", neutral: "p-draft" };

export function RelationshipList({ content }: { content: any }) {
  const relationships: any[] = content?.relationships || [];
  if (!relationships.length) return <div className="micro">No relationships.</div>;
  const names = new Map<string, string>((content?.concepts || []).map((concept: any) => [concept.conceptId, concept.name]));
  return (
    <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--jx-gray-200)", borderRadius: 8 }}>
      {relationships.map((relationship) => {
        const badge = relationshipBadge(content, relationship);
        return (
          <div key={relationship.relationshipId} style={{ padding: "8px 10px", borderBottom: "1px solid var(--jx-gray-200)" }}>
            <div className="between">
              <span><b>{names.get(relationship.from) || relationship.from}</b> <span className="micro">{relationship.type.replace(/_/g, " ")}</span> <b>{names.get(relationship.to) || relationship.to}</b></span>
              <span className={`pill ${TONE_CLASS[badge.tone]}`} title={badge.detail}>{badge.label}</span>
            </div>
            <div className="micro" style={{ color: "var(--jx-gray-500)" }}>{relationship.strength} · {relationship.scope} · confidence {relationship.confidence}</div>
          </div>
        );
      })}
    </div>
  );
}
