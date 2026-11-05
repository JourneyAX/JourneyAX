import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { TradeQuoteCreateHandler } from '../src/capabilities/handlers/trade-quote-create.handler';
import { paymentMatchesOrder, currencyMinorAmount, OrderService } from '../../agent-commerce-service/src/commerce/order.service';
const context: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', workspaceId: 'private-a', sessionId: 'private-a', idempotencyKey: 'request-a', packSettings: { catalogMapping: { identifierPaths: ['code'], pricing: { sources: [{ path: 'amount', unit: 'major', currencyPath: 'currency' }] } } }, release: { extensions: { commerce: { pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 } } } } };
const catalogue = [{ projectId: 'tenant-a', code: 'sku-1', name: 'Actual catalogue product', amount: 20, currency: 'NZD' }, { projectId: 'tenant-a', code: 'poa-1', name: 'Unpriced product', currency: 'NZD' }];
test('runtime quote is the payable checkout contract with catalogue mapping and exact scope', async () => {
  const db = new MemoryDb({ transactional: true });
  for (const item of catalogue) await db.collection('products').insertOne(item);
  const handler = new TradeQuoteCreateHandler(undefined, undefined, undefined, async () => db);
  const quote = await handler.execute({ items: [{ sku: 'sku-1', quantity: 2, unitPrice: 0.01, name: 'invented' }] }, context);
  assert.equal(quote.status, 'draft'); assert.equal(quote.validation.ok, true);
  assert.equal(quote.lines[0].unitPrice, 20); assert.equal(quote.lines[0].name, 'Actual catalogue product');
  assert.equal(quote.subtotal, 40); assert.equal(quote.tax, 6); assert.equal(quote.total, 46);
  assert.equal(quote.principalId, 'customer-a'); assert.equal(quote.environmentId, 'test');
  // This fixture checks monetary parity; the published-source boundary is tested independently.
  const orders = new OrderService(async () => db, undefined, { validate: async ({ quote: current }, source) => {
    for (const line of current.lines) assert.ok(await source.collection('products').findOne({ projectId: 'tenant-a', code: line.sku }));
  } }); let session: any;
  (orders as any).stripeClient = () => ({ checkout: { sessions: { create: async (args: any) => { session = args; return { id: 'cs-fixture', url: 'https://stripe.test/pay' }; } } } });
  const checkout = await orders.create({ tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', quote, idempotencyKey: 'checkout-a', successUrl: 'https://shop.test', cancelUrl: 'https://shop.test' });
  assert.equal(checkout.status, 'pending_payment'); assert.equal(session.line_items[0].price_data.unit_amount, currencyMinorAmount(46, 'NZD'));
  const order = { ...db.dump('orders')[0], stripeSessionId: 'cs-fixture' };
  assert.equal(paymentMatchesOrder({ id: 'cs-fixture', status: 'complete', payment_status: 'paid', livemode: false, amount_total: 4600, currency: 'nzd', metadata: session.metadata } as any, order), true);
  assert.equal(paymentMatchesOrder({ id: 'cs-fixture', status: 'complete', payment_status: 'paid', livemode: false, amount_total: 4600, currency: 'nzd', metadata: { ...session.metadata, environmentId: 'production' } } as any, order), false);
  const other = await orders.create({ tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-b', quote, idempotencyKey: 'checkout-a', successUrl: 'x', cancelUrl: 'y' });
  assert.equal(other.status, 'failed');
});
test('POA and unknown tax remain visible draft issues and can never enter payment', async () => {
  const handler = new TradeQuoteCreateHandler(undefined, undefined, catalogue);
  const quote = await handler.execute({ items: [{ sku: 'poa-1', quantity: 2 }] }, context);
  assert.equal(quote.lines[0].unitPrice, null); assert.equal(quote.validation.ok, false);
  const withoutTax = await handler.execute({ items: [{ sku: 'sku-1' }] }, { ...context, release: {} });
  assert.equal(withoutTax.validation.ok, false); assert.match(withoutTax.validation.errors.join(' '), /tax/);
  const orders = new OrderService(); (orders as any).getCol = async () => ({ findOne: async () => null });
  (orders as any).stripeClient = () => { throw new Error('Must not contact payment'); };
  assert.equal((await orders.create({ tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', quote, idempotencyKey: 'a', successUrl: 'x', cancelUrl: 'y' })).status, 'failed');
});
test('negative, fractional and substituted quantities and conflicting owners cannot become quotes', async () => {
  for (const quantity of [0, -1, 1.5, '2', Infinity]) await assert.rejects(() => new TradeQuoteCreateHandler(undefined, undefined, catalogue).execute({ items: [{ sku: 'sku-1', quantity }] }, context));
  await assert.rejects(() => new TradeQuoteCreateHandler(undefined, undefined, [{ ...catalogue[0], tenantId: 'tenant-b' }]).execute({ items: [{ sku: 'sku-1' }] }, context), /Uncatalogued/);
});

test('draft quotes count retired duplicate source identities before lifecycle filtering and persist nothing', async () => {
  const duplicate = { ...catalogue[0], name: 'Retired duplicate source', amount: 99, discontinued: true, status: 'Discontinued' };
  for (const rows of [[catalogue[0], duplicate], [duplicate, catalogue[0]]]) {
    const db = new MemoryDb();
    await db.collection('products').insertMany(rows);
    const handler = new TradeQuoteCreateHandler(undefined, undefined, undefined, async () => db);
    await assert.rejects(() => handler.execute({ items: [{ sku: 'sku-1', quantity: 1 }] }, context), /ambiguous SKU/);
    assert.equal(db.dump('quotes').length, 0, 'no source row is silently chosen for a draft');
    await assert.rejects(() => new TradeQuoteCreateHandler(undefined, undefined, rows).execute({ items: [{ sku: 'sku-1', quantity: 1 }] }, context), /ambiguous SKU/, 'the explicit isolated source obeys the same identity boundary');
  }
});
