import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoConnectionPool } from '../src';
test('connection pools separate clusters and coalesce concurrent opens without choosing the first source implicitly', async () => {
  const clients: any[] = [];
  const pool = new MongoConnectionPool((uri: string) => { const client = { uri, opens: 0, async connect() { this.opens++; await Promise.resolve(); return this; }, db: (name: string) => ({ uri, name }), close: async () => {} }; clients.push(client); return client as any; });
  const [a, again, b] = await Promise.all([pool.connect('fixture-a', 'records'), pool.connect('fixture-a', 'records'), pool.connect('fixture-b', 'records')]);
  assert.equal(a.db, again.db); assert.notEqual(a.db, b.db); assert.equal(clients.length, 2); assert.ok(clients.every(client => client.opens === 1));
  assert.throws(() => pool.get('records')); assert.equal(pool.get('records', 'fixture-b'), b.db); await pool.close();
});
test('a failed connection is never cached as a usable database and a retry starts cleanly', async () => {
  let starts = 0;
  const pool = new MongoConnectionPool(() => ({ async connect() { if (++starts === 1) throw new Error('fixture down'); return this; }, db: () => ({ fixture: true }), close: async () => {} }) as any);
  await assert.rejects(() => pool.connect('fixture', 'records'));
  assert.throws(() => pool.get('records'));
  await pool.connect('fixture', 'records'); assert.equal(starts, 2); await pool.close();
});
