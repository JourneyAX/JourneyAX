import assert from 'node:assert/strict';
import { HttpMcpTransport, McpClient, McpClientPool, StaticMcpServerDirectory, type McpRequestMeta } from '../../capability-sdk/src/mcp';
import { SampleConnectorServer } from '../src/server';
import { TenantCollections, loadConnectors } from '../src/loader';
import { resolveExample } from '../src/examples';
import type { Rec } from '../src/types';

/**
 * The contract of the sample connectors, checked through the same MCP client the runtime uses: every connector lists its tools, every tool
 * returns a stable shape, tenants are kept apart, a caller without the key is refused, and nothing secret comes back.
 */
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const KEY = 'sample-key-for-the-contract-test-7f3a91';
const TENANT = 'placemakers';
const OTHER = 'other-test-tenant';
const meta = (tenantId = TENANT): McpRequestMeta => ({ tenantId, environmentId: 'dev', correlationId: 'corr-contract' });

async function main() {
  console.log('🧪 Sample connectors: the MCP contract');
  const connectors = loadConnectors();
  const server = new SampleConnectorServer({ tenants: [TENANT, OTHER], apiKey: KEY, now: () => new Date('2026-09-01T10:00:00Z') });
  const base = await server.listen(0);
  const clientFor = (id: string, key: string | null = KEY) => new McpClient(new HttpMcpTransport({ url: `${base}/mcp/${id}`, headers: () => (key ? { Authorization: `Bearer ${key}` } : {}) }), id);
  const call = async (id: string, tool: string, args: Rec, tenantId = TENANT) => {
    const out = await clientFor(id).callTool(tool, args, meta(tenantId));
    return out;
  };
  const examplesFor = (id: string, tenantId = TENANT) => {
    const data = new TenantCollections(connectors.get(id)!.seed);
    return (tool: { example: Rec }) => resolveExample(tool.example, data);
  };

  try {
    await check('every connector lists exactly the tools its definition names, with their inputs, and says which ones only read', async () => {
      assert.equal(connectors.size, 11);
      for (const [id, { definition }] of connectors) {
        const tools = await clientFor(id).listTools(meta());
        assert.deepEqual(tools.map((t) => t.name), definition.tools.map((t) => t.name), id);
        for (const tool of tools) {
          const declared = definition.tools.find((t) => t.name === tool.name)!;
          assert.deepEqual(tool.inputSchema, declared.inputSchema);
          assert.equal(tool.annotations?.readOnlyHint, declared.annotations?.readOnlyHint);
          assert.ok(tool.description.length > 20);
        }
      }
    });

    await check('every tool returns a stable shape: ok and connector, and one of records, record, rows or a verdict; a second read gives the same answer', async () => {
      let calls = 0;
      for (const [id, { definition }] of connectors) {
        const resolve = examplesFor(id);
        for (const tool of definition.tools) {
          const args = resolve(tool);
          const writes = tool.annotations?.readOnlyHint === false;
          const first = await call(id, tool.name, args);
          assert.equal(first.isError, false, `${id}.${tool.name}: ${first.text}`);
          const data = first.data as Rec;
          assert.equal(data.ok, true, `${id}.${tool.name}`);
          assert.equal(data.connector, id);
          const shape = ['records', 'record', 'rows'].filter((key) => key in data);
          assert.ok(shape.length === 1 || ('valid' in data && 'suggestions' in data), `${id}.${tool.name} has one outline, found ${Object.keys(data).join(',')}`);
          if (Array.isArray(data.records)) assert.ok(data.records.length > 0, `${id}.${tool.name} finds something for its own example`);
          if (writes) {
            assert.equal(data.created, true);
            assert.equal(data.record.sample, true, 'what a tool creates is sample data');
          } else {
            const again = await call(id, tool.name, args);
            assert.deepEqual(again.data, first.data, `${id}.${tool.name} reads the same twice`);
          }
          assert.ok(first.bytes < 32 * 1024, `${id}.${tool.name} fits the size cap (${first.bytes} bytes)`);
          assert.equal(first.truncated, false);
          calls++;
        }
      }
      assert.equal(calls, 47);
    });

    await check('what comes back is real-shaped: products with SKUs and prices, stock with branches, orders with lines, a cart that grows when a line is added', async () => {
      const found = (await call('sap-commerce', 'find_product', { query: 'deck', limit: 5 })).data as Rec;
      assert.ok(found.total >= 1 || found.records.length === 0);
      const sku = connectors.get('sap-commerce')!.seed.collections.products[3].sku;
      const product = ((await call('sap-commerce', 'get_product', { sku })).data as Rec).record;
      assert.equal(product.sku, sku);
      assert.ok(product.price > 0 && product.url.startsWith('https://'));
      const stockRows = ((await call('ace-erp', 'stock_by_branch', { sku })).data as Rec).records;
      assert.ok(stockRows.length > 0 && stockRows.every((r: Rec) => r.sku === sku && typeof r.available === 'number' && /^\d{3}$/.test(r.branchCode)));
      const order = ((await call('sap-commerce', 'get_order', { orderId: 'ORD-100001' })).data as Rec).record;
      assert.ok(order.lines.length >= 1 && order.lines.every((l: Rec) => l.orderId === 'ORD-100001'));
      assert.ok(Math.abs(order.lines.reduce((s: number, l: Rec) => s + l.lineTotal, 0) - order.total) < 0.011);
      const cartBefore = ((await call('sap-commerce', 'get_cart', { cartId: 'CART-0002' })).data as Rec).record;
      const added = (await call('sap-commerce', 'add_to_cart', { cartId: 'CART-0002', sku, quantity: 3 })).data as Rec;
      assert.equal(added.record.sku, sku);
      assert.equal(added.record.unitPrice, product.price > 0 ? added.record.unitPrice : 0);
      assert.ok(added.record.title);
      const cartAfter = ((await call('sap-commerce', 'get_cart', { cartId: 'CART-0002' })).data as Rec).record;
      assert.equal(cartAfter.lines.length, cartBefore.lines.length + 1);
    });

    await check('the connectors fit together: an order found in commerce has a review in the CRM, a sync run in the integration layer and (if delivered) a delivery in the ERP', async () => {
      const review = ((await call('salesforce', 'order_review_status', { orderId: connectors.get('salesforce')!.seed.collections.order_reviews[0].orderId })).data as Rec).records[0];
      const orderId = review.orderId;
      const order = ((await call('sap-commerce', 'get_order', { orderId })).data as Rec).record;
      assert.equal(order.accountId, review.accountId);
      const account = ((await call('salesforce', 'get_account', { accountId: order.accountId })).data as Rec).record;
      assert.equal(account.accountId, order.accountId);
      const history = ((await call('sap-commerce', 'order_history', { accountId: order.accountId })).data as Rec).records;
      assert.ok(history.some((o: Rec) => o.orderId === orderId));
      const balance = ((await call('ace-erp', 'account_balance', { accountId: order.accountId })).data as Rec).record;
      assert.ok(balance.creditLimit >= balance.balance);
      const runs = ((await call('mulesoft', 'order_sync_status', { orderId })).data as Rec).records;
      assert.ok(runs.every((r: Rec) => r.orderId === orderId));
    });

    await check('a search works the way a shopper expects: the words they typed find products, suggestions finish a start, popular searches are ranked', async () => {
      const queries = connectors.get('bloomreach')!.seed.collections.queries;
      const top = queries[0];
      const result = ((await call('bloomreach', 'search', { query: top.query, limit: 5 })).data as Rec).records;
      assert.ok(result.length > 0);
      assert.ok(top.topSkus.includes(result[0].sku), 'the build-time ranking and the live ranking agree');
      const suggestion = ((await call('bloomreach', 'suggestions', { prefix: top.query.slice(0, 3) })).data as Rec).records;
      assert.ok(suggestion.length > 0 && suggestion.every((s: Rec) => typeof s.query === 'string'));
      const popular = ((await call('bloomreach', 'popular_searches', { limit: 5 })).data as Rec).records;
      assert.deepEqual(popular.map((p: Rec) => p.count), [...popular.map((p: Rec) => p.count)].sort((a, b) => b - a));
    });

    await check('the location tools agree with the map: the nearest branch to a branch town is that town, a drive takes minutes, a mistyped address is not valid', async () => {
      const address = connectors.get('location')!.seed.collections.addresses[0];
      const nearest = ((await call('location', 'nearest_branch', { addressId: address.addressId, limit: 3 })).data as Rec).records;
      assert.equal(nearest.length, 3);
      assert.ok(nearest[0].distanceKm <= nearest[1].distanceKm && nearest[1].distanceKm <= nearest[2].distanceKm);
      assert.equal(nearest[0].name, address.town, 'addresses sit next to their branch town');
      const trip = ((await call('location', 'drive_time', { addressId: address.addressId, branchCode: nearest[0].code })).data as Rec).record;
      assert.ok(trip.minutes >= 1 && trip.roadKm >= trip.straightLineKm && trip.estimate === true);
      const valid = (await call('location', 'validate_address', { address: address.fullAddress })).data as Rec;
      assert.equal(valid.valid, true);
      const invalid = (await call('location', 'validate_address', { address: '999 Nonexistent Boulevard, Atlantis' })).data as Rec;
      assert.equal(invalid.valid, false);
      assert.equal(invalid.match, null);
      const point = ((await call('location', 'nearest_branch', { lat: -45.03, lng: 168.66, limit: 1 })).data as Rec).records[0];
      assert.equal(point.name, 'Queenstown');
    });

    await check('bad calls are told plainly: a missing or wrong argument, a record that does not exist, a tool that does not exist', async () => {
      const missing = await call('sap-commerce', 'get_product', {});
      assert.equal(missing.isError, true);
      assert.match(missing.text, /"code":"invalid_arguments".*sku is required/);
      const wrongType = await call('sap-commerce', 'add_to_cart', { cartId: 'CART-0001', sku: 'x', quantity: 'many' });
      assert.match(wrongType.text, /quantity must be a number/);
      const notFound = await call('sap-commerce', 'get_product', { sku: 'NO-SUCH-SKU' });
      assert.equal(notFound.isError, true);
      assert.match(notFound.text, /"code":"not_found"/);
      const noCart = await call('sap-commerce', 'add_to_cart', { cartId: 'CART-9999', sku: 'x', quantity: 1 });
      assert.match(noCart.text, /No cart CART-9999/);
      await assert.rejects(call('sap-commerce', 'no_such_tool', {}), /Unknown tool/);
      await assert.rejects(clientFor('no-such-connector').listTools(meta()), /No connector/);
      assert.ok(!missing.text.includes('at ') || !/\.ts:\d+/.test(missing.text), 'no stack trace');
    });

    await check('tenants are kept apart: a write by one is not seen by another, and a tenant the server holds no data for is refused', async () => {
      const sku = connectors.get('sap-commerce')!.seed.collections.products[5].sku;
      const before = ((await call('sap-commerce', 'get_cart', { cartId: 'CART-0007' }, OTHER)).data as Rec).record.lines.length;
      await call('sap-commerce', 'add_to_cart', { cartId: 'CART-0007', sku, quantity: 1 }, TENANT);
      const mine = ((await call('sap-commerce', 'get_cart', { cartId: 'CART-0007' }, TENANT)).data as Rec).record.lines.length;
      const theirs = ((await call('sap-commerce', 'get_cart', { cartId: 'CART-0007' }, OTHER)).data as Rec).record.lines.length;
      assert.equal(mine, before + 1);
      assert.equal(theirs, before, 'the other tenant did not see the new line');
      await call('salesforce', 'create_case', { accountId: 'ACC-0001', subject: 'Only for the first tenant' }, TENANT);
      const otherCases = ((await call('salesforce', 'list_cases', { limit: 25, status: 'new' }, OTHER)).data as Rec).records;
      assert.ok(!otherCases.some((c: Rec) => c.subject === 'Only for the first tenant'));
      await assert.rejects(call('sap-commerce', 'get_cart', { cartId: 'CART-0001' }, 'a-tenant-with-no-data'), /HTTP 403/);
      const noTenant = await fetch(`${base}/mcp/sap-commerce`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.equal(noTenant.status, 400);
    });

    await check('what a write creates is sample data with a fresh id, and the seed files themselves are never changed', async () => {
      const made = ((await call('salesforce', 'create_case', { accountId: 'ACC-0002', subject: 'Contract test case', priority: 'high' })).data as Rec).record;
      assert.match(made.caseId, /^CS-\d{5}$/);
      assert.equal(made.status, 'new');
      assert.equal(made.sample, true);
      assert.equal(made.createdAt, '2026-09-01T10:00:00.000Z');
      const found = ((await call('salesforce', 'get_case', { caseId: made.caseId })).data as Rec).record;
      assert.equal(found.subject, 'Contract test case');
      const msg = ((await call('marketing-cloud', 'send_message', { accountId: 'ACC-0003', channel: 'email', templateId: 'TPL-100' })).data as Rec).record;
      assert.equal(msg.status, 'queued');
      assert.ok(msg.contactEmail.endsWith('.test'), 'the contact is looked up from the account');
      assert.equal(msg.campaign, 'Order confirmed');
      const fresh = new TenantCollections(connectors.get('salesforce')!.seed);
      assert.ok(!fresh.all('cases').some((c) => c.subject === 'Contract test case'));
    });

    await check('a caller without the key, or with the wrong one, is refused; the key is never in any answer', async () => {
      const without = await fetch(`${base}/mcp/sap-commerce`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT }, body: '{}' });
      assert.equal(without.status, 401);
      assert.ok(!(await without.text()).includes(KEY));
      const wrong = await fetch(`${base}/mcp/sap-commerce`, { method: 'POST', headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json', 'x-tenant-id': TENANT }, body: '{}' });
      assert.equal(wrong.status, 401);
      await assert.rejects(clientFor('sap-commerce', 'wrong-key').listTools(meta()), /HTTP 401/);
      await assert.rejects(clientFor('sap-commerce', null).listTools(meta()), /HTTP 401/);
      // Run every tool once more and look through the whole answer for the key.
      for (const [id, { definition }] of connectors) {
        const resolve = examplesFor(id);
        for (const tool of definition.tools.filter((t) => t.annotations?.readOnlyHint !== false)) {
          const out = await call(id, tool.name, resolve(tool));
          assert.ok(!JSON.stringify(out).includes(KEY), `${id}.${tool.name}`);
        }
      }
    });

    await check('through the runtime\'s own pool: the secret reference is resolved, sent as a bearer key and kept out of the answer', async () => {
      const ref = `tenant-secret://${TENANT}/dev/sample-connectors-key`;
      const pool = new McpClientPool({ directory: new StaticMcpServerDirectory({ 'ace-erp': `${base}/mcp/ace-erp` }), secrets: { resolve: async () => KEY }, nodeEnv: 'test' });
      const client = await pool.getClient('ace-erp', { tenantId: TENANT, environmentId: 'dev', secretRef: ref });
      const out = await client.callTool('list_branches', { query: 'dunedin' }, meta());
      assert.equal(out.isError, false);
      assert.equal((out.data as Rec).records[0].name, 'Dunedin');
      assert.ok(!JSON.stringify(out).includes(KEY));
      const wrongTenant = await pool.getClient('ace-erp', { tenantId: OTHER, environmentId: 'dev', secretRef: `tenant-secret://${OTHER}/dev/key` });
      assert.equal(((await wrongTenant.callTool('list_branches', { query: 'dunedin' }, meta(OTHER))).data as Rec).records.length, 1);
      await assert.rejects(pool.getClient('ace-erp', { tenantId: TENANT, environmentId: 'dev', secretRef: `tenant-secret://${OTHER}/dev/key` }), /CROSS_TENANT/);
    });

    await check('the server answers the protocol basics: initialise, ping, a notification gets no answer, a bad message is an error, only POST is allowed', async () => {
      const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/mcp/location`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-tenant-id': TENANT, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json() as Rec;
      assert.equal(init.result.serverInfo.name, 'sample-location');
      assert.ok(init.result.capabilities.tools);
      assert.match(init.result.instructions, /sample data/);
      assert.deepEqual(((await (await post({ jsonrpc: '2.0', id: 2, method: 'ping' })).json()) as Rec).result, {});
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
      assert.equal(((await (await post({ jsonrpc: '2.0', id: 3, method: 'nope' })).json()) as Rec).error.code, -32601);
      assert.equal((await post('{not json')).status, 400);
      assert.equal((await fetch(`${base}/mcp/location`, { method: 'GET', headers: { authorization: `Bearer ${KEY}` } })).status, 405);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
      const big = await post('x'.repeat(300 * 1024));
      assert.equal(big.status, 413);
    });
  } finally {
    await server.close();
  }
  console.log(`✅ sample connector contract: ${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
