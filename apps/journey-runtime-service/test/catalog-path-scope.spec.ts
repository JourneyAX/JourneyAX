import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const suite = createSuite('runtime: hierarchy-scoped catalogue search');
const ctx: any = { tenantId: 'p1', environmentId: 'production', workspaceId: 'w', sessionId: 's', stageId: 'st', packVersionId: 'v', correlationId: 'c', packSettings: {} };

const bathroom = ['Bathrooms & Plumbing', 'Plumbing'];
const tools = ['Tools', 'Power Tools', 'Plumbing'];
const products = [
  { projectId: 'p1', sku: 'PIPE', name: 'Pipe 20mm', category: 'Pipes', categoryPath: [...bathroom, 'Pipes'], price: { amount: 5, currency: 'NZD' } },
  { projectId: 'p1', sku: 'TOOL', name: 'Pipe cutter', category: 'Plumbing', categoryPath: tools, price: { amount: 50, currency: 'NZD' } },
  { projectId: 'p1', sku: 'GARDEN', name: 'Garden pipe', category: 'Plumbing', categoryPath: ['Outdoor', 'Plumbing'], price: { amount: 7, currency: 'NZD' } },
  { projectId: 'p1', sku: 'PAREN', name: 'Odd item', category: 'Misc', categoryPath: ['Dept (A+B)', 'Misc.'], price: { amount: 1, currency: 'NZD' } },
  { projectId: 'p1', sku: 'LOOSE', name: 'Loose fitting', category: 'Loose Fittings', price: { amount: 2, currency: 'NZD' } },
  { projectId: 'other', sku: 'FOREIGN', name: 'Foreign pipe', category: 'Pipes', categoryPath: [...bathroom, 'Pipes'], price: { amount: 5, currency: 'NZD' } },
];

/** The same handler against the in-memory list and a Mongo-shaped store: both must agree. */
async function both(input: any): Promise<string[][]> {
  const db = new MemoryDb();
  await db.collection('products').insertMany(products.map((product) => ({ ...product })));
  const viaList = await new CatalogSearchHandler(products).execute(input, ctx);
  const viaDb = await new CatalogSearchHandler(undefined, async () => db as any).execute(input, ctx);
  return [viaList, viaDb].map((result) => result.items.map((item: any) => item.sku).sort());
}

async function main() {
  await suite.test('a path selects its own subtree only, in both the list and the database query', async () => {
    const [list, db] = await both({ categoryPaths: [bathroom] });
    assert.deepEqual(list, ['PIPE']);
    assert.deepEqual(db, list);
    const [toolsOnly] = await both({ categoryPaths: [tools] });
    assert.deepEqual(toolsOnly, ['TOOL']);
    const [department] = await both({ categoryPaths: [['Bathrooms & Plumbing']] });
    assert.deepEqual(department, ['PIPE'], 'a department path covers everything below it');
  });

  await suite.test('a same-named category elsewhere is not selected, unlike the by-name scope', async () => {
    const [byName, byNameDb] = await both({ categoryIds: ['Plumbing'] });
    assert.deepEqual(byName, ['GARDEN', 'PIPE', 'TOOL'], 'the legacy name scope reaches every department with a Plumbing');
    assert.deepEqual(byNameDb, byName);
    const [byPath] = await both({ categoryPaths: [bathroom] });
    assert.deepEqual(byPath, ['PIPE']);
  });

  await suite.test('names and paths combine as a union; tenant isolation still applies', async () => {
    const [union, unionDb] = await both({ categoryIds: ['Loose Fittings'], categoryPaths: [tools] });
    assert.deepEqual(union, ['LOOSE', 'TOOL']);
    assert.deepEqual(unionDb, union);
    assert.ok(!union.includes('FOREIGN'));
    const [everything] = await both({ categoryPaths: [bathroom], maxResults: 50 });
    assert.ok(!everything.includes('FOREIGN'), 'another tenant\'s product is never returned');
  });

  await suite.test('path segments are matched literally, never as patterns', async () => {
    const [literal, literalDb] = await both({ categoryPaths: [['Dept (A+B)', 'Misc.']] });
    assert.deepEqual(literal, ['PAREN']);
    assert.deepEqual(literalDb, literal);
    const [pattern] = await both({ categoryPaths: [['.*']] });
    assert.deepEqual(pattern, [], 'a wildcard is just a name that matches nothing');
    const [dot] = await both({ categoryPaths: [['Dept (A+B)', 'Misc']] });
    assert.deepEqual(dot, [], 'a missing character is a different category, not a prefix');
  });

  await suite.test('an unusable scope narrows to nothing instead of widening to the whole catalogue', async () => {
    for (const bad of [[[]], [['']], [[' ']], [[1 as any]]]) {
      const result = await new CatalogSearchHandler(products).execute({ categoryPaths: bad } as any, ctx);
      assert.equal(result.total, 0, JSON.stringify(bad));
      assert.equal(result.error, 'invalid_category_scope');
    }
    const unscoped = await new CatalogSearchHandler(products).execute({ maxResults: 50 } as any, ctx);
    assert.ok(unscoped.total > 0, 'a request that asks for no scope at all is unchanged');
  });

  await suite.test('grouped overviews scope each group by its own paths', async () => {
    const result = await new CatalogSearchHandler(products).execute({
      groups: [
        { conceptId: 'c1', label: 'Bathroom plumbing', categoryIds: [], categoryPaths: [bathroom], maxItems: 2 },
        { conceptId: 'c2', label: 'Plumbing tools', categoryIds: [], categoryPaths: [tools], maxItems: 2 },
      ],
    } as any, ctx);
    assert.deepEqual(result.groups.map((group: any) => [group.label, group.items.map((item: any) => item.sku)]), [['Bathroom plumbing', ['PIPE']], ['Plumbing tools', ['TOOL']]]);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
