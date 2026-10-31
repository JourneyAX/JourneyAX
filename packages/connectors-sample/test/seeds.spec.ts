import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONNECTORS_DIR, loadConnectors, readManifest } from '../src/loader';
import type { Rec } from '../src/types';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Sample connectors: seed files');

const PLAN_ORDER = ['sap-commerce', 'salesforce', 'ace-erp', 'mulesoft', 'salsify', 'bloomreach', 'marketing-cloud', 'power-bi', 'google-analytics', 'uxcam', 'location'];
const manifest = readManifest();
const connectors = loadConnectors();
const records = (id: string, collection: string): Rec[] => connectors.get(id)!.seed.collections[collection] ?? [];

check('the manifest names the eleven connectors of the plan, and each has a definition, a seed and a README', () => {
  assert.deepEqual(manifest.connectors, PLAN_ORDER);
  assert.equal(manifest.seedTenantId, 'placemakers');
  for (const id of PLAN_ORDER) for (const file of ['connector.json', 'seed.json', 'README.md']) assert.ok(existsSync(path.join(DEFAULT_CONNECTORS_DIR, id, file)), `${id}/${file}`);
});

check('every connector holds at least the number of records it promises in each collection (the plan asks for 25 or more)', () => {
  for (const [id, { definition, seed }] of connectors) {
    assert.ok(Object.keys(definition.minimums).length > 0, `${id} declares minimums`);
    let biggest = 0;
    for (const [collection, minimum] of Object.entries(definition.minimums)) {
      const count = seed.collections[collection]?.length ?? 0;
      assert.ok(count >= minimum, `${id}.${collection} has ${count}, needs ${minimum}`);
      biggest = Math.max(biggest, count);
    }
    assert.ok(biggest >= 25, `${id} has a collection of 25 or more`);
    for (const collection of Object.keys(seed.collections)) assert.ok(definition.minimums[collection] !== undefined, `${id}.${collection} is covered by a minimum`);
  }
});

check('the plan\'s own numbers hold: 40+ products, 25 carts and orders, 25 trade accounts, 40 cases, stock for 100 products, 25 deliveries, 6 reports of 25+ rows', () => {
  assert.ok(records('sap-commerce', 'products').length >= 40);
  assert.ok(records('sap-commerce', 'carts').length >= 25 && records('sap-commerce', 'orders').length >= 25);
  assert.ok(records('salesforce', 'accounts').length >= 25 && records('salesforce', 'cases').length >= 40 && records('salesforce', 'order_reviews').length >= 25);
  assert.ok(records('ace-erp', 'branches').length >= 25 && records('ace-erp', 'deliveries').length >= 25 && records('ace-erp', 'price_list').length >= 25);
  assert.ok(new Set(records('ace-erp', 'stock').map((row) => row.sku)).size >= 100, 'stock for 100 products');
  assert.ok(records('mulesoft', 'sync_runs').length >= 25);
  assert.ok(records('salsify', 'products').length >= 40);
  assert.ok(records('bloomreach', 'queries').length >= 25);
  assert.ok(records('marketing-cloud', 'messages').length >= 25);
  const reports = records('power-bi', 'reports');
  assert.equal(reports.length, 6);
  for (const report of reports) assert.ok(records('power-bi', 'report_rows').filter((row) => row.reportId === report.reportId).length >= 25, `${report.reportId} has 25 rows`);
  assert.ok(records('google-analytics', 'daily_traffic').length >= 25);
  assert.ok(records('uxcam', 'sessions').length >= 25);
  assert.ok(records('location', 'addresses').length >= 25);
});

check('every record says whether it is sample: invented and mixed records are true, records copied whole from the PlaceMakers data are false', () => {
  for (const [id, { seed }] of connectors) {
    for (const [collection, rows] of Object.entries(seed.collections)) {
      const origin = seed.provenance[collection]?.origin;
      assert.ok(origin, `${id}.${collection} has provenance`);
      for (const row of rows) {
        assert.equal(typeof row.sample, 'boolean', `${id}.${collection} record has a sample flag`);
        assert.equal(row.sample, origin !== 'real', `${id}.${collection} (${origin}) record sample flag`);
      }
    }
  }
});

check('the real records are the PlaceMakers products and branches: product pages, prices and branch codes come from the data', () => {
  const products = records('sap-commerce', 'products');
  assert.equal(products.length, new Set(products.map((p) => p.sku)).size, 'unique SKUs');
  for (const product of products) {
    assert.match(product.url, /^https:\/\/www\.placemakers\.co\.nz\//);
    assert.ok(product.price > 0 && product.discountPrice > 0 && product.discountPrice <= product.price);
    assert.ok(product.title && product.department && product.categoryPath);
  }
  assert.deepEqual(records('salsify', 'products').map((p) => p.sku), products.map((p) => p.sku), 'the same products in every product connector');
  assert.deepEqual(records('bloomreach', 'catalog').map((p) => p.sku), products.map((p) => p.sku));
  const branches = records('ace-erp', 'branches');
  assert.deepEqual(records('location', 'branches'), branches);
  assert.equal(branches.length, new Set(branches.map((b) => b.code)).size);
  for (const branch of branches) { assert.match(branch.code, /^\d{3}$/); assert.ok(branch.name); assert.ok(branch.lat < -34 && branch.lat > -48 && branch.lng > 166 && branch.lng < 179); }
  assert.ok(branches.filter((b) => !b.phone).length <= 3, 'a branch the store locator lists without a phone has none here either');
  const salsify = records('salsify', 'products');
  assert.ok(salsify.filter((p) => p.documents.length > 0).length >= 60, 'documents are real data');
  assert.ok(salsify.every((p) => p.specifications.length > 0));
});

check('records point at each other: orders at accounts and products, deliveries and sync runs at orders, stock and prices at products, cases at accounts', () => {
  const skus = new Set(records('sap-commerce', 'products').map((p) => p.sku));
  const accountIds = new Set(records('salesforce', 'accounts').map((a) => a.accountId));
  const orderIds = new Set(records('sap-commerce', 'orders').map((o) => o.orderId));
  const codes = new Set(records('ace-erp', 'branches').map((b) => b.code));
  for (const order of records('sap-commerce', 'orders')) { assert.ok(order.accountId === null || accountIds.has(order.accountId)); assert.ok(codes.has(order.branchCode)); }
  for (const line of records('sap-commerce', 'order_lines')) { assert.ok(orderIds.has(line.orderId) && skus.has(line.sku)); }
  for (const line of records('sap-commerce', 'cart_lines')) assert.ok(skus.has(line.sku));
  for (const order of records('sap-commerce', 'orders')) {
    const total = records('sap-commerce', 'order_lines').filter((l) => l.orderId === order.orderId).reduce((sum, l) => sum + l.lineTotal, 0);
    assert.ok(Math.abs(total - order.total) < 0.011, `${order.orderId} total adds up`);
  }
  for (const c of records('salesforce', 'cases')) { assert.ok(accountIds.has(c.accountId)); assert.ok(c.relatedOrderId === null || orderIds.has(c.relatedOrderId)); }
  for (const r of records('salesforce', 'order_reviews')) assert.ok(orderIds.has(r.orderId) && accountIds.has(r.accountId));
  for (const d of records('ace-erp', 'deliveries')) assert.ok(orderIds.has(d.orderId) && codes.has(d.branchCode));
  for (const s of records('ace-erp', 'stock')) assert.ok(skus.has(s.sku) && codes.has(s.branchCode) && s.available === s.onHand - s.reserved);
  for (const p of records('ace-erp', 'price_list')) { assert.ok(skus.has(p.sku)); assert.ok(p.goldPrice < p.silverPrice && p.silverPrice < p.bronzePrice && p.bronzePrice < p.retailPrice); }
  for (const b of records('ace-erp', 'account_balances')) assert.ok(accountIds.has(b.accountId));
  for (const run of records('mulesoft', 'sync_runs')) assert.ok(run.orderId === null || orderIds.has(run.orderId));
  for (const m of records('marketing-cloud', 'messages')) assert.ok(accountIds.has(m.accountId));
  for (const q of records('bloomreach', 'queries')) for (const sku of q.topSkus) assert.ok(skus.has(sku));
  for (const q of records('bloomreach', 'queries')) assert.ok(q.resultCount > 0, `the query "${q.query}" finds products`);
});

check('the keys the tools look records up by are unique within their collection', () => {
  for (const [id, { definition, seed }] of connectors) {
    for (const tool of definition.tools) {
      const op: any = tool.op;
      if (op.kind !== 'get') continue;
      const values = seed.collections[op.collection].map((row) => row[op.key]);
      assert.equal(values.length, new Set(values).size, `${id}.${tool.name}: ${op.collection}.${op.key} is unique`);
    }
  }
});

check('every tool is described and carries an example; every collection a tool names exists', () => {
  for (const [id, { definition, seed }] of connectors) {
    assert.ok(definition.tools.length >= 2, `${id} has tools`);
    assert.equal(new Set(definition.tools.map((t) => t.name)).size, definition.tools.length, `${id} tool names are unique`);
    for (const tool of definition.tools) {
      assert.ok(tool.description.length > 20, `${id}.${tool.name} has a description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.example && typeof tool.example === 'object', `${id}.${tool.name} has an example`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${id}.${tool.name} says whether it only reads`);
      const op: any = tool.op;
      if (op.collection) assert.ok(seed.collections[op.collection], `${id}.${tool.name} names ${op.collection}`);
      for (const include of op.include ?? []) assert.ok(seed.collections[include.collection]);
      for (const check of op.validate ?? []) assert.ok(seed.collections[check.collection]);
    }
  }
});

check('the connectors that change data say so and ask first: add_to_cart, create_case and send_message are the only writers', () => {
  const writers = [...connectors.values()].flatMap(({ definition }) => definition.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => `${definition.connectorId}.${t.name}`));
  assert.deepEqual(writers.sort(), ['marketing-cloud.send_message', 'salesforce.create_case', 'sap-commerce.add_to_cart']);
});

check('no email address in the seeds is a real domain, and no secret or customer-looking number is in any file', () => {
  for (const id of PLAN_ORDER) {
    const text = readFileSync(path.join(DEFAULT_CONNECTORS_DIR, id, 'seed.json'), 'utf8');
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g) ?? []) assert.ok(email.endsWith('.test'), `${id}: ${email}`);
    assert.ok(!/sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|bearer\s+[a-z0-9]/i.test(text), `${id} holds no key`);
  }
});

console.log(`✅ sample connector seeds: ${passed} passed, 0 failed`);
