import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { resolveCatalogMapping } from '@journeyax/business-pack';
import {
  CatalogueIndexRegistry,
  buildSlimPipeline,
  buildSlimProjection,
  mappedFieldPaths,
  toSlimProduct,
  type CatalogueLoader,
} from '../src/capabilities/catalogue-index';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const suite = createSuite('runtime: in-memory catalogue index');
const mapping = resolveCatalogMapping();
const getDb = async () => { throw new Error('the database must not be asked in these tests'); };

/** A loader that serves the given products (as many times as it is asked) and counts how often it is asked. */
function loaderOf(products: () => any[]): { loader: CatalogueLoader; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    loader: async function* () { calls += 1; for (const product of products()) yield product; },
  };
}
const items = (count: number, prefix = 'P') => Array.from({ length: count }, (_, i) => ({ projectId: 'p1', sku: `${prefix}${i}`, name: `Item ${i}` }));

const searchCtx: any = { tenantId: 'p1', environmentId: 'production', workspaceId: 'w', sessionId: 's', stageId: 'st', packVersionId: 'v', correlationId: 'c', packSettings: {} };
const stocked = (sku: string, name: string, category: string, path: string[], extra: Record<string, any> = {}) =>
  ({ projectId: 'p1', sku, parentSku: sku, name, title: name, category, categoryPath: path, price: { amount: 10, currency: 'NZD' }, inStock: true, description: `${name} for the job`, ...extra });
const catalogue = [
  stocked('PIPE20', 'Pipe 20mm', 'Pipes', ['Plumbing', 'Pipes']),
  stocked('PIPE25', 'Pipe 25mm', 'Pipes', ['Plumbing', 'Pipes'], { pickupOnly: true }),
  stocked('TAP1', 'Basin Tap Chrome', 'Taps', ['Plumbing', 'Taps'], { brand: 'Acme' }),
  stocked('CUT1', 'Pipe Cutter', 'Hand Tools', ['Tools', 'Hand Tools']),
  stocked('OLD1', 'Pipe 15mm', 'Pipes', ['Plumbing', 'Pipes'], { discontinued: true }),
  { ...stocked('FOREIGN', 'Foreign Pipe', 'Pipes', ['Plumbing', 'Pipes']), projectId: 'other' },
];

/** A database that serves the catalogue and counts how it is asked: a search that uses the index never calls find or count. */
async function databaseOf(rows: any[]) {
  const memory = new MemoryDb();
  await memory.collection('products').insertMany(rows.map((row) => ({ ...row })));
  const products = memory.collection('products');
  const calls = { find: 0, count: 0, aggregate: 0 };
  const db: any = {
    collection: (name: string) => name !== 'products' ? memory.collection(name) : ({
      find: (...args: any[]) => { calls.find += 1; return (products as any).find(...args); },
      countDocuments: (...args: any[]) => { calls.count += 1; return (products as any).countDocuments(...args); },
      aggregate: (pipeline: any[]) => {
        calls.aggregate += 1;
        const matched = (products as any).find(pipeline[0].$match).toArray();
        return { async *[Symbol.asyncIterator]() { for (const row of await matched) yield row; }, close: async () => undefined };
      },
    }),
  };
  return { db, calls };
}

async function withIndexOn<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.CATALOGUE_INDEX;
  process.env.CATALOGUE_INDEX = 'on';
  CatalogueIndexRegistry.shared().clear();
  try { return await run(); } finally {
    CatalogueIndexRegistry.shared().clear();
    if (before === undefined) delete process.env.CATALOGUE_INDEX; else process.env.CATALOGUE_INDEX = before;
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function main() {
  await suite.test('the field list comes from the mapping, and a projection never lists a path and one of its parents', async () => {
    const paths = mappedFieldPaths(mapping);
    for (const expected of ['projectId', 'sku', 'name', 'description', 'categoryPath', 'attributes', 'stock.inStock', 'stock.availableBranchCount', 'discontinued', 'images.0']) {
      assert.ok(paths.includes(expected), `${expected} is read by the catalogue code`);
    }
    const projection = buildSlimProjection(paths);
    const keys = Object.keys(projection);
    for (const key of keys) assert.ok(!keys.some((other) => other !== key && key.startsWith(`${other}.`)), `${key} is covered by another listed path`);
    assert.ok(!keys.includes('attributes.value'), 'a path under a listed container is covered by it');
    assert.ok(!keys.some((key) => /\.\d+(\.|$)/.test(key)), 'no path runs through a list position');
    assert.deepEqual(Object.keys((projection.images as any).$cond[1]), ['$slice'], 'a photo path keeps only the first photo');
    assert.equal((projection.images as any).$cond[1].$slice[1], 1);
    assert.equal(projection.categoryPath, 1);
  });

  await suite.test('a list position larger than one keeps that many entries, and a whole path wins over a list position', () => {
    assert.equal((buildSlimProjection(['gallery.2.url', 'gallery.0']).gallery as any).$cond[1].$slice[1], 3);
    assert.equal(buildSlimProjection(['gallery.0', 'gallery']).gallery, 1);
    assert.deepEqual(buildSlimProjection(['0.x', '']), {});
  });

  await suite.test('the pipeline keeps the tenant and lifecycle rules of a database search, and keeps the product\'s own top-level fields', () => {
    const pipeline: any[] = buildSlimPipeline(mapping, 'p1');
    const match = pipeline[0].$match;
    assert.deepEqual(match.$or, mapping.tenantFields.map((field) => ({ [field]: 'p1' })), 'only this tenant\'s products');
    assert.ok(JSON.stringify(match.$and).includes('discontinued'), 'discontinued products are left out');
    assert.ok(JSON.stringify(pipeline[1]).includes('$objectToArray'), 'top-level fields are collected');
    assert.equal(pipeline[2].$project.__scalars, 1);
    assert.deepEqual(toSlimProduct({ _id: 1, __scalars: { sku: 'A', pickupOnly: true }, stock: { inStock: true } }), { _id: 1, stock: { inStock: true }, sku: 'A', pickupOnly: true });
    assert.deepEqual(toSlimProduct({ _id: 2, stock: {} }), { _id: 2, stock: {} });
  });

  await suite.test('it is off unless switched on, and then nothing is loaded and the database is used', async () => {
    const { loader, calls } = loaderOf(() => items(3));
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => false });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb }), undefined);
    await registry.warm({ tenantId: 'p1', mapping, getDb });
    assert.equal(calls(), 0);
    assert.deepEqual(registry.status(), []);
  });

  await suite.test('the first search starts a load and uses the database; once loaded the copy is served', async () => {
    const { loader, calls } = loaderOf(() => items(3));
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => true });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb }), undefined, 'not ready yet');
    assert.equal(registry.status()[0].state, 'loading');
    await settle();
    const docs = registry.productsFor({ tenantId: 'p1', mapping, getDb });
    assert.equal(docs?.length, 3);
    assert.equal(calls(), 1, 'one load, however many searches came meanwhile');
    assert.equal(registry.status()[0].state, 'ready');
    assert.equal(registry.status()[0].products, 3);
  });

  await suite.test('each tenant has its own copy', async () => {
    const { loader } = loaderOf(() => items(2));
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => true });
    await registry.warm({ tenantId: 'p1', mapping, getDb });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.length, 2);
    assert.equal(registry.productsFor({ tenantId: 'p2', mapping, getDb }), undefined, 'another tenant has no copy until its own load is done');
  });

  await suite.test('an old copy is served while a new one loads, then replaced', async () => {
    let clock = 1_000;
    let generation = 0;
    const { loader, calls } = loaderOf(() => items(generation === 0 ? 3 : 4, `G${generation}-`));
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => true, refreshMs: 100, now: () => clock });
    await registry.warm({ tenantId: 'p1', mapping, getDb });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.length, 3);
    clock += 500;
    generation = 1;
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.length, 3, 'the old copy answers while the reload runs');
    await settle();
    assert.equal(calls(), 2);
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.[0].sku, 'G1-0', 'then the new copy');
  });

  await suite.test('a failed reload keeps the copy in use, and a reload far smaller than it is refused', async () => {
    let clock = 1_000;
    let mode: 'ok' | 'fail' | 'small' | 'empty' = 'ok';
    const loader: CatalogueLoader = async function* () {
      if (mode === 'fail') throw new Error('database unavailable');
      const count = mode === 'small' ? 2 : mode === 'empty' ? 0 : 10;
      for (const product of items(count, `${mode}-`)) yield product;
    };
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => true, refreshMs: 100, retryMs: 50, now: () => clock });
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      await registry.warm({ tenantId: 'p1', mapping, getDb });
      const expected = { fail: /database unavailable/, small: /2 products against 10/, empty: /no products/ };
      for (const next of ['fail', 'small', 'empty'] as const) {
        mode = next;
        clock += 1_000;
        registry.productsFor({ tenantId: 'p1', mapping, getDb });
        await settle();
        const [status] = registry.status();
        assert.equal(status.products, 10, `${next}: the copy in use is kept`);
        assert.match(status.error || '', expected[next]);
      }
      assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.[0].sku, 'ok-0');
    } finally {
      console.warn = originalWarn;
    }
  });

  await suite.test('a tenant whose first load fails is retried only after the wait, and a tenant too large stays on the database', async () => {
    let clock = 1_000;
    let calls = 0;
    const failing: CatalogueLoader = async function* () { calls += 1; throw new Error('boom'); yield undefined; };
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const registry = new CatalogueIndexRegistry({ loader: failing, enabled: () => true, retryMs: 5_000, now: () => clock });
      registry.productsFor({ tenantId: 'p1', mapping, getDb });
      await settle();
      assert.equal(registry.status()[0].state, 'failed');
      registry.productsFor({ tenantId: 'p1', mapping, getDb });
      await settle();
      assert.equal(calls, 1, 'not retried inside the wait');
      clock += 6_000;
      registry.productsFor({ tenantId: 'p1', mapping, getDb });
      await settle();
      assert.equal(calls, 2, 'retried after it');

      const big = loaderOf(() => items(5));
      const small = new CatalogueIndexRegistry({ loader: big.loader, enabled: () => true, maxDocs: 3 });
      await small.warm({ tenantId: 'p1', mapping, getDb });
      assert.equal(small.productsFor({ tenantId: 'p1', mapping, getDb }), undefined);
      assert.equal(small.status()[0].state, 'too_large');
      small.productsFor({ tenantId: 'p1', mapping, getDb });
      await settle();
      assert.equal(big.calls(), 1, 'a too-large tenant is not loaded again');
    } finally {
      console.warn = originalWarn;
    }
  });

  await suite.test('a changed catalogue mapping is a different copy and is loaded again', async () => {
    const { loader, calls } = loaderOf(() => items(2));
    const registry = new CatalogueIndexRegistry({ loader, enabled: () => true });
    await registry.warm({ tenantId: 'p1', mapping, getDb });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping, getDb })?.length, 2);
    const changed = resolveCatalogMapping({ titlePaths: ['label'] });
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping: changed, getDb }), undefined, 'the old copy was built for another mapping');
    await settle();
    assert.equal(calls(), 2);
    assert.equal(registry.productsFor({ tenantId: 'p1', mapping: changed, getDb })?.length, 2);
  });

  await suite.test('with the index on, searches and counts are answered from the copy and say so; the database is not searched', async () => {
    const { db, calls } = await databaseOf(catalogue);
    await withIndexOn(async () => {
      await CatalogueIndexRegistry.shared().warm({ tenantId: 'p1', mapping, getDb: async () => db });
      const handler = new CatalogSearchHandler(undefined, async () => db);
      const result = await handler.execute({ isAgentMode: true, keywords: ['pipe'], maxResults: 10 } as any, searchCtx);
      assert.equal(result.source, 'index');
      assert.deepEqual(result.items.map((item: any) => item.sku).sort(), ['CUT1', 'PIPE20', 'PIPE25']);
      const counts = await handler.countInCategoryPaths([['Plumbing'], ['Plumbing', 'Pipes'], ['Tools']], searchCtx);
      assert.deepEqual(counts, [3, 2, 1]);
      assert.equal(calls.find, 0, 'no product search reached the database');
      assert.equal(calls.count, 0, 'no count reached the database');
      assert.equal(calls.aggregate, 1, 'the copy was loaded once');
    });
  });

  await suite.test('the copy holds only this tenant\'s live products, and a product keeps its own flags as attributes', async () => {
    const { db } = await databaseOf(catalogue);
    await withIndexOn(async () => {
      await CatalogueIndexRegistry.shared().warm({ tenantId: 'p1', mapping, getDb: async () => db });
      const copy = CatalogueIndexRegistry.shared().productsFor({ tenantId: 'p1', mapping, getDb: async () => db })!;
      assert.deepEqual(copy.map((doc) => doc.sku).sort(), ['CUT1', 'PIPE20', 'PIPE25', 'TAP1']);
      const found: any = await new CatalogSearchHandler(undefined, async () => db).execute({ isAgentMode: false, query: 'PIPE25', maxResults: 1 } as any, searchCtx);
      assert.equal(found.items[0].sku, 'PIPE25');
      assert.equal(found.items[0].attributes.pickupOnly, true, 'a flag the catalogue normaliser exposes survives the slim copy');
    });
  });

  await suite.test('the copy gives the same answers as the database for the same requests', async () => {
    const { db } = await databaseOf(catalogue);
    const requests: any[] = [
      { isAgentMode: true, keywords: ['pipe'] },
      { isAgentMode: true, productType: 'Pipes' },
      { isAgentMode: true, productType: 'Plumbing', keywords: ['tap'] },
      { isAgentMode: true, keywords: ['tap'], brand: 'Acme' },
      { isAgentMode: true, categoryPaths: [['Plumbing', 'Pipes']] },
      { isAgentMode: true, categoryPaths: [['Tools']], keywords: ['pipe'] },
      { isAgentMode: true, keywords: ['nothing like this exists'] },
      { isAgentMode: false, query: 'pipe' },
      { isAgentMode: false, query: 'TAP1', maxResults: 1 },
    ];
    const skus = (result: any) => result.items.map((item: any) => item.sku).sort();
    const fromDatabase = await Promise.all(requests.map((request) => new CatalogSearchHandler(undefined, async () => db).execute({ maxResults: 10, ...request }, searchCtx)));
    await withIndexOn(async () => {
      await CatalogueIndexRegistry.shared().warm({ tenantId: 'p1', mapping, getDb: async () => db });
      for (const [index, request] of requests.entries()) {
        const viaIndex: any = await new CatalogSearchHandler(undefined, async () => db).execute({ maxResults: 10, ...request }, searchCtx);
        assert.equal(viaIndex.source, 'index');
        assert.deepEqual(skus(viaIndex), skus(fromDatabase[index]), `request ${index + 1} ${JSON.stringify(request)}`);
      }
    });
  });

  await suite.test('switched off, the same handler searches the database and does not claim the index', async () => {
    const { db, calls } = await databaseOf(catalogue);
    await withIndexOn(async () => {
      await CatalogueIndexRegistry.shared().warm({ tenantId: 'p1', mapping, getDb: async () => db });
      process.env.CATALOGUE_INDEX = 'off';
      const result: any = await new CatalogSearchHandler(undefined, async () => db).execute({ isAgentMode: true, keywords: ['pipe'], maxResults: 10 } as any, searchCtx);
      assert.equal(result.source, undefined);
      assert.ok(calls.find > 0, 'the database was searched');
      assert.deepEqual(result.items.map((item: any) => item.sku).sort(), ['CUT1', 'PIPE20', 'PIPE25']);
    });
  });

  await suite.test('while the copy is still loading, a search is answered by the database', async () => {
    const { db, calls } = await databaseOf(catalogue);
    await withIndexOn(async () => {
      const result: any = await new CatalogSearchHandler(undefined, async () => db).execute({ isAgentMode: true, keywords: ['pipe'], maxResults: 10 } as any, searchCtx);
      assert.equal(result.source, undefined);
      assert.deepEqual(result.items.map((item: any) => item.sku).sort(), ['CUT1', 'PIPE20', 'PIPE25']);
      assert.ok(calls.find > 0);
      await settle();
      assert.equal(CatalogueIndexRegistry.shared().status()[0]?.state, 'ready', 'the load that the search started finished');
    });
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
