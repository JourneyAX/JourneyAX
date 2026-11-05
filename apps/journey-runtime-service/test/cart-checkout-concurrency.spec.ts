import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { CartUpdateHandler } from '../src/capabilities/handlers/cart-update.handler';
import { QuoteUpdateHandler } from '../src/capabilities/handlers/quote-update.handler';
import { OrderService } from '../../agent-commerce-service/src/commerce/order.service';

const context: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', workspaceId: 'chat-a', sessionId: 'chat-a', idempotencyKey: 'first', release: { extensions: { commerce: { pricing: { currency: 'NZD', symbol: '$', taxRate: 0, discountRate: 0 } } } } };
async function setup() {
  const db = new MemoryDb({ transactional: true });
  await db.collection('products').insertOne({ projectId: 'tenant-a', sku: 'P1', name: 'Catalogued product', priceCents: 2000, currency: 'NZD' });
  const cart = new CartUpdateHandler(undefined, undefined, undefined, async () => db);
  const first = await cart.execute({ expectedVersion: 0, items: [{ sku: 'P1', quantity: 1 }] }, context);
  const quote = new QuoteUpdateHandler(undefined, undefined, undefined, async () => db);
  return { db, cart, quote, first };
}

test('cart and quote edits share one revision boundary, expire the replaced snapshot and leave no orphan', async () => {
  const { db, cart, quote, first } = await setup();
  const result = await Promise.allSettled([
    cart.execute({ expectedVersion: 1, items: [{ sku: 'P1', quantity: 2 }] }, { ...context, idempotencyKey: 'cart-edit' }),
    quote.execute({ quoteId: first.quote.quoteId, expectedVersion: 1, items: [{ sku: 'P1', quantity: 3 }] }, { ...context, idempotencyKey: 'quote-edit' }),
  ]);
  assert.equal(result.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(result.filter(entry => entry.status === 'rejected').length, 1);
  const active = await cart.read({}, context);
  assert.equal(active?.cart.version, 2);
  assert.equal(db.dump('quotes').length, 2);
  assert.equal(db.dump('quotes').find(row => row.quoteId === first.quote.quoteId)?.status, 'expired');
  assert.equal(db.dump('quotes').filter(row => row.status === 'draft').length, 1);
});

test('a pointer failure rolls back the inserted quote and expiration of the previous quote', async () => {
  const { db, cart, first } = await setup();
  const collection = db.collection('customer_carts');
  collection.replaceOne = async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }) as any;
  await assert.rejects(() => cart.execute({ expectedVersion: 1, items: [{ sku: 'P1', quantity: 2 }] }, { ...context, idempotencyKey: 'failed' }), /revision/);
  assert.equal(db.dump('quotes').length, 1);
  assert.equal(db.dump('quotes')[0].status, 'draft');
  assert.equal((await cart.read({}, context))?.quote.quoteId, first.quote.quoteId);
  assert.equal(db.dump('customer_carts')[0].version, 1);
});

test('cart-bound quote updates replay exactly through the cart and cannot edit a superseded snapshot', async () => {
  const { db, cart, quote, first } = await setup();
  const request = { quoteId: first.quote.quoteId, mode: 'add' as const, items: [{ sku: 'P1', quantity: 2 }] };
  const edit = { ...context, idempotencyKey: 'quote-add' };
  const changed = await quote.execute(request, edit);
  assert.notEqual(changed.quote.quoteId, first.quote.quoteId);
  assert.equal(changed.cart.version, 2);
  assert.equal(changed.quote.lines[0].quantity, 3);
  assert.equal((await quote.execute(request, edit)).idempotentReplay, true);
  await assert.rejects(() => quote.execute(request, { ...edit, idempotencyKey: 'stale-edit' }), /revision/);
  assert.equal(db.dump('quotes').length, 2);
  assert.equal((await cart.read({}, context))?.quote.quoteId, changed.quote.quoteId);
});

test('a retired duplicate prevents new cart/quote revisions without changing the existing snapshot', async () => {
  const { db, cart, quote, first } = await setup();
  await db.collection('products').insertOne({ projectId: 'tenant-a', sku: 'P1', name: 'Retired duplicate source', priceCents: 9900, currency: 'NZD', discontinued: true, status: 'Discontinued' });
  await assert.rejects(() => cart.execute({ expectedVersion: 1, items: [{ sku: 'P1', quantity: 2 }] }, { ...context, idempotencyKey: 'ambiguous-cart' }), /ambiguous SKU/);
  await assert.rejects(() => quote.execute({ quoteId: first.quote.quoteId, expectedVersion: 1, items: [{ sku: 'P1', quantity: 2 }] }, { ...context, idempotencyKey: 'ambiguous-quote' }), /ambiguous SKU/);
  const active = await cart.read({}, context);
  assert.equal(active?.cart.version, 1);
  assert.equal(active?.quote.quoteId, first.quote.quoteId);
  assert.equal(active?.quote.lines[0].unitPrice, 20, 'the historical draft is not repriced or mutated');
  assert.equal(db.dump('quotes').length, 1);
  assert.equal(db.dump('quotes')[0].status, 'draft');
});

test('checkout refuses stale cart snapshots and reserves the current quote before calling Stripe', async () => {
  const { db, cart, first } = await setup();
  const current = await cart.execute({ expectedVersion: 1, items: [{ sku: 'P1', quantity: 2 }] }, { ...context, idempotencyKey: 'next' });
  const orders = new OrderService(async () => db, undefined, { validate: async () => {} }); let calls = 0;
  (orders as any).stripeClient = () => ({ checkout: { sessions: { create: async () => { calls++; return { id: 'cs_fixture', url: 'https://payment.invalid/session' }; } } } });
  const args = { tenantId: context.tenantId, environmentId: context.environmentId, principalId: context.principalId, idempotencyKey: 'payment', successUrl: 'https://shop.invalid/paid', cancelUrl: 'https://shop.invalid/cart' };
  assert.equal((await orders.create({ ...args, quote: first.quote })).status, 'failed');
  assert.equal(calls, 0); assert.equal(db.dump('orders').length, 0);
  const checkout = await orders.create({ ...args, quote: current.quote });
  assert.equal(checkout.status, 'pending_payment'); assert.equal(calls, 1);
  assert.equal(db.dump('quotes').find(row => row.quoteId === current.quote.quoteId)?.checkoutOrderId, checkout.orderId);
  await assert.rejects(() => cart.execute({ expectedVersion: 2, items: [] }, { ...context, idempotencyKey: 'during-checkout' }), /Checkout/);
  assert.equal(db.dump('quotes').length, 2);
});

test('transaction storage cannot silently fall back to independent cart/quote writes', async () => {
  const db = new MemoryDb();
  await db.collection('products').insertOne({ projectId: 'tenant-a', sku: 'P1', priceCents: 2000, currency: 'NZD' });
  const cart = new CartUpdateHandler(undefined, undefined, undefined, async () => ({ collection: db.collection.bind(db) }));
  await assert.rejects(() => cart.execute({ expectedVersion: 0, items: [{ sku: 'P1', quantity: 1 }] }, context), /Transactional/);
  assert.equal(db.dump('quotes').length, 0); assert.equal(db.dump('customer_carts').length, 0);
});
