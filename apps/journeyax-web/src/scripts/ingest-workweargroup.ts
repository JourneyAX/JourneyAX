/**
 * ingest-workweargroup.ts — one-off onboarding ingest for the "workweargroup" POC tenant.
 *
 * Mirrors ingest-project.ts's generic Playwright pipeline (extractPage → classify →
 * chunkContent → embedTexts → insertDocuments) but takes an explicit URL list instead
 * of fetching knowledgeSource from the project-service HTTP API (no services running
 * locally for this one-off onboarding — the project record itself was already written
 * directly to journeyax.tenant_configs by scratch/create-workweargroup-project.mjs).
 *
 * Real, publicly-discovered URLs only (see scratch/probe-wwg*.mjs) — no fabricated data.
 *
 *   npx tsx src/scripts/ingest-workweargroup.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { chromium } from 'playwright';
import { chunkContent } from '../services/knowledge/chunker';
import { embedTexts } from '../services/knowledge/embedder';
import { insertDocuments, closeConnection } from '../services/knowledge/mongo';
import { DocumentMetadata, DocumentType, KnowledgeDocument } from '../services/knowledge/types';
import { extractPage, composeContent } from '../services/knowledge/extractor';
import * as fs from 'fs';

const PROJECT_ID = 'workweargroup';

function readUrls(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
}

// Cap per brand — representative POC sample, not exhaustive.
const CAP = { tww: 20, hy: 16, kg: 11, nnt: 20 } as const;

const productUrls: { brand: string; url: string }[] = [];
for (const [tag, cap] of Object.entries(CAP)) {
  const urls = readUrls(`/tmp/urls_${tag}.txt`).slice(0, cap);
  for (const url of urls) productUrls.push({ brand: tag, url });
}

// Content/guide pages found during discovery (real URLs, not fabricated).
const contentUrls: string[] = [
  'https://www.hardyakka.com/au/size-guide.html',
  'https://www.kinggee.com/au/safety-hi-vis/',
  'https://www.nnt.com.au/scrubs/',
  'https://www.totallyworkwear.com.au/hi-vis',
  'https://www.totallyworkwear.com.au/healthcare/scrubs',
];

function classify(url: string, text: string): DocumentType {
  const u = url.toLowerCase();
  if (/(size-guide|sizing)/.test(u)) return 'faq';
  if (/(install|instruction|manual|how-to|assembly)/.test(u)) return 'installation';
  if (/(troubleshoot|repair|fault|leak|support|problem)/.test(u)) return 'troubleshooting';
  if (/(warranty|faq|policy|care|returns|terms)/.test(u)) return 'faq';
  if (/(inspiration|lookbook|gallery|ideas|design|collection|style)/.test(u)) return 'design';
  if (/(\/p\/|\/products\/)/.test(u)) return 'product';
  if (/add to (cart|bag)|our price|rrp|\$\d/i.test(text.slice(0, 4000))) return 'product';
  return 'general';
}

async function ingestOne(page: any, url: string, brandTag: string | null, now: Date) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const x = await extractPage(page, url);
  const title = x.title || url;
  if ((x.bodyText || '').trim().length < 100 && !x.isProduct) {
    console.log(`— skipped (thin content): ${url}`);
    return null;
  }

  const type: DocumentType = x.isProduct && x.price != null ? 'product' : classify(url, x.bodyText);
  const content = composeContent(x);

  const metadata: DocumentMetadata = {
    type, brand: PROJECT_ID, url,
    ...(brandTag ? { category: brandTag } : {}),
    ...(x.sku ? { sku: x.sku } : {}),
    ...(x.price != null ? { price: x.price } : {}),
    ...(x.priceMin != null ? { priceMin: x.priceMin } : {}),
    ...(x.priceMax != null ? { priceMax: x.priceMax } : {}),
    ...(x.currency ? { currency: x.currency } : {}),
    ...(x.availability ? { availability: x.availability } : {}),
    ...(x.images.length ? { images: x.images.slice(0, 20) } : {}),
    ...(Object.keys(x.options).length ? { options: x.options } : {}),
    ...(x.variants.length ? { variants: x.variants } : {}),
    ...(Object.keys(x.specs).length ? { specs: x.specs } : {}),
    ...(x.documents.length ? { documents: x.documents } : {}),
    ...(x.description ? { description: x.description } : {}),
    ...(x.shortDescription ? { shortDescription: x.shortDescription } : {}),
  };

  const chunks = chunkContent(content, title, url, metadata);
  if (!chunks.length) { console.log(`— skipped (no chunks): ${url}`); return null; }

  const embeddings = await embedTexts(chunks.map((c) => c.text));
  const docs: KnowledgeDocument[] = chunks.map((c, i) => ({
    projectId: PROJECT_ID, brand: PROJECT_ID, sourceUrl: url, title, content,
    chunk: c.text, chunkIndex: i, metadata, embedding: embeddings[i], crawledAt: now, updatedAt: now,
  }));
  await insertDocuments(docs);
  const badges = [
    x.images.length ? `${x.images.length}img` : '',
    x.price != null ? `$${x.price}` : '',
    Object.keys(x.specs).length ? `${Object.keys(x.specs).length}spec` : '',
  ].filter(Boolean).join(' ');
  console.log(`✓ [${type}] ${docs.length}chunk ${badges} · ${title.slice(0, 70)}`);
  return docs.length;
}

async function main() {
  console.log(`▶ ingest starting for project "${PROJECT_ID}" — ${productUrls.length} product URLs + ${contentUrls.length} content URLs`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { (globalThis as any).__name = (fn: unknown) => fn; });

  let processed = 0, chunksTotal = 0, failed = 0;
  const now = new Date();
  const failures: string[] = [];

  try {
    for (const { brand, url } of productUrls) {
      try {
        const n = await ingestOne(page, url, brand, now);
        if (n) { processed++; chunksTotal += n; }
      } catch (e) {
        failed++; failures.push(`${url}: ${(e as Error).message}`);
        console.log(`✗ ${url}: ${(e as Error).message}`);
      }
    }
    for (const url of contentUrls) {
      try {
        const n = await ingestOne(page, url, null, now);
        if (n) { processed++; chunksTotal += n; }
      } catch (e) {
        failed++; failures.push(`${url}: ${(e as Error).message}`);
        console.log(`✗ ${url}: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n■ done — ${processed} page(s) ingested, ${chunksTotal} chunk(s), ${failed} failed.`);
  if (failures.length) console.log('Failures:\n' + failures.join('\n'));
}

main()
  .catch((e) => { console.error('✖ failed:', e); process.exitCode = 1; })
  .finally(async () => { await closeConnection().catch(() => {}); });
