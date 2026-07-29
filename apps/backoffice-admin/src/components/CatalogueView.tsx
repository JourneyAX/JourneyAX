"use client";

/**
 * Catalogue — the project's REAL ingested product catalogue (B5).
 * Searches the knowledge corpus (product-type documents per projectId).
 */
import React, { useEffect, useState } from "react";
import { Search, RefreshCw, X, ExternalLink } from "lucide-react";
import type { Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

interface Row { url: string; title: string; sku?: string; price?: number; currency?: string; category?: string; collection?: string; image?: string; availability?: string; specCount?: number }

interface ItemDetail {
  url: string; title: string; sku?: string; price?: number; currency?: string; category?: string;
  collection?: string; description?: string; availability?: string; type?: string;
  specs: Record<string, string>; images: string[]; finishes: string[];
  variants: { sku: string; finish?: string; availability?: string }[];
  documents: { title: string; url: string; kind?: string }[];
  chunks: { index: number; text: string }[];
}

export function CatalogueView({ project }: { project: Project }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function openDetail(url: string) {
    setDetailLoading(true); setDetail(null);
    try {
      const r = await authedFetch(`/api/catalogue/item?projectId=${encodeURIComponent(project.projectId)}&url=${encodeURIComponent(url)}`);
      const d = await r.json();
      if (r.ok) setDetail(d);
    } finally { setDetailLoading(false); }
  }

  const load = React.useCallback(async (query: string, force?: boolean) => {
    setLoading(true);
    try {
      // force → bypass both caches, so Refresh re-reads the corpus.
      const r = await authedFetch(`/api/catalogue?projectId=${encodeURIComponent(project.projectId)}&limit=60${query ? `&q=${encodeURIComponent(query)}` : ""}${force ? "&refresh=1" : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.products); setTotal(d.totalProducts); setError(null);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [project.projectId]);

  useEffect(() => { setQ(""); load(""); }, [load]);
  useEffect(() => { const t = setTimeout(() => load(q), 350); return () => clearTimeout(t); }, [q]);

  const cur = project.pricing?.symbol || "$";

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Catalogue</h1>
          {/* Never assert a count we do not have yet. While loading, this read
              "0 products in Augusta Sportswear's ingested catalogue" — stating
              as fact the opposite of the truth (there are 2,350), which reads
              as broken rather than busy. */}
          <p className="pagesub">
            {loading && !total
              ? <>Loading <b>{project.companyName}</b>&apos;s ingested catalogue…</>
              : <><b>{total.toLocaleString()}</b> products in <b>{project.companyName}</b>&apos;s ingested catalogue — refresh it from the Knowledge Base tab.</>}
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => load(q, true)} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>{error}</div>}

      <div className="panel">
        <div style={{ position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--jx-gray-400)" }} />
          <input className="field" style={{ paddingLeft: 34 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or SKU…" />
        </div>
        <div className="tblwrap" style={{ marginTop: 8 }}>
          <div className="theadr" style={{ gridTemplateColumns: "50px 2fr 0.9fr 0.7fr 1fr 0.6fr" }}>
            <span></span><span>Product</span><span>SKU</span><span>Price</span><span>Category</span><span>Specs</span>
          </div>
          {rows.length === 0 && !loading && (
            <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
              <span className="role">No products {q ? `matching "${q}"` : "ingested yet — configure a source and run an ingest in the Knowledge Base tab"}.</span>
            </div>
          )}
          {rows.map((p) => (
            <div key={p.url} className="trow" onClick={() => openDetail(p.url)} title="Click for full detail"
              style={{ gridTemplateColumns: "50px 2fr 0.9fr 0.7fr 1fr 0.6fr", cursor: "pointer" }}>
              <span>{p.image
                ? <img src={p.image} alt="" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, border: "1px solid var(--jx-gray-200)" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                : <span style={{ display: "inline-block", width: 34, height: 34, borderRadius: 6, background: "var(--jx-gray-100)" }} />}</span>
              <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.title}>{p.title}</b>
              <span className="role">{p.sku || "—"}</span>
              <b>{typeof p.price === "number" ? `${cur}${p.price.toLocaleString()}` : "—"}</b>
              <span className="role" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.category || p.collection || "—"}</span>
              <span className="role">{p.specCount || 0}</span>
            </div>
          ))}
        </div>
        <span className="fhelp">Click any row to open the full product detail — everything the agent grounds on.</span>
      </div>

      {/* ── Product detail drawer ── */}
      {(detail || detailLoading) && (
        <div
          onClick={() => setDetail(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 400, display: "flex", justifyContent: "flex-end" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(560px, 92vw)", height: "100%", background: "var(--jx-white)", overflowY: "auto", padding: "22px 24px", boxShadow: "-14px 0 40px rgba(0,0,0,0.2)" }}
          >
            {detailLoading && <div className="role">Loading product detail…</div>}
            {detail && (
              <>
                <div className="between" style={{ marginBottom: 12 }}>
                  <h3 style={{ fontSize: 17, lineHeight: 1.3, paddingRight: 12 }}>{detail.title}</h3>
                  <button onClick={() => setDetail(null)} style={{ border: "none", background: "transparent", cursor: "pointer", flexShrink: 0 }}><X size={18} /></button>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {detail.sku && <span className="pill p-offline">SKU {detail.sku}</span>}
                  {typeof detail.price === "number" && <span className="pill p-active">{cur}{detail.price.toLocaleString()}</span>}
                  {detail.category && <span className="pill p-draft">{detail.category}</span>}
                  {detail.collection && <span className="pill p-offline">{detail.collection}</span>}
                  {detail.availability && <span className="pill p-offline">{detail.availability}</span>}
                </div>

                {detail.images?.length > 0 && (
                  <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 14 }}>
                    {detail.images.slice(0, 5).map((img) => (
                      <img key={img} src={img} alt="" style={{ height: 110, borderRadius: 8, border: "1px solid var(--jx-gray-200)" }}
                        onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                    ))}
                  </div>
                )}

                {detail.description && (
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--jx-gray-700)", marginBottom: 14 }}>{detail.description}</p>
                )}

                {Object.keys(detail.specs || {}).length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div className="micro" style={{ marginBottom: 6 }}>SPECIFICATIONS ({Object.keys(detail.specs).length})</div>
                    <div style={{ border: "1px solid var(--jx-gray-200)", borderRadius: 10, overflow: "hidden" }}>
                      {Object.entries(detail.specs).map(([k, v], i) => (
                        <div key={k} className="between" style={{ padding: "7px 12px", fontSize: 12.5, background: i % 2 ? "var(--jx-gray-100)" : "#fff" }}>
                          <span style={{ color: "var(--jx-gray-600)" }}>{k}</span>
                          <b style={{ textAlign: "right", maxWidth: "55%" }}>{v}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.variants?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div className="micro" style={{ marginBottom: 6 }}>VARIANTS ({detail.variants.length})</div>
                    <div className="chips">
                      {detail.variants.map((v) => (
                        <span key={v.sku} className="chip" style={{ cursor: "default" }}>{v.finish || v.sku} · {v.sku}</span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.documents?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div className="micro" style={{ marginBottom: 6 }}>TECHNICAL DOCUMENTS ({detail.documents.length})</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {detail.documents.map((d) => (
                        <a key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" className="node" style={{ fontSize: 12.5, textDecoration: "none" }}>
                          {d.title || d.url.split("/").pop()} <ExternalLink size={11} style={{ verticalAlign: "-1px", marginLeft: 4 }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: 14 }}>
                  <div className="micro" style={{ marginBottom: 6 }}>WHAT THE AGENT READS (grounding chunks · {detail.chunks.length})</div>
                  {detail.chunks.slice(0, 3).map((c) => (
                    <pre key={c.index} style={{ background: "var(--jx-gray-100)", borderRadius: 8, padding: "10px 12px", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 6, maxHeight: 160, overflowY: "auto" }}>
                      {c.text}
                    </pre>
                  ))}
                  <span className="fhelp">This is the REAL ingested data the agent grounds its answers on — not display copy.</span>
                </div>

                <a href={detail.url} target="_blank" rel="noopener noreferrer" className="btn" style={{ textDecoration: "none", display: "inline-block" }}>
                  View source page <ExternalLink size={12} style={{ verticalAlign: "-1px", marginLeft: 4 }} />
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
