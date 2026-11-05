import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { CheckoutQuoteRepository } from '@journeyax/database';
import { OrderService } from '../src/commerce/order.service';

async function setup() {
  const db = new MemoryDb({ transactional: true });
  const owner = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a' };
  const order: any = { ...owner, orderId: 'order-a', quoteId: 'quote-a', quoteVersion: 1, stripeSessionId: 'cs-a', status: 'pending_payment', currency: 'NZD', total: 42, paymentSecretRef: 'secret:payment-fixture' };
  await db.collection('orders').insertOne(order);
  await db.collection('quotes').insertOne({ ...owner, quoteId: 'quote-a', version: 1, status: 'draft', checkoutOrderId: order.orderId });
  const receipt: any = { id: 'cs-a', status: 'complete', payment_status: 'paid', livemode: false, amount_total: 4200, currency: 'nzd', metadata: { ...owner, orderId: 'order-a', quoteId: 'quote-a', quoteVersion: '1' } };
  const service = new OrderService(async () => db, { resolve: async () => 'sk_test_fixture' });
  const stripe: any = { checkout: { sessions: { retrieve: async () => receipt } }, webhooks: { constructEvent: () => ({ id: 'event-a', type: 'checkout.session.completed', data: { object: receipt } }) } };
  (service as any).stripeClient = () => stripe;
  return { db, order, owner, receipt, service, stripe, repository: new CheckoutQuoteRepository(db) };
}

test('provider polling and signed webhook converge to one paid order, ordered quote and durable delivery event', async () => {
  const { db, owner, service } = await setup();
  const webhook = () => service.handleWebhook('{}', 'signed-fixture', 'sk_test_fixture', owner.tenantId, { environmentId: 'test', secret: 'whsec_fixture' });
  const results = await Promise.all([service.get('order-a', owner.tenantId, owner, 'sk_test_fixture'), webhook(), webhook()]);
  assert.equal((results[0] as any).status, 'paid');
  assert.equal(db.dump('quotes')[0].status, 'ordered');
  assert.equal(db.dump('orders')[0].status, 'paid');
  assert.equal(db.dump('outbox_events').length, 1);
  assert.equal(db.dump('outbox_events')[0].eventType, 'commerce.order_paid');
  assert.deepEqual(db.dump('outbox_events')[0].payload, { orderId: 'order-a' });
});

test('failed outbox persistence rolls back order and quote and never reports a paid receipt', async () => {
  const { db, owner, service } = await setup();
  db.collection('outbox_events').insertOne = async () => { throw new Error('storage unavailable'); };
  const result = await service.get('order-a', owner.tenantId, owner, 'sk_test_fixture');
  assert.equal(result?.status, 'pending_payment');
  assert.equal(db.dump('quotes')[0].status, 'draft');
  assert.equal(db.dump('orders')[0].status, 'pending_payment');
});

test('expired provider session releases only its own reservation and permits a cart revision', async () => {
  const { db, owner, service, receipt } = await setup();
  Object.assign(receipt, { status: 'expired', payment_status: 'unpaid' });
  assert.equal((await service.get('order-a', owner.tenantId, owner, 'sk_test_fixture'))?.status, 'failed');
  assert.equal(db.dump('quotes')[0].checkoutOrderId, undefined);
  assert.equal(db.dump('quotes')[0].status, 'draft');
  assert.equal(db.dump('outbox_events').length, 0);
});

test('a late failure reads current provider state and cannot unlock a paid checkout', async () => {
  const { db, owner, service, stripe, receipt } = await setup();
  stripe.webhooks.constructEvent = () => ({ type: 'checkout.session.expired', data: { object: { ...receipt, status: 'expired', payment_status: 'unpaid' } } });
  assert.equal((await service.handleWebhook('{}', 'signed', 'sk_test_fixture', owner.tenantId, { environmentId: 'test', secret: 'whsec_fixture' })).ok, true);
  assert.equal(db.dump('orders')[0].status, 'paid');
  assert.equal(db.dump('quotes')[0].status, 'ordered');
  assert.equal(db.dump('quotes')[0].checkoutOrderId, 'order-a');
});

test('wrong principal, stale version and another reservation cannot settle or unlock a quote', async () => {
  const { db, order, repository } = await setup();
  await assert.rejects(() => repository.settle({ ...order, principalId: 'customer-b' }, 'paid'), /reservation/);
  await assert.rejects(() => repository.settle({ ...order, quoteVersion: 2 }, 'failed'), /reservation/);
  await db.collection('quotes').updateOne({ quoteId: 'quote-a' }, { $set: { checkoutOrderId: 'another-order' } });
  await assert.rejects(() => repository.settle(order, 'failed'), /reservation/);
  assert.equal(db.dump('quotes')[0].checkoutOrderId, 'another-order');
  assert.equal(db.dump('orders')[0].status, 'pending_payment');
});

test('cancellation expires the provider session before releasing the cart; another customer cannot cancel it', async () => {
  const { db, owner, receipt, service, stripe } = await setup();
  Object.assign(receipt, { status: 'open', payment_status: 'unpaid' });
  let expired = 0;
  stripe.checkout.sessions.expire = async () => { expired++; assert.equal(db.dump('quotes')[0].checkoutOrderId, 'order-a'); return { ...receipt, status: 'expired' }; };
  assert.equal(await service.cancel('order-a', owner.tenantId, { ...owner, principalId: 'someone-else' }), null);
  assert.equal(expired, 0);
  assert.equal((await service.cancel('order-a', owner.tenantId, { ...owner, role: 'buyer', groups: [] } as any))?.status, 'cancelled');
  assert.equal(expired, 1);
  assert.equal(db.dump('quotes')[0].checkoutOrderId, undefined);
  assert.equal((await service.cancel('order-a', owner.tenantId, owner))?.status, 'cancelled');
  assert.equal(expired, 1);
});

test('cancellation racing a completed payment commits payment, and pending async payment stays locked', async () => {
  const { db, owner, receipt, service, stripe } = await setup();
  Object.assign(receipt, { status: 'open', payment_status: 'unpaid' });
  stripe.checkout.sessions.expire = async () => { Object.assign(receipt, { status: 'complete', payment_status: 'paid' }); throw new Error('not open'); };
  assert.equal((await service.cancel('order-a', owner.tenantId, owner))?.status, 'paid');
  assert.equal(db.dump('quotes')[0].status, 'ordered');
  const pending = await setup(); Object.assign(pending.receipt, { status: 'complete', payment_status: 'unpaid' });
  await assert.rejects(() => pending.service.cancel('order-a', pending.owner.tenantId, pending.owner), /processing/);
  assert.equal(pending.db.dump('quotes')[0].checkoutOrderId, 'order-a');
});
