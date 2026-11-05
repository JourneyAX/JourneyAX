import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { planDemoErpSeed, applyDemoErpSeed } from '../src/demo-erp-seed';

const input: any = { datasetId: 'demo-fixture-1', tenantId: 'tenant-a', environmentId: 'test', source: 'journeyax-demo-erp', records: { accounts: [{ accountId: 'DEMO-ACC-1', name: 'Example customer' }], orders: [{ orderId: 'DEMO-ORDER-1', accountId: 'DEMO-ACC-1' }], invoices: [], deliveries: [], stock: [], prices: [] } };
test('demo planning rejects production scope, foreign accounts, credentials, duplicate IDs and cross-account orders', () => {
  assert.throws(() => planDemoErpSeed({ ...input, environmentId: 'production' }));
  for (const patch of [
    { orders: [{ orderId: 'DEMO-ORDER-1', accountId: 'FOREIGN' }] },
    { accounts: [{ accountId: 'DEMO-ACC-1', apiKey: 'secret' }] },
    { accounts: [input.records.accounts[0], input.records.accounts[0]] },
    { deliveries: [{ deliveryId: 'DEMO-DELIVERY-1', accountId: 'DEMO-ACC-1', orderId: 'DEMO-MISSING' }] },
  ]) assert.throws(() => planDemoErpSeed({ ...input, records: { ...input.records, ...patch } }));
});
test('a seed is deterministic, replay-safe and cannot overwrite differing existing records', async () => {
  const plan = planDemoErpSeed(input); assert.deepEqual(plan, planDemoErpSeed(input));
  const rows = new Map<string, any>(); let writes = 0;
  const db = { collection: (name: string) => {
    assert.match(name, /^jax_v5_demo_erp_/);
    return { findOne: async (filter: any) => rows.get(filter._id), insertOne: async (row: any) => { writes++; rows.set(row._id, structuredClone(row)); } };
  } };
  assert.deepEqual(await applyDemoErpSeed(plan, db, {}), { inserted: 2, unchanged: 0 });
  assert.deepEqual(await applyDemoErpSeed(plan, db, {}), { inserted: 0, unchanged: 2 });
  assert.equal(writes, 2);
  rows.get(plan.rows[0].document._id).contentHash = 'different';
  await assert.rejects(() => applyDemoErpSeed(plan, db, {}), /nothing may be overwritten/);
  assert.equal(writes, 2);
});
