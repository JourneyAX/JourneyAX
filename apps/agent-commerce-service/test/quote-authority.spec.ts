import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteService } from '../src/commerce/quote.service';
import { priceCommerceLines } from '@journeyax/shared-types';

const args: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', sessionId: 'chat-a', idempotencyKey: 'quote-a', items: [{ sku: 'sku-a', quantity: 2 }], pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 } };
function setup() {
  const docs: any[] = [];
  const service = new QuoteService();
  const catalogue = [{ sku: 'sku-a', name: 'Authoritative item', price: 20, currency: 'NZD' }];
  (service as any).getCol = async () => ({ findOne: async (filter: any) => docs.find(doc => Object.entries(filter).every(([key, value]) => doc[key] === value)), insertOne: async (doc: any) => { docs.push(structuredClone(doc)); } });
  (service as any).fetchPricebook = async () => ({ items: catalogue, missing: [] });
  return { service, docs, catalogue };
}

test('specialised and runtime quotes use the same policy calculation and keep unknown stock unknown', async () => {
  const { service } = setup();
  const quote = await service.build({ ...args, items: [{ ...args.items[0], unitPrice: 0.01 }] });
  assert.equal(quote.total, 46);
  assert.equal(quote.lines[0].unitPrice, 20);
  assert.equal(quote.lines[0].inStock, undefined);
  assert.equal(quote.total, priceCommerceLines(quote.lines, args.pricing).total);
});

test('quote replay requires identical input and a durable saved record', async () => {
  const { service, docs } = setup();
  const first = await service.build(args);
  const replay = await service.build(args);
  assert.equal(first.quoteId, replay.quoteId);
  assert.equal(docs.length, 1);
  await assert.rejects(() => service.build({ ...args, items: [{ sku: 'sku-a', quantity: 3 }] }), /idempotency/);
  (service as any).getCol = async () => null;
  await assert.rejects(() => service.build(args), /storage/);
  (service as any).getCol = async () => ({ findOne: async () => null, insertOne: async () => { throw new Error('database lost'); } });
  await assert.rejects(() => service.build({ ...args, idempotencyKey: 'second' }), /saved/);
});

test('unpriced items or missing tax policy cannot become payable and malformed quantities cannot mutate storage', async () => {
  const { service, docs, catalogue } = setup();
  for (const quantity of [-1, 0, 1.5, '2']) await assert.rejects(() => service.build({ ...args, items: [{ sku: 'sku-a', quantity }] }));
  assert.equal(docs.length, 0);
  catalogue[0].price = null as any;
  const poa = await service.build(args);
  assert.equal(poa.validation.ok, false);
  assert.equal(poa.lines[0].unitPrice, null);
  catalogue[0].price = 20;
  const noTax = await service.build({ ...args, idempotencyKey: 'no-tax', pricing: { currency: 'NZD', symbol: '$' } });
  assert.equal(noTax.validation.ok, false);
  assert.match(noTax.validation.errors.join(' '), /tax/);
});
