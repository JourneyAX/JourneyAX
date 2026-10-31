/**
 * Copies the shop's own web pages (project how-tos, inspiration, compliance notes, trade-tool pages) from a tenant's crawled
 * content file into the `content_pages` collection, so the agent can read what they say and show the products they feature.
 *
 * Nothing is written without --apply, and --apply needs --db: the database is always named, never assumed, so a rehearsal against
 * a scratch database cannot turn into a write to the live one by leaving something out.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/ingest-content-pages.ts <content.jsonl>
 *        [--tenant placemakers] [--db <database>] [--apply]
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/ingest-content-pages.ts --remove --db <database> [--tenant placemakers] [--apply]
 *
 * Without --apply it reads the file and prints what would be written (no connection is made). --remove undoes a load.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { connectToDatabase } from '@journeyax/database';
import { contentPageFromRow, type ContentPageRecord } from '../../apps/journey-runtime-service/src/agent/content-pages';
import { COLLECTION_CONTENT_PAGES } from '../../apps/journey-runtime-service/src/kernel/content-page.repository';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REMOVE = flag('remove');
const FILE = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
if (!FILE && !REMOVE) throw new Error('usage: ingest-content-pages.ts <content.jsonl> [--tenant placemakers] [--db <database>] [--apply]  |  --remove --db <database> [--apply]');
const TENANT = (option('tenant') || 'placemakers').toLowerCase();
const APPLY = flag('apply');
const DB_NAME = option('db');
if ((APPLY || REMOVE) && !DB_NAME) throw new Error('--apply and --remove need --db <database>: name the database to change (a scratch one to rehearse, the live one to publish).');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(): Promise<{ pages: Map<string, ContentPageRecord>; rows: number; skipped: number }> {
  const pages = new Map<string, ContentPageRecord>();
  let rows = 0;
  let skipped = 0;
  const lines = createInterface({ input: createReadStream(FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    rows++;
    let row: any;
    try { row = JSON.parse(line); } catch { skipped++; continue; }
    const page = contentPageFromRow(row);
    if (!page) { skipped++; continue; }
    if (!pages.has(page.pageId)) pages.set(page.pageId, { ...page, tenantId: TENANT, updatedAt: new Date() });
  }
  return { pages, rows, skipped };
}

async function withCollection<T>(use: (col: import('mongodb').Collection<ContentPageRecord>) => Promise<T>): Promise<T> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const { db, client } = await connectToDatabase(uri, DB_NAME!);
  try {
    return await use(db.collection<ContentPageRecord>(COLLECTION_CONTENT_PAGES));
  } finally {
    await (client as any)?.close?.();
  }
}

(async () => {
  if (REMOVE) {
    await withCollection(async (col) => {
      const count = await col.countDocuments({ tenantId: TENANT });
      if (!APPLY) { console.log(`Dry run: ${count} pages of tenant ${TENANT} in database "${DB_NAME}" would be deleted. Add --apply to delete.`); return; }
      const result = await col.deleteMany({ tenantId: TENANT });
      console.log(`Deleted ${result.deletedCount} pages of tenant ${TENANT} from database "${DB_NAME}".`);
    });
    return;
  }
  const { pages, rows, skipped } = await collect();
  const all = [...pages.values()];
  const chars = all.reduce((sum, page) => sum + page.textChars, 0);
  const links = all.reduce((sum, page) => sum + page.products.length, 0);
  const byLabel = new Map<string, number>();
  for (const page of all) for (const label of page.categories.slice(0, 1)) byLabel.set(label, (byLabel.get(label) || 0) + 1);
  console.log(`tenant ${TENANT}: ${rows} rows read, ${all.length} pages kept (${skipped} had no title, address or text)`);
  console.log(`${(chars / 1e6).toFixed(2)} million characters of text, ${all.filter((page) => page.products.length > 0).length} pages feature products (${links} product links)`);
  console.log(`first label of the pages: ${[...byLabel].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => `${label} ${n}`).join(', ')}`);
  const cut = all.filter((page) => page.truncated).length;
  if (cut > 0) console.log(`${cut} pages were longer than the store keeps and were cut (marked truncated)`);
  if (!APPLY) {
    console.log('\nDry run: nothing was written. Add --db <database> --apply to write.');
    return;
  }
  await withCollection(async (col) => {
    await col.createIndex({ tenantId: 1, pageId: 1 }, { unique: true });
    let written = 0;
    for (let start = 0; start < all.length; start += 20) {
      const batch = all.slice(start, start + 20);
      await col.bulkWrite(batch.map((page) => ({ replaceOne: { filter: { tenantId: page.tenantId, pageId: page.pageId }, replacement: page, upsert: true } })), { ordered: false });
      written += batch.length;
      await sleep(120);
    }
    console.log(`\nWrote ${written} pages to database "${DB_NAME}", collection ${COLLECTION_CONTENT_PAGES}.`);
  });
})().catch((error) => { console.error(error?.message || error); process.exit(1); });
