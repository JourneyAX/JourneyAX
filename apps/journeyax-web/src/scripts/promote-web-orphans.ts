/**
 * Step 2b — promote web-only products into the canonical catalogue.
 *
 * The CSV feeds don't carry every item: 378 products (mostly FreeStyle
 * Sublimated) exist on the site but not in the standard feed. Dropping them
 * would silently shrink the catalogue, so they're promoted to canonical records
 * with `source: 'web-scrape'` — clearly distinguishable from feed-sourced rows.
 *
 *   npx tsx src/scripts/promote-web-orphans.ts --project augusta
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
  const P = db.collection('products');
  const D = db.collection('documents');

  const csvSkus = new Set((await P.find({ projectId: PROJECT_ID }, { projection: { parentSku: 1 } }).toArray()).map((p: any) => p.parentSku));
  const web = await D.find({ projectId: PROJECT_ID, 'metadata.sku': { $exists: true } }).toArray();

  const byParent = new Map<string, any>();
  for (const d of web as any[]) {
    const parent = String(d.metadata.sku).replace(/^CUT_/, '');
    if (!parent || csvSkus.has(parent)) continue;
    const score = Object.keys(d.metadata?.specs || {}).length;
    const cur = byParent.get(parent);
    if (!cur || score > cur._score) byParent.set(parent, { ...d, _score: score });
  }
  console.log(`web-only products to promote: ${byParent.size}`);

  const now = new Date();
  const ops: any[] = [];
  for (const [parent, d] of byParent) {
    const m = d.metadata || {};
    const s = m.specs || {};
    const price = typeof m.price === 'number' ? m.price : undefined;
    const doc: Record<string, unknown> = {
      projectId: PROJECT_ID,
      parentSku: parent,
      name: d.title || parent,
      description: m.description || undefined,
      category: m.category || s.ItemType || undefined,
      isSublimation: /sublimat/i.test(`${d.title} ${s.productType || ''}`) || bool(s.isSublimation2D) === true,
      colors: [], sizes: [],
      images: Array.isArray(m.images) ? m.images : [],
      swatchImages: [], sizeChartImages: [], videos: [],
      ...(price != null ? { priceUSD: { min: price, max: price } } : {}),
      ...(s.MSRP_CAD ? { priceCAD: { min: parseFloat(s.MSRP_CAD), max: parseFloat(s.MSRP_CAD) } } : {}),
      variants: Array.isArray(m.variants) ? m.variants.map((v: any) => ({ itemSku: v.sku, color: v.finish })) : [],
      variantCount: Array.isArray(m.variants) ? m.variants.length : 0,
      web: {
        is3D: bool(s.is3D), isSublimation2D: bool(s.isSublimation2D),
        decorationMethods: list(s['Decoration Methods']),
        fabricContent: s['Fabric Content'] || undefined,
        fabricFeatures: s['Fabric Features'] || undefined,
        garmentType: s.garmentType || undefined, itemType: s.ItemType || undefined,
        gender: s.Gender || undefined, collection: s.collection || undefined,
        productUrl: d.sourceUrl || undefined,
      },
      source: 'web-scrape',
      updatedAt: now,
    };
    // prune undefined
    const w = doc.web as Record<string, unknown>;
    for (const k of Object.keys(w)) if (w[k] === undefined) delete w[k];
    ops.push({ updateOne: { filter: { projectId: PROJECT_ID, parentSku: parent }, update: { $set: doc }, upsert: true } });
  }

  let up = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const r = await P.bulkWrite(ops.slice(i, i + 500) as any[]);
    up += (r.upsertedCount || 0) + (r.modifiedCount || 0);
  }
  const total = await P.countDocuments({ projectId: PROJECT_ID });
  const feed = await P.countDocuments({ projectId: PROJECT_ID, source: 'csv-feed' });
  const scraped = await P.countDocuments({ projectId: PROJECT_ID, source: 'web-scrape' });
  console.log(`\n■ promoted ${up} | catalogue total: ${total} (csv-feed ${feed} + web-scrape ${scraped})`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
