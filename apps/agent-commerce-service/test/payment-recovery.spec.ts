import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { OrderService } from '../src/commerce/order.service';

test('server recovery settles a matching paid session without a browser, once across replicas; wrong scopes and mismatched receipts cannot settle', async () => {
  const db = new MemoryDb({ transactional: true });
  const quote: any = { tenantId: 'merchant-a', environmentId: 'test', principalId: 'shopper', quoteId: 'recovery-quote', version: 1, workspaceId: 'chat-a', status: 'draft', currency: 'NZD', total: 11.5, subtotal: 10, tax: 1.5, taxRate: .15, discount: 0, expiresAt: new Date(Date.now() + 3600000).toISOString(), validation: { ok: true, errors: [] }, lines: [{ sku: 'real-source-fixture', name: 'Fixture', quantity: 1, unitPrice: 10, lineTotal: 10 }] };
  await db.collection('quotes').insertOne(quote);
  const secrets: any = { resolve: async (_ref: string, scope: any) => { assert.equal(scope.tenantId, 'merchant-a'); assert.equal(scope.environmentId, 'test'); return 'sk_test_fixture'; } };
  let reads = 0, mismatch = true;
  const provider = { checkout: { sessions: { create: async () => ({ id: 'cs_recovery', url: 'https://provider.invalid/test' }), retrieve: async () => { reads++; return { id: 'cs_recovery', livemode: false, status: 'complete', payment_status: 'paid', currency: 'nzd', amount_total: mismatch ? 9999 : 1150, metadata: { orderId: created.orderId, tenantId: 'merchant-a', environmentId: 'test', principalId: 'shopper', quoteId: quote.quoteId, quoteVersion: '1' } }; } } } };
  const orders = new OrderService(async () => db, secrets, { validate: async () => {} }); (orders as any).stripeClient = () => provider;
  const created = await orders.create({ tenantId: quote.tenantId, environmentId: 'test', principalId: 'shopper', quote, idempotencyKey: 'one-checkout', successUrl: 'https://shop.invalid/{ORDER_ID}', cancelUrl: 'https://shop.invalid/cancel', stripe: { secretKey: 'sk_test_fixture', secretRef: 'secret:test:payment' } });
  assert.equal(created.status, 'pending_payment');
  await orders.reconcilePending('other', 'test'); assert.equal(reads, 0);
  await orders.reconcilePending('merchant-a', 'test'); assert.equal(reads, 1);
  assert.equal((await db.collection('orders').findOne({ orderId: created.orderId })).status, 'pending_payment');
  await db.collection('orders').updateOne({ orderId: created.orderId }, { $unset: { 'reconciliation.nextAt': '' } });
  mismatch = false;
  const replica = new OrderService(async () => db, secrets, { validate: async () => {} }); (replica as any).stripeClient = () => provider;
  await Promise.all([orders.reconcilePending('merchant-a', 'test'), replica.reconcilePending('merchant-a', 'test')]);
  assert.equal(reads, 2);
  assert.equal((await db.collection('orders').findOne({ orderId: created.orderId })).status, 'paid');
  assert.equal(await db.collection('outbox_events').countDocuments({ eventType: 'commerce.order_paid' }), 1);
  await orders.reconcilePending('merchant-a', 'test'); assert.equal(reads, 2);
});
