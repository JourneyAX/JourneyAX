import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { salesforceCustomerProfile, commerceCustomerProfile } from '../src/connectors/customer-profile';

const args = { email: 'owned@example.test', fullName: 'Owned Customer', externalCustomerKey: 'jax-customer-tenant-environment-owner' };
test('CRM profile creation uses an atomic account/contact request and verifies both source identities', async () => {
  let row: any; let writes = 0;
  const api: any = async (method: string, path: string, request: any) => {
    if (method === 'GET' && path === '/query') return { totalSize: row ? 1 : 0, records: row ? [row] : [] };
    writes++; assert.equal(request.body.allOrNone, true);
    const steps = request.body.compositeRequest;
    assert.equal(steps[1].body.AccountId, '@{account.id}');
    assert.equal(steps[1].body.Email, args.email);
    row = { Id: 'contact-a', AccountId: 'account-a', Name: args.fullName, Account: { Description: steps[0].body.Description } };
    return { compositeResponse: [{ httpStatusCode: 201, body: { success: true, id: 'account-a' } }, { httpStatusCode: 201, body: { success: true, id: 'contact-a' } }] };
  };
  const tool = salesforceCustomerProfile(api, () => 'v62.0').find(tool => tool.name === 'create_customer_profile')!;
  assert.equal((await tool.run(args)).created, true); assert.equal((await tool.run(args)).created, false); assert.equal(writes, 1);
});

test('ambiguous or conflicting CRM profiles cannot be silently reused or changed', async () => {
  for (const rows of [[{ Id: 'c', AccountId: 'a', Account: { Description: 'other owner' } }], [{ Id: 'c' }, { Id: 'd' }]]) {
    let writes = 0;
    const api: any = async (method: string) => { if (method !== 'GET') writes++; return { totalSize: rows.length, records: rows }; };
    await assert.rejects(() => salesforceCustomerProfile(api, () => 'v62.0').find(tool => tool.name === 'create_customer_profile')!.run(args), /identity|mapping|contacts/);
    assert.equal(writes, 0);
  }
});

test('commerce profile is passwordless external identity data and repeats do not create a second customer', async () => {
  let row: any; let writes = 0;
  const api: any = async (method: string, path: string, request: any) => {
    if (method === 'GET') return { total: row ? 1 : 0, results: row ? [row] : [] };
    writes++; assert.equal(request.body.authenticationMode, 'ExternalAuth'); assert.equal('password' in request.body, false);
    row = { ...request.body, id: 'customer-a', version: 1 }; return { customer: row };
  };
  const tool = commerceCustomerProfile(api).find(tool => tool.name === 'create_customer_profile')!;
  assert.equal((await tool.run(args)).created, true); assert.equal((await tool.run(args)).created, false); assert.equal(writes, 1);
  row.key = 'other-tenant'; await assert.rejects(() => tool.run(args), /mapping/); assert.equal(writes, 1);
});

function commerceOrderFixture() {
  const customer = { id: 'customer-a', key: args.externalCustomerKey, email: args.email };
  const order: any = { id: 'order-a', orderNumber: 'owned-order', version: 4, customerEmail: args.email, paymentState: 'Paid', paymentInfo: { payments: [{ id: 'payment-a' }] } };
  const payment: any = { id: 'payment-a', version: 1 };
  const writes: any[] = [];
  const api: any = async (method: string, path: string, request: any) => {
    if (method === 'GET') return path.startsWith('/customers/') ? customer : path.startsWith('/orders/') ? structuredClone(order) : structuredClone(payment);
    writes.push(request.body); const record = path.startsWith('/orders/') ? order : payment;
    assert.equal(request.body.version, record.version, 'every mutation uses the freshly read source version');
    const action = request.body.actions[0];
    if (action.action === 'setCustomerId') order.customerId = action.customerId;
    else if (action.action === 'setCustomer') payment.customer = action.customer;
    else assert.fail('an unrelated source mutation was attempted');
    record.version++; return structuredClone(record);
  };
  return { customer, order, payment, writes, tools: commerceCustomerProfile(api) };
}
test('an owned paid order and payment are linked, read back and replayed without another mutation', async () => {
  const f = commerceOrderFixture(); const write = f.tools.find(t => t.name === 'link_order_customer')!;
  const input = { orderNumber: 'owned-order', externalCustomerKey: args.externalCustomerKey, email: args.email };
  const receipt = await write.run(input);
  assert.equal(receipt.record.paymentCustomersLinked, true); assert.equal(receipt.record.customerId, 'customer-a'); assert.deepEqual(receipt.record.linkedPaymentIds, ['payment-a']);
  assert.equal(f.writes.length, 2); await write.run(input); assert.equal(f.writes.length, 2);
  assert.equal((await f.tools.find(t => t.name === 'get_order_customer_link')!.run({ orderId: 'owned-order' })).record.paymentCustomersLinked, true);
});
test('conflicting order owner or payment owner cannot be overwritten', async () => {
  for (const conflict of ['email', 'order', 'payment']) {
    const f = commerceOrderFixture();
    if (conflict === 'email') f.order.customerEmail = 'different@example.test';
    if (conflict === 'order') f.order.customerId = 'different-customer';
    if (conflict === 'payment') f.payment.customer = { id: 'different-customer' };
    await assert.rejects(() => f.tools.find(t => t.name === 'link_order_customer')!.run({ orderNumber: 'owned-order', externalCustomerKey: args.externalCustomerKey, email: args.email }), /owner|different/);
    assert.equal(f.writes.length, 0);
  }
});
