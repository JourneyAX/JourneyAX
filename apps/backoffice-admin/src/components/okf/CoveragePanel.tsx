"use client";

import React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { KnowledgeCoverage } from "../../lib/api";
import { count, coverageHeadline, percent } from "./insight-model";

const cell: React.CSSProperties = { padding: "5px 8px", textAlign: "left", borderBottom: "1px solid var(--jx-gray-200)", fontSize: 12.5, verticalAlign: "top" };
const head: React.CSSProperties = { ...cell, fontWeight: 700, fontSize: 11, textTransform: "uppercase", color: "var(--jx-gray-600)" };
const numeric: React.CSSProperties = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div role="img" aria-label={label} style={{ background: "var(--jx-gray-200)", borderRadius: 4, height: 8, width: 90, overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", background: value >= 99 ? "#52c41a" : value >= 50 ? "#faad14" : "var(--jx-destructive)" }} />
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "9px 10px" }}>
      <div className="micro">{label}</div>
      <strong style={{ fontSize: 18 }}>{value}</strong>
      {hint && <div className="micro" style={{ textTransform: "none", letterSpacing: 0, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/**
 * What the knowledge covers and what is still missing, by department, journey and kind of claim. Every figure comes from
 * the service, computed from the saved draft and the tenant's live catalogue.
 */
export function CoveragePanel({ coverage }: { coverage: KnowledgeCoverage | null }) {
  if (!coverage) return <div className="micro">Coverage is computed once a draft exists.</div>;
  const headline = coverageHeadline(coverage);
  const v = coverage.verification;
  const unscoped = coverage.catalogue?.uncovered ?? 0;
  return (
    <section aria-label="Knowledge coverage">
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div>
          <h4 style={{ margin: 0 }}>Coverage</h4>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0, margin: "2px 0 0", color: "var(--jx-gray-600)" }}>{headline.text}</p>
        </div>
        <span className={`pill ${v.verifiedClaims > 0 ? "p-active" : "p-draft"}`}>{v.verifiedClaims} verified claim{v.verifiedClaims === 1 ? "" : "s"}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
        <Fact label="Derived from catalogue" value={count(coverage.layers.derived)} hint="Structure only: where things are" />
        <Fact label="Authored" value={count(coverage.layers.authored)} hint={`${coverage.authored.families.length} families · ${coverage.authored.projects.length} projects · ${coverage.authored.problems.length} problems · ${coverage.authored.care.length} care`} />
        <Fact label="Candidate documents" value={count(v.candidateSources)} hint={`across ${count(v.conceptsWithCandidateSources)} concepts, none verified yet`} />
        <Fact label="Not reachable" value={count(unscoped)} hint="listed products no concept selects" />
      </div>

      <h5 style={{ margin: "14px 0 4px" }}>By department</h5>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th scope="col" style={head}>Department</th><th scope="col" style={{ ...head, textAlign: "right" }}>Products</th><th scope="col" style={head}>Covered</th><th scope="col" style={{ ...head, textAlign: "right" }}>Concepts</th><th scope="col" style={{ ...head, textAlign: "right" }}>Authored</th><th scope="col" style={{ ...head, textAlign: "right" }}>With documents</th></tr>
        </thead>
        <tbody>
          {coverage.departments.map((department) => {
            const covered = department.products ? percent(department.productsCovered ?? 0, department.products) : null;
            return (
              <tr key={department.name} data-department={department.name}>
                <th scope="row" style={{ ...cell, fontWeight: 600 }}>{department.name}</th>
                <td style={numeric}>{department.products === undefined ? "—" : count(department.products)}</td>
                <td style={cell}>{covered === null ? "—" : <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Bar value={covered} label={`${covered}% of ${department.name} products covered`} />{covered}%</span>}</td>
                <td style={numeric}>{count(department.concepts)}</td>
                <td style={numeric}>{count(department.authoredConcepts)}</td>
                <td style={numeric}>{count(department.conceptsWithCandidateSources)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {coverage.catalogue && coverage.catalogue.uncoveredCategories.length > 0 && (
        <div className="node" style={{ marginTop: 8, borderColor: "#faad14" }}>
          <AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} aria-hidden="true" />
          <b>{count(unscoped)} listed products are outside every concept's scope</b> and can never be retrieved:
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {coverage.catalogue.uncoveredCategories.slice(0, 6).map((entry, index) => (
              <li key={index} className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
                {entry.path.length ? entry.path.join(" › ") : entry.category ? `Category “${entry.category}”` : "No department and no category"} — {count(entry.products)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h5 style={{ margin: "14px 0 4px" }}>Journeys</h5>
      {coverage.journeys.length === 0 && <div className="micro">No concept hands off to a journey.</div>}
      {coverage.journeys.map((journey) => (
        <div key={journey.journeyId} className="between" style={{ padding: "5px 0", borderBottom: "1px solid var(--jx-gray-200)", alignItems: "flex-start" }}>
          <div>
            <b>{journey.journeyId}</b>
            <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{journey.concepts.map((concept) => concept.name).join(", ")}</div>
          </div>
          {journey.existsInPack === null
            ? <span className="pill p-offline">pack not published</span>
            : journey.existsInPack
              ? <span className="pill p-active"><CheckCircle2 size={11} style={{ verticalAlign: "-1px" }} aria-hidden="true" /> in the live pack</span>
              : <span className="pill p-inactive">missing from the live pack</span>}
        </div>
      ))}
      {coverage.projectsWithoutJourney.length > 0 && (
        <p className="micro" style={{ textTransform: "none", letterSpacing: 0, margin: "6px 0 0" }}>
          Answered by the knowledge alone (no journey): {coverage.projectsWithoutJourney.map((project) => project.name).join(", ")}.
        </p>
      )}

      <h5 style={{ margin: "14px 0 4px" }}>What is still unverified</h5>
      {Object.keys(v.byClaimClass).length === 0 && v.guidanceGaps.length === 0 && <div className="micro">Nothing here makes a claim that needs verifying.</div>}
      {Object.entries(v.byClaimClass).map(([claimClass, counts]) => (
        <div key={claimClass} className="between" style={{ padding: "3px 0" }}>
          <span>{claimClass.replace(/_/g, " ")}</span>
          <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{counts.verified} verified · {counts.unverified} unverified</span>
        </div>
      ))}
      {v.guidanceGaps.length > 0 && (
        <div className="node" style={{ marginTop: 6 }}>
          <b>{v.guidanceGaps.length} topic{v.guidanceGaps.length === 1 ? "" : "s"} with no verified guidance</b>
          <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}> — customers are referred to a professional until a person writes and verifies it.</span>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {v.guidanceGaps.map((gap) => <li key={gap.conceptId} className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{gap.name} ({gap.kind}) — {gap.reason}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
