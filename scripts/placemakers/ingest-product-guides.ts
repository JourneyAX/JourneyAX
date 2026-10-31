/**
 * Copies the guides that ride with each product in a tenant's master data file (the specification guide, installation
 * guide or instruction manual, as text) into the `product_guides` collection, so the agent can read what a guide says.
 *
 * A guide that many products share (every size of one paint carries the same file) is stored once and lists the products
 * that carry it. Nothing is written without --apply, and --apply needs --db: the database is always named, never assumed,
 * so a rehearsal against a scratch database cannot turn into a write to the live one by leaving something out.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/ingest-product-guides.ts <master.jsonl>
 *        [--tenant placemakers] [--only-skus 4410133,3140076] [--db <database>] [--apply]
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/ingest-product-guides.ts --remove --db <database> [--tenant placemakers] [--apply]
 *
 * Without --apply it reads the file and prints what would be written (no connection is made). --remove undoes a load: it
 * deletes the tenant's guides from the named database (the agent then simply finds no guide text, as before).
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { connectToDatabase } from '@journeyax/database';
import { guideDocId, guidesFromProductRecord, type ProductGuideRecord } from '../../apps/journey-runtime-service/src/agent/product-guides';
import { COLLECTION_PRODUCT_GUIDES } from '../../apps/journey-runtime-service/src/kernel/product-guide.repository';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REMOVE = flag('remove');
const FILE = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
if (!FILE && !REMOVE) throw new Error('usage: ingest-product-guides.ts <master.jsonl> [--tenant placemakers] [--only-skus a,b] [--db <database>] [--apply]  |  --remove --db <database> [--apply]');
const TENANT = (option('tenant') || 'placemakers').toLowerCase();
const ONLY = new Set((option('only-skus') || '').split(',').map((sku) => sku.trim()).filter(Boolean));
const APPLY = flag('apply');
const DB_NAME = option('db');
if ((APPLY || REMOVE) && !DB_NAME) throw new Error('--apply and --remove need --db <database>: name the database to change (a scratch one to rehearse, the live one to publish).');

const BATCH = 20;
const PAUSE_MS = 120;
const MAX_TEXT_CHARS = 600_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(): Promise<{ records: Map<string, ProductGuideRecord>; products: number; withGuide: number }> {
  const records = new Map<string, ProductGuideRecord>();
  let products = 0;
  let withGuide = 0;
  const lines = createInterface({ input: createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    products++;
    if (!line.includes('"documents"')) continue;
    let product: any;
    try { product = JSON.parse(line); } catch { continue; }
    const sku = String(product?.sku ?? product?.parentSku ?? '').trim();
    if (!sku || (ONLY.size > 0 && !ONLY.has(sku))) continue;
    const guides = guidesFromProductRecord(product);
    if (guides.length === 0) continue;
    withGuide++;
    for (const guide of guides) {
      const docId = guideDocId(guide.url, guide.title, guide.text);
      const known = records.get(docId);
      if (known) { if (!known.skus.includes(sku)) known.skus.push(sku); continue; }
      const text = guide.text.length > MAX_TEXT_CHARS ? guide.text.slice(0, MAX_TEXT_CHARS) : guide.text;
      records.set(docId, { tenantId: TENANT, docId, title: guide.title, kind: guide.kind, url: guide.url, pages: guide.pages, text, textChars: text.length, ...(text.length < guide.text.length ? { truncated: true } : {}), skus: [sku], updatedAt: new Date() });
    }
  }
  return { records, products, withGuide };
}

async function remove() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const { db, client } = await connectToDatabase(uri, DB_NAME!);
  try {
    const col = db.collection<ProductGuideRecord>(COLLECTION_PRODUCT_GUIDES);
    const count = await col.countDocuments({ tenantId: TENANT });
    if (!APPLY) { console.log(`Dry run: ${count} guides of tenant ${TENANT} in database "${DB_NAME}" would be deleted. Add --apply to delete.`); return; }
    const result = await col.deleteMany({ tenantId: TENANT });
    console.log(`Deleted ${result.deletedCount} guides of tenant ${TENANT} from database "${DB_NAME}".`);
  } finally {
    await (client as any)?.close?.();
  }
}

(async () => {
  if (REMOVE) return remove();
  const { records, products, withGuide } = await collect();
  const all = [...records.values()];
  const chars = all.reduce((sum, record) => sum + record.textChars, 0);
  const byTitle = new Map<string, number>();
  for (const record of all) byTitle.set(record.title, (byTitle.get(record.title) || 0) + 1);
  const links = all.reduce((sum, record) => sum + record.skus.length, 0);
  console.log(`tenant ${TENANT}: ${products} product records read, ${withGuide} carry a guide with text`);
  console.log(`${all.length} distinct guides (${links} product links), ${(chars / 1e6).toFixed(1)} million characters of text`);
  console.log(`by title: ${[...byTitle].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([title, n]) => `${title} ${n}`).join(', ')}`);
  const largest = all.reduce((best, record) => (record.textChars > best.textChars ? record : best), all[0]);
  if (largest) console.log(`largest: "${largest.title}" ${largest.textChars} characters, carried by ${largest.skus.length} products`);
  const cut = all.filter((record) => record.truncated).length;
  if (cut > 0) console.log(`${cut} guides were longer than ${MAX_TEXT_CHARS} characters and were cut there (marked truncated)`);
  if (!APPLY) {
    console.log('\nDry run: nothing was written. Add --db <database> --apply to write.');
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const { db, client } = await connectToDatabase(uri, DB_NAME!);
  try {
    const col = db.collection<ProductGuideRecord>(COLLECTION_PRODUCT_GUIDES);
    await col.createIndex({ tenantId: 1, docId: 1 }, { unique: true });
    await col.createIndex({ tenantId: 1, skus: 1 });
    let written = 0;
    for (let start = 0; start < all.length; start += BATCH) {
      const batch = all.slice(start, start + BATCH);
      await col.bulkWrite(batch.map((record) => ({ replaceOne: { filter: { tenantId: record.tenantId, docId: record.docId }, replacement: record, upsert: true } })), { ordered: false });
      written += batch.length;
      if (written % 400 === 0 || written === all.length) console.log(`  ${written} / ${all.length}`);
      await sleep(PAUSE_MS);
    }
    console.log(`\nWrote ${written} guides to database "${DB_NAME}", collection ${COLLECTION_PRODUCT_GUIDES}.`);
  } finally {
    await (client as any)?.close?.();
  }
})().catch((error) => { console.error(error?.message || error); process.exit(1); });
