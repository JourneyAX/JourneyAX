"use client";

/**
 * Knowledge Base — per-tenant view of the scraped RAG corpus (journeyx.documents):
 * product completeness, designs, technical/troubleshooting PDFs, and a clean-up
 * (dedup) action. Brand is derived from the project id (the scrape tags docs by
 * brand, e.g. "caroma").
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Database, RefreshCw, Sparkles, FileText, Layers, Wrench, Trash2, Globe, Play, Save } from "lucide-react";
import { projectApi, type Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";
import { IngestionSources } from "./IngestionSources";

interface Stats {
  brand: string;
  total: number;
  products: number;
  withSpecs: number;
  withImage: number;
  withPrice: number;
  designs: number;
  technical: number;
  troubleshooting: number;
  duplicateGroups: number;
  specsPct: number;
}

interface Recon {
  hub?: { facts?: any; narrative?: string; topics?: { title: string }[]; updatedAt?: string } | null;
  relationships: { collections: number; sizingGroups: number; outfittingSets: number };
  missing: { distinctCodes: number; totalReferences: number; codes: { code: string; count: number }[] } | null;
}

export function KnowledgeBase({ project }: { project: Project }) {
  const brand = project.projectId.toLowerCase();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dedupBusy, setDedupBusy] = useState(false);
  const [dedupMsg, setDedupMsg] = useState<string | null>(null);
  // Catalogue relationships + feed-drift report produced by catalog-extract.
  const [recon, setRecon] = useState<Recon | null>(null);

  // ── B4: knowledge source config + ingest job control ──
  const ks0 = project.knowledgeSource || {};
  const [src, setSrc] = useState({
    domain: ks0.domain || "",
    sitemapUrl: ks0.sitemapUrl || "",
    seedUrls: (ks0.seedUrls || []).join("\n"),
    maxPages: ks0.maxPages ?? 50,
  });
  const [srcSaving, setSrcSaving] = useState(false);
  const [srcSaved, setSrcSaved] = useState(false);
  const [job, setJob] = useState<any>(null);
  const [ingestErr, setIngestErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const k = project.knowledgeSource || {};
    setSrc({ domain: k.domain || "", sitemapUrl: k.sitemapUrl || "", seedUrls: (k.seedUrls || []).join("\n"), maxPages: k.maxPages ?? 50 });
    setJob(null); setIngestErr(null);
    // Show the latest job for this project (e.g. one still running from earlier)
    authedFetch(`/api/knowledge/ingest?projectId=${encodeURIComponent(project.projectId)}`)
      .then((r) => (r.ok ? r.json() : null)).then((j) => j && setJob(j)).catch(() => {});
  }, [project.projectId]);

  // Poll while a job is queued/running; refresh stats when it finishes.
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (job && (job.status === "queued" || job.status === "running")) {
      pollRef.current = setInterval(async () => {
        try {
          const r = await authedFetch(`/api/knowledge/ingest?jobId=${job.jobId}`);
          if (r.ok) {
            const j = await r.json();
            setJob(j);
            if (j.status === "completed" || j.status === "failed") load();
          }
        } catch {}
      }, 3000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [job?.jobId, job?.status]);

  async function saveSource() {
    setSrcSaving(true); setSrcSaved(false);
    try {
      await projectApi.update(project.projectId, {
        knowledgeSource: {
          domain: src.domain.trim() || undefined,
          sitemapUrl: src.sitemapUrl.trim() || undefined,
          seedUrls: src.seedUrls.split("\n").map((s) => s.trim()).filter(Boolean),
          maxPages: Number(src.maxPages) || 50,
        },
      });
      setSrcSaved(true); setTimeout(() => setSrcSaved(false), 2500);
    } catch (e: any) { setIngestErr(e.message); }
    finally { setSrcSaving(false); }
  }

  async function startIngest(limit?: number) {
    setIngestErr(null);
    try {
      await saveSource(); // ensure the runner sees the latest source config
      const r = await authedFetch(`/api/knowledge/ingest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.projectId, limit }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setJob({ jobId: data.jobId, status: "queued", progress: {}, log: [] });
    } catch (e: any) { setIngestErr(e.message); }
  }

  const load = useCallback(async (force?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      // force → bypass both caches, so Refresh re-counts the corpus.
      const res = await authedFetch(
        `/api/knowledge/stats?brand=${encodeURIComponent(brand)}${force ? '&refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStats(data);
      // Secondary panel — a failure here must not blank the whole tab.
      try {
        const rr = await authedFetch(`/api/knowledge/reconciliation?brand=${encodeURIComponent(brand)}`);
        if (rr.ok) setRecon(await rr.json());
      } catch { /* relationships simply not shown */ }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => { load(); }, [load]);

  async function runDedup() {
    if (!confirm(`Remove duplicate chunks for "${brand}"? Keeps the newest of each duplicate group.`)) return;
    setDedupBusy(true);
    setDedupMsg(null);
    try {
      const res = await authedFetch(`/api/knowledge/dedup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDedupMsg(`Removed ${data.removed} duplicate chunk(s) across ${data.duplicateGroups} group(s).`);
      load();
    } catch (e: any) {
      setDedupMsg(`Failed: ${e.message}`);
    } finally {
      setDedupBusy(false);
    }
  }

  const card = (icon: React.ReactNode, label: string, value: React.ReactNode, sub?: string) => (
    <div className="panel" style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--jx-gray-500)", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {icon}{label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, color: "var(--jx-black)", marginTop: 6, fontFamily: "var(--font-display)" }}>{value}</div>
      {sub && <div className="micro" style={{ color: "var(--jx-gray-500)" }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <IngestionSources project={project} onSaved={load} />
      <div className="ctop">
        <div>
          <h1 className="pageh">Knowledge Base</h1>
          <p className="pagesub">
            The RAG corpus powering <b>{project.companyName}</b>'s agent — scraped products, designs and technical documents (brand <b>{brand}</b>).
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--jx-destructive)", color: "var(--jx-destructive)" }}>
          Could not load knowledge stats: {error}
        </div>
      )}

      {/* ── B4: Knowledge source (config, per project) + Start ingest ── */}
      <div className="panel">
        <div className="between">
          <h4><Globe size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Knowledge source</h4>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={saveSource} disabled={srcSaving}>
              <Save size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              {srcSaving ? "Saving…" : srcSaved ? "Saved ✓" : "Save source"}
            </button>
            <button
              className="btn y"
              onClick={() => startIngest(5)}
              disabled={job?.status === "running" || job?.status === "queued"}
              title="Ingest a small test batch (5 pages) first"
            >
              <Play size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              Test ingest (5)
            </button>
            <button
              className="btn y"
              onClick={() => startIngest()}
              disabled={job?.status === "running" || job?.status === "queued"}
            >
              <Play size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              Start ingest
            </button>
          </div>
        </div>
        <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "4px 0 10px" }}>
          Where this project's corpus comes from — configuration, not code. The runner crawls, classifies,
          chunks and embeds; documents land tagged with <b>projectId="{brand}"</b>.
        </p>
        <div className="form-grid">
          <div>
            <span className="flabel">Site / domain</span>
            <input className="field" value={src.domain} onChange={(e) => setSrc({ ...src, domain: e.target.value })} placeholder="https://www.example.com" />
          </div>
          <div>
            <span className="flabel">Sitemap URL (optional)</span>
            <input className="field" value={src.sitemapUrl} onChange={(e) => setSrc({ ...src, sitemapUrl: e.target.value })} placeholder="https://www.example.com/sitemap-products.xml" />
          </div>
          <div className="full">
            <span className="flabel">Seed URLs (one per line)</span>
            <textarea className="field" rows={3} value={src.seedUrls} onChange={(e) => setSrc({ ...src, seedUrls: e.target.value })} placeholder={"https://www.example.com/products\nhttps://www.example.com/support"} />
          </div>
          <div>
            <span className="flabel">Max pages per run</span>
            <input className="field" type="number" min={1} max={2000} style={{ maxWidth: 140 }} value={src.maxPages} onChange={(e) => setSrc({ ...src, maxPages: Number(e.target.value) })} />
          </div>
        </div>
        {ingestErr && <div className="micro" style={{ color: "var(--jx-destructive)", marginTop: 8 }}>{ingestErr}</div>}
      </div>

      {/* Brand context the agent receives every turn (AUG-14) */}
      {recon?.hub && (
        <div className="panel">
          <h4>Brand context</h4>
          <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
            Given to the agent at the start of every conversation, so it knows who this business is without searching.
            Catalogue figures are computed; the summary is orientation only — the agent still retrieves before quoting any policy or price.
          </p>
          {recon.hub.facts?.brands?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span className="flabel" style={{ margin: 0 }}>Brands in this catalogue</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {recon.hub.facts.brands.map((b: any) => (
                  <span key={b.name} className="pill p-draft">{b.name} · {b.products}</span>
                ))}
              </div>
            </div>
          )}
          {recon.hub.narrative && (
            <p style={{ fontSize: 13, lineHeight: 1.55, marginTop: 12, color: "var(--jx-gray-800)" }}>
              {recon.hub.narrative}
            </p>
          )}
          {recon.hub.topics?.length ? (
            <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 10 }}>
              {recon.hub.topics.length} help topics are advertised to the agent as retrievable.
            </p>
          ) : null}
        </div>
      )}

      {/* Catalogue relationships + feed drift (AUG-10/12) */}
      {recon && (
        <div className="panel">
          <h4>Catalogue relationships</h4>
          <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 4 }}>
            Derived from catalogue documents — what matches what, and which sizes exist. The agent reads these as exact facts rather than inferring them.
          </p>
          <div style={{ display: "flex", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
            {[
              ["Collections", recon.relationships.collections],
              ["Sizing groups", recon.relationships.sizingGroups],
              ["Outfitting sets", recon.relationships.outfittingSets],
            ].map(([label, n]) => (
              <div key={String(label)}>
                <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "var(--font-display)" }}>{n as number}</div>
                <div className="micro" style={{ color: "var(--jx-gray-500)" }}>{label}</div>
              </div>
            ))}
          </div>

          {recon.missing && recon.missing.distinctCodes > 0 && (
            <div style={{ marginTop: 18, borderTop: "1px solid var(--jx-gray-200)", paddingTop: 14 }}>
              <div className="between">
                <span className="flabel" style={{ margin: 0 }}>Styles in the catalogue but not in the product feed</span>
                <span className="pill p-draft">{recon.missing.distinctCodes} codes</span>
              </div>
              <p className="micro" style={{ color: "var(--jx-gray-500)", marginTop: 6 }}>
                Your catalogue references these {recon.missing.distinctCodes} style codes ({recon.missing.totalReferences} times), but no product record exists for them.
                They were excluded from the relationships above — the agent will not recommend an item it cannot price or sell.
                A high count usually means the product feed is behind the catalogue.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {recon.missing.codes.slice(0, 40).map((c) => (
                  <code key={c.code} className="micro" style={{ background: "var(--jx-gray-100)", padding: "2px 6px", borderRadius: 4 }}>
                    {c.code}{c.count > 1 ? ` ×${c.count}` : ""}
                  </code>
                ))}
                {recon.missing.codes.length > 40 && (
                  <span className="micro" style={{ color: "var(--jx-gray-500)" }}>+{recon.missing.codes.length - 40} more</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ingest job status */}
      {job && (
        <div className="panel">
          <div className="between">
            <h4>Ingest job</h4>
            <span className={`pill ${job.status === "completed" ? "p-active" : job.status === "failed" ? "p-inactive" : "p-draft"}`}>
              {job.status}{(job.status === "running" || job.status === "queued") ? "…" : ""}
            </span>
          </div>
          <div className="micro" style={{ color: "var(--jx-gray-600)", margin: "6px 0" }}>
            {job.progress?.processed ?? 0}/{job.progress?.discovered ?? "?"} pages · {job.progress?.chunks ?? 0} chunks
            {job.progress?.failed ? ` · ${job.progress.failed} failed` : ""}
          </div>
          {Array.isArray(job.log) && job.log.length > 0 && (
            <pre style={{ maxHeight: 180, overflowY: "auto", background: "var(--jx-gray-100)", borderRadius: 8, padding: "10px 12px", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {job.log.slice(-25).join("\n")}
            </pre>
          )}
          {job.error && <div className="micro" style={{ color: "var(--jx-destructive)" }}>{job.error}</div>}
        </div>
      )}

      {stats && stats.total === 0 && (
        <div className="panel" style={{ color: "var(--jx-gray-600)" }}>
          No knowledge scraped for <b>{brand}</b> yet. The Playwright ingest tags documents by brand — run the scrape for this tenant to populate the corpus.
        </div>
      )}

      {stats && stats.total > 0 && (
        <>
          <div className="cardrow" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {card(<Database size={14} />, "Total documents", stats.total.toLocaleString())}
            {card(<Sparkles size={14} />, "Products", stats.products.toLocaleString(), `${stats.withSpecs.toLocaleString()} with specs · ${stats.specsPct}%`)}
            {card(<Layers size={14} />, "Designs", stats.designs.toLocaleString())}
            {card(<FileText size={14} />, "Technical PDFs", stats.technical.toLocaleString())}
            {card(<Wrench size={14} />, "Troubleshooting", stats.troubleshooting.toLocaleString())}
            {card(<Sparkles size={14} />, "With image / price", `${stats.withImage.toLocaleString()} / ${stats.withPrice.toLocaleString()}`)}
          </div>

          <div className="panel">
            <div className="between">
              <h4><Trash2 size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Clean-up</h4>
              <span className="micro">{stats.duplicateGroups} duplicate group(s) detected</span>
            </div>
            <p className="micro" style={{ color: "var(--jx-gray-600)", marginTop: 4 }}>
              Collapses genuine duplicate chunks left by earlier re-ingest runs (same URL + index + type), keeping the newest. Product-text vs PDF chunks are never touched.
            </p>
            <div className="between" style={{ marginTop: 10 }}>
              <span className="micro" style={{ color: dedupMsg?.startsWith("Failed") ? "var(--jx-destructive)" : "var(--jx-gray-700)" }}>{dedupMsg || ""}</span>
              <button className="btn y" onClick={runDedup} disabled={dedupBusy || stats.duplicateGroups === 0}>
                {dedupBusy ? "Cleaning…" : `Run clean-up (${stats.duplicateGroups})`}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
