import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductSemanticSearcher } from '../src/infrastructure/product-semantic-search';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const context: any = { tenantId: 'shop-a', environmentId: 'test', workspaceId: 'isolated', sessionId: 'isolated', stageId: 'unused', packVersionId: 'test', correlationId: 'isolated', packSettings: {} };
const product = (sku: string, extra: any = {}) => ({ tenantId: 'shop-a', sku, name: 'Moisture resistant board', category: 'Wall Linings', price: { amount: 12, currency: 'NZD' }, inStock: true, ...extra });

test('semantic discovery calls the existing document service and hydrates authoritative catalogue records', async () => {
  let requested: any; let calls = 0;
  const searcher = createProductSemanticSearcher({ baseUrl: () => 'http://semantic.test', internalKey: () => 'fixture-only', fetchImpl: (async (url: any, init: any) => {
    calls++; requested = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify({ method: 'vector', candidates: [{ sku: 'REAL', score: .9, price: 1 }, { sku: 'NOT-IN-CATALOGUE', score: 1 }, { sku: 'FOREIGN', score: 1 }] }));
  }) as any });
  const handler = new CatalogSearchHandler([product('REAL'), product('FOREIGN', { tenantId: 'shop-b' })], undefined, searcher);
  const result = await handler.execute({ query: 'wet room walls', isAgentMode: true }, context);
  assert.deepEqual(result.items.map((item: any) => item.sku), ['REAL']);
  assert.equal(result.items[0].priceCents, 1200, 'candidate payload cannot set a product price');
  assert.equal(result.retrieval, 'hybrid');
  assert.equal(requested.url, 'http://semantic.test/api/v1/shop-a/products/semantic-candidates');
  assert.equal(requested.body.query, 'wet room walls', 'no apparel vocabulary or guessed product type is injected');
  assert.equal(calls, 1, 'relaxation passes share one semantic lookup');
});

test('exact SKU lookup does not embed or invoke semantic discovery', async () => {
  let calls = 0;
  const handler = new CatalogSearchHandler([product('REAL')], undefined, async () => { calls++; return []; });
  const result = await handler.execute({ sku: 'REAL', query: 'REAL', isAgentMode: true }, context);
  assert.equal(result.items[0].sku, 'REAL'); assert.equal(calls, 0);
});

test('unavailable semantic retrieval remains a labelled keyword result', async () => {
  const handler = new CatalogSearchHandler([product('REAL')], undefined, async () => { throw new Error('fixture unavailable'); });
  const result = await handler.execute({ query: 'board', isAgentMode: true }, context);
  assert.equal(result.items[0].sku, 'REAL'); assert.equal(result.retrieval, 'keyword');
});

test('keyword candidates with contradictory tenant ownership are rejected too', async () => {
  const handler = new CatalogSearchHandler([product('VALID'), product('CONTRADICTORY', { projectId: 'shop-b' })]);
  const result = await handler.execute({ query: 'board', isAgentMode: true }, context);
  assert.deepEqual(result.items.map((item: any) => item.sku), ['VALID']);
});
