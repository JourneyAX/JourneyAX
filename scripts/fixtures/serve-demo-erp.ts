import { resolve } from 'node:path';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { RealConnectorServer } from '../../packages/connectors-real/src/server';
import { mongoDemoErp, DEMO_ERP_COLLECTIONS } from '../../packages/connectors-real/src/connectors/mongo-demo-erp';

async function main() {
  config({ path: process.env.JOURNEYAX_ENV_FILE || resolve(__dirname, '../../.env'), override: false, quiet: true });
  const tenantId = process.env.ERP_DEMO_TENANT;
  const environmentId = process.env.ERP_DEMO_ENVIRONMENT;
  const datasetId = process.env.ERP_DEMO_DATASET;
  const uri = process.env.ERP_DEMO_MONGODB_URI || (process.env.ERP_DEMO_USE_CURRENT_CLUSTER === '1' ? process.env.MONGODB_URI : undefined);
  const database = process.env.ERP_DEMO_DATABASE;
  const apiKey = process.env.ERP_DEMO_API_KEY;
  const iqScopeSecret = process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET;
  if (!iqScopeSecret || iqScopeSecret.length < 32) throw new Error('The IQ connector signing secret is required.');
  if (!tenantId || !environmentId || !['dev', 'test', 'staging'].includes(environmentId) || !datasetId || !uri || !database || !apiKey) throw new Error('ERP_DEMO_TENANT, ENVIRONMENT, DATASET, DATABASE, API_KEY and an explicit Mongo source are required.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000 });
  const allowed = new Set<string>(Object.values(DEMO_ERP_COLLECTIONS));
  const connector = mongoDemoErp({ tenantId, environmentId: environmentId as 'test', datasetId }, {
    find: async (collection, filter, limit) => {
      if (!allowed.has(collection)) throw new Error('Only isolated demo ERP collections can be read.');
      await client.connect();
      return client.db(database).collection(collection).find(filter, { projection: { _id: 0 }, maxTimeMS: 5_000 }).sort({ _id: 1 }).limit(Math.min(limit, 51)).toArray();
    },
  }, process.env.ERP_DEMO_CONNECTOR_ID || 'erp-demo');
  const server = new RealConnectorServer({ connectors: [connector], tenants: [tenantId], environmentId, connectionRef: datasetId, apiKey, iqScopeSecret });
  const address = await server.listen(Number(process.env.ERP_DEMO_PORT || 4021), '127.0.0.1');
  console.log(JSON.stringify({ service: 'Demonstration ERP (not SAP)', address, tenantId, environmentId, datasetId, sample: true }));
  const stop = async () => { await server.close(); await client.close(); };
  process.once('SIGINT', () => { void stop().finally(() => process.exit()); });
  process.once('SIGTERM', () => { void stop().finally(() => process.exit()); });
}
main().catch(() => { console.error('Demo ERP did not start. Check the explicit non-production scope and credentials; no connection values are printed.'); process.exitCode = 1; });
