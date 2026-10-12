import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import {
  classifyAvailability,
  resolveCatalogMapping,
  CatalogMappingSchema,
} from '@journeyax/business-pack';

const suite = createSuite('runtime: catalog mapping and currency');

const ctx = (catalogMapping?: unknown): any => ({
  tenantId: 't1', environmentId: 'production', workspaceId: 'w', sessionId: 's',
  stageId: 'st', packVersionId: 'p', correlationId: 'c', packSettings: { catalogMapping },
});

const products = [
  { sku: 'A1', projectId: 't1', name: 'Boot A', category: 'boots', price: { amount: 100, currency: 'nzd' }, inStock: true },
  { sku: 'A2', projectId: 't1', name: 'Boot B', category: 'boots', priceCents: 12900 },
  { sku: 'A3', projectId: 't1', name: 'Boot C', category: 'boots', priceUSD: { min: 80 }, toeProtection: 'composite' },
  { sku: 'A4', projectId: 't1', name: 'Boot D', category: 'boots', status: 'Discontinued', price: { amount: 10, currency: 'NZD' } },
  { sku: 'A5', projectId: 'other', name: 'Boot E', category: 'boots', price: { amount: 10, currency: 'NZD' } },
  { sku: 'A6', projectId: 't1', name: 'Boot F', category: 'boots', price: { amount: 55, currency: 'NZD' }, toeProtection: 'steel' },
];

async function search(input: any, mapping?: unknown) {
  return new CatalogSearchHandler(products).execute(input, ctx(mapping));
}

async function main() {
  await suite.test('declared currency is kept; the request currency is only a filter', async () => {
    const result = await search({ query: 'boot', currency: 'NZD' });
    const bySku = new Map(result.items.map((i: any) => [i.sku, i]));
    assert.equal((bySku.get('A1') as any).currency, 'NZD');
    assert.equal((bySku.get('A1') as any).priceCents, 10000);
  });

  await suite.test('a price with no declared currency is never labelled with the requested currency', async () => {
    const result = await search({ query: 'boot', currency: 'NZD' });
    const constrained = result.items.find((i: any) => i.sku === 'A2');
    assert.ok(constrained === undefined || (constrained.priceCents === null && constrained.currency === undefined), 'never quoted in the requested currency');
    const priced = await search({ query: 'boot', currency: 'NZD', requireAuthoritativePrice: true });
    assert.equal(priced.items.find((i: any) => i.sku === 'A2'), undefined, 'excluded when an authoritative price is required');
    const unconstrained = await search({ query: 'boot' });
    const a2 = unconstrained.items.find((i: any) => i.sku === 'A2');
    assert.equal(a2.priceCents, null, 'unpriced, not quotable');
    assert.equal(a2.currencyUndeclared, true);
    assert.equal(a2.currency, undefined);
  });

  await suite.test('regression: a USD-only product requested in NZD is never returned as an NZD price', async () => {
    const only = new CatalogSearchHandler([{ projectId: 't1', sku: 'U1', name: 'Boot', priceUSD: { min: 100 } }]);
    const result = await only.execute({ query: 'boot', currency: 'NZD' } as any, ctx());
    for (const item of result.items) {
      assert.equal(item.currency, undefined);
      assert.equal(item.price, undefined);
      assert.equal(item.priceCents, null);
    }
  });

  await suite.test('PlaceMakers-shaped data: priceUSD.min priced in the currency declared on the product', async () => {
    const data = [{ projectId: 't1', sku: 'P1', name: 'Screw', priceUSD: { min: 15.33, max: 15.33 }, currency: 'NZD', availability: true, variants: [{ msrpUSD: 15.33 }] },
      { projectId: 't1', sku: 'P2', name: 'Screw long', variants: [{ msrpUSD: 9.5 }], currency: 'NZD', availability: false }];
    const mapping = { pricing: { sources: [
      { path: 'priceUSD', rangeKey: 'min', unit: 'major', currencyPath: 'currency' },
      { path: 'variants.0.msrpUSD', unit: 'major', currencyPath: 'currency' },
    ] } };
    const result = await new CatalogSearchHandler(data).execute({ query: 'screw' } as any, ctx(mapping));
    const bySku = new Map(result.items.map((i: any) => [i.sku, i]));
    assert.equal((bySku.get('P1') as any).priceCents, 1533);
    assert.equal((bySku.get('P1') as any).currency, 'NZD');
    assert.equal((bySku.get('P2') as any).priceCents, 950, 'falls through to the variant price');
    assert.equal((bySku.get('P1') as any).inStock, true, 'boolean availability still counts as stock');
    assert.equal((bySku.get('P2') as any).inStock, false);
    const without = await new CatalogSearchHandler(data).execute({ query: 'screw' } as any, ctx());
    assert.ok(without.items.every((i: any) => i.priceCents === null), 'without the tenant mapping these prices are not guessed');
  });

  await suite.test('tenant mapping can declare a price source and its currency explicitly', async () => {
    const mapping = {
      pricing: { sources: [{ path: 'priceUSD', rangeKey: 'min', unit: 'major', currency: 'USD' }] },
    };
    const result = await search({ query: 'boot', currency: 'USD' }, mapping);
    const quoted = result.items.filter((i: any) => i.priceCents != null);
    assert.deepEqual(quoted.map((i: any) => i.sku), ['A3']);
    assert.equal(quoted[0].currency, 'USD');
    assert.equal(quoted[0].priceCents, 8000);
    assert.ok(result.items.filter((i: any) => i.priceCents == null).every((i: any) => i.currency === undefined));
  });

  await suite.test('tenant isolation and lifecycle exclusion come from the mapping', async () => {
    const result = await search({ query: 'boot' });
    const skus = result.items.map((i: any) => i.sku);
    assert.ok(!skus.includes('A5'), 'other tenant excluded');
    assert.ok(!skus.includes('A4'), 'discontinued excluded');
    const custom = await search({ query: 'boot' }, { availability: { excludedStatuses: [] } });
    assert.ok(custom.items.map((i: any) => i.sku).includes('A4'), 'tenant mapping controls the excluded vocabulary');
  });

  await suite.test('attribute aliases are tenant data; no alias means no implicit mapping', async () => {
    const noAlias = await search({ query: 'boot', toeType: 'composite' });
    assert.equal(noAlias.items.length, 6 - 2, 'unknown top-level input is not a filter without a declared alias');
    const aliased = await search({ query: 'boot', toeType: 'composite' }, { attributeAliases: { toeType: ['toeProtection'] } });
    assert.deepEqual(aliased.items.map((i: any) => i.sku), ['A3'], 'composite must not match steel by substring');
  });

  await suite.test('price bounds exclude unpriced products', async () => {
    const result = await search({ query: 'boot', minPriceCents: 1, currency: 'NZD' });
    assert.ok(result.items.every((i: any) => i.priceCents > 0));
  });

  await suite.test('mapping validation rejects operator injection and unknown keys', () => {
    assert.throws(() => resolveCatalogMapping({ searchPaths: ['$where'] }));
    assert.throws(() => resolveCatalogMapping({ unknownKey: true }));
    assert.equal(CatalogMappingSchema.safeParse({ imagePaths: ['a.b'] }).success, true);
  });

  await suite.test('an invalid pack mapping fails closed', async () => {
    const result = await search({ query: 'boot' }, { searchPaths: ['$where'] });
    assert.equal(result.items.length, 0);
    assert.match(result.error, /invalid/);
  });

  await suite.test('classifyAvailability exposes the vocabulary to other callers', () => {
    const mapping = resolveCatalogMapping({ availability: { unpricedStatuses: ['poa'] } });
    assert.equal(classifyAvailability({ status: 'POA' }, mapping), 'unpriced');
    assert.equal(classifyAvailability({ lifecycle: { status: 'discontinued' } }, mapping), 'excluded');
    assert.equal(classifyAvailability({ status: 'active' }, mapping), 'available');
  });
}

main().then(() => { suite.finish(); }).catch((e) => { console.error(e); process.exitCode = 1; });
