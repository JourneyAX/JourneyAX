/**
 * One-time transform: PlaceMakers' 183-article CMS content index
 * (/Users/mahaveer/Downloads/pmContentIndex-br-cronJob_20260821.jsonl) has real,
 * live URLs per article (relative paths, e.g. "/useful-contacts") but the
 * `kb-articles` pipeline stage (stageKbArticles in pipeline.ts) doesn't accept a
 * pre-extracted JSONL directly — it fetches a `sitemapUrl`/`url`, parses <loc>
 * tags out of it as XML, then CRAWLS each URL live with Playwright.
 *
 * Verified live: https://www.placemakers.co.nz/online/useful-contacts sits
 * behind an AWS WAF JS challenge that blocks plain curl (HTTP 202,
 * x-amzn-waf-action: challenge) but a headless Playwright chromium page.goto()
 * passes it fine and returns real rendered content (confirmed by inspection).
 * So this writes a synthetic XML sitemap containing the 183 REAL article URLs,
 * base-prefixed with https://www.placemakers.co.nz/online (confirmed against
 * the product URLs in the product feed, which use the same /online prefix, and
 * against a live fetch of one article), so stageKbArticles genuinely crawls
 * them live rather than us pre-writing article content ourselves.
 *
 * Usage: npx tsx src/scripts/transform-placemakers-sitemap.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const SRC = '/Users/mahaveer/Downloads/pmContentIndex-br-cronJob_20260821.jsonl';
const OUT = path.resolve(__dirname, '../../public/data/placemakers-content-sitemap.xml');
const BASE = 'https://www.placemakers.co.nz/online';

function main() {
  const lines = readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim());
  const urls: string[] = [];
  let skipped = 0;
  for (const line of lines) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    const u: string | undefined = rec?.value?.attributes?.url;
    if (!u) { skipped++; continue; }
    const full = u.startsWith('http') ? u : `${BASE}${u.startsWith('/') ? '' : '/'}${u}`;
    urls.push(full);
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  writeFileSync(OUT, xml);
  console.log(JSON.stringify({ lines: lines.length, urls: urls.length, skipped, out: OUT }, null, 2));
}

main();
