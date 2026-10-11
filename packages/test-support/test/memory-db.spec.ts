import assert from 'node:assert/strict';
import { DuplicateKeyError, MemoryDb, createSuite } from '../src';

const suite = createSuite('test-support: memory db');

async function main() {
  await suite.test('equality, dotted paths, $in, $or, $ne and $exists queries', async () => {
    const db = new MemoryDb();
    const c = db.collection('items');
    await c.insertMany([
      { a: 1, nested: { b: 'x' }, tags: ['p', 'q'] },
      { a: 2, nested: { b: 'y' }, tags: ['q'] },
      { a: 3 },
    ]);
    assert.equal((await c.find({ 'nested.b': 'x' }).toArray()).length, 1);
    assert.equal((await c.find({ a: { $in: [1, 3] } }).toArray()).length, 2);
    assert.equal((await c.find({ $or: [{ a: 1 }, { a: 2 }] }).toArray()).length, 2);
    assert.equal((await c.find({ a: { $ne: 1 } }).toArray()).length, 2);
    assert.equal((await c.find({ nested: { $exists: false } }).toArray()).length, 1);
    assert.equal((await c.find({ tags: 'q' }).toArray()).length, 2, 'array membership');
  });

  await suite.test('sort, limit, skip and projection', async () => {
    const c = new MemoryDb().collection('rows');
    await c.insertMany([{ n: 3, k: 'c' }, { n: 1, k: 'a' }, { n: 2, k: 'b' }]);
    const rows = await c.find({}).sort({ n: -1 }).limit(2).project({ k: 1 }).toArray();
    assert.deepEqual(rows.map((r) => r.k), ['c', 'b']);
    assert.equal('n' in rows[0], false);
    const excluded = await c.find({}, { projection: { k: 0, _id: 0 } }).sort({ n: 1 }).toArray();
    assert.deepEqual(excluded[0], { n: 1 });
  });

  await suite.test('update operators: $set, $unset, $inc, $push with $each/$slice, $addToSet', async () => {
    const c = new MemoryDb().collection('u');
    await c.insertOne({ k: 1, count: 1, list: [1], set: ['a'] });
    await c.updateOne({ k: 1 }, {
      $set: { 'deep.value': 5 }, $inc: { count: 2 }, $push: { list: { $each: [2, 3], $slice: -2 } }, $addToSet: { set: 'a' },
    });
    const doc = (await c.findOne({ k: 1 }))!;
    assert.equal(doc.deep.value, 5);
    assert.equal(doc.count, 3);
    assert.deepEqual(doc.list, [2, 3]);
    assert.deepEqual(doc.set, ['a']);
    await c.updateOne({ k: 1 }, { $unset: { count: '' } });
    assert.equal((await c.findOne({ k: 1 }))!.count, undefined);
  });

  await suite.test('upsert inserts equality filter fields and honours $setOnInsert', async () => {
    const c = new MemoryDb().collection('up');
    const res = await c.updateOne({ tenantId: 't', n: 1 }, { $set: { v: 1 }, $setOnInsert: { createdAt: 'now' } }, { upsert: true });
    assert.equal(res.upsertedCount, 1);
    const doc = (await c.findOne({ tenantId: 't' }))!;
    assert.deepEqual([doc.v, doc.createdAt, doc.n], [1, 'now', 1]);
    await c.updateOne({ tenantId: 't' }, { $set: { v: 2 }, $setOnInsert: { createdAt: 'later' } }, { upsert: true });
    assert.deepEqual([(await c.findOne({ tenantId: 't' }))!.v, (await c.findOne({ tenantId: 't' }))!.createdAt], [2, 'now']);
  });

  await suite.test('unique indexes reject duplicates with code 11000, on insert and on update', async () => {
    const c = new MemoryDb().collection('uniq');
    await c.createIndex({ tenantId: 1, version: 1 }, { unique: true });
    await c.insertOne({ tenantId: 't', version: '1' });
    await assert.rejects(c.insertOne({ tenantId: 't', version: '1' }), (e: any) => e instanceof DuplicateKeyError && e.code === 11000);
    await c.insertOne({ tenantId: 't', version: '2' });
    await assert.rejects(c.updateOne({ version: '2' }, { $set: { version: '1' } }), (e: any) => e.code === 11000);
  });

  await suite.test('sessions and transactions are no-ops so transactional code runs', async () => {
    const db = new MemoryDb();
    const session = db.client.startSession();
    let ran = false;
    await session.withTransaction(async () => { ran = true; });
    await session.endSession();
    assert.equal(ran, true);
  });

  await suite.test('stored documents are isolated copies', async () => {
    const c = new MemoryDb().collection('iso');
    const original = { k: 1, list: [1] };
    await c.insertOne(original);
    original.list.push(2);
    assert.deepEqual((await c.findOne({ k: 1 }))!.list, [1]);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
