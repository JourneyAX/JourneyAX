import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { applyDemoErpSeed, planDemoErpSeed } from '../../packages/connectors-real/src/demo-erp-seed';

async function main() {
  const args = process.argv.slice(2);
  const inputAt = args.indexOf('--input');
  if (inputAt < 0 || !args[inputAt + 1]) throw new Error('Use --input <dataset.json>; add --apply only to seed the approved isolated demo collections.');
  const plan = planDemoErpSeed(JSON.parse(readFileSync(resolve(args[inputAt + 1]), 'utf8')));
  const summary = { tenantId: plan.dataset.tenantId, environmentId: plan.dataset.environmentId, datasetId: plan.dataset.datasetId, source: plan.dataset.source, collections: [...new Set(plan.rows.map(row => row.collection))], records: plan.rows.length };
  if (!args.includes('--apply')) { console.log(JSON.stringify({ mode: 'dry_run', ...summary })); return; }
  config({ path: process.env.JOURNEYAX_ENV_FILE || resolve(__dirname, '../../.env'), override: false, quiet: true });
  const uri = process.env.ERP_DEMO_MONGODB_URI || (args.includes('--use-current-cluster') ? process.env.MONGODB_URI : undefined);
  const database = process.env.ERP_DEMO_DATABASE || process.env.MONGODB_DB_NAME;
  if (!uri || !database) throw new Error('Set ERP_DEMO_MONGODB_URI and ERP_DEMO_DATABASE explicitly (or authorise --use-current-cluster with a database name).');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000 });
  try {
    await client.connect(); const db = client.db(database); const session = client.startSession();
    try {
      let result: { inserted: number; unchanged: number } | undefined;
      await session.withTransaction(async () => { result = await applyDemoErpSeed(plan, db, session); });
      console.log(JSON.stringify({ mode: 'applied', ...summary, ...result }));
    } finally { await session.endSession(); }
  } finally { await client.close(); }
}
main().catch(() => { console.error('ERP demo seed failed; inspect configuration/validation without exposing connection strings. No production collections are targeted.'); process.exitCode = 1; });
