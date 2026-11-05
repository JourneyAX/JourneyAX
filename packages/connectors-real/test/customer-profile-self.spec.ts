import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commerceCustomerProfile } from '../src/connectors/customer-profile';
import { RealConnectorServer } from '../src/server';

const customer = { id: '4b5c84e2-c0e0-4809-8e64-b768bf080e15', key: `jax_${'a'.repeat(64)}`, email: 'owner@example.test', version: 2 };
function fixture() {
  let wrongOwner = false; const calls: any[] = [];
  const tools = commerceCustomerProfile(async (method, path, request) => {
    calls.push({ method, path, request }); assert.equal(method, 'GET');
    if (path === '/customers') return { total: 1, results: [customer] };
    const order = { id: 'order-uuid', orderNumber: 'owned-order', customerId: wrongOwner ? 'another-customer' : customer.id };
    return path === '/orders' ? { total: 1, results: [order] } : order;
  }, order => ({ orderId: order.id, orderNumber: order.orderNumber }));
  return { tools, calls, wrong: () => { wrongOwner = true; } };
}
test('shopper source tools accept only the requester in the signed caller and preserve arbitrary profile lookups as staff only', async () => {
  const f = fixture();
  const server = new RealConnectorServer({ connectors: [{ connectorId: 'commercetools', title: 'Commerce', description: 'Fixture', required: [], missing: () => [], tools: f.tools }] });
  const scope: any = { principal: { id: customer.email, audience: 'shopper', groups: [] }, operation: 'read', fields: ['record.externalCustomerKey'] };
  const invoke = (name: string, requesterEmail: string) => server.handle('commercetools', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { requesterEmail } } }, scope) as Promise<any>;
  const wrong = await invoke('get_my_customer_profile', 'another@example.test');
  assert.equal(wrong.error.code, -32003); assert.equal(f.calls.length, 0);
  const arbitrary = await server.handle('commercetools', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_customer_profile', arguments: { customerId: customer.id } } }, scope) as any;
  assert.equal(arbitrary.error.code, -32003); assert.equal(f.calls.length, 0);
  const actual = await invoke('get_my_customer_profile', customer.email);
  const result = JSON.parse(actual.result.content[0].text);
  assert.equal(result.record.externalCustomerKey, customer.key);
  assert.doesNotMatch(JSON.stringify(result), /owner@example|customerId|version/);
});
test('owned source order reads and lists verify the customer ID after the vendor query, with no write fallback', async () => {
  const f = fixture();
  const read = f.tools.find(tool => tool.name === 'get_my_order')!;
  assert.equal((await read.run({ requesterEmail: customer.email, orderId: 'owned-order' })).record.orderNumber, 'owned-order');
  const list = f.tools.find(tool => tool.name === 'get_my_orders')!;
  assert.equal((await list.run({ requesterEmail: customer.email })).records[0].orderNumber, 'owned-order');
  assert.equal(f.calls.find(call => call.path === '/orders').request.query.where, `customerId=${JSON.stringify(customer.id)}`);
  f.wrong();
  await assert.rejects(() => read.run({ requesterEmail: customer.email, orderId: 'owned-order' }), /not owned/);
  await assert.rejects(() => list.run({ requesterEmail: customer.email }), /registered owner/);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
