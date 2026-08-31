/**
 * Config-driven ingestion pipeline (AUG-6/AUG-7).
 *
 * THE productised path: a project declares `knowledgeSource.sources[]` in its
 * config and this pipeline runs them — no brand URLs, project ids, file paths or
 * model names in code. The same pipeline onboards every future tenant.
 *
 * Stages (each only runs if the project configures a source for it):
 *   csv-feed        → canonical products (dual price books + live inventory)
 *   websphere-rest  → catalogue via REST (stores without feeds)
 *   [merge]         → fold the scraped web layer onto Parent_SKU, promote orphans
 *   [narrate]       → one embedded narrative per product (UNDERSTANDING layer)
 *   pdf             → decoration guides / size charts / swatches / catalogues
 *   kb-articles     → help-centre articles (fit, care, lead times, policies)
 *
 * Facts stay structured in `products`; only prose is embedded into `documents`.
 */
import path from 'path';
import { Db } from 'mongodb';
import OpenAI from 'openai';
import { buildCatalogue, FeedUrls, CanonicalProduct } from './csv-feed';
import { embedTexts } from './embedder';
import { fetchOptionSpace } from './websphere';
import { deriveOptionSpace, deriveGarmentType } from './option-space-derive';
import { captureCap, buildGlobalColourIndex } from './cap-decoration';
import { fetchLeadTimes, leadTimeForProductType } from './lead-time';
import { fetchPalettes, fetchGarmentAttributes, captureStyle } from './decoration';
import { calibrateProbe, buildProbeUrl, fetchPng, analyse } from './design-visuals';

export interface SourceItem {
  id: string;
  type: 'csv-feed' | 'websphere-rest' | 'pdf' | 'kb-articles' | 'html' | 'team-directory';
  enabled?: boolean;
  label?: string;
  url?: string;
  role?: string;
  currency?: string;
  sublimation?: boolean;
  docType?: string;
  storeId?: string;
  catalogId?: string;
  sitemapUrl?: string;
  urlIncludes?: string;
  urlExcludes?: string;
  maxPages?: number;
  /** Colour collections to ingest (AUG-30). A brand may publish several, with
   *  DIFFERENT naming conventions, and which one a style uses follows from its
   *  product type — so they are listed, not guessed. */
  colourCollections?: string[];
  /** Imaging host + id pattern for design renders (AUG-42). Config, not code —
   *  a different brand's imaging vendor needs no change here. */
  imagingHost?: string;
  texturePattern?: string;
  /** Saturated, far-apart palette names used to measure zones separately. */
  probeColours?: string[];
}

export interface PipelineCtx {
  projectId: string;
  db: Db;
  sources: SourceItem[];
  ingestModel: string;
  extractModel?: string;              // optional stronger model for relationship extraction
  storageDir: string;                 // artifact cache (local dev; GCS-backed in prod)
  log: (msg: string) => void | Promise<void>;
  progress: (patch: Record<string, unknown>) => void | Promise<void>;
  only?: string[];                    // optional: run just these stage names
}

const enabled = (s: SourceItem) => s.enabled !== false;

/**
 * Retry a transient failure a few times before giving up.
 *
 * Long ingest passes run for many minutes against a shared cluster and a remote
 * embedding API; both interrupt occasionally for reasons unrelated to the work.
 * Losing an entire run to one blip — as happened at 1,000 of 7,445 documents —
 * wastes the expensive part (the embeddings already paid for).
 */
async function withRetry<T>(fn: () => Promise<T>, onRetry: (m: string) => unknown, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i === attempts - 1) break;
      await onRetry(`${(e as Error).message} (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

/* ───────────────────────── stage: csv-feed ───────────────────────── */
export async function stageCsvFeeds(ctx: PipelineCtx): Promise<number> {
  const feeds = ctx.sources.filter((s) => s.type === 'csv-feed' && enabled(s));
  if (!feeds.length) return 0;

  // Map declared sources onto the connector's slots by role/currency/sublimation.
  const urls: FeedUrls = {};
  for (const f of feeds) {
    if (!f.url) continue;
    if (f.role === 'inventory') { urls.inventory = f.url; continue; }
    const cad = (f.currency || 'USD').toUpperCase() === 'CAD';
    if (f.sublimation) { if (cad) urls.sublimationCAD = f.url; else urls.sublimationUS = f.url; }
    else { if (cad) urls.productCAD = f.url; else urls.productUS = f.url; }
  }

  await ctx.log(`csv-feed: ${feeds.length} configured feed(s)`);
  const catalogue = await buildCatalogue(urls, path.join(ctx.storageDir, 'feeds'), (m) => void ctx.log(`  · ${m}`));
  const products = [...catalogue.values()];

  const P = ctx.db.collection('products');
  await P.createIndex({ projectId: 1, parentSku: 1 }, { unique: true }).catch(() => {});
  await P.createIndex({ projectId: 1, 'variants.itemSku': 1 }).catch(() => {});

  const now = new Date();
  for (let i = 0; i < products.length; i += 500) {
    await P.bulkWrite(products.slice(i, i + 500).map((p: CanonicalProduct) => ({
      updateOne: {
        filter: { projectId: ctx.projectId, parentSku: p.parentSku },
        update: { $set: { ...p, projectId: ctx.projectId, source: 'csv-feed', updatedAt: now } },
        upsert: true,
      },
    })) as any[]);
    await ctx.progress({ 'progress.products': Math.min(i + 500, products.length) });
  }
  await ctx.log(`csv-feed: ${products.length} canonical products persisted`);
  return products.length;
}

/* ─────────────────── stage: merge scraped web layer ─────────────────── */
const boolOf = (v?: string) => (v == null ? undefined : /^true$/i.test(String(v).trim()));
const listOf = (v?: string) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export async function stageMergeWebLayer(ctx: PipelineCtx): Promise<{ merged: number; promoted: number }> {
  const P = ctx.db.collection('products');
  const D = ctx.db.collection('documents');
  const web = await D.find(
    { projectId: ctx.projectId, 'metadata.sku': { $exists: true }, 'metadata.specs': { $exists: true } },
    { projection: { 'metadata.sku': 1, 'metadata.specs': 1, 'metadata.variants': 1, 'metadata.images': 1, 'metadata.price': 1, 'metadata.description': 1, title: 1, sourceUrl: 1 } },
  ).toArray();
  if (!web.length) return { merged: 0, promoted: 0 };

  // Richest record wins per parent SKU (CUT_ prefix = cut/custom variant).
  const best = new Map<string, any>();
  for (const d of web as any[]) {
    const parent = String(d.metadata?.sku || '').replace(/^CUT_/, '');
    if (!parent) continue;
    const score = Object.keys(d.metadata?.specs || {}).length;
    const cur = best.get(parent);
    if (!cur || score > cur._score) best.set(parent, { ...d, _score: score });
  }

  const layerOf = (d: any) => {
    const s = d.metadata?.specs || {};
    const w: Record<string, unknown> = {
      is3D: boolOf(s.is3D), isSublimation2D: boolOf(s.isSublimation2D),
      decorationMethods: listOf(s['Decoration Methods']),
      fabricContent: s['Fabric Content'] || undefined,
      fabricFeatures: s['Fabric Features'] || undefined,
      garmentType: s.garmentType || undefined, itemType: s.ItemType || undefined,
      productType: s.productType || undefined, gender: s.Gender || undefined,
      colorFamily: s.ColorFamily || undefined, collection: s.collection || undefined,
      legacyStyleNumber: s['legacy style number'] || undefined, callout: s.Callout || undefined,
      msrpCAD: s.MSRP_CAD ? parseFloat(s.MSRP_CAD) : undefined,
      productUrl: d.sourceUrl || undefined,
    };
    for (const k of Object.keys(w)) if (w[k] === undefined) delete w[k];
    return w;
  };

  const existing = new Set((await P.find({ projectId: ctx.projectId }, { projection: { parentSku: 1 } }).toArray()).map((p: any) => p.parentSku));
  const mergeOps: any[] = [];
  const promoteOps: any[] = [];
  const now = new Date();

  for (const [parent, d] of best) {
    if (existing.has(parent)) {
      mergeOps.push({ updateOne: { filter: { projectId: ctx.projectId, parentSku: parent }, update: { $set: { web: layerOf(d), webMergedAt: now } } } });
    } else {
      // Web-only product (absent from the feeds) — promote rather than lose it.
      const m = d.metadata || {};
      const price = typeof m.price === 'number' ? m.price : undefined;
      promoteOps.push({ updateOne: {
        filter: { projectId: ctx.projectId, parentSku: parent },
        update: { $set: {
          projectId: ctx.projectId, parentSku: parent, name: d.title || parent,
          description: m.description || undefined,
          images: Array.isArray(m.images) ? m.images : [],
          colors: [], sizes: [], swatchImages: [], sizeChartImages: [], videos: [],
          ...(price != null ? { priceUSD: { min: price, max: price } } : {}),
          variants: Array.isArray(m.variants) ? m.variants.map((v: any) => ({ itemSku: v.sku, color: v.finish })) : [],
          variantCount: Array.isArray(m.variants) ? m.variants.length : 0,
          web: layerOf(d), source: 'web-scrape', updatedAt: now,
        } },
        upsert: true,
      } });
    }
  }
  for (let i = 0; i < mergeOps.length; i += 500) await P.bulkWrite(mergeOps.slice(i, i + 500));
  for (let i = 0; i < promoteOps.length; i += 500) await P.bulkWrite(promoteOps.slice(i, i + 500));
  await ctx.log(`merge: ${mergeOps.length} enriched, ${promoteOps.length} web-only promoted`);
  return { merged: mergeOps.length, promoted: promoteOps.length };
}

/* ───────────────────────── stage: narratives ───────────────────────── */
const SYSTEM = `You write product knowledge for a teamwear sales expert's reference library.
Given structured facts about ONE garment, write 90–150 words of natural, specific prose that a knowledgeable
outfitter would say when recommending it.

Rules:
- Use ONLY the facts given. Never invent prices, SKUs, fabrics, sizes or claims.
- Lead with what it is and who it suits (sport, level, team role).
- Weave in fabric/performance, decoration options, colour range and sizing where given.
- Mention custom sublimation or 3D design only if stated.
- Plain confident prose. No marketing hype, no bullet lists, no headings, no emoji.
- Do not restate the raw field labels.`;

function brief(p: any): string {
  const L: string[] = [`Name: ${p.name}`, `Style/SKU: ${p.parentSku}`];
  const add = (k: string, v: unknown) => { if (v) L.push(`${k}: ${v}`); };
  add('Category', p.category); add('Garment type', p.web?.garmentType); add('Fit/gender', p.web?.gender);
  add('Description', p.description && String(p.description).slice(0, 700));
  add('Features', p.features && String(p.features).slice(0, 500));
  add('Fabric', p.web?.fabricContent); add('Fabric features', p.web?.fabricFeatures && String(p.web.fabricFeatures).slice(0, 300));
  add('Decoration methods', p.web?.decorationMethods?.join(', '));
  if (p.web?.is3D) L.push('Has 3D configurator: yes');
  if (p.isSublimation) L.push('Custom sublimation product: yes');
  add('Collection', p.web?.collection);
  if (p.colors?.length) L.push(`Colours (${p.colors.length}): ${p.colors.slice(0, 18).map((c: any) => c.name).join(', ')}`);
  if (p.sizes?.length) L.push(`Sizes: ${p.sizes.slice(0, 20).join(', ')}`);
  if (p.priceUSD) L.push(`Price USD: ${p.priceUSD.min}${p.priceUSD.max !== p.priceUSD.min ? `–${p.priceUSD.max}` : ''}`);
  if (p.priceCAD) L.push(`Price CAD: ${p.priceCAD.min}${p.priceCAD.max !== p.priceCAD.min ? `–${p.priceCAD.max}` : ''}`);
  add('In stock', p.totalStock && `${p.totalStock} units`);
  add('Variants', p.variantCount); add('Origin', p.countryOfOrigin);
  return L.join('\n');
}

export async function stageNarratives(ctx: PipelineCtx, opts: { force?: boolean; limit?: number } = {}): Promise<number> {
  const P = ctx.db.collection('products');
  const D = ctx.db.collection('documents');
  const filter: any = { projectId: ctx.projectId };
  if (!opts.force) filter.narrativeAt = { $exists: false };
  const products = await P.find(filter).limit(opts.limit ?? 0).toArray();
  if (!products.length) return 0;

  const openai = new OpenAI();
  const model = ctx.ingestModel;
  // GPT-5/o-series bill REASONING against max_completion_tokens; a small budget
  // returns an empty string. This is mechanical prose — disable reasoning.
  const isReasoning = /^(gpt-5|o[134])/.test(model);
  await ctx.log(`narratives: ${products.length} product(s) with model=${model}`);

  let done = 0;
  const CONC = 6;
  for (let i = 0; i < products.length; i += CONC) {
    const batch = products.slice(i, i + CONC);
    const texts = await Promise.all(batch.map(async (p: any) => {
      try {
        const r = await openai.chat.completions.create({
          model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: brief(p) }],
          max_completion_tokens: 600,
          ...(isReasoning ? { reasoning_effort: 'minimal' as any } : { temperature: 0.4 }),
        });
        return (r.choices[0]?.message?.content || '').trim();
      } catch { return ''; }
    }));

    const ok = batch.map((p, j) => ({ p, text: texts[j] })).filter((x) => x.text.length > 40);
    if (!ok.length) continue;
    const emb = await embedTexts(ok.map((x) => x.text));
    const now = new Date();
    await D.bulkWrite(ok.map((x, j) => {
      const p: any = x.p;
      // p.web?.productUrl is set by apparel PDP scrapes; p.url is the additive
      // field the PlaceMakers field-backfill writes directly from the source
      // export (no PDP scrape needed — the real URL was already in the feed).
      // Falls back to the synthetic placeholder only when neither is present.
      const url = p.web?.productUrl || p.url || `product://${ctx.projectId}/${p.parentSku}`;
      return { updateOne: {
        filter: { projectId: ctx.projectId, sourceUrl: url, chunkIndex: 0 },
        update: { $set: {
          projectId: ctx.projectId, brand: ctx.projectId, sourceUrl: url,
          title: p.name, content: x.text, chunk: x.text, chunkIndex: 0,
          metadata: {
            type: 'product', brand: ctx.projectId, url, sku: p.parentSku,
            ...(p.priceUSD ? { price: p.priceUSD.min, currency: 'USD' } : {}),
            ...(p.category ? { category: p.category } : {}),
            ...(p.categoryPath?.length ? { categoryPath: p.categoryPath } : {}),
            ...(p.stock ? { stock: p.stock } : {}),
            ...(p.images?.length ? { images: p.images.slice(0, 12) } : {}),
            ...(p.colors?.length ? { colors: p.colors.slice(0, 24) } : {}),
            ...(p.sizes?.length ? { sizes: p.sizes } : {}),
            ...(p.web?.decorationMethods ? { decorationMethods: p.web.decorationMethods } : {}),
            ...(p.web?.is3D ? { is3D: true } : {}),
            variantCount: p.variantCount,
          },
          embedding: emb[j], crawledAt: now, updatedAt: now,
        } }, upsert: true } };
    }) as any[]);
    await P.bulkWrite(ok.map((x: any) => ({ updateOne: {
      filter: { projectId: ctx.projectId, parentSku: x.p.parentSku },
      update: { $set: { narrative: x.text, narrativeAt: new Date() } },
    } })) as any[]);
    done += ok.length;
    if (done % 60 === 0) await ctx.progress({ 'progress.narratives': done });
  }
  await ctx.log(`narratives: ${done} generated + embedded`);
  return done;
}

/* ─────────────────────────── stage: pdf ─────────────────────────── */
const cleanPdf = (s: string) => s.replace(/\f/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

function chunkText(text: string, max = 1200): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > max && cur) { out.push(cur); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.length > 80);
}

/** Ingest every configured `pdf` source (downloading into the artifact store). */
export async function stagePdfs(ctx: PipelineCtx): Promise<number> {
  const pdfs = ctx.sources.filter((s) => s.type === 'pdf' && enabled(s) && s.url);
  if (!pdfs.length) return 0;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require('pdf-parse');
  const { readFileSync, mkdirSync, existsSync, statSync, createWriteStream } = await import('fs');
  const { Readable } = await import('stream');
  const { pipeline: streamPipe } = await import('stream/promises');

  const dir = path.join(ctx.storageDir, 'catalogs');
  mkdirSync(dir, { recursive: true });
  const D = ctx.db.collection('documents');
  let total = 0;

  for (const src of pdfs) {
    const file = path.join(dir, path.basename(new URL(src.url!).pathname));
    try {
      if (!existsSync(file) || statSync(file).size < 1024) {
        const res = await fetch(src.url!, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await streamPipe(Readable.fromWeb(res.body as any), createWriteStream(file));
      }
      const title = src.label || path.basename(file, '.pdf').replace(/[-_]/g, ' ');
      const parser = new PDFParse({ data: readFileSync(file) });
      const info = await parser.getInfo().catch(() => ({} as any));
      const pageCount: number = info?.total ?? info?.numpages ?? 0;

      // Extract in bounded PAGE WINDOWS. A 950MB/640pp catalogue would blow the
      // heap in one pass; `partial` lets us pull a slice at a time, embed it and
      // move on, so memory stays flat regardless of document size.
      const WINDOW = 25;
      let chunkIndex = 0;
      let docChunks = 0;
      const now = new Date();

      const windows: number[][] = [];
      if (pageCount > 0) {
        for (let p = 1; p <= pageCount; p += WINDOW) {
          windows.push(Array.from({ length: Math.min(WINDOW, pageCount - p + 1) }, (_, k) => p + k));
        }
      } else {
        windows.push([]); // unknown page count → single full pass
      }

      for (const win of windows) {
        const r = win.length ? await parser.getText({ partial: win }) : await parser.getText();
        const pages: string[] = (r.pages?.map((p: any) => String(p.text || '')) ?? [String(r.text || '')]).map(cleanPdf);

        const chunks: { text: string; page: number }[] = [];
        pages.forEach((pg, i) => chunkText(pg).forEach((c) => chunks.push({ text: c, page: win.length ? win[i] : i + 1 })));
        if (!chunks.length) continue;

        for (let i = 0; i < chunks.length; i += 64) {
          const slice = chunks.slice(i, i + 64);
          const texts = slice.map((c) => `${title} — page ${c.page}\n\n${c.text}`);
          const emb = await embedTexts(texts);
          const base = chunkIndex;
          await D.bulkWrite(texts.map((txt, j) => ({ updateOne: {
            filter: { projectId: ctx.projectId, sourceUrl: src.url, chunkIndex: base + j },
            update: { $set: {
              projectId: ctx.projectId, brand: ctx.projectId, sourceUrl: src.url,
              title, content: txt, chunk: txt, chunkIndex: base + j,
              metadata: { type: src.docType || 'design', brand: ctx.projectId, url: src.url, documentTitle: title, page: slice[j].page, format: 'pdf' },
              embedding: emb[j], crawledAt: now, updatedAt: now,
            } }, upsert: true } })) as any[]);
          chunkIndex += texts.length;
          docChunks += texts.length;
        }
        if (windows.length > 4) await ctx.progress({ 'progress.pdfChunks': total + docChunks });
      }
      await parser.destroy?.();

      if (!docChunks) { await ctx.log(`  - ${title}: no extractable text (image-only)`); continue; }
      total += docChunks;
      await ctx.log(`  ok ${title} — ${pageCount || '?'}p -> ${docChunks} chunk(s) [${src.docType || 'design'}]`);
    } catch (e) {
      await ctx.log(`  fail ${src.label || src.url}: ${(e as Error).message.slice(0, 70)}`);
    }
  }
  return total;
}

/* ──────────────── stage: kb-articles (help centre) ──────────────── */
export async function stageKbArticles(ctx: PipelineCtx): Promise<number> {
  const srcs = ctx.sources.filter((s) => s.type === 'kb-articles' && enabled(s) && (s.sitemapUrl || s.url));
  if (!srcs.length) return 0;
  const { chromium } = await import('playwright');
  const { extractPage, composeContent } = await import('./extractor');

  const D = ctx.db.collection('documents');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { (globalThis as any).__name = (fn: unknown) => fn; });
  let total = 0;

  try {
    for (const src of srcs) {
      const smUrl = src.sitemapUrl || src.url!;
      let urls: string[] = [];
      try {
        const xml = await (await fetch(smUrl)).text();
        urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      } catch (e) { await ctx.log(`  fail sitemap ${smUrl}: ${(e as Error).message.slice(0, 60)}`); continue; }
      if (src.urlIncludes) urls = urls.filter((u) => u.includes(src.urlIncludes!));
      if (src.urlExcludes) urls = urls.filter((u) => !u.includes(src.urlExcludes!));
      urls = urls.slice(0, src.maxPages ?? 200);
      await ctx.log(`kb-articles: ${urls.length} article(s) from ${src.label || smUrl}`);

      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1200);
          const x = await extractPage(page, url);
          if ((x.bodyText || '').length < 200) continue;
          const chunks = chunkText(composeContent(x), 1400);
          if (!chunks.length) continue;
          const emb = await embedTexts(chunks);
          const now = new Date();
          await D.bulkWrite(chunks.map((c, j) => ({ updateOne: {
            filter: { projectId: ctx.projectId, sourceUrl: url, chunkIndex: j },
            update: { $set: {
              projectId: ctx.projectId, brand: ctx.projectId, sourceUrl: url,
              title: x.title, content: c, chunk: c, chunkIndex: j,
              metadata: { type: src.docType || 'faq', brand: ctx.projectId, url, documentTitle: x.title },
              embedding: emb[j], crawledAt: now, updatedAt: now,
            } }, upsert: true } })) as any[]);
          total += chunks.length;
          if (total % 40 === 0) await ctx.progress({ 'progress.articleChunks': total });
        } catch { /* skip unreachable page */ }
      }
    }
  } finally { await browser.close(); }
  await ctx.log(`kb-articles: ${total} chunk(s) embedded`);
  return total;
}

/* ─────────── stage: design knowledge — vectorised (AUG-43) ───────────
 * Make the captured designs RETRIEVABLE.
 *
 * The decoration and visual stages write onto the product document, which the
 * agent can only reach when it already knows the SKU. That is the wrong way
 * round for the journey this platform exists to serve: a customer says "we want
 * something bold with a stripe across the chest" and the agent has to FIND
 * candidates. Facts on a product record cannot answer that; an embedded
 * description can.
 *
 * So each design line becomes one document in the vector store, written in the
 * words a customer would use — the measured character ("28% band across the mid
 * garment", "bold — accents dominate") alongside the sport, garment type and
 * the colours it can actually take. Tagged with projectId, so tenant isolation
 * holds, and with the sku + design line so a hit maps straight back to
 * something orderable.
 */
export async function stageDesignKnowledge(ctx: PipelineCtx, opts: { limit?: number; force?: boolean } = {}): Promise<number> {
  const P = ctx.db.collection('products');
  const D = ctx.db.collection('documents');

  /* Resumable. Embedding 7,000+ documents takes many minutes and the first
   * attempt died mid-run on a server-side interrupt after 1,000. Writes are
   * upserts keyed on (projectId, docType, sku, designLine), so re-running is
   * idempotent — but re-embedding what is already embedded costs real money and
   * time, so styles already covered are skipped unless explicitly redone. */
  /* Skip only what is genuinely finished.
   *
   * "Already embedded" is not the same as "up to date": a style embedded BEFORE
   * its visual reading existed carries structure but no appearance description,
   * which is the half that makes a design findable by how it looks. Re-embedding
   * everything to fix those would pay the embedding cost for thousands of
   * documents that are already complete, so only styles whose documents are
   * missing an appearance they could now have are redone. */
  let doneSkus: string[] = [];
  if (!opts.force) {
    const embedded: string[] = await D.distinct('sku', { projectId: ctx.projectId, docType: 'design' });
    const stale = new Set<string>(
      await D.distinct('sku', {
        projectId: ctx.projectId, docType: 'design',
        $or: [{ character: { $exists: false } }, { 'character.0': { $exists: false } }],
      }),
    );
    // A stale style is only worth redoing if a visual reading now exists for it.
    const readable = new Set<string>(
      await P.distinct('parentSku', { projectId: ctx.projectId, designVisualsAt: { $exists: true } }),
    );
    doneSkus = embedded.filter((sku) => !(stale.has(sku) && readable.has(sku)));
    const redo = embedded.length - doneSkus.length;
    if (redo) await ctx.log(`design-knowledge: ${redo} style(s) embedded without an appearance now have one — re-embedding those`);
  }

  const styles = await P.find(
    { projectId: ctx.projectId, 'decoration.designLines.0': { $exists: true },
      ...(doneSkus.length ? { parentSku: { $nin: doneSkus } } : {}) },
    { projection: { parentSku: 1, name: 1, category: 1, decoration: 1, designVisuals: 1, priceUSD: 1, leadTimeDays: 1 } },
  ).limit(opts.limit ?? 0).toArray();
  if (doneSkus.length) await ctx.log(`design-knowledge: resuming — ${doneSkus.length} style(s) already embedded, skipping`);
  if (!styles.length) { await ctx.log('design-knowledge: nothing left to embed'); return 0; }

  const palette: any = await ctx.db.collection('brand_palettes').findOne({ projectId: ctx.projectId });
  const colourNames: string[] = (palette?.colours || []).map((c: any) => c.display).filter(Boolean);

  await ctx.log(`design-knowledge: building documents for ${styles.length} style(s)`);

  let written = 0, withVisuals = 0;
  const BATCH = 64;                    // embedding calls are the cost here
  let pending: { doc: any; text: string }[] = [];

  const flush = async () => {
    if (!pending.length) return;
    const emb = await withRetry(() => embedTexts(pending.map((p) => p.text)),
      (m) => ctx.log(`design-knowledge: embed retry — ${m}`));
    const ops = pending.map((p, i) => ({
      updateOne: {
        filter: { projectId: ctx.projectId, docType: 'design', sku: p.doc.sku, designLine: p.doc.designLine },
        update: { $set: { ...p.doc, chunk: p.text, content: p.text, embedding: emb[i], updatedAt: new Date() } },
        upsert: true,
      },
    }));
    await withRetry(() => D.bulkWrite(ops, { ordered: false }),
      (m) => ctx.log(`design-knowledge: write retry — ${m}`));
    written += pending.length;
    pending = [];
  };

  for (const s of styles as any[]) {
    const dec = s.decoration;
    const visuals = new Map<string, any>((s.designVisuals || []).map((v: any) => [v.designLine, v]));
    if (visuals.size) withVisuals++;
    // "Adult | BASKETBALL | TOP" → the sport, which is how customers ask.
    const sport = String(s.category || '').split('|').map((x: string) => x.trim())[1] || '';

    for (const dl of dec.designLines || []) {
      const v = visuals.get(dl.designLine);
      const zones = (dl.zones || []).length;
      const lettering = (dl.textSlots || []).length
        ? `Can be printed with team name and numbers (${dl.textSlots.length} lettering positions).`
        : 'No lettering positions on this piece.';

      /* Written as prose, not a field dump: this text is what gets embedded, so
       * it has to read like the question a customer would ask. */
      const text = [
        `${dl.designLine} design on the ${s.name}.`,
        sport ? `Sport: ${sport}.` : '',
        `${dec.gender || 'Adult'} ${(dec.garmentType || 'garment').toLowerCase()}.`,
        `${zones} colour zone${zones === 1 ? '' : 's'} that can be set to the team's colours.`,
        v?.character?.length ? `Appearance: ${v.character.join('; ')}.` : '',
        lettering,
        dl.price ? `Priced from $${dl.price}.` : '',
        s.leadTimeDays ? `Made to order — about ${s.leadTimeDays} business days for production.` : '',
        colourNames.length ? `Available colours include ${colourNames.slice(0, 12).join(', ')}.` : '',
      ].filter(Boolean).join(' ');

      pending.push({
        text,
        doc: {
          projectId: ctx.projectId, docType: 'design',
          sku: s.parentSku, designLine: dl.designLine, designLineSlug: dl.slug,
          title: `${dl.designLine} — ${s.name}`,
          garmentType: dec.garmentType, gender: dec.gender, productType: dec.productType,
          sport: sport || undefined,
          zoneCount: zones, textSlots: (dl.textSlots || []).map((t: any) => t.slot),
          price: dl.price, thumbnail: dl.thumbnail,
          // Measured, so a "bold" query can be ranked against something real.
          character: v?.character || [],
          coverage: (v?.zones || []).map((z: any) => ({ zone: z.zone, coverage: z.coverage })),
          partialMeasurement: v?.partialMeasurement || undefined,
        },
      });
      if (pending.length >= BATCH) await flush();
    }
    await ctx.progress({ 'progress.designKnowledge': written });
  }
  await flush();

  await ctx.log(`design-knowledge: DONE — ${written} design documents embedded (${withVisuals} styles had visual readings)`);
  if (withVisuals < styles.length) {
    await ctx.log(`design-knowledge: NOTE — ${styles.length - withVisuals} style(s) have no visual reading yet; `
      + 'their documents carry structure but no appearance description');
  }
  return written;
}

/* ──────────────── stage: design visuals (AUG-42) ────────────────
 * Render every design line and read what it actually looks like.
 *
 * The catalogue cannot distinguish "Hardwood Pinstripe" from "Mardi Gras" —
 * both are a body colour and some accents. The renders can: one is thin
 * pinstripes spread over the garment, the other is thick bands across the
 * chest. Without this an agent recommending a design is guessing from a name.
 *
 * Every zone the catalogue reports is filled with a DIFFERENT probe colour, so
 * each can be measured separately: how much it covers, where it sits, whether
 * it is a band or a scatter. Probe colours are calibrated by rendering them
 * first, because the imaging host applies its own lighting and the palette
 * gives names, not RGB.
 */
export async function stageDesignVisuals(ctx: PipelineCtx, opts: { limit?: number; maxPerStyle?: number; force?: boolean } = {}): Promise<number> {
  const src = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  const host = src?.imagingHost;
  /* Fallback only. The id pattern is resolved PER STYLE (308 use
   * preview-prod-{style}-l, 106 use preview-{style}_front), so a single
   * configured pattern would render a third of the catalogue wrongly. */
  const pattern = src?.texturePattern;
  if (!host || !pattern) {
    await ctx.log('design-visuals: source needs imagingHost + texturePattern — skipping');
    return 0;
  }
  const P = ctx.db.collection('products');

  /* Resumable. This walks 7,000+ renders against someone else's imaging host
   * over ~20 minutes, and the first attempt died on a transient Atlas error
   * after 11 styles. Restarting from zero would re-fetch thousands of images
   * that were already read, so styles already captured are skipped unless the
   * caller explicitly asks to redo them. */
  const query: Record<string, unknown> = {
    projectId: ctx.projectId, 'decoration.designLines.0': { $exists: true },
    /* Only styles the imaging host can actually draw. 263 sublimated styles
     * resolved to no texture at all — rendering them produces nothing to read
     * and is pure load on someone else's server. */
    renderPattern: { $nin: [null, false] },
  };
  if (!opts.force) query.designVisualsAt = { $exists: false };

  const styles = await P.find(query, { projection: { parentSku: 1, decoration: 1, renderPattern: 1 } })
    .limit(opts.limit ?? 0).toArray();
  const already = await P.countDocuments({
    projectId: ctx.projectId, 'decoration.designLines.0': { $exists: true }, designVisualsAt: { $exists: true },
  });
  if (already) await ctx.log(`design-visuals: resuming — ${already} style(s) already captured, skipping`);
  if (!styles.length) { await ctx.log('design-visuals: no captured decoration — run the decoration stage first'); return 0; }

  /* Probe colours: saturated and far apart in hue, so a mis-read cannot be a
   * near-miss. White is deliberately excluded — it collides with the render
   * background and would be discarded as neutral along with it. */
  /* Probe colours are CHOSEN FROM MEASURED HUE, not by name.
   *
   * Picking ten names that sounded different gave eight clashing pairs — "Gold"
   * and "Laser Yellow" are the same hue to a camera, and two zones sharing a
   * hue means one zone's pixels are credited to the other. So a broad set is
   * calibrated first and then thinned greedily by actual measured separation. */
  const candidates = src.probeColours?.length ? src.probeColours
    : (await ctx.db.collection('brand_palettes').findOne({ projectId: ctx.projectId }))
        ?.colours?.map((c: any) => c.render) || [];
  if (!candidates.length) { await ctx.log('design-visuals: no palette to draw probes from'); return 0; }

  /* Calibration needs ONE style that renders. Hanging it on a single pick made
   * the whole stage abort the moment that style happened not to render — which
   * is exactly what a resumed run does, since skipping completed styles changes
   * which one comes first. Several candidates are tried before giving up. */
  const seeds = styles
    .filter((s: any) => (s.decoration.designLines[0]?.zones || []).length >= 2)
    .slice(0, 6);
  if (!seeds.length) seeds.push(styles[0]);

  let measured: any[] = [];
  let usedSeed = '';
  for (const seed of seeds as any[]) {
    const seedPattern = seed.renderPattern || pattern;
    const seedZones = [...new Set(seed.decoration.designLines.flatMap((d: any) => d.zones.map((z: any) => z.zone)))] as string[];
    /* Try the design lines with the MOST zones first: a line that paints a lot
     * of the garment gives the calibrator plenty of pixels to average, and some
     * lines simply do not toggle. Using only designLines[0] made calibration
     * depend on whichever line happened to be listed first. */
    const lines = [...seed.decoration.designLines].sort((a: any, b: any) => b.zones.length - a.zones.length).slice(0, 3);
    for (const line of lines) {
      const got: any[] = [];
      for (const n of candidates.slice(0, 40)) {
        const pc = await calibrateProbe(host, seedPattern, seed.parentSku, line.slug, seedZones, n);
        if (pc && (pc.hsv?.s ?? 0) > 0.25) got.push(pc);   // grey has no usable hue
      }
      if (got.length >= 3) { measured = got; usedSeed = `${seed.parentSku}/${line.designLine}`; break; }
    }
    if (measured.length) break;
    await ctx.log(`design-visuals: seed ${seed.parentSku} yielded nothing on ${lines.length} design line(s) — trying another`);
  }
  if (!measured.length) { await ctx.log('design-visuals: no seed style rendered — cannot calibrate, aborting'); return 0; }
  await ctx.log(`design-visuals: calibrated ${measured.length} saturated candidate colours from seed ${usedSeed}`);

  const MIN_SEP = 30;   // degrees — below this the analyser cannot tell them apart
  const probePool: any[] = [];
  for (const c of measured.sort((a, b) => (b.hsv?.s ?? 0) - (a.hsv?.s ?? 0))) {
    const far = probePool.every((p) => {
      const d = Math.abs((c.hsv?.h ?? 0) - (p.hsv?.h ?? 0)) % 360;
      return Math.min(d, 360 - d) >= MIN_SEP;
    });
    if (far) probePool.push(c);
  }
  if (probePool.length < 2) { await ctx.log('design-visuals: too few separable probe colours — aborting'); return 0; }
  await ctx.log(`design-visuals: ${probePool.length} separable probes (>=${MIN_SEP}deg apart): `
    + probePool.map((p) => `${p.render}@${Math.round(p.hsv.h)}deg`).join(', '));
  await ctx.log('design-visuals: designs with more zones than probes are recorded as PARTIAL');

  const total = styles.reduce((n: number, s: any) => n + Math.min(s.decoration.designLines.length, opts.maxPerStyle ?? Infinity), 0);
  await ctx.log(`design-visuals: ${styles.length} styles · ${total} design renders to read`);

  let done = 0, captured = 0, failed = 0, flagged = 0, unreadable = 0;
  const CONC = 5;   // gentle — this is someone else's imaging host

  for (const s of styles as any[]) {
    const lines = (s.decoration.designLines || []).slice(0, opts.maxPerStyle ?? Infinity);
    const visuals: any[] = [];
    const unavailable: string[] = [];   // design lines this style cannot render

    for (let i = 0; i < lines.length; i += CONC) {
      await Promise.all(lines.slice(i, i + CONC).map(async (dl: any) => {
        // ALWAYS probe every zone the catalogue reports — a partial probe
        // measures a garment nobody would order.
        const probes = dl.zones.map((z: any, k: number) => ({ zone: z.zone, colour: probePool[k % probePool.length] }));
        if (!probes.length) return;
        const got = await fetchPng(buildProbeUrl(host, s.renderPattern || pattern, s.parentSku, dl.slug, probes, 600));
        done++;
        if (!got) { failed++; return; }
        const a = analyse(got.png, probes);
        /* An unfilled render is not a fault in the product and not a broken
         * template — it means the catalogue lists a design line the style's
         * atlas does not implement. Proven by same-style pairs: on 228103
         * "PHILLY" renders nothing while "VEGAS" paints, from the identical
         * template. Every style with a blank design also had a working one
         * (10 of 10), so the style is fine and the LINE is not offered.
         *
         * Recorded rather than discarded: a design line that cannot render is
         * one the agent must never put in front of a customer. */
        if ((a as any).unreadable) {
          unreadable++;
          unavailable.push(dl.designLine);
          return;
        }
        // More zones than probes means colours repeat and two zones become
        // indistinguishable. Recorded, never silently averaged.
        const partial = dl.zones.length > probePool.length;
        if (a.unsetZones.length || a.invisibleZones.length) flagged++;
        visuals.push({
          designLine: dl.designLine, slug: dl.slug,
          zonesExpected: dl.zones.length, zonesSeen: a.zonesSeen,
          zones: a.zones, unsetZones: a.unsetZones, invisibleZones: a.invisibleZones,
          character: partial ? [...a.character, `PARTIAL: ${dl.zones.length} zones vs ${probePool.length} probes`] : a.character,
          partialMeasurement: partial || undefined,
          imageBytes: got.bytes,
        });
      }));
    }

    if (visuals.length) {
      // The renders are the expensive part; a transient write failure must not
      // throw them away or abort the whole pass.
      let saved = false;
      for (let attempt = 0; attempt < 4 && !saved; attempt++) {
        try {
          await P.updateOne({ _id: s._id }, { $set: {
            designVisuals: visuals,
            // Empty array is meaningful: "checked, all lines render".
            unavailableDesignLines: unavailable,
            designVisualsAt: new Date(),
          } });
          saved = true;
        } catch (e) {
          if (attempt === 3) { await ctx.log(`design-visuals: ${s.parentSku} SAVE FAILED — ${(e as Error).message}`); break; }
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      if (!saved) { failed++; continue; }
      captured += visuals.length;
      const odd = visuals.filter((v) => v.unsetZones.length || v.invisibleZones.length).length;
      await ctx.log(`design-visuals: ${s.parentSku} ${visuals.length}/${lines.length} read`
        + (odd ? ` · ${odd} with unset zones` : '')
        + (unavailable.length ? ` · ${unavailable.length} design line(s) NOT on this style` : '')
        + ` · e.g. ${visuals[0].designLine}: ${visuals[0].character.slice(0, 2).join(', ')}`);
    }
    await ctx.progress({ 'progress.designVisuals': done });
  }

  await ctx.log(`design-visuals: DONE — ${captured} designs read, ${failed} render failures, `
    + `${unreadable} unreadable (template returned an unfilled garment), ${flagged} with unset zones`);
  return captured;
}

/* ────────────────────── stage: decoration (AUG-30) ──────────────────────
 * What each style can actually be DESIGNED with: the brand's colour palettes,
 * the design lines, the colour zones those lines paint, and where lettering
 * prints. Every one of these was previously hardcoded or hand-typed, and every
 * one was wrong in a way a customer saw.
 *
 * Runs only over styles that can be decorated at all, so it does not hammer the
 * brand's host asking about garments that are not made to order.
 */
export async function stageDecoration(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const src = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  if (!src?.url || !src.storeId) {
    await ctx.log('decoration: no enabled websphere-rest source configured — skipping');
    return 0;
  }
  const base = src.url.replace(/\/$/, '');
  const utility = `${base}/wcs/resources/store/${src.storeId}/utilityservices`;
  const search = `${base}/search/resources/store/${src.storeId}/productview`;
  const P = ctx.db.collection('products');

  /* 1 ── palettes. Indexed by ID across every collection, because the
   *      collections do not share a naming convention (RussellColors is
   *      "RA STEALTH", SublimationColors is plain "NAVY") and a style's
   *      catalogue entry cites an id, not a name. */
  const collections = src.colourCollections?.length ? src.colourCollections : [];
  if (!collections.length) {
    await ctx.log('decoration: no colourCollections configured on the source — cannot resolve colours');
    return 0;
  }
  const palette = await fetchPalettes(search, collections, (m) => { void ctx.log(`decoration: ${m}`); });
  if (!palette.size) { await ctx.log('decoration: no colours resolved — aborting rather than writing blanks'); return 0; }

  // Persist the palette itself: this is what replaces the hand-typed colour list.
  await ctx.db.collection('brand_palettes').updateOne(
    { projectId: ctx.projectId },
    { $set: { projectId: ctx.projectId, collections,
              colours: [...palette.values()], count: palette.size, updatedAt: new Date() } },
    { upsert: true },
  );
  await ctx.log(`decoration: ${palette.size} colours stored across ${collections.length} collection(s)`);

  /* 2 ── garment types. Top vs bottom decides the zone namespace, and the
   *      platform states it — it must never be inferred from a product name. */
  const attrs = await fetchGarmentAttributes(utility);
  await ctx.log(`decoration: garment attributes for ${attrs.size} style key(s)`);

  /* 3 ── per style. Only decoratable ones. */
  const candidates = await P.find(
    { projectId: ctx.projectId, isSublimation: true },
    { projection: { parentSku: 1 } },
  ).limit(opts.limit ?? 0).toArray();
  await ctx.log(`decoration: ${candidates.length} sublimated style(s) to capture`);

  let done = 0, captured = 0, empty = 0, tops = 0, bottoms = 0, withText = 0;
  const unresolved = new Map<string, number>();
  const CONC = 4;   // deliberately gentle — this is someone else's storefront

  for (let i = 0; i < candidates.length; i += CONC) {
    await Promise.all(candidates.slice(i, i + CONC).map(async (p: any) => {
      const style = String(p.parentSku || '');
      if (!style) return;
      const cap = await captureStyle(utility, style, palette, attrs);
      done++;
      if (!cap) { empty++; return; }

      for (const u of cap.unresolvedColours) unresolved.set(u, (unresolved.get(u) || 0) + 1);
      if (cap.garmentType === 'Top') tops++;
      else if (cap.garmentType === 'Bottom') bottoms++;
      if (cap.textSlots.length) withText++;

      await P.updateOne({ _id: p._id }, { $set: {
        decoration: cap,
        // Mirror into the shape the render path already reads, so design lines
        // and their zones come from this capture rather than a live re-fetch.
        designLines: Object.fromEntries(cap.designLines.map((d) => [d.slug, {
          label: d.designLine, zones: d.zones.map((z) => z.zone),
        }])),
        designLinesAt: new Date(),
        decorationAt: new Date(),
      } });
      captured++;

      await ctx.log(
        `decoration: ${style} [${cap.garmentType || '?'}/${cap.productType || '?'}] `
        + `${cap.designLines.length} design lines · ${cap.zoneNamespace || 'no zones'} · `
        + `text[${cap.textSlots.join(',') || 'none'}]`
        + (cap.unresolvedColours.length ? ` · ${cap.unresolvedColours.length} UNRESOLVED colours` : ''),
      );
    }));
    if (done % 40 === 0 || done >= candidates.length) {
      await ctx.progress({ 'progress.decoration': done });
    }
  }

  await ctx.log(`decoration: DONE — ${captured} captured (${tops} tops, ${bottoms} bottoms, ${withText} with lettering), ${empty} with no design data`);
  if (unresolved.size) {
    /* Loud on purpose. An unresolved id means a colour collection we have not
     * ingested — the exact failure that let fourteen hand-typed names stand in
     * for eighty real ones. Silence here would repeat it. */
    const top = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    await ctx.log(`decoration: WARNING — ${unresolved.size} unresolved colour id(s); a palette collection is missing:`);
    for (const [k, n] of top) await ctx.log(`decoration:   ${k} (${n} occurrences)`);
  } else {
    await ctx.log('decoration: every colour resolved against the ingested palettes');
  }
  return captured;
}

/* ────────────── stage: option space (configurable choices) ──────────────
 * What can a customer actually CHOOSE on a product — colours (with swatch art),
 * sizes, and the fixed characteristics that constrain the choice. The source
 * platform already models this precisely, so it is fetched as fact rather than
 * inferred: no LLM, no guessing at a configurator's UI.
 *
 * Runs against the platform ids already stored on canonical products, so it
 * enriches the FACT layer in place rather than creating a parallel catalogue.
 *
 * A second pass then derives the option space of anything the platform did not
 * answer for, from the product's own variant rows (AUG-41) — see
 * `deriveOptionSpace`. Made-to-order styles are systematically absent from the
 * platform's attribute model, so without this pass the catalogue's custom
 * products are the ones a customer cannot configure.
 */
export async function stageOptionSpace(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const src = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  if (!src?.url || !src.storeId || !src.catalogId) {
    await ctx.log('option-space: no enabled websphere-rest source configured — deriving from variants only');
    return (await garmentTypePass(ctx, opts)) + (await derivedOptionSpacePass(ctx, opts));
  }
  const cfg = { base: src.url.replace(/\/$/, ''), storeId: String(src.storeId), catalogId: String(src.catalogId), currency: src.currency };
  const P = ctx.db.collection('products');

  const products = await P.find(
    { projectId: ctx.projectId, 'web.productUrl': /productId=/ },
    { projection: { parentSku: 1, 'web.productUrl': 1 } },
  ).limit(opts.limit ?? 0).toArray();
  if (!products.length) { await ctx.log('option-space: no products carry a platform id — run the merge stage first'); return 0; }

  await ctx.log(`option-space: ${products.length} product(s) to enrich from ${cfg.base}`);

  let done = 0, enriched = 0, failed = 0;
  const CONC = 4;   // deliberately gentle — this is someone else's storefront
  for (let i = 0; i < products.length; i += CONC) {
    await Promise.all(products.slice(i, i + CONC).map(async (p: any) => {
      const id = /productId=(\d+)/.exec(String(p.web?.productUrl || ''))?.[1];
      if (!id) return;
      const space = await fetchOptionSpace(cfg, id);
      if (!space) { failed++; return; }
      const hasContent = Object.keys(space.defining).length || Object.keys(space.descriptive).length
        || space.merchandising.length || space.angleImages.length;
      if (!hasContent) return;
      await P.updateOne({ _id: p._id }, { $set: { optionSpace: space, optionSpaceAt: new Date() } });
      enriched++;
    }));
    done += Math.min(CONC, products.length - i);
    if (done % 100 === 0 || done >= products.length) {
      await ctx.log(`option-space: ${done}/${products.length} · ${enriched} enriched · ${failed} unavailable`);
      await ctx.progress({ 'progress.optionSpace': done });
    }
  }

  await ctx.log(`option-space: DONE — ${enriched} product(s) enriched, ${failed} unavailable from the source platform`);
  return enriched + (await garmentTypePass(ctx, opts)) + (await derivedOptionSpacePass(ctx, opts));
}

/**
 * Fill the option space of products the platform did not answer for, from their
 * own variant rows (AUG-41).
 *
 * Only ever writes where there is nothing already: a platform-sourced option
 * space is authoritative and is never overwritten by a derived one. The source
 * is recorded on the document so a reader — or a back-office operator looking at
 * why a style offers what it offers — can tell the two apart.
 */
/**
 * Fill the garment type wherever the platform did not state one.
 *
 * Deliberately a pass of its own rather than a step inside the choices
 * derivation: those two questions are independent, and conflating them hid a
 * whole product category. The choices pass only looks at products whose option
 * space is EMPTY, but headwear already carries platform attributes — so caps
 * had choices and no garment type, and a derivation living inside that pass
 * never saw a single one of them. The rack groups on garment type, so the
 * effect was that 110 stocked, priced cap styles could not appear in a kit.
 */
export async function garmentTypePass(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const P = ctx.db.collection('products');
  const products = await P.find(
    { projectId: ctx.projectId, 'optionSpace.descriptive.garmentType': { $exists: false } },
    { projection: { parentSku: 1, category: 1, optionSpace: 1 } },
  ).limit(opts.limit ?? 0).toArray();

  if (!products.length) { await ctx.log('option-space: every product already has a garment type'); return 0; }

  let filled = 0;
  const byType: Record<string, number> = {};
  for (const p of products as any[]) {
    const gt = deriveGarmentType(
      p.category,
      p.optionSpace?.descriptive?.garmentType,
      p.optionSpace?.descriptive?.ItemType,
    );
    if (!gt) continue;                       // no evidence: leave it unset, never guess
    await P.updateOne({ _id: p._id }, {
      $set: { 'optionSpace.descriptive.garmentType': gt, garmentTypeSource: 'category' },
    });
    filled++;
    byType[gt] = (byType[gt] || 0) + 1;
  }
  const summary = Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  await ctx.log(`option-space: garment type derived for ${filled}/${products.length} product(s) — ${summary}`);
  return filled;
}

export async function derivedOptionSpacePass(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const P = ctx.db.collection('products');
  const q = {
    projectId: ctx.projectId,
    'variants.0': { $exists: true },
    $or: [{ 'optionSpace.defining': { $exists: false } }, { 'optionSpace.defining': {} }],
  };
  const products = await P.find(q, { projection: { parentSku: 1, variants: 1, isSublimation: 1, optionSpace: 1 } })
    .limit(opts.limit ?? 0).toArray();
  if (!products.length) { await ctx.log('option-space: nothing left to derive'); return 0; }

  await ctx.log(`option-space: deriving choices for ${products.length} product(s) from their variant rows`);

  let derived = 0, rows = 0;
  for (const p of products as any[]) {
    const d = deriveOptionSpace(p.variants, { isSublimation: p.isSublimation });
    if (!d) continue;
    await P.updateOne({ _id: p._id }, {
      $set: {
        'optionSpace.defining': d.defining,
        'optionSpace.definingSource': 'variants',
        optionSpaceAt: new Date(),
      },
    });
    derived++; rows += d.derivedFrom;
  }

  await ctx.log(`option-space: derived ${derived} product(s) from ${rows.toLocaleString()} variant rows`);
  return derived;
}

/* ────────────── stage: team directory (who the customer buys for) ──────────────
 * Team outfitting starts with "which school?", so the agent needs a real roster
 * of institutions — not a list it made up.
 *
 * Sourced from a configured public SPARQL endpoint (Wikidata by default), which
 * gives verifiable, refreshable, citable facts: programme name, team nickname,
 * conference, division, country.
 *
 * DELIBERATELY NOT SOURCED HERE:
 *  • Team COLOURS — the public data has them for under 2% of programmes, and as
 *    vague words ("blue") not hex. Inventing them would look authoritative and
 *    be wrong often enough to misprint an order, so colours stay unset and the
 *    agent asks the customer to confirm.
 *  • LOGOS / marks — collegiate marks are trademarked and licensed. Artwork is
 *    supplied by the customer, never reproduced from a web source.
 * Every record carries its source URI so any claim can be traced.
 */
const TEAM_SPARQL = `
SELECT ?t ?tLabel ?confLabel ?ctryLabel ?alias WHERE {
  ?t wdt:P31 wd:Q2367225 ; wdt:P17 ?ctry .
  VALUES ?ctry { wd:Q30 wd:Q16 }
  OPTIONAL { ?t wdt:P118 ?conf }
  # Alternate labels are how customers ACTUALLY refer to a programme — "IIT" for
  # Illinois Tech, "Ole Miss" for Mississippi. Without them a real record is
  # unfindable by its common name, and fuzzy matching fills the gap with the
  # WRONG school.
  OPTIONAL { ?t skos:altLabel ?alias FILTER(lang(?alias) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

/** "Northwestern Wildcats" → institution "Northwestern", nickname "Wildcats".
 *  Only splits on a known nickname pattern; otherwise the whole label is kept. */
function splitProgramme(label: string): { institution: string; nickname?: string } {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2) return { institution: label.trim() };
  // Nicknames are the trailing word(s); take the last as nickname when the label
  // has a plural ending, which is the overwhelming convention (Wildcats, Mules).
  const last = parts[parts.length - 1];
  if (/s$/i.test(last) && parts.length > 1) {
    return { institution: parts.slice(0, -1).join(' '), nickname: last };
  }
  return { institution: label.trim() };
}

/** Pull US school directories (NCES via the Urban Institute API). Authoritative
 *  for WHO exists — names, district, place, grade level. Carries no mascots,
 *  colours or team names, which is exactly why those stay customer-confirmed.
 *  Scope is configured (states + grade levels) so a tenant ingests the market it
 *  actually sells to rather than blindly pulling ~100k records. */
async function fetchSchoolDirectory(
  src: SourceItem,
  log: (m: string) => void | Promise<void>,
): Promise<any[]> {
  const base = src.url || 'https://educationdata.urban.org/api/v1/schools/ccd/directory';
  const year = (src as any).year || '2022';
  // Default to high schools: the core team-sports buyer. Configure levels for
  // middle/elementary where a tenant sells youth programmes.
  const levels: string[] = (src as any).levels?.length ? (src as any).levels : ['3'];
  const states: string[] = (src as any).states?.length ? (src as any).states : [];
  const out: any[] = [];

  for (const level of levels) {
    // Per-state paging keeps each response small and lets a partial failure lose
    // one state rather than the whole run.
    const scopes = states.length ? states : [''];
    for (const st of scopes) {
      let page = 1;
      for (;;) {
        const q = new URLSearchParams({ school_level: String(level), limit: '1000', page: String(page) });
        if (st) q.set('state_location', st);
        try {
          const res = await fetch(`${base}/${year}/?${q}`, {
            headers: { 'User-Agent': 'JourneyAX/1.0 (school directory ingestion)' },
            signal: AbortSignal.timeout(90000),
          });
          if (!res.ok) { await log(`  · schools ${st || 'US'} L${level} p${page}: HTTP ${res.status}, stopping this scope`); break; }
          const body: any = await res.json();
          const rows = body.results || [];
          out.push(...rows);
          if (!body.next || !rows.length) break;
          page++;
        } catch (e) {
          await log(`  · schools ${st || 'US'} L${level} p${page}: ${(e as Error).message} — stopping this scope`);
          break;
        }
      }
    }
    await log(`  · schools level ${level}: ${out.length} cumulative`);
  }
  return out;
}

export async function stageTeamDirectory(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const sources = ctx.sources.filter(enabled).filter((s) => s.type === 'team-directory');
  if (!sources.length) { await ctx.log('team-directory: no enabled team-directory source configured — skipping'); return 0; }

  const now = new Date();
  const T = ctx.db.collection('team_directory');
  await T.createIndex({ projectId: 1, slug: 1 }, { unique: true }).catch(() => {});
  await T.createIndex({ projectId: 1, searchNames: 1 }).catch(() => {});
  await T.createIndex({ projectId: 1, kind: 1 }).catch(() => {});

  let total = 0;
  for (const src of sources) {
    const provider = (src as any).provider || 'sparql';
    if (provider === 'nces-schools') { total += await ingestSchools(ctx, src, T, now); continue; }
    total += await ingestProgrammes(ctx, src, T, now, opts);
  }
  await ctx.log(`team-directory: DONE — ${total} record(s) across ${sources.length} source(s)`);
  return total;
}

/** K-12 schools. Distinct `kind` so the agent can tell a high school from a
 *  college programme, and so club records never collide with them. */
async function ingestSchools(ctx: PipelineCtx, src: SourceItem, T: any, now: Date): Promise<number> {
  await ctx.log(`team-directory: fetching school directory (${(src as any).states?.join(',') || 'all states'}, levels ${(src as any).levels?.join(',') || '3'})`);
  const rows = await fetchSchoolDirectory(src, (m) => ctx.log(m));
  if (!rows.length) { await ctx.log('team-directory: school source returned nothing — existing records left untouched'); return 0; }

  const LEVEL: Record<string, string> = { '1': 'Elementary', '2': 'Middle', '3': 'High', '4': 'Other' };
  const ops: any[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = String(r.school_name || '').trim();
    const id = String(r.ncessch || '').trim();
    if (!name || !id) continue;
    const slug = `sch-${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const city = r.city_location || r.city_mailing || '';
    const state = r.state_location || r.state_mailing || '';
    // Include a "Name (City, ST)" handle so a coach naming a common school name
    // can still be disambiguated by place.
    const searchNames = [...new Set([name, `${name} ${state}`, `${name} ${city}`]
      .filter(Boolean).map((s: string) => s.toLowerCase()))];
    ops.push({ updateOne: {
      filter: { projectId: ctx.projectId, slug },
      update: { $set: {
        projectId: ctx.projectId, slug, kind: 'school',
        programme: name, institution: name,
        district: r.lea_name || null,
        level: LEVEL[String(r.school_level)] || null,
        city: city || null, state: state || null, country: 'United States',
        searchNames,
        colours: [], colourSource: 'unconfirmed',
        artworkPolicy: 'customer-supplied',
        // The school directory is authoritative for existence and place, but
        // carries NO team names, mascots or colours — those come from the customer.
        confidence: 'authoritative-directory',
        source: `nces:${id}`, sourceKind: 'nces', updatedAt: now,
      } },
      upsert: true,
    } });
  }
  for (let i = 0; i < ops.length; i += 500) await T.bulkWrite(ops.slice(i, i + 500));
  await ctx.log(`team-directory: ${ops.length} school(s) upserted (names/district/place only — no mascots or colours exist in this source)`);
  return ops.length;
}

/** College athletic programmes via SPARQL. */
async function ingestProgrammes(ctx: PipelineCtx, src: SourceItem, T: any, now: Date, opts: { limit?: number }): Promise<number> {
  const endpoint = src.url || 'https://query.wikidata.org/sparql';

  await ctx.log(`team-directory: querying ${endpoint}`);
  let rows: any[] = [];
  try {
    const res = await fetch(`${endpoint}?query=${encodeURIComponent(TEAM_SPARQL)}`, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'JourneyAX/1.0 (team directory ingestion)' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = ((await res.json()) as any).results?.bindings || [];
  } catch (e) {
    await ctx.log(`team-directory: source unavailable (${(e as Error).message}) — existing directory left untouched`);
    return 0;
  }

  // One programme can appear on several rows (multiple conferences); fold them.
  const byUri = new Map<string, any>();
  for (const r of rows) {
    const uri = r.t?.value;
    const label = r.tLabel?.value;
    if (!uri || !label || /^Q\d+$/.test(label)) continue;   // unlabelled entities are noise
    const e = byUri.get(uri) || { uri, label, conferences: new Set<string>(), aliases: new Set<string>(), country: r.ctryLabel?.value };
    if (r.confLabel?.value) e.conferences.add(r.confLabel.value);
    if (r.alias?.value) e.aliases.add(r.alias.value);
    byUri.set(uri, e);
  }

  const entries = [...byUri.values()].slice(0, opts.limit || undefined);
  const ops: any[] = [];
  for (const e of entries) {
    const { institution, nickname } = splitProgramme(e.label);
    const confs = [...e.conferences] as string[];
    const division = confs.find((c) => /Division|NAIA|U SPORTS|CCAA|Junior College/i.test(c));
    const conference = confs.find((c) => c !== division);
    const slug = e.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    // Lower-cased handles the agent can match on, including partials the customer
    // is likely to say ("Chicago" for "University of Chicago Maroons").
    const searchNames = [...new Set([e.label, institution, nickname, ...(e.aliases || [])]
      .filter(Boolean).map((s: string) => String(s).toLowerCase()))];
    ops.push({ updateOne: {
      filter: { projectId: ctx.projectId, slug },
      update: { $set: {
        projectId: ctx.projectId, slug, kind: 'college',
        programme: e.label, institution, nickname,
        conference: conference || null, division: division || null,
        country: e.country || null,
        searchNames,
        colours: [],                      // intentionally empty — customer-confirmed
        colourSource: 'unconfirmed',
        artworkPolicy: 'customer-supplied',
        // The public source contains real errors (e.g. it lists the Chicago
        // Maroons as Division I; they play Division III), so nothing from it is
        // presented to a customer as settled fact.
        confidence: 'unverified-public-source',
        source: e.uri, sourceKind: 'sparql', updatedAt: now,
      } },
      upsert: true,
    } });
  }
  for (let i = 0; i < ops.length; i += 500) await T.bulkWrite(ops.slice(i, i + 500));

  /* Curated overlay — a small hand-checked set is more trustworthy than the bulk
   * source, so it WINS on the fields it defines and is marked as such. This is
   * how a tenant corrects the directory over time without re-deriving it. */
  let curated = 0;
  const CUR = ctx.db.collection('school_directory');
  for (const s of (await CUR.find({}, { projection: { embedding: 0 } }).toArray()) as any[]) {
    const names = [s.name, ...(s.aliases || []), s.nickname].filter(Boolean).map((x: string) => String(x).toLowerCase());
    const match = await T.findOne({ projectId: ctx.projectId, searchNames: { $in: names } });
    if (!match) continue;
    const $set: any = { confidence: 'curated', curatedFrom: s.source || 'curated' };
    if (s.nickname) $set.nickname = s.nickname;
    if (s.mascot) $set.mascot = s.mascot;
    if (s.conference) $set.conference = s.conference;
    if (s.division) $set.division = s.division;
    if (s.state) $set.state = s.state;
    // Curated colours are hand-checked, so they may be offered — still flagged
    // for the customer to confirm before anything is printed.
    if (s.colours?.length || s.colors?.length) {
      $set.colours = s.colours || s.colors;
      $set.colourSource = 'curated-confirm-with-customer';
    }
    await T.updateOne({ _id: match._id }, { $set });
    curated++;
  }

  const withConf = entries.filter((e: any) => e.conferences.size).length;
  await ctx.log(`team-directory: ${curated} record(s) upgraded from the curated overlay`);
  await ctx.log(`team-directory: ${ops.length} programmes (${withConf} with conference/division). Colours intentionally unset: the public source covers <2%, so the agent confirms them with the customer instead of guessing. All non-curated records are flagged 'unverified-public-source'.`);
  return ops.length;
}

/* ────────────── stage: taxonomy (audience / sport / garment) ──────────────
 * The source encodes its merchandising taxonomy as one compound string —
 * "Adult | BASEBALL | ON-FIELD TOPS". Useful to a human, useless as a filter.
 * This splits it into queryable fields so the agent can answer "youth baseball
 * tops" exactly instead of pattern-matching prose.
 *
 * Purely deterministic — no model involved, so it costs nothing and cannot
 * hallucinate a sport. Where the source gives no usable category the sport is
 * left NULL and reported, rather than guessed from the product name.
 */

/** Segments that describe WHO the garment is for, not what sport it is. */
const AUDIENCES = new Set(['adult', 'youth', 'ladies', 'girls', 'womens', 'mens', 'misc', 'toddler', 'infant']);

/** Segments that are garment groupings rather than sports. Anything left over in
 *  the sport position is treated as a sport. */
const NON_SPORTS = new Set([
  'tees', 'fleece', 'outerwear', 'bottoms', 'tops', 'polos', 'bags', 'headwear',
  'lifestyle', 'accessories', 'aprons', 'socks', 'uniforms', 'sublimation', 'closeout',
  'pullovers', 'top', 'tops', 'bottom', 'all', 'shorts', 'pants', 'jackets', 'shirts',
]);

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim();

export function parseCategory(raw: string): { audience?: string; sport?: string; garmentGroup?: string } {
  const s = String(raw || '').trim();
  // Raw platform ids carry no meaning — treat as absent rather than inventing one.
  if (!s || /^[0-9]{8,}$/.test(s)) return {};

  const parts = s.split('|').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return {};

  const out: { audience?: string; sport?: string; garmentGroup?: string } = {};
  const rest: string[] = [];
  for (const p of parts) {
    if (!out.audience && AUDIENCES.has(p.toLowerCase())) out.audience = titleCase(p);
    else rest.push(p);
  }
  if (!rest.length) return out;

  // Segments carry internal suffixes ("TOPS FSG", "HEADWEAR ASB") — strip them
  // before classifying, or a grouping reads as an unknown sport.
  const clean = (v: string) => v.replace(/\s+(ASB|FSG|T\d)$/i, '').trim();

  // Only the FIRST remaining segment can be a sport; the LAST is the garment
  // group. With one segment there is no sport, just a grouping.
  const head = clean(rest[0]);
  if (rest.length > 1 && !NON_SPORTS.has(head.toLowerCase())) out.sport = titleCase(head);
  out.garmentGroup = titleCase(clean(rest[rest.length - 1]));
  return out;
}

export async function stageTaxonomy(ctx: PipelineCtx): Promise<number> {
  const P = ctx.db.collection('products');
  await P.createIndex({ projectId: 1, 'taxonomy.sport': 1 }).catch(() => {});
  await P.createIndex({ projectId: 1, 'taxonomy.audience': 1, 'taxonomy.sport': 1 }).catch(() => {});

  const products = await P.find({ projectId: ctx.projectId }, { projection: { category: 1 } }).toArray();
  await ctx.log(`taxonomy: parsing ${products.length} product categories`);

  const ops: any[] = [];
  let withSport = 0, unparsed = 0;
  const sports = new Map<string, number>();
  for (const p of products as any[]) {
    const t = parseCategory(p.category);
    if (!t.sport && !t.audience && !t.garmentGroup) { unparsed++; continue; }
    if (t.sport) { withSport++; sports.set(t.sport, (sports.get(t.sport) || 0) + 1); }
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { taxonomy: t } } } });
  }
  for (let i = 0; i < ops.length; i += 500) await P.bulkWrite(ops.slice(i, i + 500));

  const top = [...sports.entries()].sort((a, b) => b[1] - a[1]);
  await ctx.log(`taxonomy: DONE — ${ops.length} classified, ${withSport} with a sport, ${unparsed} unclassifiable (no usable source category)`);
  await ctx.log(`taxonomy: sports found — ${top.map(([s, n]) => `${s}(${n})`).join(' ')}`);
  return ops.length;
}

/* ────────────── stage: brand hub (high-level agent context) ──────────────
 * One compact orientation brief per project, injected into every conversation so
 * the agent starts knowing WHO this business is and WHAT it sells, instead of
 * rediscovering it from retrieved fragments each turn.
 *
 * Split deliberately by trust level:
 *   • `facts`     — COMPUTED from the catalogue. Cannot be wrong.
 *   • `topics`    — which help topics exist, with source URLs. Pointers, not answers.
 *   • `narrative` — a short LLM-written orientation, explicitly non-authoritative.
 *
 * Specific policy values (lead times, prices, returns) are deliberately NOT
 * baked in: they go stale, and a confidently-wrong lead time is worse than none.
 * The hub tells the agent that a topic exists and to retrieve it.
 */
const HUB_SYSTEM = `You write a SHORT orientation brief for a sales agent joining a company.

From the supplied catalogue summary and help-article titles, write 4-6 sentences covering:
what this business sells, who buys from it, how its range is organised, and what kinds of
support material exist.

Rules:
- Use ONLY what the input states. Do not invent policies, lead times, prices, or claims.
- Do not state specific numbers for policies (lead times, minimums, return windows) — say the
  topic exists and must be looked up.
- Neutral, factual, no marketing language. Plain prose, no headings or bullets.`;

export async function stageBrandHub(ctx: PipelineCtx): Promise<number> {
  const P = ctx.db.collection('products');
  const D = ctx.db.collection('documents');
  const H = ctx.db.collection('brand_hub');
  const q = { projectId: ctx.projectId };

  await ctx.log('brand-hub: computing catalogue facts');

  const [total, brandRows, priced, collections, topicDocs] = await Promise.all([
    P.countDocuments(q),
    P.aggregate([{ $match: q }, { $group: { _id: '$optionSpace.brand', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    // priceUSD is a band object ({min,max,cost}), not a scalar — take the low end.
    P.find({ ...q, 'priceUSD.min': { $gt: 0 } }, { projection: { priceUSD: 1 } }).toArray(),
    ctx.db.collection('collections').find(q, { projection: { name: 1, kind: 1 } }).toArray(),
    D.find({ ...q, 'metadata.type': 'faq' }, { projection: { title: 1, sourceUrl: 1 } }).toArray(),
  ]);

  const brands = brandRows.filter((b: any) => b._id).map((b: any) => ({ name: String(b._id), products: b.n }));
  const prices = priced
    .map((p: any) => Number(p.priceUSD?.min))
    .filter((n: number) => Number.isFinite(n) && n > 0)
    .sort((a: number, b: number) => a - b);
  const pct = (f: number) => (prices.length ? prices[Math.floor(prices.length * f)] : null);

  // Titles dedupe: several chunks share a source article.
  const topicMap = new Map<string, string>();
  for (const t of topicDocs as any[]) {
    const title = String(t.title || '').trim();
    if (title && !topicMap.has(title)) topicMap.set(title, String(t.sourceUrl || ''));
  }
  const topics = [...topicMap.entries()].map(([title, url]) => ({ title, url }));

  /* The catalogue's own vocabulary, counted from the taxonomy stage. The
   * business profile declares WHICH dimensions this business thinks in; these
   * are the actual values behind them, so the agent knows what it can filter by
   * instead of guessing sport names. */
  const dim = async (field: string) => (await P.aggregate([
    { $match: { ...q, [field]: { $exists: true, $ne: null } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 40 },
  ]).toArray()).map((r: any) => ({ value: String(r._id), productCount: r.n }));

  const taxonomy = {
    primary: await dim('taxonomy.sport'),
    secondary: await dim('taxonomy.garmentGroup'),
    audience: (await P.distinct('taxonomy.audience', q)).filter(Boolean).map(String),
  };
  await ctx.log(`brand-hub: taxonomy — ${taxonomy.primary.length} primary, ${taxonomy.secondary.length} secondary, ${taxonomy.audience.length} audience value(s)`);

  const facts = {
    productCount: total,
    brands,
    priceBandUsd: prices.length ? { low: pct(0.1), median: pct(0.5), high: pct(0.9) } : null,
    collectionCount: collections.filter((c: any) => c.kind === 'collection').length,
    sizingGroupCount: collections.filter((c: any) => c.kind === 'sizing-group').length,
    outfittingSetCount: collections.filter((c: any) => c.kind === 'outfitting-set').length,
    helpTopicCount: topics.length,
  };
  await ctx.log(`brand-hub: ${total} products · ${brands.length} brand(s) · ${topics.length} help topic(s)`);

  // Narrative: orientation only, and clearly fallible — so it is generated from
  // the computed facts + topic titles, never from raw prose it might over-read.
  let narrative = '';
  try {
    const openai = new OpenAI();
    const model = ctx.extractModel || ctx.ingestModel;
    const isReasoning = /^(gpt-5|o[134])/.test(model);
    const input = [
      `Catalogue: ${facts.productCount} products.`,
      brands.length ? `Brands sold: ${brands.map((b) => `${b.name} (${b.products})`).join(', ')}.` : '',
      facts.priceBandUsd ? `Typical price band USD ${facts.priceBandUsd.low}–${facts.priceBandUsd.high}.` : '',
      `${facts.collectionCount} named collections, ${facts.sizingGroupCount} adult/youth/ladies sizing groups, ${facts.outfittingSetCount} coordinated sets.`,
      taxonomy.primary.length ? `Organised by ${taxonomy.primary.map((t) => `${t.value} (${t.productCount})`).join(', ')}.` : '',
      taxonomy.secondary.length ? `Garment groups: ${taxonomy.secondary.slice(0, 12).map((t) => t.value).join(', ')}.` : '',
      `Help topics available: ${topics.map((t) => t.title).slice(0, 60).join('; ')}.`,
    ].filter(Boolean).join('\n');

    const r = await openai.chat.completions.create({
      model,
      messages: [{ role: 'system', content: HUB_SYSTEM }, { role: 'user', content: input }],
      max_completion_tokens: 700,
      ...(isReasoning ? { reasoning_effort: 'minimal' as any } : { temperature: 0.3 }),
    });
    narrative = (r.choices[0]?.message?.content || '').trim();
  } catch (e) {
    await ctx.log(`brand-hub: narrative generation failed (${(e as Error).message}) — facts still saved`);
  }

  await H.updateOne(
    { projectId: ctx.projectId },
    { $set: { projectId: ctx.projectId, facts, taxonomy, topics, narrative, updatedAt: new Date() } },
    { upsert: true },
  );
  await ctx.log(`brand-hub: DONE — facts + ${topics.length} topic pointer(s)${narrative ? ' + narrative' : ' (no narrative)'}`);
  return 1;
}

/* ────────────── stage: catalogue extraction (collections/triplets) ──────────────
 * Catalogue pages encode relationships that exist in NO feed:
 *   - collection membership ("On The Rise", "Rowhouse", "Alumni"…)
 *   - adult / youth / ladies SKU groups for the SAME garment
 *   - coordinated outfitting sets (jersey + shorts + warm-up)
 * e.g. "INTEGRATED 7 PIECE PAD PANT  F25PFM Adult XS-2XL  F25PFW Youth S-2XL".
 *
 * This is genuine reasoning over messy multi-column layout, so it uses the
 * project's configured extract model. Extracted SKUs are VALIDATED against the
 * canonical catalogue — anything the model invents is dropped, never persisted.
 */
const EXTRACT_SYSTEM = `You extract product RELATIONSHIPS from sportswear catalogue page text.

Return JSON only, matching this shape:
{
  "collections":   [{ "name": string, "skus": string[] }],
  "sizingGroups":  [{ "styleName": string, "adult": string|null, "youth": string|null, "ladies": string|null }],
  "outfittingSets":[{ "name": string, "skus": string[] }]
}

Rules:
- Use ONLY style numbers/SKUs that literally appear in the text. Never invent or complete a code.
- A sizing group is the SAME garment offered for different bodies (Adult / Youth / Ladies / Girls / Womens).
- A collection is a named range printed on the page (e.g. "ON THE RISE COLLECTION").
- An outfitting set is garments presented together as one team look.
- If a category has nothing, return an empty array. No commentary, no markdown.`;

export async function stageCatalogExtract(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const D = ctx.db.collection('documents');
  const P = ctx.db.collection('products');
  const C = ctx.db.collection('collections');
  await C.createIndex({ projectId: 1, name: 1 }, { unique: true }).catch(() => {});
  // The agent's lookup path is by member SKU, not by name — index it or every
  // findRelated call scans the whole collection.
  await C.createIndex({ projectId: 1, skus: 1 }).catch(() => {});

  // Only catalogue PDF pages carry these relationships.
  const pages = await D.find(
    { projectId: ctx.projectId, 'metadata.format': 'pdf', 'metadata.type': 'design' },
    { projection: { chunk: 1, 'metadata.documentTitle': 1, 'metadata.page': 1 } },
  ).limit(opts.limit ?? 0).toArray();
  if (!pages.length) { await ctx.log('catalog-extract: no catalogue pages found — run the pdf stage first'); return 0; }

  // Valid SKU set — the guard against hallucinated codes.
  const known = new Set<string>();
  for (const p of await P.find({ projectId: ctx.projectId }, { projection: { parentSku: 1 } }).toArray()) {
    known.add(String((p as any).parentSku).toUpperCase());
  }

  const openai = new OpenAI();
  const model = ctx.extractModel || ctx.ingestModel;
  const isReasoning = /^(gpt-5|o[134])/.test(model);
  await ctx.log(`catalog-extract: ${pages.length} catalogue page(s), model=${model} (validating SKUs against ${known.size} known)`);

  const collections = new Map<string, Set<string>>();
  const sizing: { styleName: string; adult?: string; youth?: string; ladies?: string }[] = [];
  const sets = new Map<string, Set<string>>();
  let processed = 0, withFindings = 0, droppedSkus = 0;

  const seenSig = new Set<string>();

  /** Idempotent checkpoint — upserts everything accumulated so far. Called
   *  periodically so a long run survives a crash and can be inspected mid-flight;
   *  re-running the stage overwrites the same keys rather than duplicating. */
  const flush = async () => {
    const now = new Date();
    const ops: any[] = [];
    for (const [name, skus] of collections) {
      ops.push({ updateOne: { filter: { projectId: ctx.projectId, name },
        update: { $set: { projectId: ctx.projectId, name, kind: 'collection', skus: [...skus], updatedAt: now } }, upsert: true } });
    }
    /* An outfitting set is identified by its MEMBERS, not by the label the model
     * happened to write on that page — the same set otherwise lands under several
     * names ("698HBM with coordinating pants" / "Coordinating pant for 698HBM").
     * Group by SKU signature and keep the alternative labels as aliases so the
     * merge is lossless. */
    const bySignature = new Map<string, { skus: string[]; names: string[] }>();
    for (const [name, skuSet] of sets) {
      const skus = [...skuSet].sort();
      const sig = skus.join('|');
      const entry = bySignature.get(sig) || { skus, names: [] };
      entry.names.push(name);
      bySignature.set(sig, entry);
    }
    for (const [sig, { skus, names }] of bySignature) {
      // Prefer a real product name over a generated phrase that just restates a
      // member code ("Coordinating pant for 698HBM"); among those, the most
      // descriptive. Falls back to the first label if every name cites a SKU.
      const descriptive = names.filter((n) => !skus.some((s) => n.toUpperCase().includes(s)));
      const canonical = (descriptive.length ? descriptive : names).sort((a, b) => b.length - a.length)[0];
      ops.push({ updateOne: { filter: { projectId: ctx.projectId, name: `set:${sig}` },
        update: { $set: { projectId: ctx.projectId, name: `set:${sig}`, kind: 'outfitting-set',
          label: canonical, aliases: names.filter((n) => n !== canonical), skus, updatedAt: now } }, upsert: true } });
    }
    for (const g of sizing.splice(0)) {           // drain: each group is written once
      // Signature must be over DISTINCT members: otherwise the same group
      // recorded with a repeated code ("1218|1218|1219") keys differently from
      // the clean form ("1218|1219") and the two never merge.
      const sig = [...new Set([g.adult, g.youth, g.ladies].filter(Boolean))].sort().join('|');
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      ops.push({ updateOne: { filter: { projectId: ctx.projectId, name: `sizing:${sig}` },
        update: { $set: { projectId: ctx.projectId, name: `sizing:${sig}`, kind: 'sizing-group', styleName: g.styleName,
          adult: g.adult, youth: g.youth, ladies: g.ladies, skus: [g.adult, g.youth, g.ladies].filter(Boolean), updatedAt: now } }, upsert: true } });
    }
    for (let i = 0; i < ops.length; i += 500) await C.bulkWrite(ops.slice(i, i + 500));

    // Back-link membership so the agent can answer "what completes this look?"
    const linkOps: any[] = [];
    for (const [name, skus] of collections) {
      for (const sku of skus) linkOps.push({ updateOne: { filter: { projectId: ctx.projectId, parentSku: sku }, update: { $addToSet: { collections: name } } } });
    }
    for (let i = 0; i < linkOps.length; i += 500) await P.bulkWrite(linkOps.slice(i, i + 500));

    // Reconciliation: catalogue codes with no product record. Ranked by how often
    // they appear, so the most-referenced gaps surface first. Actionable signal —
    // "your feed is missing styles your own catalogue is selling".
    const top = [...unknownCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500);
    await ctx.db.collection('ingest_reconciliation').updateOne(
      { projectId: ctx.projectId, kind: 'catalogue-codes-missing-from-feed' },
      { $set: {
        projectId: ctx.projectId,
        kind: 'catalogue-codes-missing-from-feed',
        distinctCodes: unknownCodes.size,
        totalReferences: droppedSkus,
        codes: top.map(([code, count]) => ({ code, count })),
        updatedAt: now,
      } },
      { upsert: true },
    );
  };

  /* A code the model read off the page but which isn't in the canonical
   * catalogue is NOT necessarily a hallucination — catalogues routinely carry
   * styles the product feed hasn't picked up yet. Either way it must not enter
   * the product graph (we cannot recommend something unbuyable), but dropping it
   * silently would hide real feed drift, so unknown codes are counted and
   * reported for reconciliation instead of discarded. */
  const unknownCodes = new Map<string, number>();
  const keep = (sku: unknown): string | undefined => {
    const s = String(sku || '').trim().toUpperCase();
    if (!s) return undefined;
    if (!known.has(s)) { droppedSkus++; unknownCodes.set(s, (unknownCodes.get(s) || 0) + 1); return undefined; }
    return s;
  };

  const CONC = 4;
  for (let i = 0; i < pages.length; i += CONC) {
    const batch = pages.slice(i, i + CONC);
    await Promise.all(batch.map(async (pg: any) => {
      const text = String(pg.chunk || '').slice(0, 6000);
      if (text.length < 120) return;
      try {
        const r = await openai.chat.completions.create({
          model,
          messages: [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: text }],
          max_completion_tokens: 1500,
          response_format: { type: 'json_object' },
          ...(isReasoning ? { reasoning_effort: 'minimal' as any } : { temperature: 0 }),
        });
        const raw = r.choices[0]?.message?.content || '{}';
        const out = JSON.parse(raw);
        let found = false;

        for (const c of out.collections || []) {
          const name = String(c?.name || '').trim();
          const skus = (c?.skus || []).map(keep).filter(Boolean) as string[];
          if (!name || !skus.length) continue;
          if (!collections.has(name)) collections.set(name, new Set());
          skus.forEach((s) => collections.get(name)!.add(s));
          found = true;
        }
        for (const g of out.sizingGroups || []) {
          let adult = keep(g?.adult); const youth = keep(g?.youth), ladies = keep(g?.ladies);
          /* On a ladies' style the model tends to fill BOTH `adult` and `ladies`
           * with the same code, which asserts "the ladies version of X is X" —
           * a no-op that would let the agent claim an alternate version exists
           * when it's the same garment. The specific slot carries the real
           * information, so drop the generic one. */
          if (adult && (adult === ladies || adult === youth)) adult = undefined;
          if (!(adult || youth || ladies)) continue;
          if ([adult, youth, ladies].filter(Boolean).length < 2) continue; // a group needs ≥2 distinct lines
          sizing.push({ styleName: String(g?.styleName || '').trim() || 'Unnamed style', adult, youth, ladies });
          found = true;
        }
        for (const s of out.outfittingSets || []) {
          const name = String(s?.name || '').trim();
          const skus = (s?.skus || []).map(keep).filter(Boolean) as string[];
          if (!name || skus.length < 2) continue;
          if (!sets.has(name)) sets.set(name, new Set());
          skus.forEach((x) => sets.get(name)!.add(x));
          found = true;
        }
        if (found) withFindings++;
      } catch { /* skip unparseable page */ }
    }));
    processed += batch.length;
    if (processed % 40 === 0 || processed >= pages.length) {
      await flush();   // checkpoint: survives a crash, and lets an operator inspect mid-run
      await ctx.log(`catalog-extract: ${processed}/${pages.length} pages · ${collections.size} collections · ${seenSig.size} sizing groups · ${sets.size} sets`);
      await ctx.progress({ 'progress.catalogPages': processed });
    }
  }

  await flush();
  await ctx.log(`catalog-extract: DONE — ${collections.size} collections, ${seenSig.size} sizing groups, ${sets.size} outfitting sets (${withFindings} pages had findings). ` +
    `Reconciliation: ${unknownCodes.size} distinct catalogue code(s) referenced ${droppedSkus} time(s) are NOT in the product feed — excluded from the graph and logged for review.`);
  return collections.size + seenSig.size + sets.size;
}


/**
 * Cap decoration capture (CAP-1 / C2).
 *
 * Headwear reaches the customer through the same rack and the same journey as
 * the tops and bottoms; only the colouring mechanism differs, so only the
 * mechanism is captured separately. See cap-decoration.ts for why the per-mesh
 * map cannot be defaulted across styles.
 *
 * Styles are selected by the garment type derived in the option-space stage,
 * so the rule for what counts as headwear lives in exactly one place
 * (`deriveGarmentType`) rather than being re-stated as a query literal here.
 */
export async function stageCapDecoration(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const src = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  if (!src?.url || !src.storeId) {
    await ctx.log('cap-decoration: no enabled websphere-rest source configured — skipping');
    return 0;
  }
  const ep = {
    base: src.url.replace(/\/$/, ''),
    storeId: String(src.storeId),
    meshPattern: (src as any).capMeshPattern as string | undefined,
  };
  if (!ep.meshPattern) {
    await ctx.log('cap-decoration: no capMeshPattern on the source — 3D cannot be confirmed, so nothing is marked configurable');
  }

  const P = ctx.db.collection('products');
  const styles = await P.find(
    { projectId: ctx.projectId, 'optionSpace.descriptive.garmentType': 'Headwear' },
    { projection: { parentSku: 1, name: 1, variants: 1 } },
  ).limit(opts.limit ?? 0).toArray();

  if (!styles.length) {
    await ctx.log('cap-decoration: no headwear styles found — run the option-space stage first (it derives the garment type)');
    return 0;
  }
  await ctx.log(`cap-decoration: ${styles.length} headwear style(s) to probe`);

  /* Colour names for configurator-only colours (CAP-4). The cap offers more
     colours than it is stocked in, and those extras are named nowhere on the
     cap itself — but colour codes are global, so the name is read from every
     product's variant rows once, up front, and used as the fallback. */
  const allVariants = await P.find(
    { projectId: ctx.projectId, 'variants.0': { $exists: true } },
    { projection: { variants: 1 } },
  ).toArray();
  const globalNames = buildGlobalColourIndex(allVariants as any[]);
  await ctx.log(`cap-decoration: global colour index built — ${Object.keys(globalNames).length} named codes across the catalogue`);

  let configurable = 0, stock = 0, failed = 0;
  for (const st of styles as any[]) {
    const sku = String(st.parentSku).toUpperCase();
    try {
      const cap = await withRetry(
        () => captureCap(ep, sku, st.variants, globalNames),
        (m) => ctx.log(`cap-decoration: ${sku} retry — ${m}`),
      );
      for (const w of cap.warnings) await ctx.log(`cap-decoration: ${sku} — ${w}`);

      if (cap.notConfigurable) {
        stock++;
        /* Recorded, not skipped: "checked, not configurable" must be
           distinguishable from "never looked at" downstream. */
        await P.updateOne({ projectId: ctx.projectId, parentSku: st.parentSku }, {
          $set: { decorationSystem: null, capCheckedAt: new Date() },
        });
        continue;
      }

      configurable++;
      await P.updateOne({ projectId: ctx.projectId, parentSku: st.parentSku }, {
        $set: {
          decorationSystem: 'cap',
          capColours: cap.colours,
          capMeshes: cap.meshes,
          capMeshUrl: cap.meshUrl,
          capMeshBytes: cap.meshBytes,
          capCheckedAt: new Date(),
        },
      });
      await ctx.log(`cap-decoration: ${sku} — ${cap.colours.length} colour(s), ${cap.meshes.length} mesh(es), ${Math.round((cap.meshBytes || 0) / 1024)} KB`);
    } catch (e) {
      failed++;
      await ctx.log(`cap-decoration: ${sku} FAILED — ${(e as Error).message}`);
    }
  }

  await ctx.log(`cap-decoration: ${configurable} configurable, ${stock} stock-only, ${failed} failed`);
  return configurable;
}

/**
 * Cap knowledge vectorization (CAP-2).
 *
 * Retrieval answers from embedded documents, not from the products collection.
 * Caps had none, so a customer asking for team caps was answered from whatever
 * cap text happened to exist in the crawled pages — in the verified case a
 * "Twill Stretchfit Cap" (438C) that is not in the catalogue at all, cannot be
 * priced, and reads designability 'unknown', while 100 genuinely configurable
 * caps sat unmentioned. The agent was not wrong to recommend it; it had nothing
 * better to find.
 *
 * One document per cap STYLE, not per colourway. A document per colourway would
 * be six near-identical texts per cap differing only in a colour word, which
 * crowds out other garments in the results without adding meaning — the colour
 * names go into the one document instead, so "navy cap" still matches.
 *
 * Only configurable caps are embedded. A stock cap that was checked and found
 * to have no colourways is deliberately left out: putting it in retrieval is
 * how the agent ends up offering something it cannot design, which is AUG-25.
 */
export async function stageCapKnowledge(ctx: PipelineCtx, opts: { limit?: number; force?: boolean } = {}): Promise<number> {
  const P = ctx.db.collection('products');
  const D = ctx.db.collection('documents');

  let doneSkus: string[] = [];
  if (!opts.force) {
    doneSkus = await D.distinct('sku', { projectId: ctx.projectId, docType: 'cap' });
    if (doneSkus.length) await ctx.log(`cap-knowledge: resuming — ${doneSkus.length} cap(s) already embedded, skipping`);
  }

  const caps = await P.find(
    { projectId: ctx.projectId, decorationSystem: 'cap',
      ...(doneSkus.length ? { parentSku: { $nin: doneSkus } } : {}) },
    { projection: {
        parentSku: 1, name: 1, title: 1, category: 1, priceUSD: 1, imageUrl: 1,
        capColours: 1, capMeshes: 1, optionSpace: 1, leadTimeDays: 1,
      } },
  ).limit(opts.limit ?? 0).toArray();

  if (!caps.length) { await ctx.log('cap-knowledge: nothing left to embed'); return 0; }
  await ctx.log(`cap-knowledge: building documents for ${caps.length} configurable cap(s)`);

  /* Decoration capability (C5) is a property of the brand's cap programme, not
     of one cap, so it comes from project config — the sides a logo can go on
     and the techniques offered, each with its own lead time. Config-driven so a
     different vertical edits it in the back office rather than in code. */
  const capSrc: any = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  const capDec = capSrc?.capDecoration;
  const decSentence = (() => {
    const sides = (capDec?.sides || []).filter(Boolean);
    const techs = (capDec?.techniques || []).map((t: any) => t.label).filter(Boolean);
    if (!sides.length || !techs.length) return '';
    return `A custom logo, team name or number can be added on the ${sides.join(', ').toLowerCase()} `
      + `using ${techs.slice(0, 6).join(', ').toLowerCase()}.`;
  })();

  let written = 0, unnamed = 0;
  const BATCH = 64;
  let pending: { doc: any; text: string }[] = [];

  const flush = async () => {
    if (!pending.length) return;
    const emb = await withRetry(() => embedTexts(pending.map((p) => p.text)),
      (m) => ctx.log(`cap-knowledge: embed retry — ${m}`));
    const ops = pending.map((p, i) => ({
      updateOne: {
        filter: { projectId: ctx.projectId, docType: 'cap', sku: p.doc.sku },
        update: { $set: { ...p.doc, chunk: p.text, content: p.text, embedding: emb[i], updatedAt: new Date() } },
        upsert: true,
      },
    }));
    await withRetry(() => D.bulkWrite(ops, { ordered: false }),
      (m) => ctx.log(`cap-knowledge: write retry — ${m}`));
    written += pending.length;
    pending = [];
  };

  for (const c of caps as any[]) {
    const name = c.name || c.title || c.parentSku;
    const colours = (c.capColours || []) as { code: string; name?: string }[];
    const named = colours.map((x) => x.name).filter(Boolean) as string[];
    if (named.length < colours.length) unnamed++;

    const sizes = (c.optionSpace?.defining?.['Available Sizes'] || [])
      .map((s: any) => s.value).filter(Boolean);

    /* Prose, not a field dump — this text is what gets embedded, so it has to
     * read like the question a customer would actually ask. */
    const text = [
      `${name} — a customisable team cap.`,
      'Headwear. Decorated as a cap: the crown, visor, button and stitching each take their own colour.',
      named.length
        ? `Made in ${named.length} colourway${named.length === 1 ? '' : 's'}: ${named.slice(0, 20).join(', ')}.`
        : 'Colourways are identified by code in the catalogue.',
      `${(c.capMeshes || []).length} colourable parts.`,
      sizes.length ? `Sizes: ${sizes.join(', ')}.` : '',
      c.priceUSD?.min != null ? `Priced from $${c.priceUSD.min}.` : '',
      c.leadTimeDays ? `Made to order — about ${c.leadTimeDays} business days for production.` : '',
      decSentence,
      'Can be previewed in 3D and added to a team kit alongside jerseys and pants.',
    ].filter(Boolean).join(' ');

    pending.push({
      text,
      doc: {
        projectId: ctx.projectId, docType: 'cap',
        sku: c.parentSku,
        title: name,
        garmentType: 'Headwear',
        decorationSystem: 'cap',
        /* Stated on the document so retrieval can be trusted without a second
         * lookup: everything embedded here is designable by construction. */
        designable: true,
        colourways: colours.map((x) => ({ code: x.code, name: x.name })),
        colourNames: named,
        meshCount: (c.capMeshes || []).length,
        sizes,
        price: c.priceUSD?.min,
        leadTimeDays: c.leadTimeDays,
        decorationSides: capDec?.sides || undefined,
        decorationTechniques: (capDec?.techniques || []).map((t: any) => ({ code: t.code, label: t.label, leadTimeDays: t.leadTimeDays })),
        thumbnail: typeof c.imageUrl === 'string' ? c.imageUrl : undefined,
      },
    });
    if (pending.length >= BATCH) await flush();
    await ctx.progress({ 'progress.capKnowledge': written });
  }
  await flush();

  await ctx.log(`cap-knowledge: DONE — ${written} cap document(s) embedded`);
  if (unnamed) {
    await ctx.log(`cap-knowledge: NOTE — ${unnamed} cap(s) have colourways with no name in the variant rows; `
      + 'those colours are searchable by code only');
  }
  return written;
}

/**
 * Production lead-time capture (CAP-1 / C6).
 *
 * Tags each product with its standard production window, read from the
 * platform's own priceAndLeadTime feed and joined on the product type the
 * catalogue already records. Made-to-order goods only: a stock item ships from
 * shelf and carries no production window, so it is left untagged rather than
 * given a misleading zero.
 */
export async function stageLeadTime(ctx: PipelineCtx, opts: { limit?: number } = {}): Promise<number> {
  const src = ctx.sources.filter(enabled).find((s) => s.type === 'websphere-rest');
  if (!src?.url || !src.storeId) {
    await ctx.log('lead-time: no enabled websphere-rest source configured — skipping');
    return 0;
  }

  let index;
  try {
    index = await withRetry(
      () => fetchLeadTimes(src.url!, String(src.storeId)),
      (m) => ctx.log(`lead-time: retry — ${m}`),
    );
  } catch (e) {
    await ctx.log(`lead-time: FAILED to fetch the feed — ${(e as Error).message}`);
    return 0;
  }
  const types = Object.entries(index.days).map(([k, v]) => `${k} ${v}d`).join(', ');
  await ctx.log(`lead-time: ${index.ruleCount} rules; standard windows — ${types || 'none found'}`);
  if (!Object.keys(index.days).length) {
    await ctx.log('lead-time: no standard windows parsed — aborting rather than tagging blanks');
    return 0;
  }

  const P = ctx.db.collection('products');
  /* Only made-to-order styles have a production window. A style is made to
     order when it is sublimated or configured as a cap — the same test the
     rest of the pipeline uses, so the two never disagree. */
  const cur = P.find(
    { projectId: ctx.projectId,
      $or: [{ isSublimation: true }, { decorationSystem: { $type: 'string' } }] },
    { projection: { parentSku: 1, 'optionSpace.descriptive.productType': 1, decorationSystem: 1 } },
  ).limit(opts.limit ?? 0);

  let tagged = 0, unresolved = 0;
  const bulk: any[] = [];
  for await (const p of cur as any) {
    const pt = p.optionSpace?.descriptive?.productType;
    let days = leadTimeForProductType(index, pt);
    /* A cap is decorated, not cut-and-sewn, so it has no sublimation product
       type. Caps are stocked blanks decorated to order, which the feed models
       under CUT_SEW turnaround, so a cap with no product type falls back to it. */
    if (days === undefined && p.decorationSystem === 'cap') days = leadTimeForProductType(index, 'CUT_SEW');
    if (days === undefined) { unresolved++; continue; }
    bulk.push({ updateOne: { filter: { _id: p._id }, update: {
      $set: { leadTimeDays: days, leadTimeSource: 'priceAndLeadTime', leadTimeAt: new Date() },
    } } });
    tagged++;
    if (bulk.length >= 500) { await P.bulkWrite(bulk.splice(0), { ordered: false }); }
  }
  if (bulk.length) await P.bulkWrite(bulk, { ordered: false });

  await ctx.log(`lead-time: ${tagged} product(s) tagged, ${unresolved} with no matching product type`);
  return tagged;
}

/* ───────────────────────── orchestrator ───────────────────────── */
export async function runPipeline(ctx: PipelineCtx): Promise<Record<string, number>> {
  const want = (stage: string) => !ctx.only?.length || ctx.only.includes(stage);
  const out: Record<string, number> = {};
  const stages: [string, () => Promise<void>][] = [
    ['csv-feed',        async () => { out.products = await stageCsvFeeds(ctx); }],
    ['merge',           async () => { const m = await stageMergeWebLayer(ctx); out.merged = m.merged; out.promoted = m.promoted; }],
    ['narratives',      async () => { out.narratives = await stageNarratives(ctx); }],
    ['pdf',             async () => { out.pdfChunks = await stagePdfs(ctx); }],
    ['kb-articles',     async () => { out.articleChunks = await stageKbArticles(ctx); }],
    ['option-space',    async () => { out.optionSpace = await stageOptionSpace(ctx); }],
    ['decoration',      async () => { out.decoration = await stageDecoration(ctx); }],
    ['cap-decoration',  async () => { out.capDecoration = await stageCapDecoration(ctx); }],
    ['lead-time',       async () => { out.leadTime = await stageLeadTime(ctx); }],
    ['design-visuals',  async () => { out.designVisuals = await stageDesignVisuals(ctx); }],
    ['design-knowledge', async () => { out.designKnowledge = await stageDesignKnowledge(ctx); }],
    ['cap-knowledge',   async () => { out.capKnowledge = await stageCapKnowledge(ctx); }],
    ['taxonomy',        async () => { out.taxonomy = await stageTaxonomy(ctx); }],
    ['team-directory',  async () => { out.teams = await stageTeamDirectory(ctx); }],
    ['catalog-extract', async () => { out.catalogRelations = await stageCatalogExtract(ctx); }],
    // Last: the hub summarises everything the earlier stages produced.
    ['brand-hub',       async () => { out.brandHub = await stageBrandHub(ctx); }],
  ];
  const planned = stages.filter(([n]) => want(n)).map(([n]) => n);
  await ctx.log(`pipeline start — ${ctx.sources.filter(enabled).length} enabled source(s), model=${ctx.ingestModel}` +
    (ctx.extractModel ? `, extract=${ctx.extractModel}` : '') + ` — stages: ${planned.join(' → ')}`);

  let n = 0;
  for (const [name, run] of stages) {
    if (!want(name)) continue;
    n++;
    const t = Date.now();
    await ctx.log(`── stage ${n}/${planned.length}: ${name} — starting`);
    await run();
    await ctx.log(`── stage ${n}/${planned.length}: ${name} — finished in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  await ctx.log(`pipeline complete — ${JSON.stringify(out)}`);
  return out;
}
