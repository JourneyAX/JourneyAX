import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { MemoryProductCollection, UnsupportedFilter, compileFilter, valuesAt } from '../src/capabilities/catalogue-filter';

const suite = createSuite('runtime: catalogue filters over products held in memory');

const docs = [
  { _id: 1, projectId: 'p1', sku: 'A', name: 'Pipe 20mm', category: 'Pipes', categoryPath: ['Plumbing', 'Pipes'], attributes: [{ name: 'colour', value: 'Grey' }, { name: 'size', value: '20mm' }], discontinued: false },
  { _id: 2, projectId: 'p1', sku: 'B', name: 'Basin Tap', category: 'Taps', categoryPath: ['Plumbing', 'Taps'], attributes: [{ name: 'colour', value: 'Chrome' }], discontinued: true },
  { _id: 3, projectId: 'p2', sku: 'C', name: 'Pipe Cutter', category: 'Tools', categoryPath: ['Tools', 'Hand Tools'], stock: { inStock: true, branches: [{ code: '1' }, { code: '2' }] } },
  { _id: 4, projectId: 'p1', sku: 'D', name: 'Cladding', category: 'Boards' },
];
const ids = (list: any[]) => list.map((doc) => doc._id);
const find = async (filter: any, limit?: number) => {
  const cursor = new MemoryProductCollection(docs).find(filter);
  return ids(await (limit === undefined ? cursor.toArray() : cursor.limit(limit).toArray()));
};

async function main() {
  await suite.test('a path reaches nested fields, list positions and the fields of every list element', () => {
    assert.deepEqual(valuesAt(docs[0], ['categoryPath', '1']), ['Pipes']);
    assert.deepEqual(valuesAt(docs[0], ['attributes', 'value']), ['Grey', '20mm']);
    assert.deepEqual(valuesAt(docs[2], ['stock', 'branches', '1', 'code']), ['2']);
    assert.deepEqual(valuesAt(docs[3], ['stock', 'inStock']), []);
  });

  await suite.test('equality, patterns and $in match a list field when any element matches', async () => {
    assert.deepEqual(await find({ projectId: 'p1' }), [1, 2, 4]);
    assert.deepEqual(await find({ discontinued: true }), [2]);
    assert.deepEqual(await find({ name: /^pipe/i }), [1, 3]);
    assert.deepEqual(await find({ 'attributes.value': /chrome/i }), [2]);
    assert.deepEqual(await find({ categoryPath: 'Pipes' }), [1], 'a list field equals when it contains the value');
    assert.deepEqual(await find({ 'categoryPath.0': { $in: [/^plumbing$/i, 'Nowhere'] } }), [1, 2]);
    assert.deepEqual(await find({ sku: { $in: ['C', 'D'] } }), [3, 4]);
  });

  await suite.test('$and, $or and $nor combine clauses; a missing field matches nothing', async () => {
    assert.deepEqual(await find({ $or: [{ projectId: 'p2' }, { name: /tap/i }] }), [2, 3]);
    assert.deepEqual(await find({ projectId: 'p1', $nor: [{ discontinued: true }] }), [1, 4]);
    assert.deepEqual(await find({ $and: [{ projectId: 'p1' }, { $or: [{ category: 'Pipes' }, { category: 'Boards' }] }] }), [1, 4]);
    assert.deepEqual(await find({ colour: 'Grey' }), []);
  });

  await suite.test('the limit keeps the first matches in load order, and count and distinct follow the same filter', async () => {
    assert.deepEqual(await find({ projectId: 'p1' }, 2), [1, 2]);
    const collection = new MemoryProductCollection(docs);
    assert.equal(await collection.countDocuments({ projectId: 'p1' }), 3);
    assert.equal(await collection.countDocuments({}), 4);
    assert.deepEqual((await collection.distinct('category', { projectId: 'p1' })).sort(), ['Boards', 'Pipes', 'Taps']);
    assert.deepEqual((await collection.distinct('categoryPath')).sort(), ['Hand Tools', 'Pipes', 'Plumbing', 'Taps', 'Tools']);
  });

  await suite.test('a filter it cannot evaluate is refused, never guessed', () => {
    for (const filter of [{ price: { $gt: 5 } }, { $text: { $search: 'x' } }, { $or: [] }, { sku: { $regex: 'A' } }, { sku: null }, { sku: { a: 1 } }, { sku: { $in: [{ a: 1 }] } }]) {
      assert.throws(() => compileFilter(filter as any), UnsupportedFilter, JSON.stringify(filter));
    }
  });

  await suite.test('a global pattern behaves the same however often it is used', async () => {
    const collection = new MemoryProductCollection(docs);
    const pattern = /pipe/gi;
    assert.deepEqual(ids(await collection.find({ name: pattern }).toArray()), [1, 3]);
    assert.deepEqual(ids(await collection.find({ name: pattern }).toArray()), [1, 3]);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
