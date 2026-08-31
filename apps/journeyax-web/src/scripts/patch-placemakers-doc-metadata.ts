/**
 * Propagate the additive PlaceMakers fields (backfill-placemakers-fields.ts)
 * into the RETRIEVAL layer the agent actually reads.
 *
 * product.service.ts's search() returns `metadata.url` (falling back to
 * sourceUrl) as the `url` the LLM cites, plus (after this task) `stock` and
 * `categoryPath`. Those `documents` records were written by
 * stageNarratives (pipeline.ts) BEFORE the field-backfill ran, using the
 * synthetic `product://placemakers/<sku>` placeholder for url and no
 * stock/categoryPath at all. Waiting for a full re-narration (another
 * OpenAI + embedding pass over 41k products) just to pick up fields that
 * already live on the `products` collection would be wasteful — this script
 * instead patches ONLY the metadata.url / metadata.stock / metadata.categoryPath
 * fields on the existing `documents` records directly, keyed by
 * metadata.sku === products.parentSku.
 *
 * Does NOT touch sourceUrl (the upsert key stageNarratives uses — changing it
 * would create duplicate documents on the next narrative run), embedding,
 * content, or chunk. Purely additive metadata enrichment.
 *
 * Usage: npx tsx src/scripts/patch-placemakers-doc-metadata.ts [--dry]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient } from 'mongodb';

const PROJECT_ID = 'placemakers';
const DRY = process.argv.includes('--dry');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const P = db.collection('products');
  const D = db.collection('documents');

  console.log('loading products fields into memory…');
  const rows = await P.find(
    { projectId: PROJECT_ID },
    { projection: { parentSku: 1, url: 1, stock: 1, categoryPath: 1 } },
  ).toArray();
  const bySku = new Map<string, any>(rows.map((r: any) => [String(r.parentSku), r]));
  console.log(`  ${bySku.size} products loaded`);

  const cursor = D.find(
    { projectId: PROJECT_ID, 'metadata.type': 'product' },
    { projection: { 'metadata.sku': 1 } },
  );

  let seen = 0, matched = 0, opsBuilt = 0, modified = 0;
  let ops: any[] = [];
  const BATCH = 500;

  const flush = async () => {
    if (!ops.length) return;
    if (DRY) { ops = []; return; }
    const batch = ops; ops = [];
    let attempt = 0;
    for (;;) {
      try {
        const r = await D.bulkWrite(batch, { ordered: false });
        modified += r.modifiedCount || 0;
        return;
      } catch (e: any) {
        attempt++;
        const transient = /NotWritablePrimary|not master|connection.*closed|ECONNRESET|topology was destroyed/i.test(String(e?.message || e));
        if (!transient || attempt > 5) throw e;
        const wait = Math.min(2000 * attempt, 10000);
        console.warn(`\n  transient write error (attempt ${attempt}) — retrying in ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  };

  for await (const doc of cursor) {
    seen++;
    const sku = String((doc as any).metadata?.sku || '').trim();
    const p = sku ? bySku.get(sku) : undefined;
    if (!p) continue;
    matched++;

    const set: Record<string, unknown> = {};
    if (p.url) set['metadata.url'] = p.url;
    if (p.stock) set['metadata.stock'] = p.stock;
    if (p.categoryPath?.length) set['metadata.categoryPath'] = p.categoryPath;
    if (!Object.keys(set).length) continue;

    ops.push({ updateOne: { filter: { _id: (doc as any)._id }, update: { $set: set } } });
    opsBuilt++;
    if (ops.length >= BATCH) {
      await flush();
      process.stdout.write(`\r  seen ${seen} | matched ${matched} | modified ${modified}`);
    }
  }
  await flush();
  process.stdout.write('\n');

  console.log(JSON.stringify({ seen, matched, opsBuilt, modified, dry: DRY }, null, 2));
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
