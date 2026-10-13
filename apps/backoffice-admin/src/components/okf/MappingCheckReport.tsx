"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { MappingCheck } from "../../lib/api";
import { READABLE_LABELS, count, formatMoney, percent, sortIssues } from "./insight-model";
import { describeIssue } from "./catalog-mapping-form";

const cell: React.CSSProperties = { padding: "3px 6px", textAlign: "left", borderBottom: "1px solid var(--jx-gray-200)", fontSize: 12, verticalAlign: "top" };

const ICON = {
  error: <XCircle size={14} color="var(--jx-destructive)" aria-label="error" />,
  warning: <AlertTriangle size={14} color="#d48806" aria-label="warning" />,
  info: <Info size={14} color="var(--jx-gray-500)" aria-label="note" />,
} as const;

/** What a mapping would make of real products: the verdict, what could not be read, and the products as they would be read. */
export function MappingCheckReport({ check, stale }: { check: MappingCheck; stale: boolean }) {
  const issues = sortIssues(check.issues);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  return (
    <section aria-label="Check against your catalogue" style={{ display: "grid", gap: 10 }}>
      <div className="between">
        <b>Checked {count(check.sampleSize)} of {count(check.catalogueProducts)} products</b>
        <span className={`pill ${stale ? "p-offline" : check.ok ? "p-active" : "p-inactive"}`}>
          {stale ? "Out of date — check again" : check.ok ? (check.issues.some((i) => i.severity === "warning") ? "Safe to save, with warnings" : "Safe to save") : `${errors} problem${errors === 1 ? "" : "s"} to fix`}
        </span>
      </div>

      {check.mappingErrors.length > 0 && (
        <ul role="alert" style={{ margin: 0, paddingLeft: 18 }}>
          {check.mappingErrors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}

      {check.sampleSize > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>
          {Object.entries(check.readable).map(([key, share]) => (
            <div key={key} style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "6px 8px" }} data-readable={key}>
              <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{READABLE_LABELS[key] ?? key}</div>
              <strong>{percent(share, 1)}%</strong>
            </div>
          ))}
        </div>
      )}

      {issues.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} data-severity={issue.severity} style={{ display: "flex", gap: 8 }}>
              <span style={{ paddingTop: 2 }}>{ICON[issue.severity]}</span>
              <span>
                {issue.message}
                {issue.affected > 0 && <span className="micro" style={{ textTransform: "none", letterSpacing: 0 }}> — {describeIssue(issue)}{issue.examples.length ? `, e.g. ${issue.examples.join(", ")}` : ""}</span>}
                <span className="micro" style={{ textTransform: "none", letterSpacing: 0, display: "block" }}>Change: {issue.field}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {issues.length === 0 && check.sampleSize > 0 && <div><CheckCircle2 size={14} color="#389e0d" style={{ verticalAlign: "-2px" }} aria-hidden="true" /> Every meaning could be read from every sampled product.</div>}

      {Object.keys(check.currencies).length > 0 && (
        <div className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
          Prices found in: {Object.entries(check.currencies).map(([code, n]) => `${code} (${count(n)})`).join(", ")}. Lifecycle: {check.availability.available} shown, {check.availability.excluded} hidden, {check.availability.unpriced} price on application.
        </div>
      )}

      {check.statuses.length > 0 && (
        <div>
          <div className="micro">Lifecycle values in use</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th scope="col" style={cell}>Value</th><th scope="col" style={cell}>Products</th><th scope="col" style={cell}>Treated as</th></tr></thead>
            <tbody>{check.statuses.map((status) => <tr key={status.value}><td style={cell}>{status.value}</td><td style={cell}>{count(status.count)}</td><td style={cell}>{status.treatedAs}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      {check.rows.length > 0 && (
        <div>
          <div className="micro">Products as the assistant would read them</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th scope="col" style={cell}>Code</th><th scope="col" style={cell}>Name</th><th scope="col" style={cell}>Category path</th><th scope="col" style={cell}>Price</th><th scope="col" style={cell}>Stock</th><th scope="col" style={cell}>State</th></tr></thead>
            <tbody>
              {check.rows.map((row, index) => (
                <tr key={`${row.sku}-${index}`}>
                  <td style={cell}>{row.sku || "—"}</td>
                  <td style={cell}>{row.title || "—"}</td>
                  <td style={cell}>{row.categoryPath.length ? row.categoryPath.join(" › ") : row.category || "—"}</td>
                  <td style={cell}>{row.currencyUndeclared ? "Price found, currency not declared" : formatMoney(row.priceCents, row.currency)}</td>
                  <td style={cell}>{row.inStock === undefined ? "unknown" : row.inStock ? "in stock" : "out of stock"}</td>
                  <td style={cell}>{row.availability}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {check.unusedPaths.length > 0 && (
        <details>
          <summary className="micro" style={{ cursor: "pointer" }}>{check.unusedPaths.length} configured field{check.unusedPaths.length === 1 ? "" : "s"} found on no sampled product</summary>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{check.unusedPaths.map((entry) => <li key={`${entry.field}-${entry.path}`} className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>{entry.path} <span>({entry.field})</span></li>)}</ul>
        </details>
      )}
    </section>
  );
}
