import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const context: any = {
  tenantId: 'shop-a', environmentId: 'test', workspaceId: 'isolated', sessionId: 'isolated',
  stageId: 'unused', packVersionId: 'test', correlationId: 'isolated', packSettings: {},
};
const product = (sku: string, more: Record<string, unknown> = {}) => ({
  tenantId: 'shop-a', sku, name: 'Wood screw', category: 'Wood Screws',
  price: { amount: 12, currency: 'NZD' }, inStock: true, ...more,
});

test('vector candidates cannot escape tenant, lifecycle or category scope', async () => {
  const own = product('OWN');
  const vectorCandidates = [
    product('VALID'), product('FOREIGN', { tenantId: 'shop-b' }),
    product('OWNERLESS', { tenantId: undefined }),
    product('CONTRADICTORY', { projectId: 'shop-b' }),
    product('OTHER-TYPE', { name: 'Wall paint', category: 'Paint' }),
    product('DISCONTINUED', { discontinued: true }),
  ];
  const handler = new CatalogSearchHandler([own], undefined, async () => vectorCandidates.map(doc => ({ doc, score: .99 })));
  const result = await handler.execute({ query: 'screw', productType: 'Wood Screws', isAgentMode: true }, context);
  assert.deepEqual(result.items.map((item: any) => item.sku).sort(), ['OWN', 'VALID']);
});

test('valid vector candidates retain their meaning and exact price/currency filters', async () => {
  const handler = new CatalogSearchHandler([], undefined, async () => [
    { doc: product('ALLOWED'), score: .9 },
    { doc: product('TOO-EXPENSIVE', { price: { amount: 200, currency: 'NZD' } }), score: 1 },
    { doc: product('WRONG-CURRENCY', { price: { amount: 12, currency: 'USD' } }), score: 1 },
  ]);
  const result = await handler.execute({ query: 'screw', currency: 'NZD', maxPriceCents: 2000, isAgentMode: true }, context);
  assert.deepEqual(result.items.map((item: any) => item.sku), ['ALLOWED']);
});
