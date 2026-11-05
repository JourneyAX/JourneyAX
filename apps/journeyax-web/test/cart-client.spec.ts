import test from 'node:test';
import assert from 'node:assert/strict';
import { changeOwnedCart } from '../src/lib/cart-client';

test('cart clicks merge with current server items, send no prices, and persist removing the last item', async () => {
  const original = globalThis.fetch;
  const writes: any[] = [];
  let items = [{ sku: 'from-chat', quantity: 2 }];
  let version = 4;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      assert.equal(body.expectedVersion, version);
      assert.equal(body.sessionId, 'chat-1');
      assert.deepEqual(Object.keys(body).sort(), ['expectedVersion', 'idempotencyKey', 'items', 'sessionId']);
      writes.push(body);
      items = body.items;
      version++;
    }
    return Response.json({ cart: { version, items, status: items.length ? 'active' : 'empty' } });
  };
  try {
    await changeOwnedCart('tenant-a', 'chat-1', { kind: 'add', sku: 'clicked-item', quantity: 3 });
    assert.deepEqual(items, [{ sku: 'from-chat', quantity: 2 }, { sku: 'clicked-item', quantity: 3 }]);
    await changeOwnedCart('tenant-a', 'chat-1', { kind: 'remove', sku: 'clicked-item' });
    const empty = await changeOwnedCart('tenant-a', 'chat-1', { kind: 'remove', sku: 'from-chat' });
    assert.equal(empty.cart.status, 'empty');
    assert.deepEqual(writes[2].items, []);
    assert.equal(new Set(writes.map(value => value.idempotencyKey)).size, 3);
  } finally { globalThis.fetch = original; }
});

test('invalid quantities never call the server and a conflicting cart mutation is never retried', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return init?.method === 'POST' ? Response.json({ error: 'changed' }, { status: 409 }) : Response.json({ cart: { version: 2, items: [], status: 'empty' } });
  };
  try {
    for (const quantity of [0, -1, 1.5, NaN]) await assert.rejects(() => changeOwnedCart('tenant', 'chat', { kind: 'add', sku: 'item', quantity }), /whole quantity/);
    assert.equal(calls, 0);
    await assert.rejects(() => changeOwnedCart('tenant', 'chat', { kind: 'add', sku: 'item', quantity: 1 }), /changed/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
