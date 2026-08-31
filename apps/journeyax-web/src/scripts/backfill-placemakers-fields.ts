/**
 * ADDITIVE field backfill for the PlaceMakers tenant (projectId: 'placemakers').
 *
 * The original onboarding (transform-placemakers-csv.ts -> csv-feed.ts) reshaped
 * the real source export into the apparel CSV vocabulary, which silently dropped
 * fields that exist in the real source and matter for a building-materials
 * assistant: the real PDP url, per-branch stock, full category hierarchy,
 * subclass, delivery/pickup/national-supply flags and promotion tags.
 *
 * This script reads the SAME source file directly
 * (/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl, JSON-Patch,
 * one line per product) and does a per-product `updateOne($set)` against the
 * EXISTING journeyx.products documents, matched by parentSku === the product id
 * from the JSON-Patch `path` (e.g. "/products/1002486" -> "1002486").
 *
 * Adds, never removes or overwrites unrelated fields:
 *   - url                  <- value.attributes.url (real PDP URL)
 *   - web.productUrl       <- same URL, so the narrative/embedding pipeline
 *                             (pipeline.ts stageNarratives) picks up the real
 *                             URL on any future re-narration instead of the
 *                             synthetic product://placemakers/<sku> placeholder.
 *   - stock                <- derived from branchAvailability (see below)
 *   - promotionTags        <- as-is array
 *   - categoryPath          <- full category_paths hierarchy (all named segments,
 *                             root dropped); `category` (leaf) is left untouched.
 *   - subClassName, subClassCode
 *   - deliveryOptions, nationallySupplied, pickupOnly, availability
 *
 * branchAvailability format (confirmed by inspection of 500+ sample records):
 * every entry is exactly 5 chars: a 3-digit branch code + 2 flag letters, and
 * only "YN" or "YY" ever appear (never "NN"/"NY") — so the first flag is a
 * constant "ranged at this branch" bit and the second is the real "in stock
 * now" bit. stock is derived as:
 *   { branchCount, availableBranchCount, branches: [{ code, inStock }] }
 *
 * Scope safety: every DB read/write is explicitly filtered to
 * projectId: 'placemakers'. No other tenant's documents are touched.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-placemakers-fields.ts [--dry] [--limit N]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { createReadStream } from 'fs';
import readline from 'readline';
import { MongoClient } from 'mongodb';

const SRC = '/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl';
const PROJECT_ID = 'placemakers';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry');
const LIMIT = arg('limit') ? Number(arg('limit')) : undefined;

function parseBranchAvailability(ba: unknown): { branchCount: number; availableBranchCount: number; branches: { code: string; inStock: boolean }[] } | undefined {
  if (!Array.isArray(ba) || !ba.length) return undefined;
  const branches: { code: string; inStock: boolean }[] = [];
  for (const raw of ba) {
    const s = String(raw || '');
    const m = /^(\d+)([A-Z])([A-Z])$/.exec(s);
    if (!m) continue;
    branches.push({ code: m[1], inStock: m[3] === 'Y' });
  }
  if (!branches.length) return undefined;
  return {
    branchCount: branches.length,
    availableBranchCount: branches.filter((b) => b.inStock).length,
    branches,
  };
}

function categoryPathFromPaths(paths: any): string[] {
  if (!Array.isArray(paths)) return [];
  for (const branch of paths) {
    if (!Array.isArray(branch) || !branch.length) continue;
    if (branch.length === 1 && branch[0]?.id === 'root') continue;
    return branch.map((seg: any) => String(seg?.name || '').trim()).filter(Boolean);
  }
  return [];
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db('journeyx').collection('products');

  const rl = readline.createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });

  let lines = 0, parsed = 0, skippedNotProduct = 0, skippedBadJson = 0, noId = 0;
  let opsBuilt = 0, matched = 0, modified = 0;
  const BATCH = 500;
  let ops: any[] = [];

  const flush = async () => {
    if (!ops.length) return;
    if (DRY) { ops = []; return; }
    const batch = ops;
    ops = [];
    // Transient replica-set failovers (NotWritablePrimary etc.) happen on a
    // long-running Atlas write while other jobs (e.g. the narrative embedder)
    // are also active — retry a few times with backoff instead of aborting
    // the whole run and losing already-computed progress.
    let attempt = 0;
    for (;;) {
      try {
        const r = await col.bulkWrite(batch, { ordered: false });
        matched += r.matchedCount || 0;
        modified += r.modifiedCount || 0;
        return;
      } catch (e: any) {
        attempt++;
        const transient = /NotWritablePrimary|not master|connection.*closed|ECONNRESET|topology was destroyed/i.test(String(e?.message || e));
        if (!transient || attempt > 5) throw e;
        const wait = Math.min(2000 * attempt, 10000);
        console.warn(`\n  transient write error (attempt ${attempt}): ${String(e?.message || e).slice(0, 120)} — retrying in ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  };

  for await (const line of rl) {
    lines++;
    if (!line.trim()) continue;
    if (LIMIT && parsed >= LIMIT) break;
    let rec: any;
    try { rec = JSON.parse(line); } catch { skippedBadJson++; continue; }

    const p: string = rec?.path || '';
    if (!p.startsWith('/products/')) { skippedNotProduct++; continue; }
    const id = p.slice('/products/'.length);
    if (!id) { noId++; continue; }
    const a = rec?.value?.attributes;
    if (!a) { skippedBadJson++; continue; }
    parsed++;

    const url: string | undefined = a.url || undefined;
    const stock = parseBranchAvailability(a.branchAvailability);
    const categoryPath = categoryPathFromPaths(a.category_paths);

    const set: Record<string, unknown> = {};
    if (url) { set.url = url; set['web.productUrl'] = url; }
    if (stock) set.stock = stock;
    if (Array.isArray(a.promotionTags)) set.promotionTags = a.promotionTags;
    if (categoryPath.length) set.categoryPath = categoryPath;
    if (a.subClassName != null) set.subClassName = a.subClassName;
    if (a.subClassCode != null) set.subClassCode = a.subClassCode;
    if (Array.isArray(a.deliveryOptions)) set.deliveryOptions = a.deliveryOptions;
    if (typeof a.nationallySupplied === 'boolean') set.nationallySupplied = a.nationallySupplied;
    if (typeof a.pickupOnly === 'boolean') set.pickupOnly = a.pickupOnly;
    if (typeof a.availability === 'boolean') set.availability = a.availability;

    if (!Object.keys(set).length) continue;
    set.fieldsBackfilledAt = new Date();

    ops.push({
      updateOne: {
        filter: { projectId: PROJECT_ID, parentSku: id },
        update: { $set: set },
      },
    });
    opsBuilt++;

    if (ops.length >= BATCH) {
      await flush();
      process.stdout.write(`\r  processed ${parsed} | matched ${matched} | modified ${modified}`);
    }
  }
  await flush();
  process.stdout.write('\n');

  console.log(JSON.stringify({
    lines, parsed, opsBuilt, matched, modified, skippedNotProduct, skippedBadJson, noId, dry: DRY,
  }, null, 2));

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
