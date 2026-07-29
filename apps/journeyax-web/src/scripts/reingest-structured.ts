/**
 * Structured re-ingestion (steps 1–2) — recovers product fields already present
 * in the indexed text but never parsed into metadata, and tags troubleshooting
 * docs by category. ADDITIVE ONLY: it $set's metadata.* fields; it never touches
 * `content`, `embedding`, or `chunk`, so vector search is unaffected.
 *
 * Run dry (no writes):   DRY=1 npx tsx --env-file=.env apps/journeyax-web/src/scripts/reingest-structured.ts
 * Run for real:                npx tsx --env-file=.env apps/journeyax-web/src/scripts/reingest-structured.ts
 */
import { MongoClient } from 'mongodb';

const DRY = process.env.DRY === '1';

// Known Caroma spec labels (longest-first so "item material" wins over "item").
const SPEC_KEYS = [
  'item code', 'product types', 'item material', 'capacity size', 'capacity to overflow',
  'number of tap holes', 'independent living compliant', 'as1428.1 accessible',
  'wels rating', 'flow rate', 'installation type', 'range', 'brand', 'colour', 'color',
  'shape', 'overflow', 'material', 'finish', 'warranty', 'dimensions', 'width', 'height',
  'depth', 'weight', 'series',
].sort((a, b) => b.length - a.length);

function parseSpecs(content: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const start = content.indexOf('Specifications');
  if (start === -1) return specs;
  const end = content.indexOf('Product Codes', start);
  const section = content.slice(start + 'Specifications'.length, end === -1 ? start + 3000 : end);
  for (const block of section.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    const lower = block.toLowerCase();
    const key = SPEC_KEYS.find((k) => lower.startsWith(k));
    if (!key) continue;
    let value = block.slice(key.length).trim();
    // "range[Liano II](url)" → "Liano II"
    const link = value.match(/^\[([^\]]+)\]/);
    if (link) value = link[1].trim();
    value = value.replace(/\\+/g, '').trim();
    if (value && value.length < 120) specs[key] = value;
  }
  return specs;
}

function firstPrice(content: string): number | null {
  const m = content.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Category from a troubleshooting filename/title, e.g. basin_issue → Basins. */
function troubleshootCategory(doc: any): string | null {
  const s = `${doc.metadata?.url || ''} ${doc.title || ''}`.toLowerCase();
  const map: [RegExp, string][] = [
    [/basin/, 'Basins'], [/toilet|cistern|pan/, 'Toilet Suites'], [/shower/, 'Showers'],
    [/tap|mixer|tapware/, 'Tapware'], [/bath\b|bathtub/, 'Baths'], [/waste|drain/, 'Wastes'],
    [/sink|laundry/, 'Kitchen & Laundry'],
  ];
  for (const [re, cat] of map) if (re.test(s)) return cat;
  return null;
}

async function main() {
  const c = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10000 });
  await c.connect();
  const col = c.db('journeyx').collection('documents');
  console.log(DRY ? '── DRY RUN (no writes) ──' : '── LIVE RUN (writing metadata) ──');

  // ── Step 1: products ──────────────────────────────────────────────
  const products = col.find({ 'metadata.type': 'product' });
  let pCount = 0, pSku = 0, pPrice = 0, pColl = 0;
  const ops: any[] = [];
  const samples: string[] = [];
  for await (const doc of products as any) {
    const content: string = doc.content || '';
    const specs = parseSpecs(content);
    const sku = specs['item code'] || null;
    const price = firstPrice(content);
    const collection = specs['range'] || specs['series'] || null;
    const finish = specs['colour'] || specs['color'] || specs['finish'] || null;
    const category = specs['product types'] || null;

    const set: any = {};
    if (sku && !doc.metadata?.sku) { set['metadata.sku'] = sku; pSku++; }
    if (price != null && doc.metadata?.price == null) { set['metadata.price'] = price; pPrice++; }
    if (collection && !doc.metadata?.collection) { set['metadata.collection'] = collection; pColl++; }
    if (finish && !doc.metadata?.finish) set['metadata.finish'] = finish;
    if (category && !doc.metadata?.category) set['metadata.category'] = category;
    if (Object.keys(specs).length && !doc.metadata?.specs) set['metadata.specs'] = specs;

    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
    pCount++;
    if (samples.length < 6 && sku) samples.push(`   • ${(doc.title||'').slice(0,48)} | sku=${sku} price=${price} coll=${collection} finish=${finish}`);
  }
  console.log(`\nProducts scanned: ${pCount} — would set sku:${pSku} price:${pPrice} collection:${pColl}`);
  console.log('Samples:'); samples.forEach((s) => console.log(s));
  if (!DRY && ops.length) { await col.bulkWrite(ops); console.log(`  ✓ wrote ${ops.length} product updates`); }

  // ── Step 2: troubleshooting category tags ─────────────────────────
  const trOps: any[] = [];
  for await (const doc of col.find({ 'metadata.type': 'troubleshooting' }) as any) {
    const cat = troubleshootCategory(doc);
    if (cat && !doc.metadata?.category) trOps.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { 'metadata.category': cat } } } });
  }
  console.log(`\nTroubleshooting docs — would tag category: ${trOps.length}`);
  if (!DRY && trOps.length) { await col.bulkWrite(trOps); console.log(`  ✓ wrote ${trOps.length} troubleshooting tags`); }

  await c.close();
  console.log(DRY ? '\n(DRY RUN complete — re-run without DRY=1 to apply)' : '\n✓ Done.');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
