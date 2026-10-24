import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { OrderService, type OrderDoc } from '../src/commerce/order.service';

/**
 * Paying inside the storefront: the order keeps what was bought, the payment form opens from a Stripe session made for it (no redirect),
 * the same unfinished order opens the same session again, and once Stripe says paid the order has who is billed and where it goes.
 */
const suite = createSuite('commerce: paying inside the storefront');

const quote: any = {
  quoteId: 'q1', tenantId: 't', version: 1, title: 'Patio', currency: 'NZD', symbol: '$', status: 'draft',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), validation: { ok: true, errors: [], warnings: [] },
  lines: [
    { sku: 'P1', name: 'Forum Paver', quantity: 83, unitPrice: 5, lineTotal: 415, imageUrl: 'http://x/p1.jpg', sourceOfPrice: 'catalogue', inStock: true },
    { sku: 'U1', name: 'Priceless', quantity: 1, unitPrice: null, lineTotal: 0, sourceOfPrice: 'unavailable', inStock: true },
  ],
  subtotal: 415, discountRate: 0, discount: 0, taxRate: 0.15, tax: 62.25, total: 477.25,
};

function fakeCollection() {
  const docs: OrderDoc[] = [];
  return {
    docs,
    findOne: async (filter: any) => docs.find((d: any) => Object.entries(filter).every(([k, v]) => (d as any)[k] === v)) || null,
    insertOne: async (doc: OrderDoc) => { docs.push(doc); },
    updateOne: async (filter: any, update: any) => { const d: any = docs.find((x: any) => Object.entries(filter).every(([k, v]) => x[k] === v)); if (d) Object.assign(d, update.$set); },
    createIndex: async () => 'ok',
  };
}

function service(stripe: any, col = fakeCollection()) {
  const orders = new OrderService();
  (orders as any).getCol = async () => col;
  (orders as any).stripeClient = () => stripe;
  return { orders, col };
}

async function main() {
  await suite.test('an embedded payment asks Stripe for an embedded session that never redirects, and returns what the form needs', async () => {
    let params: any;
    const stripe = { checkout: { sessions: { create: async (p: any) => { params = p; return { id: 'cs_1', client_secret: 'secret_1', url: null }; } } } };
    const { orders, col } = service(stripe);
    const result = await orders.create({ tenantId: 't', quote, idempotencyKey: 'q1', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'http://s/cancel', embedded: true, collect: { shipping: true, countries: ['NZ'] }, stripe: { publishableKey: 'pk_test_x' } });
    assert.equal(result.status, 'pending_payment');
    assert.equal(result.clientSecret, 'secret_1');
    assert.equal(result.publishableKey, 'pk_test_x');
    assert.equal(params.ui_mode, 'embedded');
    assert.equal(params.redirect_on_completion, 'never');
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
    const { orders } = service(stripe);
    const result = await orders.create({ tenantId: 't', quote, idempotencyKey: 'q2', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'http://s/cancel' });
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
      retrieve: async () => ({ id: 'cs_3', status: 'open', client_secret: 'secret_3' }),
    } } };
    const { orders, col } = service(stripe);
    const args = { tenantId: 't', quote, idempotencyKey: 'q3', successUrl: 'x', cancelUrl: 'y', embedded: true, stripe: { publishableKey: 'pk_test_y' } };
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
        id: 'cs_4', status: 'complete', payment_status: 'paid',
        customer_details: { name: 'Ana Smith', email: 'ana@example.com', phone: '+64 21 000 000', address: { line1: '1 High St', city: 'Auckland', postal_code: '1010', country: 'NZ' } },
        shipping_details: { name: 'Ana Smith', address: { line1: '9 Site Rd', city: 'Takapuna', postal_code: '0622', country: 'NZ' } },
      }),
    } } };
    const { orders } = service(stripe);
    const made = await orders.create({ tenantId: 't', quote, idempotencyKey: 'q4', successUrl: 'x', cancelUrl: 'y', embedded: true });
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

  await suite.test('with no payment provider switched on the order stands as paid straight away, with its items kept', async () => {
    const { orders, col } = service(null);
    const result = await orders.create({ tenantId: 't', quote, idempotencyKey: 'q5', successUrl: 'http://s/{ORDER_ID}', cancelUrl: 'y', embedded: true });
    assert.equal(result.status, 'paid');
    assert.equal(result.clientSecret, undefined);
    assert.equal(col.docs[0].lines!.length, 1);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
