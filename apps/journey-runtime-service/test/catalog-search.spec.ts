import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogSearchHandler,
  buildGlossaryIndex,
  tokenizeQuery,
} from '../src/capabilities/handlers/catalog-search.handler';
import type { ExecutionContext } from '@journeyax/capability-sdk';

const makeContext = (overrides?: Partial<ExecutionContext>): ExecutionContext => ({
  tenantId: 'test-tenant',
  environmentId: 'test',
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  stageId: 'shop',
  packVersionId: '1.0.0',
  correlationId: 'corr-1',
  packSettings: {},
  ...overrides,
});

test('CatalogSearchHandler - buildGlossaryIndex & tokenizeQuery', async (t) => {
  await t.test('builds bidirectional clusters from OKF concepts and vocabulary', () => {
    const index = buildGlossaryIndex({
      vocabulary: {
        synonyms: {
          dwang: ['noggin', '100x50'],
        },
      },
      okfConcepts: [
        {
          name: 'Plasterboard',
          synonyms: ['drywall'],
          customerPhrases: ['jib', 'gib sheet'],
        },
      ],
    });

    assert.ok(index.has('dwang'));
    assert.deepEqual(index.get('dwang'), ['noggin', '100x50']);
    assert.ok(index.get('noggin')?.includes('dwang'));

    assert.ok(index.has('jib'));
    assert.ok(index.get('jib')?.includes('plasterboard'));
    assert.ok(index.get('jib')?.includes('drywall'));
    assert.ok(index.get('plasterboard')?.includes('jib'));
  });

  await t.test('tokenizeQuery expands tokens with synonyms from glossaryIndex', () => {
    const glossaryIndex = new Map<string, string[]>([
      ['jib', ['gib', 'plasterboard']],
      ['dwang', ['noggin']],
    ]);

    const tokens = tokenizeQuery('need screws for jib and dwang', glossaryIndex);
    assert.equal(tokens.length, 3); // 'need', 'for', 'and' are stopwords or filtered

    const jibToken = tokens.find((tk) => tk.stem === 'jib');
    assert.ok(jibToken);
    assert.ok(jibToken.regex.test('gib'));
    assert.ok(jibToken.regex.test('plasterboard'));
    assert.ok(jibToken.regex.test('jib'));

    const dwangToken = tokens.find((tk) => tk.stem === 'dwang');
    assert.ok(dwangToken);
    assert.ok(dwangToken.regex.test('dwang'));
    assert.ok(dwangToken.regex.test('noggin'));
  });
});

test('CatalogSearchHandler - In-Memory Search with Glossary Expansion', async (t) => {
  const products = [
    {
      tenantId: 'test-tenant',
      sku: 'SKU-GIB-1',
      name: 'Standard GIB Plasterboard Sheet 10mm',
      category: 'Plasterboard',
      price: { amount: 25, currency: 'NZD' },
      inStock: true,
    },
    {
      tenantId: 'test-tenant',
      sku: 'SKU-TIMBER-1',
      name: 'Structural Framing Timber 100x50 Nogging',
      category: 'Framing Timber',
      price: { amount: 15, currency: 'NZD' },
      inStock: true,
    },
    {
      tenantId: 'test-tenant',
      sku: 'SKU-SCREW-1',
      name: 'General Purpose Wood Screws 50mm',
      category: 'Wood Screws',
      price: { amount: 12, currency: 'NZD' },
      inStock: true,
    },
  ];

  const handler = new CatalogSearchHandler(products);

  await t.test('searches with glossary alias and finds matching product', async () => {
    const ctx = makeContext({
      vocabulary: {
        synonyms: {
          jib: ['gib', 'plasterboard'],
          dwang: ['nogging', '100x50'],
        },
      },
    });

    const res1 = await handler.execute({ query: 'jib sheet' }, ctx);
    assert.equal(res1.items.length, 1);
    assert.equal(res1.items[0].sku, 'SKU-GIB-1');

    const res2 = await handler.execute({ query: 'dwang' }, ctx);
    assert.equal(res2.items.length, 1);
    assert.equal(res2.items[0].sku, 'SKU-TIMBER-1');
  });

  await t.test('falls back gracefully to standard keyword search when no glossary matches', async () => {
    const ctx = makeContext();
    const res = await handler.execute({ query: 'wood screws' }, ctx);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].sku, 'SKU-SCREW-1');
  });
});

test('CatalogSearchHandler - Hybrid Retrieval & Reranking', async (t) => {
  const products = [
    {
      tenantId: 'test-tenant',
      sku: 'SKU-KW-1',
      name: 'Basic Timber Screws 40mm',
      category: 'Fasteners',
      price: { amount: 8, currency: 'NZD' },
      inStock: true,
    },
    {
      tenantId: 'test-tenant',
      sku: 'SKU-HYBRID-TOP',
      name: 'Heavy Duty Structural Timber Screws',
      category: 'Fasteners',
      price: { amount: 16, currency: 'NZD' },
      inStock: true,
    },
    {
      tenantId: 'test-tenant',
      sku: 'SKU-VEC-1',
      name: 'Decking Fastener Coated',
      category: 'Fasteners',
      price: { amount: 22, currency: 'NZD' },
      inStock: true,
    },
  ];

  await t.test('combines vector search candidates with keyword search and reranks via RRF', async () => {
    const mockVectorSearcher = async () => [
      { doc: products[1], score: 0.95 }, // SKU-HYBRID-TOP ranked #0 in vector
      { doc: products[2], score: 0.88 }, // SKU-VEC-1 ranked #1 in vector
    ];

    const handler = new CatalogSearchHandler(products, undefined, mockVectorSearcher);
    const ctx = makeContext();

    const res = await handler.execute({ query: 'structural timber screws' }, ctx);
    assert.ok(res.items.length >= 2);
    // SKU-HYBRID-TOP matches both keyword and vector search, so RRF gives it top position
    assert.equal(res.items[0].sku, 'SKU-HYBRID-TOP');
  });

  await t.test('gracefully handles vector search failure and falls back to keyword search', async () => {
    const failingVectorSearcher = async () => {
      throw new Error('Vector index unavailable');
    };

    const handler = new CatalogSearchHandler(products, undefined, failingVectorSearcher);
    const ctx = makeContext();

    const res = await handler.execute({ query: 'timber screws' }, ctx);
    assert.ok(res.items.length >= 1);
    assert.equal(res.error, undefined);
  });
});
