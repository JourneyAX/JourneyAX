"use client";

import React from "react";
import type { KnowledgeCoverage, KnowledgeLifecycle, OkfAnalysis } from "../../lib/api";
import { count } from "./insight-model";

/**
 * What the assistant knows, in plain words, before any detail: whether customers are being served with it, how much it covers, and how
 * much is waiting for a person. Every figure comes from the service; the sentences are the only copy here.
 */
export function KnowledgeSummary({ lifecycle, coverage, analysis, verifiedByPeople }: {
  lifecycle: KnowledgeLifecycle | null;
  coverage: KnowledgeCoverage | null;
  analysis: OkfAnalysis | null;
  verifiedByPeople: number;
}) {
  const live = lifecycle?.active?.knowledge ?? null;
  const topics = coverage?.totals.concepts;
  const waiting = analysis?.staleness.length;
  const reach = coverage?.catalogue;
  const tiles: Array<{ label: string; value: React.ReactNode; hint: string }> = [
    { label: "Topics it knows", value: topics === undefined ? "—" : count(topics), hint: "departments, categories, projects and problems" },
    { label: "Products it can find", value: reach ? `${count(reach.covered)} of ${count(reach.products)}` : "—", hint: "from your live catalogue" },
    { label: "Confirmed by a person", value: count(verifiedByPeople), hint: "safety, care, installation and warranty advice" },
    { label: "Waiting for a person", value: waiting === undefined ? "—" : count(waiting), hint: "see the checklist below" },
  ];
  return (
    <section aria-label="What the assistant knows">
      <p style={{ margin: "0 0 10px", fontSize: 14 }}>
        {live
          ? <>Customers are being served with knowledge release <b>{live.version}</b>. It answers product questions from your live catalogue, and holds back any advice nobody has confirmed yet.</>
          : lifecycle
            ? <>No knowledge release is live yet, so customers are served from the catalogue alone.</>
            : <>Loading what the assistant knows…</>}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
        {tiles.map((tile) => (
          <div key={tile.label} style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "9px 10px" }}>
            <div className="micro">{tile.label}</div>
            <strong style={{ fontSize: 20 }}>{tile.value}</strong>
            <div className="micro" style={{ textTransform: "none", letterSpacing: 0, marginTop: 2 }}>{tile.hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
