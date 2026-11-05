import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteUpdateHandler } from '../src/capabilities/handlers/quote-update.handler';
import { TradeQuoteCreateHandler } from '../src/capabilities/handlers/trade-quote-create.handler';

const ctx: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', workspaceId: 'workspace-a', sessionId: 'session-a', idempotencyKey: 'create', release: { extensions: { commerce: { pricing: { currency: 'NZD', taxRate: 0.15, discountRate: 0 } } } } };
const products = [{ projectId: 'tenant-a', sku: 'sku-a', name: 'Catalogue item', priceCents: 2000, currency: 'NZD' }, { projectId: 'tenant-a', sku: 'sku-b', name: 'Second item', priceCents: 1000, currency: 'NZD' }];
async function fixture() {
  const quote = await new TradeQuoteCreateHandler(undefined, undefined, products).execute({ items: [{ sku: 'sku-a', quantity: 2 }] }, ctx);
  const store = new Map([[quote.quoteId, quote]]);
  return { quote, store, handler: new QuoteUpdateHandler(undefined, store, products) };
}

test('quote edit reprices the complete quote, preserves its identity and returns the actual new revision', async () => {
  const { quote, handler } = await fixture();
  const changed = await handler.execute({ quoteId: quote.quoteId, expectedVersion: 1, items: [{ sku: 'sku-a', quantity: 4, unitPrice: 0.01 } as any] }, { ...ctx, idempotencyKey: 'edit' });
  assert.equal(changed.quote.quoteId, quote.quoteId);
  assert.equal(changed.quote.version, 2);
  assert.equal(changed.quote.subtotal, 80);
  assert.equal(changed.quote.total, 92);
  assert.equal(changed.quote.lines[0].unitPrice, 20);
  assert.equal(changed.quote.expiresAt, quote.expiresAt);
});

test('add-to-quote adds quantities to verified existing lines, with replay bound to exact input', async () => {
  const { quote, handler } = await fixture();
  const request = { quoteId: quote.quoteId, mode: 'add' as const, items: [{ sku: 'sku-a', quantity: 1 }, { sku: 'sku-b', quantity: 2 }] };
  const context = { ...ctx, idempotencyKey: 'add' };
  const first = await handler.execute(request, context);
  assert.deepEqual(first.quote.lines.map((line: any) => [line.sku, line.quantity]), [['sku-a', 3], ['sku-b', 2]]);
  const replay = await handler.execute(request, context);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.quote, first.quote);
  await assert.rejects(() => handler.execute({ ...request, items: [{ sku: 'sku-a', quantity: 5 }] }, context), /idempotency/);
});

test('wrong owner, stale revision, expired and ordered quotes are never changed', async () => {
  const { quote, store, handler } = await fixture();
  const input = { quoteId: quote.quoteId, items: [{ sku: 'sku-a', quantity: 3 }] };
  for (const change of [{ principalId: 'customer-b' }, { tenantId: 'tenant-b' }, { environmentId: 'production' }, { workspaceId: 'other' }]) await assert.rejects(() => handler.execute(input, { ...ctx, ...change, idempotencyKey: 'edit' }), /unavailable/);
  await assert.rejects(() => handler.execute({ ...input, expectedVersion: 2 }, { ...ctx, idempotencyKey: 'edit' }), /revision/);
  store.set(quote.quoteId, { ...quote, status: 'ordered' });
  await assert.rejects(() => handler.execute(input, { ...ctx, idempotencyKey: 'edit' }), /draft/);
  store.set(quote.quoteId, { ...quote, expiresAt: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(() => handler.execute(input, { ...ctx, idempotencyKey: 'edit' }), /unexpired/);
});

test('concurrent quote edits cannot silently overwrite the winning revision', async () => {
  const { quote, store, handler } = await fixture();
  const results = await Promise.allSettled([2, 3].map(quantity => handler.execute({ quoteId: quote.quoteId, expectedVersion: 1, items: [{ sku: 'sku-a', quantity }] }, { ...ctx, idempotencyKey: `edit-${quantity}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.get(quote.quoteId).version, 2);
});
