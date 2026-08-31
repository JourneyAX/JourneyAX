/**
 * One-time transform: PlaceMakers' real JSON-Patch product export
 * (/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl, 41,221 lines)
 * → a CSV matching csv-feed.ts's hardcoded Momentec/Augusta column vocabulary,
 * so the existing `csv-feed` pipeline stage can ingest it unmodified.
 *
 * PlaceMakers has no parent/variant (colour x size) split the way apparel does,
 * so this is one row per product: Parent_SKU = Item_SKU = the product id from
 * the JSON Patch `path` (e.g. "/products/1002486" -> "1002486").
 *
 * Field choices (see task notes for full rationale):
 *   - MSRP <- discountPrice when hasDiscount is true, else price (i.e. the real
 *     current sell price, not a pre-discount list price).
 *   - OriginalPrice <- price, but ONLY when hasDiscount is true (else we'd be
 *     fabricating a "was" price for items that were never discounted).
 *   - Category <- the leaf (last) segment of the first non-root category_paths
 *     branch.
 *   - Status <- "Discontinued" when discontinued===true, else blank (Active is
 *     the implicit default in csv-feed.ts, so we don't invent one).
 *   - Color/Size/Color_Hex_Value/UPC_Code/GTIN/Weight/Case_Pack_Qty/
 *     Swatch_Image_URL/Size_Chart_Image_URL/ProductVideoUrl/CompleteTheLook_JSON/
 *     Rating/Reviews left blank: not present in source data, and apparel-only
 *     concepts (colour/size) that don't apply to building materials.
 *   - Rows with no title are skipped (defensive against a messy real export).
 *
 * Usage: npx tsx src/scripts/transform-placemakers-csv.ts
 */
import { createReadStream, createWriteStream } from 'fs';
import readline from 'readline';
import path from 'path';

const SRC = '/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl';
const OUT = path.resolve(__dirname, '../../public/data/placemakers-products.csv');

const COLUMNS = [
  'Parent_SKU', 'Item_Name', 'Brand', 'Division', 'Item_Description', 'Category',
  'Features', 'Country_Of_Origin', 'Main_Image_URL', 'Other_Image_URL',
  'Swatch_Image_URL', 'Size_Chart_Image_URL', 'ProductVideoUrl',
  'CompleteTheLook_JSON', 'Rating', 'Reviews', 'OriginalPrice', 'Color',
  'Color_Hex_Value', 'Size', 'MSRP', 'Cost', 'Item_SKU', 'UPC_Code', 'GTIN',
  'Weight', 'Case_Pack_Qty', 'Status',
];

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function leafCategory(paths: any): string {
  if (!Array.isArray(paths)) return '';
  // category_paths is an array of branches; pick the first branch that isn't
  // just the synthetic "root" node and take its last (leaf) segment.
  for (const branch of paths) {
    if (!Array.isArray(branch) || !branch.length) continue;
    if (branch.length === 1 && branch[0]?.id === 'root') continue;
    const leaf = branch[branch.length - 1];
    if (leaf?.name) return String(leaf.name);
  }
  return '';
}

async function main() {
  const rl = readline.createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
  const out = createWriteStream(OUT);
  out.write(COLUMNS.map(csvEscape).join(',') + '\n');

  let lines = 0, parsed = 0, skippedNoTitle = 0, skippedBadJson = 0, skippedNotProduct = 0, written = 0;

  for await (const line of rl) {
    lines++;
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { skippedBadJson++; continue; }

    const p: string = rec?.path || '';
    if (!p.startsWith('/products/')) { skippedNotProduct++; continue; } // skip /items/... (CMS) etc.
    const id = p.slice('/products/'.length);
    const a = rec?.value?.attributes;
    if (!a) { skippedBadJson++; continue; }
    parsed++;

    const title = (a.title || '').trim();
    if (!title) { skippedNoTitle++; continue; }

    const hasDiscount = a.hasDiscount === true;
    const msrp = hasDiscount ? a.discountPrice : a.price;
    const originalPrice = hasDiscount ? a.price : '';
    const category = leafCategory(a.category_paths);
    const status = a.discontinued === true ? 'Discontinued' : '';

    const row: Record<string, unknown> = {
      Parent_SKU: id,
      Item_Name: title,
      Brand: a.brand || '',
      Division: a.subBrand || '',
      Item_Description: a.description || '',
      Category: category,
      Features: Array.isArray(a.keywords) ? a.keywords.join('; ') : '',
      Country_Of_Origin: '',
      Main_Image_URL: a.thumb_image || '',
      Other_Image_URL: '',
      Swatch_Image_URL: '',
      Size_Chart_Image_URL: '',
      ProductVideoUrl: '',
      CompleteTheLook_JSON: '',
      Rating: '',
      Reviews: '',
      OriginalPrice: originalPrice,
      Color: '',
      Color_Hex_Value: '',
      Size: '',
      MSRP: msrp ?? '',
      Cost: '',
      Item_SKU: id,
      UPC_Code: '',
      GTIN: '',
      Weight: '',
      Case_Pack_Qty: '',
      Status: status,
    };
    out.write(COLUMNS.map((c) => csvEscape(row[c])).join(',') + '\n');
    written++;
  }

  await new Promise((res) => out.end(res));
  console.log(JSON.stringify({ lines, parsed, written, skippedNoTitle, skippedBadJson, skippedNotProduct, out: OUT }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
