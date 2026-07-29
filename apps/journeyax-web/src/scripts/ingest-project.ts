/**
 * ingest-project.ts — GENERIC, per-project knowledge ingestion (B4).
 *
 * Replaces the Caroma-hardcoded scripts for onboarding: the target site comes from
 * the PROJECT's `knowledgeSource` config (domain/seedUrls/sitemapUrl/maxPages —
 * edited in the back office Knowledge tab), never from constants in code. Docs are
 * written with BOTH `projectId` (the platform isolation key) and `brand=projectId`
 * (back-compat with existing retrieval filters).
 *
 * Designed to be SPAWNED by the back-office "Start ingest" action with a --job id;
 * it reports status/progress/log into `journeyx.ingest_jobs` so the UI can poll.
 * Also runnable by hand:
 *
 *   npx tsx src/scripts/ingest-project.ts --project caroma-nz [--job <id>] [--limit 5]
 *
 * v1 pipeline (generic): Playwright chromium → page title + innerText → classify by
 * URL/content heuristics → chunk → embed → upsert. Rich per-vertical extraction
 * (specs/PDF parsing à la ingest-master) can layer on later per source type.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { chromium } from 'playwright';
import { MongoClient, ObjectId } from 'mongodb';
import { chunkContent } from '../services/knowledge/chunker';
import { embedTexts } from '../services/knowledge/embedder';
import { insertDocuments, closeConnection } from '../services/knowledge/mongo';
import { DocumentMetadata, DocumentType, KnowledgeDocument } from '../services/knowledge/types';
import { extractPage, composeContent } from '../services/knowledge/extractor';
import { iterateProducts, composeWsContent, WsConfig } from '../services/knowledge/websphere';

const PROJECT_API = process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';

// ── args ────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PROJECT_ID = (arg('project') || '').toLowerCase();
const JOB_ID = arg('job');
const LIMIT = arg('limit') ? Number(arg('limit')) : undefined;

if (!PROJECT_ID) {
  console.error('Usage: ingest-project.ts --project <projectId> [--job <jobId>] [--limit N]');
  process.exit(1);
}

// ── job status reporting (journeyx.ingest_jobs) ─────────────────────────────
let jobsClient: MongoClient | null = null;
async function jobUpdate(patch: Record<string, unknown>, logLine?: string) {
  if (!JOB_ID) { if (logLine) console.log(logLine); return; }
  try {
    if (!jobsClient) {
      jobsClient = new MongoClient(process.env.MONGODB_URI!);
      await jobsClient.connect();
    }
    const update: any = { $set: { ...patch, updatedAt: new Date() } };
    if (logLine) { update.$push = { log: { $each: [logLine], $slice: -200 } }; console.log(logLine); }
    await jobsClient.db('journeyx').collection('ingest_jobs').updateOne({ _id: new ObjectId(JOB_ID) }, update);
  } catch (e) { console.warn('job update failed:', (e as Error).message); }
}

// Decode the handful of XML/HTML entities that appear in sitemap <loc> URLs.
function decodeEntities(u: string): string {
  return u.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ── URL discovery from the project's knowledgeSource ────────────────────────
// Config-driven filtering (no per-site code): a project may set
//   knowledgeSource.urlIncludes  — only crawl URLs containing this substring
//   knowledgeSource.urlExcludes  — skip URLs containing this substring
// e.g. a WebSphere store sets urlIncludes="ProductDisplay" to crawl the canonical
// product URLs and skip its broken SEO-slug URLs.
async function discoverUrls(src: any, cap: number): Promise<string[]> {
  const raw: string[] = [];
  for (const u of src.seedUrls ?? []) if (u?.trim()) raw.push(u.trim());
  if (src.sitemapUrl) {
    try {
      const xml = await (await fetch(src.sitemapUrl)).text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) raw.push(decodeEntities(m[1]));
    } catch (e) { await jobUpdate({}, `⚠ sitemap fetch failed: ${(e as Error).message}`); }
  }

  const inc = (src.urlIncludes || '').trim();
  const exc = (src.urlExcludes || '').trim();
  const seen = new Set<string>();     // by canonical id (productId) or full url
  const out: string[] = [];
  for (const u of raw) {
    if (inc && !u.includes(inc)) continue;
    if (exc && u.includes(exc)) continue;
    // Dedupe canonical commerce URLs by their productId (same product, many categories).
    const pid = u.match(/[?&]productId=(\d+)/)?.[1];
    const key = pid || u;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= cap) break;
  }
  if (out.length === 0 && src.domain) out.push(src.domain);
  return out.slice(0, cap);
}

/** Generic type classification from URL path + content, no vertical hardcoding. */
function classify(url: string, text: string): DocumentType {
  const u = url.toLowerCase();
  if (/(install|instruction|manual|how-to|assembly)/.test(u)) return 'installation';
  if (/(troubleshoot|repair|fault|leak|support|problem)/.test(u)) return 'troubleshooting';
  if (/(warranty|faq|policy|care|returns|terms)/.test(u)) return 'faq';
  if (/(inspiration|lookbook|gallery|ideas|design|collection|style)/.test(u)) return 'design';
  if (/(product|shop|item|sku|\/p\/|\/dp\/)/.test(u)) return 'product';
  if (/add to (cart|bag)|our price|rrp|\$\d/i.test(text.slice(0, 4000))) return 'product';
  return 'general';
}

// ── WebSphere REST connector run (clean catalogue feed, no browser) ─────────
async function runWebsphere(src: any, cap: number): Promise<void> {
  const cfg: WsConfig = {
    base: (src.domain || '').replace(/\/$/, '') || 'https://www.momentecbrands.com',
    storeId: String(src.storeId || ''),
    catalogId: String(src.catalogId || ''),
    categoryIds: src.categoryIds,
    currency: src.currency || 'USD',
  };
  if (!cfg.storeId || !cfg.catalogId) {
    throw new Error('websphere-rest source needs storeId and catalogId in knowledgeSource.');
  }
  await jobUpdate({}, `▶ WebSphere REST feed: store ${cfg.storeId}, catalog ${cfg.catalogId} (cap ${cap})`);

  let processed = 0, chunksTotal = 0;
  const now = new Date();
  for await (const p of iterateProducts(cfg, cap, (m) => { void jobUpdate({}, `… ${m}`); })) {
    try {
      const content = composeWsContent(p);
      const metadata: DocumentMetadata = {
        type: 'product', brand: PROJECT_ID, url: p.url,
        ...(p.sku ? { sku: p.sku } : {}),
        ...(p.price != null ? { price: p.price } : {}),
        currency: p.currency,
        ...(p.category ? { category: p.category } : {}),
        ...(p.images.length ? { images: p.images } : {}),
        ...(p.longDescription ? { description: p.longDescription } : {}),
        ...(p.shortDescription ? { shortDescription: p.shortDescription } : {}),
        ...(p.options && Object.keys(p.options).length ? { options: p.options } : {}),
        ...(p.specs && Object.keys(p.specs).length ? { specs: p.specs } : {}),
        ...(p.variants && p.variants.length
          ? { variants: p.variants.filter((v) => v.sku).map((v) => ({ sku: v.sku as string, finish: v.attrs?.['Color'] })) }
          : {}),
        ...(p.documents && p.documents.length ? { documents: p.documents } : {}),
      };
      const chunks = chunkContent(content, p.title, p.url, metadata);
      if (!chunks.length) continue;
      const embeddings = await embedTexts(chunks.map((c) => c.text));
      const docs: KnowledgeDocument[] = chunks.map((c, i) => ({
        projectId: PROJECT_ID, brand: PROJECT_ID, sourceUrl: p.url, title: p.title,
        content, chunk: c.text, chunkIndex: i, metadata, embedding: embeddings[i], crawledAt: now, updatedAt: now,
      }));
      await insertDocuments(docs);
      processed++; chunksTotal += docs.length;
      await jobUpdate(
        { 'progress.processed': processed, 'progress.chunks': chunksTotal },
        `✓ [${processed}] ${p.sku || p.productId} · ${p.images.length}img ${p.price != null ? '$' + p.price : ''} · ${p.title.slice(0, 60)}`,
      );
    } catch (e) {
      await jobUpdate({}, `✗ ${p.productId}: ${(e as Error).message}`);
    }
  }
  await jobUpdate(
    { status: 'completed', finishedAt: now, 'progress.processed': processed, 'progress.chunks': chunksTotal },
    `■ done (WebSphere REST) — ${processed} product(s), ${chunksTotal} chunk(s). Docs tagged projectId="${PROJECT_ID}".`,
  );
  await closeConnection();
}

async function main() {
  await jobUpdate({ status: 'running', startedAt: new Date() }, `▶ ingest starting for project "${PROJECT_ID}"`);

  // 1) Load the project's knowledgeSource config (the whole point: config, not code)
  const res = await fetch(`${PROJECT_API}/api/v1/projects/${PROJECT_ID}`, { headers: { 'X-Tenant-ID': PROJECT_ID } });
  if (!res.ok) throw new Error(`project "${PROJECT_ID}" not found (HTTP ${res.status})`);
  const project: any = await res.json();
  const src = project.knowledgeSource || {};
  const cap = LIMIT ?? src.maxPages ?? 50;

  // ── Connector strategy: WebSphere REST feed (clean catalogue incl. SKUs) ──
  if (src.type === 'websphere-rest') {
    await runWebsphere(src, cap);
    return;
  }

  if (!src.domain && !(src.seedUrls?.length) && !src.sitemapUrl) {
    throw new Error('knowledgeSource is not configured for this project — set domain/seedUrls/sitemapUrl in the back office Knowledge tab.');
  }
  const urls = await discoverUrls(src, cap);
  await jobUpdate({ 'progress.discovered': urls.length }, `☰ ${urls.length} URL(s) to ingest (cap ${cap})`);

  // 2) Crawl generically with Playwright (handles JS-rendered sites)
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // tsx/esbuild wraps functions with a `__name` helper that doesn't exist in the
  // browser context — shim it in every page world so page.evaluate() works.
  await page.addInitScript(() => { (globalThis as any).__name = (fn: unknown) => fn; });
  // Warm the session first — some commerce platforms (e.g. WebSphere) only render
  // product pages once a session cookie exists.
  const warmOrigin = src.domain || (src.sitemapUrl ? new URL(src.sitemapUrl).origin : undefined);
  if (warmOrigin) {
    try { await page.goto(warmOrigin, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1500); }
    catch { /* non-fatal */ }
  }
  let processed = 0, chunksTotal = 0, failed = 0;

  try {
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // best-effort settle
        await page.waitForTimeout(2500); // let client-side rendering finish

        // Rich, generic PDP extraction (schema.org/OG/DOM heuristics) — captures
        // images, price, variants, specs, docs/PDFs, reviews, availability, etc.
        const x = await extractPage(page, url);
        const title = x.title || url;
        if ((x.bodyText || '').trim().length < 100 && !x.isProduct) {
          await jobUpdate({}, `— skipped (thin content): ${url}`);
          continue;
        }

        // URL/content type, but let a JSON-LD Product override to 'product'.
        const type: DocumentType = x.isProduct && x.price != null ? 'product' : classify(url, x.bodyText);
        const content = composeContent(x);

        // Full structured metadata — only set fields the page actually exposed.
        const metadata: DocumentMetadata = {
          type, brand: PROJECT_ID, url,
          ...(x.sku ? { sku: x.sku } : {}),
          ...(x.price != null ? { price: x.price } : {}),
          ...(x.priceMin != null ? { priceMin: x.priceMin } : {}),
          ...(x.priceMax != null ? { priceMax: x.priceMax } : {}),
          ...(x.currency ? { currency: x.currency } : {}),
          ...(x.category ? { category: x.category } : {}),
          ...(x.availability ? { availability: x.availability } : {}),
          ...(x.images.length ? { images: x.images.slice(0, 20) } : {}),
          ...(Object.keys(x.options).length ? { options: x.options } : {}),
          ...(x.variants.length ? { variants: x.variants } : {}),
          ...(Object.keys(x.specs).length ? { specs: x.specs } : {}),
          ...(x.documents.length ? { documents: x.documents } : {}),
          ...(x.description ? { description: x.description } : {}),
          ...(x.shortDescription ? { shortDescription: x.shortDescription } : {}),
          ...(x.rating != null ? { rating: x.rating } : {}),
          ...(x.reviewCount != null ? { reviewCount: x.reviewCount } : {}),
        };

        const chunks = chunkContent(content, title, url, metadata);
        if (!chunks.length) { await jobUpdate({}, `— skipped (no chunks): ${url}`); continue; }

        const embeddings = await embedTexts(chunks.map((c) => c.text));
        const now = new Date();
        const docs: KnowledgeDocument[] = chunks.map((c, i) => ({
          projectId: PROJECT_ID,
          brand: PROJECT_ID,          // back-compat retrieval key (brand === projectId)
          sourceUrl: url,
          title,
          content,
          chunk: c.text,
          chunkIndex: i,
          metadata,
          embedding: embeddings[i],
          crawledAt: now,
          updatedAt: now,
        }));
        await insertDocuments(docs);
        processed++; chunksTotal += docs.length;
        const badges = [
          x.images.length ? `${x.images.length}img` : '',
          x.price != null ? `$${x.price}` : '',
          Object.keys(x.specs).length ? `${Object.keys(x.specs).length}spec` : '',
          x.documents.length ? `${x.documents.length}doc` : '',
        ].filter(Boolean).join(' ');
        await jobUpdate(
          { 'progress.processed': processed, 'progress.chunks': chunksTotal },
          `✓ [${processed}/${urls.length}] ${type} · ${docs.length}chunk ${badges} · ${title.slice(0, 60)}`,
        );
      } catch (e) {
        failed++;
        await jobUpdate({ 'progress.failed': failed }, `✗ ${url}: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  await jobUpdate(
    { status: 'completed', finishedAt: new Date() },
    `■ done — ${processed} page(s), ${chunksTotal} chunk(s), ${failed} failed. Docs tagged projectId="${PROJECT_ID}".`,
  );
}

main()
  .catch(async (e) => {
    await jobUpdate({ status: 'failed', error: e.message, finishedAt: new Date() }, `✖ failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnection().catch(() => {});
    await jobsClient?.close().catch(() => {});
  });
