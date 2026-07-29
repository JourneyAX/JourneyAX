/**
 * Step 2 — merge the web-scraped layer onto the canonical CSV products.
 *
 * The CSV feed and the site scrape are complementary, NOT redundant:
 *   CSV only  → cost, UPC/GTIN, colour hex, size-chart URL, per-SKU colour+size
 *   Web only  → is3D / isSublimation2D (CONFIGURATOR flags), decoration methods,
 *               fabric content & features, garmentType, collection, MSRP_CAD,
 *               legacy style number, callouts
 *
 * Join key: Parent_SKU (the web `metadata.sku`, with any `CUT_` prefix stripped).
 * Nothing is overwritten — web fields land under `web.*` on the canonical record.
 *
 *   npx tsx src/scripts/merge-web-layer.ts --project augusta
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient } from 'mongodb';

function arg(n: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
const PROJECT_ID = arg('project') || 'augusta';

const bool = (v?: string) => (v == null ? undefined : /^true$/i.test(String(v).trim()));
const list = (v?: string) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const products = db.collection('products');
  const docs = db.collection('documents');

  // One web record per parent SKU (prefer the richest: most spec keys).
  const web = await docs.find({ projectId: PROJECT_ID, 'metadata.sku': { $exists: true } },
    { projection: { 'metadata.sku': 1, 'metadata.specs': 1, 'metadata.options': 1, 'metadata.variants': 1, 'metadata.documents': 1, title: 1, sourceUrl: 1 } }).toArray();
  console.log(`web docs: ${web.length}`);

  const best = new Map<string, any>();
  for (const d of web as any[]) {
    const raw = String(d.metadata?.sku || '');
    const parent = raw.replace(/^CUT_/, '');
    if (!parent) continue;
    const score = Object.keys(d.metadata?.specs || {}).length;
    const cur = best.get(parent);
    if (!cur || score > cur._score) best.set(parent, { ...d, _score: score, _isCut: raw.startsWith('CUT_') });
  }
  console.log(`unique parent SKUs from web: ${best.size}`);

  let matched = 0, unmatched = 0;
  const ops: any[] = [];
  for (const [parent, d] of best) {
    const s = d.metadata?.specs || {};
    const webLayer: Record<string, unknown> = {
      // ⭐ configurator flags — exist ONLY here
      is3D: bool(s.is3D),
      isSublimation2D: bool(s.isSublimation2D),
      decorationMethods: list(s['Decoration Methods']),
      fabricContent: s['Fabric Content'] || undefined,
      fabricFeatures: s['Fabric Features'] || undefined,
      garmentType: s.garmentType || undefined,
      itemType: s.ItemType || undefined,
      productType: s.productType || undefined,
      gender: s.Gender || undefined,
      colorFamily: s.ColorFamily || undefined,
      collection: s.collection || undefined,
      legacyStyleNumber: s['legacy style number'] || undefined,
      callout: s.Callout || undefined,
      msrpCAD: s.MSRP_CAD ? parseFloat(s.MSRP_CAD) : undefined,
      variantCountWeb: s['Variant count'] ? parseInt(s['Variant count'], 10) : undefined,
      productUrl: d.sourceUrl || undefined,
      hasCutVariant: !!d._isCut,
    };
    for (const k of Object.keys(webLayer)) if (webLayer[k] === undefined) delete webLayer[k];
    ops.push({ updateOne: { filter: { projectId: PROJECT_ID, parentSku: parent }, update: { $set: { web: webLayer, webMergedAt: new Date() } } } });
  }

  for (let i = 0; i < ops.length; i += 500) {
    const r = await products.bulkWrite(ops.slice(i, i + 500) as any[]);
    matched += r.matchedCount || 0;
  }
  unmatched = best.size - matched;

  console.log(`\n■ merged: ${matched} products enriched | ${unmatched} web SKUs had no CSV match`);
  const with3D = await products.countDocuments({ projectId: PROJECT_ID, 'web.is3D': true });
  const withDeco = await products.countDocuments({ projectId: PROJECT_ID, 'web.decorationMethods.0': { $exists: true } });
  const withFabric = await products.countDocuments({ projectId: PROJECT_ID, 'web.fabricContent': { $exists: true } });
  const withColl = await products.countDocuments({ projectId: PROJECT_ID, 'web.collection': { $exists: true } });
  console.log(`   3D configurator: ${with3D} | decoration methods: ${withDeco} | fabric: ${withFabric} | collection: ${withColl}`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
