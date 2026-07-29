"use client";

/**
 * Orders & Quotes — REAL quote/BOM sessions from the agent (B5).
 * Lists every session whose journey state carries a bill of materials —
 * i.e. actual quotes customers built with the agent. No mock rows.
 */
import React from "react";
import { RefreshCw } from "lucide-react";
import { useInsights } from "./DashboardLive";
import type { Project } from "../lib/api";

export function OrdersQuotes({ project }: { project: Project }) {
  const { data, error, loading, reload } = useInsights(project.projectId);
  const cur = project.pricing?.symbol || "$";
  const [open, setOpen] = React.useState<string | null>(null); // expanded quote row

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Orders &amp; Quotes</h1>
          <p className="pagesub">Quotes customers actually built with <b>{project.companyName}</b>'s agent (from live session state).</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      {data && (
        <div className="panel">
          <div className="micro">QUOTES / BILLS OF MATERIALS ({data.quotes.length})</div>
          <div className="tblwrap" style={{ marginTop: 8 }}>
            <div className="theadr" style={{ gridTemplateColumns: "1.4fr 1.6fr 0.6fr 0.8fr 0.7fr 1fr" }}>
              <span>Quote</span><span>Items</span><span>#</span><span>Total</span><span>Stage</span><span>Updated</span>
            </div>
            {data.quotes.length === 0 && (
              <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
                <span className="role">No quotes yet — they appear here the moment a customer builds one with the agent.</span>
              </div>
            )}
            {data.quotes.map((q: any) => {
              /* Identify a row by its QUOTE, not its session.
               *
               * One conversation legitimately produces several quotes — a coach
               * adds a cap, re-prices, adds shorts — so keying on sessionId gave
               * React duplicate keys the moment this view started reading real
               * quotes, and expanding one row expanded every quote from the same
               * conversation. The quote id is the thing each row actually is. */
              const rowId = q.quoteId || q.sessionId;
              return (
              <React.Fragment key={rowId}>
                <div className="trow" onClick={() => setOpen(open === rowId ? null : rowId)}
                  title="Click to see every line item"
                  style={{ gridTemplateColumns: "1.4fr 1.6fr 0.6fr 0.8fr 0.7fr 1fr", cursor: "pointer" }}>
                  {/* Name the row by the quote it IS. The column showed the
                      session, so several quotes from one conversation rendered
                      as identical-looking rows. */}
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                     title={q.orderId ? `Order ${q.orderId}` : `Session ${q.sessionId}`}>{rowId}</b>
                  <span className="role" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {q.itemNames?.join(", ") || "—"}{q.items > (q.itemNames?.length || 0) ? ` +${q.items - q.itemNames.length} more` : ""}
                  </span>
                  <span className="role">{q.items}</span>
                  <b>{cur}{(q.totalCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
                  <span><span className={`pill ${q.phase === "ordered" ? "p-active" : "p-draft"}`}>{q.phase || "quote"}</span></span>
                  <span className="role">{q.updatedAt ? new Date(q.updatedAt).toLocaleString() : "—"}</span>
                </div>
                {open === rowId && (
                  <div style={{ padding: "6px 6px 14px", borderBottom: "1px solid var(--jx-gray-200)" }}>
                    <div className="micro" style={{ margin: "6px 0" }}>LINE ITEMS — the exact bill of materials in this journey</div>
                    <div style={{ border: "1px solid var(--jx-gray-200)", borderRadius: 10, overflow: "hidden" }}>
                      {(q.lines || []).map((l: any, i: number) => (
                        <div key={i} className="between" style={{ padding: "8px 12px", fontSize: 12.5, background: i % 2 ? "var(--jx-gray-100)" : "#fff" }}>
                          <span>
                            <b>{l.name || "Unnamed item"}</b>
                            {l.sku && <span className="role" style={{ marginLeft: 8 }}>SKU {l.sku}</span>}
                            {l.category && <span className="role" style={{ marginLeft: 8 }}>{l.category}</span>}
                          </span>
                          <span><span className="role">×{l.quantity}</span> <b style={{ marginLeft: 10 }}>{cur}{Number(l.price).toLocaleString()}</b></span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
              );
            })}
          </div>
          <span className="fhelp">
            Full order-management (fulfilment, shipment, returns) arrives with the fulfilment adapter — quotes here are the agent's real output today.
          </span>
        </div>
      )}
    </>
  );
}
