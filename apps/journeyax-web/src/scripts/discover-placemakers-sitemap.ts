/**
 * Legitimate URL-universe discovery for PlaceMakers, WITHOUT ever touching
 * the gated category-browse pages (confirmed CAPTCHA/interactive
 * human-verification gate — off-limits per hard constraint).
 *
 * Step 1: fetch https://www.placemakers.co.nz/online/robots.txt and
 *         https://www.placemakers.co.nz/online/sitemap.xml (and a short list
 *         of common SAP Commerce Cloud sitemap conventions) using the SAME
 *         proven technique already used for the 183-article CMS crawl and the
 *         PDP spec-check proof run: headless Playwright chromium page.goto(),
 *         which passes the site's AWS WAF JS challenge automatically (no
 *         human interaction, no CAPTCHA-solving — this is not the gate named
 *         in the hard constraint, it's the same non-interactive JS challenge
 *         already confirmed passable this way for every non-category page).
 *
 * Step 2: if a real sitemap is found, parse <loc> URLs and report counts +
 *         patterns. This script does NOT write to the DB.
 *
 * RESULT (2026-08-26): /online/robots.txt IS real and loads cleanly (no
 * gate), and it declares `Sitemap: https://www.placemakers.co.nz/online/sitemap.xml`.
 * BUT that declared sitemap URL itself returns a genuine, consistently
 * reproduced HTTP 500 "Server Error" (not a WAF/CAPTCHA response — no
 * x-amzn-waf-action header, no challenge page, just a broken server-side
 * route), confirmed 3x in a row. Every other common SAP Commerce Cloud
 * sitemap path tried (sitemapindex.xml, sitemap_index.xml, sitemap/index.xml,
 * sitemap-product(s).xml, product-sitemap.xml, sitemaps/sitemap.xml,
 * nz/sitemap.xml) returns the site's normal rendered 404 page (not gated
 * either — just genuinely doesn't exist). Conclusion: PlaceMakers advertises
 * a sitemap in robots.txt but does not actually serve a working one. There is
 * no legitimate sitemap-based way to enumerate the full URL universe.
 *
 * Usage: npx tsx src/scripts/discover-placemakers-sitemap.ts
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

const BASE = 'https://www.placemakers.co.nz/online';
const CANDIDATES = [
  '/robots.txt',
  '/sitemap.xml',
];

async function main() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results: { url: string; status: number | null; ok: boolean; bytes: number; snippet: string; error?: string }[] = [];

  try {
    for (const c of CANDIDATES) {
      const url = `${BASE}${c}`;
      const t0 = Date.now();
      if (c !== CANDIDATES[0]) await page.waitForTimeout(4000);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3500);
        const status = resp?.status() ?? null;
        const body = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const raw = text && text.length > 0 ? text : body;
        results.push({
          url,
          status,
          ok: !!resp?.ok(),
          bytes: raw.length,
          snippet: raw.slice(0, 300).replace(/\s+/g, ' '),
        });
        console.log(`[${Date.now() - t0}ms] ${url} -> HTTP ${status}, ${raw.length} bytes`);
        console.log(`   FULL BODY:\n${raw}`);

        // HARD SAFETY CHECK: if this landed on an interactive human-verification
        // / CAPTCHA page (not the automatic non-interactive WAF JS challenge),
        // stop immediately and do not interact with it or try anything else.
        const lower = raw.toLowerCase();
        if (/captcha|verify you are human|press and hold|are you a robot|i'm not a robot|human verification/.test(lower)) {
          console.log(`   !! DETECTED interactive human-verification challenge at ${url}. STOPPING per hard constraint — not interacting.`);
          break;
        }
      } catch (e: any) {
        results.push({ url, status: null, ok: false, bytes: 0, snippet: '', error: String(e?.message || e).slice(0, 200) });
        console.log(`[${Date.now() - t0}ms] ${url} -> FAILED: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n■ SUMMARY');
  for (const r of results) {
    console.log(`  ${r.url}: status=${r.status} ok=${r.ok} bytes=${r.bytes}${r.error ? ' error=' + r.error : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
