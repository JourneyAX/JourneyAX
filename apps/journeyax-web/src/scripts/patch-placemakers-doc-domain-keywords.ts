/**
 * Lightweight, resilient fix for a real gap left by
 * apply-placemakers-domain-keywords.ts's first pass: the `documents`
 * (chunkIndex:0, the narrative doc) `metadata.domainKeywords` $set was
 * originally keyed on sourceUrl, but many of those documents still carry the
 * pre-URL-backfill synthetic `product://placemakers/<sku>` sourceUrl (the
 * backfill only ever patched metadata.url, deliberately never sourceUrl — see
 * patch-placemakers-doc-metadata.ts). That silently missed most of the
 * catalogue (only ~1,970/40,793 matched).
 *
 * This script does NOT recompute domain keywords or call any LLM/embedding
 * API — `products.metadata.domainKeywords` is already correct and persisted.
 * It just copies that value onto the matching `documents` record, joined by
 * the proven-safe key (metadata.sku === products.parentSku), exactly like
 * patch-placemakers-doc-metadata.ts. Purely additive — only
 * `metadata.domainKeywords` is touched, nothing else on the document.
 *
 * Written defensively for a cluster under heavy concurrent load (many other
 * dev services sharing the same Atlas cluster caused earlier attempts to hang
 * indefinitely on connection acquisition): small batches, retry-with-backoff
 * on transient errors, and a cursor rather than loading everything into
 * memory at once.
 *
 * Usage: npx tsx src/scripts/patch-placemakers-doc-domain-keywords.ts [--dry]
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
  const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
  await client.connect();
  const db = client.db('journeyx');
  const P = db.collection('products');
  const D = db.collection('documents');

  console.log('loading products with domainKeywords already set…');
  const rows = await P.find(
    { projectId: PROJECT_ID, 'metadata.domainKeywords.0': { $exists: true } },
    { projection: { parentSku: 1, 'metadata.domainKeywords': 1 } },
  ).toArray();
  const bySku = new Map<string, string[]>(rows.map((r: any) => [String(r.parentSku), r.metadata?.domainKeywords || []]));
  console.log(`  ${bySku.size} products loaded`);

  const cursor = D.find(
    { projectId: PROJECT_ID, 'metadata.type': 'product', chunkIndex: 0 },
    { projection: { 'metadata.sku': 1, 'metadata.domainKeywords': 1 } },
  );

  let seen = 0, matched = 0, alreadySet = 0, opsBuilt = 0, modified = 0;
  let ops: any[] = [];
  const BATCH = 300;

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
        const transient = /NotWritablePrimary|not master|connection.*closed|ECONNRESET|topology was destroyed|connection within the time limit|PooledConnectionAcquisitionExceededTimeLimit/i.test(String(e?.message || e));
        if (!transient || attempt > 8) throw e;
        const wait = Math.min(2000 * attempt, 15000);
        console.warn(`\n  transient write error (attempt ${attempt}) — retrying in ${wait}ms: ${String(e?.message || e).slice(0, 100)}`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  };

  for await (const doc of cursor) {
    seen++;
    const sku = String((doc as any).metadata?.sku || '').trim();
    const kw = sku ? bySku.get(sku) : undefined;
    if (!kw || !kw.length) continue;
    matched++;
    if ((doc as any).metadata?.domainKeywords?.length) { alreadySet++; continue; }

    ops.push({ updateOne: { filter: { _id: (doc as any)._id }, update: { $set: { 'metadata.domainKeywords': kw } } } });
    opsBuilt++;
    if (ops.length >= BATCH) {
      await flush();
      process.stdout.write(`\r  seen ${seen} | matched ${matched} | alreadySet ${alreadySet} | modified ${modified}`);
    }
  }
  await flush();
  process.stdout.write('\n');

  console.log(JSON.stringify({ seen, matched, alreadySet, opsBuilt, modified, dry: DRY }, null, 2));
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
