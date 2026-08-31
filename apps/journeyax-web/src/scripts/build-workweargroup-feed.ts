/**
 * build-workweargroup-feed.ts — scrapes the real, already-discovered Workwear
 * Group product URLs (see /tmp/urls_{hy,kg,nnt,tww}.txt, found during the earlier
 * discovery pass over the four public storefronts) and writes them out as a CSV
 * in the EXACT schema `csv-feed.ts` (the same connector every other tenant's
 * catalogue feed goes through) expects — Parent_SKU, Item_SKU, Item_Name, etc.
 *
 * This does NOT ingest anything itself. It only produces
 *   data/workweargroup/feeds/workweargroup-products.csv
 * which is then picked up by the REAL, job-tracked pipeline (run-ingest.ts →
 * pipeline.ts stageCsvFeeds) via a `csv-feed` knowledgeSource.sources[] entry,
 * exactly like every other tenant's product feed.
 *
 *   npx tsx src/scripts/build-workweargroup-feed.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { chromium } from 'playwright';
import * as fs from 'fs';
import { extractPage } from '../services/knowledge/extractor';

const CAP = { tww: 20, hy: 16, kg: 11, nnt: 20 } as const;
const BRAND_NAME: Record<string, string> = { hy: 'Hard Yakka', kg: 'KingGee', nnt: 'NNT', tww: 'Totally Workwear' };

function readUrls(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function skuFromUrl(url: string): string {
  const last = url.replace(/\/$/, '').split('/').pop() || url;
  return last.replace(/\.html?$/i, '').replace(/[?#].*$/, '').slice(0, 64);
}

async function main() {
  const rows: Record<string, string>[] = [];
  const failures: string[] = [];
  let n = 0;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { (globalThis as any).__name = (fn: unknown) => fn; });

  for (const [tag, cap] of Object.entries(CAP)) {
    const urls = readUrls(`/tmp/urls_${tag}.txt`).slice(0, cap);
    console.log(`▶ ${BRAND_NAME[tag]}: ${urls.length} product URL(s)`);
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000);
        const x = await extractPage(page, url);
        if ((x.bodyText || '').trim().length < 100) { console.log(`— thin: ${url}`); continue; }

        const parentSku = x.sku || skuFromUrl(url);
        const colours = x.variants.length ? x.variants.map((v) => v.finish).filter(Boolean) : [];
        const sizes = x.options?.Size || x.options?.size || [];

        if (colours.length || sizes.length) {
          // One row per colour (and, where present, per size) so the connector's
          // colour/size vocabularies are populated exactly as a real feed would.
          const combos = colours.length ? colours : [undefined];
          for (const colour of combos) {
            const sizeList = sizes.length ? sizes : [undefined];
            for (const size of sizeList) {
              rows.push({
                Parent_SKU: parentSku,
                Item_SKU: `${parentSku}${colour ? '-' + colour.replace(/\s+/g, '').slice(0, 8) : ''}${size ? '-' + size : ''}`,
                Item_Name: x.title,
                Brand: BRAND_NAME[tag],
                Division: 'Workwear',
                Item_Description: x.description || x.shortDescription || '',
                Category: x.category || BRAND_NAME[tag],
                Features: Object.entries(x.specs || {}).map(([k, v]) => `${k}: ${v}`).join('; '),
                Country_Of_Origin: '',
                Main_Image_URL: x.images[0] || '',
                Other_Image_URL: x.images[1] || '',
                Color: colour || '',
                Color_Hex_Value: '',
                Size: size || '',
                MSRP: x.price != null ? String(x.price) : '',
                Cost: '',
                UPC_Code: '',
                GTIN: '',
                Weight: '',
                Case_Pack_Qty: '',
                Status: x.availability || 'Active',
                Rating: x.rating != null ? String(x.rating) : '',
                Reviews: x.reviewCount != null ? String(x.reviewCount) : '',
                OriginalPrice: x.priceMax != null && x.priceMax !== x.price ? String(x.priceMax) : '',
              });
            }
          }
        } else {
          rows.push({
            Parent_SKU: parentSku,
            Item_SKU: parentSku,
            Item_Name: x.title,
            Brand: BRAND_NAME[tag],
            Division: 'Workwear',
            Item_Description: x.description || x.shortDescription || '',
            Category: x.category || BRAND_NAME[tag],
            Features: Object.entries(x.specs || {}).map(([k, v]) => `${k}: ${v}`).join('; '),
            Country_Of_Origin: '',
            Main_Image_URL: x.images[0] || '',
            Other_Image_URL: x.images[1] || '',
            Color: '', Color_Hex_Value: '', Size: '',
            MSRP: x.price != null ? String(x.price) : '',
            Cost: '', UPC_Code: '', GTIN: '', Weight: '', Case_Pack_Qty: '',
            Status: x.availability || 'Active',
            Rating: x.rating != null ? String(x.rating) : '',
            Reviews: x.reviewCount != null ? String(x.reviewCount) : '',
            OriginalPrice: '',
          });
        }
        n++;
        console.log(`✓ [${n}] ${parentSku} · ${x.images.length}img ${x.price != null ? '$' + x.price : ''} · ${x.title.slice(0, 60)}`);
      } catch (e) {
        failures.push(`${url}: ${(e as Error).message}`);
        console.log(`✗ ${url}: ${(e as Error).message}`);
      }
    }
  }
  await browser.close();

  const header = ['Parent_SKU', 'Item_SKU', 'Item_Name', 'Brand', 'Division', 'Item_Description', 'Category',
    'Features', 'Country_Of_Origin', 'Main_Image_URL', 'Other_Image_URL', 'Color', 'Color_Hex_Value', 'Size',
    'MSRP', 'Cost', 'UPC_Code', 'GTIN', 'Weight', 'Case_Pack_Qty', 'Status', 'Rating', 'Reviews', 'OriginalPrice'];
  const csv = [header.join(',')]
    .concat(rows.map((r) => header.map((h) => csvEscape(r[h])).join(',')))
    .join('\n');

  const outDir = path.resolve(__dirname, '../../../../data/workweargroup/feeds');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'workweargroup-products.csv');
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(`\n■ wrote ${rows.length} row(s) for ${n} product(s) to ${outFile}`);
  if (failures.length) console.log(`  ${failures.length} failure(s):\n` + failures.join('\n'));
}

main().catch((e) => { console.error('✖ failed:', e); process.exitCode = 1; });
