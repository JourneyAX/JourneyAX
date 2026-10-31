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

    const stopWords = ['need', 'for', 'and'];
    const tokens = tokenizeQuery('need screws for jib and dwang', glossaryIndex, stopWords);
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

test('CatalogSearchHandler - Dimension normalization from pack vocabulary / OKF (SKU 1002835)', async (t) => {
  // SKU 1002835 from docs/evals/placemakers-100.json (prompt 1)
  const product1002835 = {
    tenantId: 'placemakers',
    sku: '1002835',
    name: 'Radiata Structural Grade 8 Planer Gauged Kiln Dried H3.2 CCA Treated 100 x 50mm (90 x 45mm)',
    category: 'SG H3.2 Radiata KD',
    description: 'SG8 structural grade framing timber suitable for internal and exposed above ground applications. Treated H3.2 CCA. Machine gauged to ensure dimensional accuracy and straightness. Ideal for frames and trusses.',
    price: { amount: 15, currency: 'NZD' },
    inStock: true,
  };

  const handler = new CatalogSearchHandler([product1002835]);

  await t.test('matches SKU 1002835 across dimension forms configured via pack vocabulary', async () => {
    // Normalization rules loaded from pack vocabulary (never hardcoded in search code)
    const ctx = makeContext({
      tenantId: 'placemakers',
      vocabulary: {
        slotSynonyms: {
          '100x50': ['100 x 50', '100x50mm', '100 x 50mm', '4x2', '4 x 2', '4 by 2', '90x45', '90 x 45', '90x45mm', '90 x 45mm'],
          '4x2': ['100x50', '100 x 50', '100x50mm', '100 x 50mm', '4 x 2', '4 by 2', '90x45', '90 x 45', '90x45mm', '90 x 45mm'],
        },
      },
    });

    const queries = ['100x50', '100 x 50', '100x50mm', '4x2', 'Do you have 100x50 H3.2 treated timber in stock?'];
    for (const q of queries) {
      const res = await handler.execute({ query: q }, ctx);
      assert.ok(res.items.length >= 1, `Expected at least 1 match for query "${q}"`);
      assert.equal(res.items[0].sku, '1002835', `Query "${q}" should return SKU 1002835`);
    }
  });

  await t.test('matches SKU 1002835 across dimension forms configured via OKF concept glossary', async () => {
    // Normalization rules loaded from OKF concept release / authoring customer phrases
    const ctx = makeContext({
      tenantId: 'placemakers',
      okfConcepts: [
        {
          name: 'Timber & Plywood > Structural Grade Timber Kiln Dried',
          customerPhrases: ['framing timber', '4x2', '2x4', '4 by 2', '4 x 2', '90x45', '90 x 45', '90x45mm', '90 x 45mm', '100x50', '100 x 50', '100x50mm', '100 x 50mm'],
        },
      ],
    } as any);

    const queries = ['100x50', '100 x 50', '100x50mm', '4x2'];
    for (const q of queries) {
      const res = await handler.execute({ query: q }, ctx);
      assert.ok(res.items.length >= 1, `Expected at least 1 match for query "${q}"`);
      assert.equal(res.items[0].sku, '1002835', `Query "${q}" should return SKU 1002835 via OKF glossary`);
    }
  });
});

