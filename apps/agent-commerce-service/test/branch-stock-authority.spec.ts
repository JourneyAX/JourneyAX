import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BranchStockService } from '../src/commerce/branch-stock.service';

test('unconfigured and demo inventory never confirm stock or pickup', async () => {
  const original = globalThis.fetch; const endpoint = process.env.PRODUCT_SERVICE_URL;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ sku: 'P1', source: 'demo', branches: [{ stockQty: 20, clickAndCollectReady: true, collectionTimeframe: 'within 60 minutes' }] }); };
  try {
    delete process.env.PRODUCT_SERVICE_URL;
    assert.equal((await BranchStockService.getStockForSku('tenant-a', 'P1', 'Product', 'B1')).ok, false);
    assert.equal(calls, 0, 'there is no implicit localhost inventory server');
    process.env.PRODUCT_SERVICE_URL = 'http://inventory.invalid';
    const demo = await BranchStockService.getStockForSku('tenant-a', 'P1', 'Product', 'B1');
    assert.equal(demo.ok, false); assert.deepEqual(demo.branches, []);
  } finally { globalThis.fetch = original; if (endpoint === undefined) delete process.env.PRODUCT_SERVICE_URL; else process.env.PRODUCT_SERVICE_URL = endpoint; }
});

test('inventory facts require matching tenant, SKU and selected branch, and explicit source values', async () => {
  const original = globalThis.fetch; const endpoint = process.env.PRODUCT_SERVICE_URL;
  const valid = { tenantId: 'tenant-a', sku: 'P1', source: 'inventory-connection', branches: [{ branchCode: 'B1', branchName: 'Selected branch', stockQty: 8, status: 'In Stock', clickAndCollectReady: true, collectionTimeframe: 'ready tomorrow' }] };
  let data: any = valid;
  globalThis.fetch = async () => Response.json(data);
  process.env.PRODUCT_SERVICE_URL = 'http://inventory.invalid';
  try {
    const read = () => BranchStockService.getStockForSku('tenant-a', 'P1', 'Product', 'B1');
    assert.deepEqual((await read()).branches, valid.branches);
    for (const invalid of [{ ...valid, tenantId: 'tenant-b' }, { ...valid, sku: 'P2' }, { ...valid, source: undefined }, { ...valid, sample: true }, { ...valid, branches: [{ ...valid.branches[0], branchCode: 'B2' }] }, { ...valid, branches: [{ ...valid.branches[0], stockQty: 0 }] }]) {
      data = invalid; const result = await read(); assert.equal(result.ok, false); assert.deepEqual(result.branches, []);
    }
  } finally { globalThis.fetch = original; if (endpoint === undefined) delete process.env.PRODUCT_SERVICE_URL; else process.env.PRODUCT_SERVICE_URL = endpoint; }
});
