import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { CheckoutReceiptHandler } from '../src/capabilities/handlers/checkout-receipt.handler';
import { executeAgentTool } from '../src/agent/agent-tools';

const owner = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a' };
const orderId = 'ord_' + 'a'.repeat(32);
async function fixture() {
  const db = new MemoryDb({ transactional: true });
  const release = { version: '1.0.0', checksum: 'a'.repeat(64) };
  const order = { ...owner, orderId, quoteId: 'quote-a', quoteVersion: 2, release, workspaceId: 'original-chat', status: 'paid', stripeSessionId: 'cs_test_a', paidAt: '2026-01-01T00:00:00Z', subtotal: 20, tax: 3, taxRate: 0.15, total: 23, currency: 'NZD', billing: { email: 'private@example.invalid' }, shipping: { address: { line1: 'Private address' } }, commerceSync: { eventId: `commerce.order-paid:tenant-a:test:${orderId}`, status: 'ready' }, lines: [{ sku: 'P1', name: 'Actual item', quantity: 2, unitPrice: 10, lineTotal: 20 }] };
  await db.collection('orders').insertOne(order);
  await db.collection('quotes').insertOne({ ...owner, quoteId: order.quoteId, version: order.quoteVersion, checkoutOrderId: orderId, status: 'ordered', total: order.total, currency: order.currency, release });
  return { db, handler: new CheckoutReceiptHandler(async () => db) };
}

test('the same owner can discuss a committed checkout across chats without exposing billing, addresses or secrets', async () => {
  const { handler } = await fixture();
  const result = await handler.execute({ orderId }, { ...owner, workspaceId: 'new-chat' } as any);
  assert.equal(result.found, true);
  assert.equal(result.receipt!.total, 23);
  assert.equal(result.receipt!.taxPercent, 15);
  assert.equal(result.receipt!.lines[0].sku, 'P1');
  assert.equal(result.receipt!.liveFulfilmentVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /private@example|Private address|cs_test_a|paymentSecretRef/);
});

test('an order card uses the committed purchase values and cannot be fabricated or repriced from the current catalogue', async () => {
  const { handler, db } = await fixture();
  await db.collection('orders').updateOne({ orderId }, { $set: { paidAt: new Date('2026-01-01T00:00:00Z') } });
  const result = await handler.execute({ orderId }, owner as any);
  assert.equal(result.receipt!.paidAt, '2026-01-01T00:00:00.000Z', 'Mongo timestamps become card-compatible ISO strings');
  const ctx: any = { ...owner, correlationId: 'receipt-card', release: { manifest: { tenantId: owner.tenantId }, experience: { cards: { allowedCardTypes: ['orderStatus'] } } }, turnProductSkus: new Set(), catalogProductCache: new Map([['P1', { sku: 'P1', price: 999, title: 'Changed listing' }]]), allowedClaimClasses: new Set(), presentedCards: [], readSourceIds: new Set() };
  assert.equal((await executeAgentTool('present_card', { cardType: 'orderStatus', state: { orderId } }, ctx)).ok, false);
  ctx.lastCheckoutReceipt = result.receipt;
  assert.equal((await executeAgentTool('present_card', { cardType: 'orderStatus', state: { orderId: 'another-order' } }, ctx)).ok, false);
  const shown = await executeAgentTool('present_card', { cardType: 'orderStatus', state: { orderId, status: 'refunded', lines: [], totals: { total: 0.01 } } }, ctx);
  assert.equal(shown.ok, true);
  const card = ctx.presentedCards[0].state;
  assert.equal(card.status, 'paid');
  assert.equal(card.totals.total, 23);
  assert.equal(card.totals.tax, 3);
  assert.equal(card.lines[0].price, 10);
  assert.equal(card.lines[0].title, 'Actual item');
  assert.equal(card.lines[0].qty, 2);
});

test('a guessed reference cannot expose another owner, tenant or environment', async () => {
  const { handler } = await fixture();
  for (const change of [{ principalId: 'other' }, { tenantId: 'other' }, { environmentId: 'production' }]) assert.deepEqual(await handler.execute({ orderId }, { ...owner, ...change } as any), { found: false });
  await assert.rejects(() => handler.execute({ orderId }, { ...owner, principalId: 'anonymous' } as any), /verified/);
  await assert.rejects(() => handler.execute({ orderId: 'AAAAAAAA' }, owner as any), /complete/);
});

test('a claimed paid state and mismatched quote cannot become an authoritative receipt', async () => {
  const { db, handler } = await fixture();
  await db.collection('orders').updateOne({ orderId }, { $unset: { stripeSessionId: '' } });
  await assert.rejects(() => handler.execute({ orderId }, owner as any), /committed payment receipt/);
  await db.collection('quotes').updateOne({ quoteId: 'quote-a' }, { $set: { total: 0.01 } });
  await assert.rejects(() => handler.execute({ orderId }, owner as any), /disagree/);
});
