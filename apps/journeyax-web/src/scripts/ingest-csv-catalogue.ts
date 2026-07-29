/**
 * Build the canonical product catalogue from the CSV feeds and persist it to
 * `journeyx.products` (structured, exactly-queryable — the FACT layer).
 *
 * Narrative generation (the vector/UNDERSTANDING layer) runs separately over
 * these records, so facts stay precise and only prose gets embedded.
 *
 *   npx tsx src/scripts/ingest-csv-catalogue.ts --project augusta [--dry]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient } from 'mongodb';
import { buildCatalogue, FeedUrls, CanonicalProduct } from '../services/knowledge/csv-feed';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PROJECT_ID = arg('project') || 'augusta';
const DRY = process.argv.includes('--dry');

const FEEDS: FeedUrls = {
  productUS: 'https://static.momentecbrands.com/productdata/product-data-std-all.csv',
  sublimationUS: 'https://static.momentecbrands.com/productdata/sublimation-product-data-std-all.csv',
  productCAD: 'https://static.momentecbrands.com/productdata/cad-product-data-std-all.csv',
  sublimationCAD: 'https://static.momentecbrands.com/productdata/cad-sublimation-product-data-std-all.csv',
  inventory: 'https://static.augustasportswear.com/productdata/inventorydata/ASG_inventory_data.csv',
};

async function main() {
  const cacheDir = path.resolve(__dirname, '../../../../data/augusta-feeds');
  console.log(`▶ building canonical catalogue for "${PROJECT_ID}"…`);
  const t0 = Date.now();
  const catalogue = await buildCatalogue(FEEDS, cacheDir, (m) => console.log('  ·', m));

  const products = [...catalogue.values()];
  const withUSD = products.filter((p) => p.priceUSD).length;
  const withCAD = products.filter((p) => p.priceCAD).length;
  const withImg = products.filter((p) => p.images.length).length;
  const withHex = products.filter((p) => p.colors.some((c) => c.hex)).length;
  const withChart = products.filter((p) => p.sizeChartImages.length).length;
  const withStock = products.filter((p) => p.totalStock).length;
  const variants = products.reduce((s, p) => s + p.variantCount, 0);
  const subl = products.filter((p) => p.isSublimation).length;

  console.log(`\n■ ${products.length.toLocaleString()} canonical products | ${variants.toLocaleString()} variants  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log(`   USD priced: ${withUSD} | CAD priced: ${withCAD} | images: ${withImg} | colour-hex: ${withHex} | size-charts: ${withChart} | in stock: ${withStock} | sublimation: ${subl}`);

  const sample = products.find((p) => p.priceCAD && p.colors.some((c) => c.hex) && p.variantCount > 3);
  if (sample) {
    console.log(`\n   sample → ${sample.parentSku} "${sample.name}"`);
    console.log(`     USD ${sample.priceUSD?.min}–${sample.priceUSD?.max} (cost ${sample.priceUSD?.cost}) | CAD ${sample.priceCAD?.min}–${sample.priceCAD?.max}`);
    console.log(`     colours ${sample.colors.length} (${sample.colors.slice(0, 3).map((c) => c.name + (c.hex ? ' ' + c.hex : '')).join(', ')}) | sizes ${sample.sizes.length} | variants ${sample.variantCount} | stock ${sample.totalStock ?? 'n/a'}`);
  }
  if (DRY) { console.log('\n(dry run — nothing written)'); return; }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db('journeyx').collection('products');
  await col.createIndex({ projectId: 1, parentSku: 1 }, { unique: true }).catch(() => {});
  await col.createIndex({ projectId: 1, 'variants.itemSku': 1 }).catch(() => {});

  const now = new Date();
  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < products.length; i += BATCH) {
    const ops = products.slice(i, i + BATCH).map((p: CanonicalProduct) => ({
      updateOne: {
        filter: { projectId: PROJECT_ID, parentSku: p.parentSku },
        update: { $set: { ...p, projectId: PROJECT_ID, source: 'csv-feed', updatedAt: now } },
        upsert: true,
      },
    }));
    const r = await col.bulkWrite(ops as any[]);
    written += (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
    process.stdout.write(`\r   writing… ${Math.min(i + BATCH, products.length)}/${products.length}`);
  }
  console.log(`\n■ persisted ${written.toLocaleString()} products to journeyx.products (projectId="${PROJECT_ID}")`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
