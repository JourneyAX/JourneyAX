import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mongoDemoErp } from '../src/connectors/mongo-demo-erp';

test('every ERP read applies an explicit non-production tenant/environment/synthetic filter', async () => {
  const seen: any[] = [];
  const connector = mongoDemoErp({ tenantId: 'tenant-a', environmentId: 'test', datasetId: 'demo-fixture-1' }, { find: async (collection, filter) => { seen.push({ collection, filter }); return [{ tenantId: 'tenant-a', environmentId: 'test', datasetId: 'demo-fixture-1', synthetic: true, accountId: 'demo-a', name: 'Example customer' }]; } });
  const result = await connector.tools.find(tool => tool.name === 'account_balance')!.run({ accountId: 'demo-a', tenantId: 'tenant-b', environmentId: 'production' });
  assert.equal(result.sample, true); assert.equal(result.source, 'mongo-demo-erp');
  assert.deepEqual(seen[0].filter, { accountId: 'demo-a', tenantId: 'tenant-a', environmentId: 'test', datasetId: 'demo-fixture-1', synthetic: true });
  assert.equal(connector.tools.every(tool => tool.readOnly), true);
});
test('bad source ownership, missing values and operator injection never become fabricated facts', async () => {
  const connector = mongoDemoErp({ tenantId: 'tenant-a', environmentId: 'test', datasetId: 'demo-fixture-1' }, { find: async () => [{ tenantId: 'tenant-b', environmentId: 'test', datasetId: 'demo-fixture-1', synthetic: true, balance: 100 }] });
  const tool = connector.tools.find(tool => tool.name === 'account_balance')!;
  await assert.rejects(() => tool.run({ accountId: 'demo-a' }), /not uniquely available/);
  await assert.rejects(() => tool.run({ accountId: { $ne: null } }), /valid source identifier/);
  assert.throws(() => mongoDemoErp({ tenantId: 'tenant-a', environmentId: 'production' as any, datasetId: 'demo-fixture-1' }, { find: async () => [] }), /non-production/);
});
