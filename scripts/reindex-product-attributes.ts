#!/usr/bin/env node
/**
 * Product Attribute Re-indexer
 *
 * Scans existing products in the catalogue and extracts structured attributes
 * (e.g. size, treatment, rValue, colour, fit) using the tenant's catalogue mapping
 * attribute definitions, storing the extracted fields in `attributes` on each product.
 *
 * Usage:
 *   npx tsx scripts/reindex-product-attributes.ts [--tenant <tenantId>] [--batch-size <n>] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractProductAttributes } from '../packages/ingestion/src/populators/product.populators';

if (typeof (process as any).loadEnvFile === 'function' && fs.existsSync('.env')) {
  try {
    (process as any).loadEnvFile('.env');
  } catch {}
}

export interface ReindexOptions {
  db?: any;
  tenantId?: string;
  attributeDefinitions?: Record<string, any>;
  batchSize?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface ReindexResult {
  totalScanned: number;
  totalUpdated: number;
  extractedCounts: Record<string, number>;
}

export async function reindexProductAttributes(options: ReindexOptions = {}): Promise<ReindexResult> {
  const log = options.log || console.log;
  const batchSize = options.batchSize || 500;
  const dryRun = Boolean(options.dryRun);

  let db = options.db;
  let closeClient: (() => Promise<void>) | null = null;

  if (!db) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI environment variable is required when db is not provided');
    }
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');
    closeClient = () => client.close();
  }

  try {
    // Load attribute definitions from mapping or pack release if not provided
    let defs = options.attributeDefinitions;
    if (!defs) {
      const mappingPath = path.resolve('docs/migrations/placemakers-catalog-mapping.json');
      if (fs.existsSync(mappingPath)) {
        const raw = fs.readFileSync(mappingPath, 'utf8');
        const parsed = JSON.parse(raw);
        defs = parsed.catalogMapping?.attributeDefinitions;
      }
    }

    if (!defs || Object.keys(defs).length === 0) {
      log('No attribute definitions found to re-index with.');
      return { totalScanned: 0, totalUpdated: 0, extractedCounts: {} };
    }

    log(`Re-indexing product attributes with definitions: ${Object.keys(defs).join(', ')}...`);

    const filter: Record<string, any> = {};
    if (options.tenantId) {
      filter.$or = [
        { projectId: options.tenantId },
        { tenantId: options.tenantId },
      ];
    }

    const collection = db.collection('products');
    const cursor = collection.find(filter);
    let totalScanned = 0;
    let totalUpdated = 0;
    const extractedCounts: Record<string, number> = {};

    let bulkOps: any[] = [];

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      if (!doc) break;
      totalScanned++;

      const extracted = extractProductAttributes(doc, defs);
      const attrKeys = Object.keys(extracted);

      if (attrKeys.length > 0) {
        for (const k of attrKeys) {
          extractedCounts[k] = (extractedCounts[k] || 0) + 1;
        }

        const updateSet: Record<string, any> = {
          attributes: {
            ...(doc.attributes || {}),
            ...extracted,
          },
        };
        for (const [k, v] of Object.entries(extracted)) {
          updateSet[k] = v;
        }

        if (!dryRun) {
          bulkOps.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: updateSet },
            },
          });
        }
        totalUpdated++;

        if (bulkOps.length >= batchSize) {
          if (!dryRun) {
            await collection.bulkWrite(bulkOps);
            bulkOps = [];
          }
          log(`  Processed ${totalScanned} products (${totalUpdated} updated so far)...`);
        }
      }
    }

    if (bulkOps.length > 0 && !dryRun) {
      await collection.bulkWrite(bulkOps);
    }

    log(`Re-index complete. Scanned: ${totalScanned}, Updated: ${totalUpdated}${dryRun ? ' (dry run)' : ''}`);
    for (const [k, count] of Object.entries(extractedCounts)) {
      log(`  - ${k}: ${count} products extracted`);
    }

    return { totalScanned, totalUpdated, extractedCounts };
  } finally {
    if (closeClient) {
      await closeClient();
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let tenantId: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) {
      tenantId = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  reindexProductAttributes({ tenantId, dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Reindex failed:', err);
      process.exit(1);
    });
}
