import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CartUpdateHandler } from '../src/capabilities/handlers/cart-update.handler';
import { TradeQuoteCreateHandler } from '../src/capabilities/handlers/trade-quote-create.handler';
import { CartRequestSchema } from '../src/commerce/cart-request';
import { commerceItems } from '../src/capabilities/handlers/catalogue-commerce';

const ctx: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', workspaceId: 'workspace-a', sessionId: 'session-a', idempotencyKey: 'request-a', packSettings: { catalogMapping: { identifierPaths: ['code'], pricing: { sources: [{ path: 'amount', unit: 'major', currencyPath: 'currency' }] } } }, release: { extensions: { commerce: { pricing: { currency: 'NZD', taxRate: 0, discountRate: 0 } } } } };
const products = [{ projectId: 'tenant-a', code: 'sku-a', name: 'Actual item', amount: 20, currency: 'NZD' }, { projectId: 'tenant-a', code: 'poa-a', name: 'Unpriced item', currency: 'NZD' }];

test('browser and agent carts obey the same paid-delivery limits', () => {
  const request = { sessionId: 'session-a', idempotencyKey: 'limit-a', expectedVersion: 0 };
  for (const items of [[{ sku: 'a', quantity: 1001 }], Array.from({ length: 51 }, (_, i) => ({ sku: `s-${i}`, quantity: 1 }))]) {
    assert.equal(CartRequestSchema.safeParse({ ...request, items }).success, false);
    assert.throws(() => commerceItems(items), /checkout/);
  }
  const boundary = Array.from({ length: 50 }, (_, i) => ({ sku: `s-${i}`, quantity: 1000 }));
  assert.equal(CartRequestSchema.safeParse({ ...request, items: boundary }).success, true);
  assert.equal(commerceItems(boundary).length, 50);
});

test('cart and quote share mapped authoritative prices and ignore model prices/descriptions', async () => {
  const carts = new Map();
  const handler = new CartUpdateHandler(undefined, carts, products);
  const items = [{ sku: 'sku-a', quantity: 3, unitPrice: 0.01, name: 'Invented item' }];
  const result = await handler.execute({ cartId: 'same-id', items }, ctx);
  const quote = await new TradeQuoteCreateHandler(undefined, undefined, products).execute({ items }, ctx);
  assert.equal(result.cart.items[0].unitPrice, 20);
  assert.equal(result.cart.items[0].name, 'Actual item');
  assert.equal(result.cart.subtotal, 60);
  assert.deepEqual(result.cart.items, quote.lines);
  assert.deepEqual(await handler.get({ cartId: 'same-id' }, ctx), result.cart);
});

test('a guessed cart ID cannot read or overwrite another principal, tenant, environment or workspace', async () => {
  const handler = new CartUpdateHandler(undefined, new Map(), products);
  await handler.execute({ cartId: 'same-id', items: [{ sku: 'sku-a', quantity: 2 }] }, ctx);
  for (const change of [{ principalId: 'customer-b' }, { tenantId: 'tenant-b' }, { environmentId: 'production' }, { workspaceId: 'workspace-b' }]) {
    const other = { ...ctx, ...change };
    assert.equal(await handler.get({ cartId: 'same-id' }, other), null);
    await handler.execute({ cartId: 'same-id', items: [] }, other);
    assert.equal((await handler.get({ cartId: 'same-id' }, ctx)).items[0].quantity, 2);
  }
  await assert.rejects(() => handler.get({ cartId: 'same-id' }, { ...ctx, principalId: undefined }), /verified/);
});

test('malformed items, ambiguous owners and unavailable catalogue entries fail before a cart mutation', async () => {
  const carts = new Map();
  const handler = new CartUpdateHandler(undefined, carts, products);
  for (const quantity of [0, -1, '2', 1.5, Infinity]) await assert.rejects(() => handler.execute({ items: [{ sku: 'sku-a', quantity }] }, ctx));
  for (const items of [undefined, [{ sku: 'missing', quantity: 1 }], [{ sku: 'sku-a' }, { sku: 'sku-a' }]]) await assert.rejects(() => handler.execute({ items }, ctx));
  for (const data of [[{ ...products[0], tenantId: 'tenant-b' }], [products[0], products[0]], [{ ...products[0], discontinued: true }]]) await assert.rejects(() => new CartUpdateHandler(undefined, carts, data).execute({ items: [{ sku: 'sku-a' }] }, ctx));
  assert.equal(carts.size, 0);
});

test('an unknown price remains unknown, while an explicit empty item list clears only the owned cart', async () => {
  const handler = new CartUpdateHandler(undefined, new Map(), products);
  const result = await handler.execute({ items: [{ sku: 'poa-a', quantity: 1 }] }, ctx);
  assert.equal(result.cart.pricesComplete, false);
  assert.equal(result.cart.items[0].unitPrice, null);
  assert.equal((await handler.execute({ items: [] }, { ...ctx, idempotencyKey: 'clear' })).cart.status, 'empty');
});


test('cart replay is exact, concurrent revisions conflict, and clearing preserves the old quote snapshot', async () => {
  const store = new Map();
  const handler = new CartUpdateHandler(undefined, store, products);
  const request = { items: [{ sku: 'sku-a', quantity: 2 }], expectedVersion: 0 };
  const first = await handler.execute(request, ctx);
  const replay = await handler.execute(request, ctx);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.cart.version, 1);
  assert.equal(first.quote.quoteId, replay.quote.quoteId);
  assert.equal(first.quote.total, 40);
  await assert.rejects(() => handler.execute({ ...request, items: [{ sku: 'sku-a', quantity: 3 }] }, ctx), /idempotency/);
  await assert.rejects(() => handler.execute(request, { ...ctx, idempotencyKey: 'stale' }), /revision/);
  const cleared = await handler.execute({ items: [], expectedVersion: 1 }, { ...ctx, idempotencyKey: 'clear' });
  assert.equal(cleared.cart.version, 2);
  assert.equal(cleared.cart.status, 'empty');
  assert.equal(cleared.quote, undefined);
  assert.equal(first.quote.lines[0].quantity, 2);
  assert.equal((await handler.read({}, ctx))?.quote, undefined);
});
