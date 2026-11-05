import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, publishBusinessPack, getVerifiedBusinessPackMetadata } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { PublishedCheckoutCatalogueAuthority } from '../src/commerce/checkout-catalogue-authority';
import { OrderService } from '../src/commerce/order.service';

async function fixture() {
  const db = new MemoryDb({ transactional: true }), raw: any = structuredClone(rawLegacyFixture); raw.manifest.environmentId = 'test';
  await publishBusinessPack(db as any, raw);
  const pack = await new PackRepository(db).loadActivePack('placemakers', 'test'), meta = getVerifiedBusinessPackMetadata(pack)!;
  const quote: any = { tenantId: 'placemakers', environmentId: 'test', principalId: 'owner', quoteId: 'old-quote', version: 1, status: 'draft', release: { version: meta.version, checksum: meta.checksum }, currency: 'NZD', total: 10, subtotal: 10, tax: 0, discount: 0, taxRate: 0, discountRate: 0, expiresAt: new Date(Date.now() + 3600000).toISOString(), validation: { ok: true, errors: [] }, lines: [{ sku: 'SOURCE-A', name: 'Previously priced item', quantity: 1, unitPrice: 10, lineTotal: 10 }] };
  await db.collection('quotes').insertOne(quote);
  await db.collection('products').insertOne({ projectId: 'placemakers', sku: 'SOURCE-A', name: 'Product', url: 'https://shop.example/a', web: { productUrl: 'https://shop.example/a' }, price: { amount: 999, currency: 'NZD' } });
  return { db, quote, scope: { tenantId: 'placemakers', environmentId: 'test', quote }, args: { tenantId: 'placemakers', environmentId: 'test', principalId: 'owner', quote, idempotencyKey: 'one-order', successUrl: 'https://shop.invalid/success', cancelUrl: 'https://shop.invalid/cancel' } };
}

test('checkout identity validation uses the pinned published mapping without changing the quoted price', async () => {
  const { db, quote, scope } = await fixture(), before = JSON.stringify(quote);
  await new PublishedCheckoutCatalogueAuthority().validate(scope, db);
  assert.equal(JSON.stringify(quote), before); assert.equal(quote.lines[0].unitPrice, 10);
  await assert.rejects(new PublishedCheckoutCatalogueAuthority().validate({ ...scope, tenantId: 'other' }, db), /scoped/);
  await assert.rejects(new PublishedCheckoutCatalogueAuthority().validate({ ...scope, quote: { ...quote, release: { ...quote.release, checksum: '0'.repeat(64) } } }, db));
});

test('a pre-guard quote cannot create a Stripe session once its source identity is conflicted, missing or cross-tenant', async () => {
  for (const changed of [
    { url: 'https://shop.example/renamed', web: { productUrl: 'https://shop.example/original' } },
    { projectId: 'other' }, { tenantId: 'other' }, { discontinued: true },
  ]) {
    const { db, args } = await fixture(); await db.collection('products').updateOne({ sku: 'SOURCE-A' }, { $set: changed });
    let providerCreates = 0;
    const orders = new OrderService(async () => db);
    (orders as any).stripeClient = () => ({ checkout: { sessions: { create: async () => { providerCreates++; return {}; } } } });
    const result = await orders.create(args);
    assert.equal(result.status, 'failed'); assert.match(result.error || '', /catalogue source identity/);
    assert.equal(providerCreates, 0); assert.equal(db.dump('orders').length, 0); assert.equal(db.dump('quotes')[0].checkoutOrderId, undefined);
  }
});

test('historical paid replay remains readable without revalidating or repricing its catalogue', async () => {
  const { db, quote, args } = await fixture();
  await db.collection('orders').insertOne({ tenantId: args.tenantId, environmentId: args.environmentId, principalId: args.principalId, orderId: 'paid-history', idempotencyKey: args.idempotencyKey, quoteId: quote.quoteId, quoteVersion: quote.version, total: quote.total, currency: quote.currency, status: 'paid' });
  let validations = 0;
  const orders = new OrderService(async () => db, undefined, { validate: async () => { validations++; throw new Error('source now changed'); } });
  const result = await orders.create(args);
  assert.equal(result.status, 'paid'); assert.equal(result.orderId, 'paid-history'); assert.equal(result.total, 10); assert.equal(validations, 0);
});

test('a retired or conflicted duplicate cannot make the first source row the checkout winner', async () => {
  const { db, scope } = await fixture();
  await db.collection('products').insertOne({ projectId: 'placemakers', sku: 'SOURCE-A', name: 'Another identity', discontinued: true });
  await assert.rejects(new PublishedCheckoutCatalogueAuthority().validate(scope, db), /ambiguous/);
});
