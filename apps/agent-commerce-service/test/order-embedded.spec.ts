import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import { createSuite, MemoryDb } from '@journeyax/test-support';
import { OrderService, type OrderDoc } from '../src/commerce/order.service';

/**
 * Paying inside the storefront: the order keeps what was bought, the payment form opens from a Stripe session made for it (no redirect),
 * the same unfinished order opens the same session again, and once Stripe says paid the order has who is billed and where it goes.
 */
const suite = createSuite('commerce: paying inside the storefront');

const quote: any = {
  quoteId: 'q1', tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', version: 1, title: 'Patio', currency: 'NZD', symbol: '$', status: 'draft',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), validation: { ok: true, errors: [], warnings: [] },
  lines: [
    { sku: 'P1', name: 'Forum Paver', quantity: 83, unitPrice: 5, lineTotal: 415, imageUrl: 'http://x/p1.jpg', sourceOfPrice: 'catalogue', inStock: true },
  ],
  subtotal: 415, discountRate: 0, discount: 0, taxRate: 0.15, tax: 62.25, total: 477.25,
};

async function service(stripe: any) {
  const db = new MemoryDb({ transactional: true });
  await db.collection('quotes').insertOne(quote);
  const col = db.collection<OrderDoc>('orders');
  const orders = new OrderService(async () => db, undefined, { validate: async () => {} });
  (orders as any).stripeClient = () => stripe;
  return { orders, col, db };
}

async function main() {
  await suite.test('unsupported delivery quantities and line counts are refused before Stripe or order reservation', async () => {
    let calls = 0;
    const stripe = { checkout: { sessions: { create: async () => { calls++; throw new Error('must not charge'); } } } };
    for (const lines of [[{ ...quote.lines[0], quantity: 1001 }], Array.from({ length: 51 }, (_, i) => ({ ...quote.lines[0], sku: `sku-${i}`, quantity: 1 }))]) {
      const { orders, col } = await service(stripe);
      const result = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote: { ...quote, lines }, idempotencyKey: 'over-limit', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'http://s/cancel' });
      assert.equal(result.status, 'failed'); assert.equal(result.orderId, '');
      assert.equal(col.docs.length, 0, 'an unsupported order must not reserve payment');
    }
    assert.equal(calls, 0);
  });
  await suite.test('an embedded payment uses the current provider page contract and an approved return URL for methods requiring redirects', async () => {
    let params: any;
    const stripe = { checkout: { sessions: { create: async (p: any) => { params = p; return { id: 'cs_1', client_secret: 'secret_1', url: null }; } } } };
    const { orders, col } = await service(stripe);
    const result = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'q1', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'http://s/cancel', embedded: true, collect: { shipping: true, countries: ['NZ'] }, stripe: { publishableKey: 'pk_test_x' } });
    assert.equal(result.status, 'pending_payment');
    assert.equal(result.clientSecret, 'secret_1');
    assert.equal(result.publishableKey, 'pk_test_x');
    assert.equal(params.ui_mode, 'embedded_page');
    assert.equal(params.redirect_on_completion, 'if_required');
    assert.equal(params.return_url, `http://s/${result.orderId}`);
    assert.equal(params.success_url, undefined, 'nothing redirects');
    assert.equal(params.billing_address_collection, 'required');
    assert.deepEqual(params.shipping_address_collection, { allowed_countries: ['NZ'] });
    assert.equal(params.line_items[0].price_data.unit_amount, 47725, 'the amount is the quote\'s total');
    const kept = col.docs[0];
    assert.equal(kept.lines!.length, 1, 'only payable lines are kept');
    assert.deepEqual(kept.lines![0], { sku: 'P1', name: 'Forum Paver', quantity: 83, unitPrice: 5, lineTotal: 415, imageUrl: 'http://x/p1.jpg' });
    assert.deepEqual([kept.subtotal, kept.tax, kept.total, kept.title, kept.symbol], [415, 62.25, 477.25, 'Patio', '$']);
  });

  await suite.test('the hosted page is still what a shop that did not switch embedded payment on gets', async () => {
    let params: any;
    const stripe = { checkout: { sessions: { create: async (p: any) => { params = p; return { id: 'cs_2', url: 'https://stripe.test/pay' }; } } } };
    const { orders } = await service(stripe);
    const result = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'q2', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'http://s/cancel' });
    assert.equal(result.checkoutUrl, 'https://stripe.test/pay');
    assert.equal(result.clientSecret, undefined);
    assert.equal(params.ui_mode, undefined);
    assert.match(params.success_url, /^http:\/\/s\/ord_/);
    assert.equal(params.shipping_address_collection, undefined, 'no delivery address is asked for unless the shop wants it');
  });

  await suite.test('an unfinished embedded order opens the same payment again, and a paid one does not', async () => {
    let created = 0;
    const stripe = { checkout: { sessions: {
      create: async () => { created++; return { id: 'cs_3', client_secret: 'secret_3' }; },
      retrieve: async () => ({ id: 'cs_3', status: 'open', client_secret: 'secret_3', payment_status: 'unpaid', livemode: false, amount_total: 47725, currency: 'nzd', metadata: { tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quoteId: 'q1', quoteVersion: '1', orderId: col.docs[0].orderId } }),
    } } };
    const { orders, col } = await service(stripe);
    const args = { tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'q3', successUrl: 'x', cancelUrl: 'y', embedded: true, stripe: { publishableKey: 'pk_test_y' } };
    const first = await orders.create(args);
    const second = await orders.create(args);
    assert.equal(created, 1, 'one Stripe session, however many times the customer opens the payment');
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.clientSecret, 'secret_3');
    (col.docs[0] as any).status = 'paid';
    const third = await orders.create(args);
    assert.equal(third.status, 'paid');
    assert.equal(third.clientSecret, undefined);
  });

  await suite.test('once Stripe says it is paid, the order has who is billed and where it goes, and the time it was paid', async () => {
    const stripe = { checkout: { sessions: {
      create: async () => ({ id: 'cs_4', client_secret: 'secret_4' }),
      retrieve: async () => ({
        id: 'cs_4', status: 'complete', payment_status: 'paid', livemode: false, amount_total: 47725, currency: 'nzd', metadata: { orderId: made.orderId, tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quoteId: 'q1', quoteVersion: '1' },
        customer_details: { name: 'Ana Smith', email: 'ana@example.com', phone: '+64 21 000 000', address: { line1: '1 High St', city: 'Auckland', postal_code: '1010', country: 'NZ' } },
        shipping_details: { name: 'Ana Smith', address: { line1: '9 Site Rd', city: 'Takapuna', postal_code: '0622', country: 'NZ' } },
      }),
    } } };
    const { orders } = await service(stripe);
    const made = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'q4', successUrl: 'x', cancelUrl: 'y', embedded: true });
    const read = await orders.get(made.orderId, 't');
    assert.equal(read!.status, 'paid');
    assert.ok(read!.paidAt);
    assert.equal(read!.billing!.name, 'Ana Smith');
    assert.equal(read!.billing!.address!.postalCode, '1010');
    assert.equal(read!.shipping!.address!.city, 'Takapuna');
    const again = await orders.get(made.orderId, 't');
    assert.equal(again!.status, 'paid');
    assert.equal(again!.lines![0].sku, 'P1', 'the order still says what was bought');
  });

  await suite.test('with no payment provider the request fails without recording a paid order', async () => {
    const { orders, col } = await service(null);
    const result = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'q5', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'y', embedded: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.clientSecret, undefined);
    assert.equal(col.docs.length, 0);
  });

  await suite.test('checkout retains only the verified owner’s registered source identity, ignoring other tenants and environments', async () => {
    const stripe = { checkout: { sessions: { create: async () => ({ id: 'cs_registered', url: 'https://stripe.test/pay' }) } } };
    const { orders, col, db } = await service(stripe);
    await db.collection('customer_profile_links').insertOne({ tenantId: 'different', environmentId: 'test', principalId: 'fixture-customer', canonicalId: 'wrong-tenant', status: 'ready' });
    await db.collection('customer_profile_links').insertOne({ tenantId: 't', environmentId: 'production', principalId: 'fixture-customer', canonicalId: 'wrong-environment', status: 'ready' });
    await db.collection('customer_profile_links').insertOne({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', email: 'verified@example.test', canonicalId: 'registered-customer', references: { commerce: { customerId: 'source-customer' } }, status: 'ready' });
    const result = await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'registered', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'y', customer: { email: 'untrusted@example.test' } });
    assert.equal(result.status, 'pending_payment');
    assert.deepEqual(col.docs[0].customerProfile, { canonicalId: 'registered-customer', email: 'verified@example.test', references: { commerce: { customerId: 'source-customer' } } });
  });

  await suite.test('a definite provider validation rejection releases the quote, while an uncertain network failure keeps it locked', async () => {
    for (const definite of [true, false]) {
      const error = definite ? Object.assign(new Error('Invalid checkout option'), { type: 'StripeInvalidRequestError', statusCode: 400 }) : Object.assign(new Error('Connection lost'), { type: 'StripeConnectionError' });
      const { orders, col, db } = await service({ checkout: { sessions: { create: async () => { throw error; } } } });
      await orders.create({ tenantId: 't', environmentId: 'test', principalId: 'fixture-customer', quote, idempotencyKey: 'rejected', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'y', embedded: true });
      assert.equal(col.docs[0].status, definite ? 'failed' : 'pending_payment');
      const saved = await db.collection('quotes').findOne({ quoteId: 'q1' });
      assert.equal(saved.checkoutOrderId, definite ? undefined : col.docs[0].orderId);
      assert.equal((await db.collection('outbox_events').find({}).toArray()).length, 0, 'no payment event can be invented');
    }
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
