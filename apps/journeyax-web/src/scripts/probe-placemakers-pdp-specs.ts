/**
 * Phase-2 groundwork PROOF (not the full run): given the real PlaceMakers PDP
 * `url` field now recovered by backfill-placemakers-fields.ts, check what
 * structured spec data is actually recoverable by scraping the real page.
 *
 * The source JSON export's `value.attributes` never carried structured spec
 * fields (material, glazing type, dimensions as data) — only free text inside
 * `description`. Real structured specs, if they exist at all, only live on the
 * rendered PDP page. This script reuses the SAME proven extractor already
 * used for the 183-article CMS crawl (stageKbArticles in pipeline.ts +
 * extractPage/composeContent in extractor.ts) — Playwright headless chromium,
 * already confirmed to pass the site's AWS WAF JS challenge.
 *
 * Scope: this is a PROOF RUN against a small real sample (window-category
 * products, since that's the category the live conversation failed on), NOT
 * the full 41k-page scrape. It writes nothing to the DB — it only reports,
 * per URL: fetch time, whether a real spec table was found, what keys/values
 * came back, and image/document counts, so the user can decide whether to
 * greenlight a full run.
 *
 * Usage: npx tsx src/scripts/probe-placemakers-pdp-specs.ts [--limit 15]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { createReadStream } from 'fs';
import readline from 'readline';

const SRC = '/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const LIMIT = arg('limit') ? Number(arg('limit')) : 15;

function leafCategory(paths: any): string {
  if (!Array.isArray(paths)) return '';
  for (const branch of paths) {
    if (!Array.isArray(branch) || !branch.length) continue;
    if (branch.length === 1 && branch[0]?.id === 'root') continue;
    return String(branch[branch.length - 1]?.name || '');
  }
  return '';
}

async function collectWindowSample(): Promise<{ id: string; title: string; url: string; category: string }[]> {
  const rl = readline.createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
  const out: { id: string; title: string; url: string; category: string }[] = [];
  for await (const line of rl) {
    if (out.length >= LIMIT) break;
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const p: string = rec?.path || '';
    if (!p.startsWith('/products/')) continue;
    const a = rec?.value?.attributes;
    if (!a?.url) continue;
    const title = String(a.title || '');
    const category = leafCategory(a.category_paths);
    const hay = (title + ' ' + category).toLowerCase();
    // Prefer actual window UNITS over hardware — but since the earlier grep
    // found only hardware for "casement", cast the net at "window" generally
    // and exclude the obvious hardware/accessory noise so the sample is
    // representative of what's actually there.
    if (!/window/.test(hay)) continue;
    if (/hardware|stay|handle|fastener|latch|hinge|lock|catch|wingnut|clip/.test(hay)) continue;
    out.push({ id: p.slice('/products/'.length), title, url: a.url, category });
  }
  return out;
}

async function main() {
  const sample = await collectWindowSample();
  console.log(`■ ${sample.length} window-category (non-hardware) product URLs selected for the proof scrape`);
  sample.forEach((s, i) => console.log(`  ${i + 1}. [${s.id}] ${s.title}  (${s.category})`));
  if (!sample.length) { console.log('No non-hardware window products found in the sample window — nothing to scrape.'); return; }

  const { chromium } = await import('playwright');
  const { extractPage, composeContent } = await import('../services/knowledge/extractor');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { (globalThis as any).__name = (fn: unknown) => fn; });

  const results: any[] = [];
  try {
    for (const s of sample) {
      const t0 = Date.now();
      try {
        await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1200);
        const x = await extractPage(page, s.url);
        const ms = Date.now() - t0;
        const specKeys = Object.keys(x.specs || {});
        results.push({
          id: s.id, title: s.title, url: s.url, ms,
          bodyTextLen: (x.bodyText || '').length,
          specCount: specKeys.length, specs: x.specs,
          imageCount: x.images.length, documentCount: x.documents.length,
          documents: x.documents,
          isProduct: x.isProduct,
        });
        console.log(`\n[${s.id}] ${s.title} — ${ms}ms, bodyText ${x.bodyText.length} chars, ${specKeys.length} spec fields, ${x.images.length} images, ${x.documents.length} linked docs`);
        if (specKeys.length) console.log(`   specs: ${JSON.stringify(x.specs)}`);
        if (x.documents.length) console.log(`   documents: ${x.documents.map((d) => `[${d.kind}] ${d.title}`).join(' | ')}`);
      } catch (e: any) {
        const ms = Date.now() - t0;
        results.push({ id: s.id, title: s.title, url: s.url, ms, error: String(e?.message || e).slice(0, 200) });
        console.log(`\n[${s.id}] ${s.title} — FAILED after ${ms}ms: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const ok = results.filter((r) => !r.error);
  const withSpecs = ok.filter((r) => r.specCount > 0);
  const withDocs = ok.filter((r) => r.documentCount > 0);
  const avgMs = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;

  console.log('\n■ SUMMARY');
  console.log(`  attempted: ${results.length} | succeeded: ${ok.length} | failed: ${results.length - ok.length}`);
  console.log(`  avg time/page: ${avgMs}ms`);
  console.log(`  pages with a real spec table (>=1 spec field): ${withSpecs.length}/${ok.length}`);
  console.log(`  pages with linked documents (PDFs/guides): ${withDocs.length}/${ok.length}`);
  if (results.length - ok.length) {
    console.log('  full-41k extrapolation at this rate: ' + ((avgMs * 41221) / 1000 / 60).toFixed(0) + ' min (serial, single page) — parallelize to shrink');
  } else {
    console.log('  full-41k extrapolation at this rate: ' + ((avgMs * 41221) / 1000 / 60).toFixed(0) + ' min (serial, single page) — parallelize to shrink');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
