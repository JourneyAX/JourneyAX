import test from 'node:test';
import assert from 'node:assert/strict';
import { changeOwnedCart } from '../cart-client';

test('recovery reprices the freshly read owned cart without changing quantities or supplying client prices', async () => {
  const original = globalThis.fetch, calls: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url, init });
    if (!init?.method) return Response.json({ cart: { version: 8, items: [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }], status: 'active' } });
    return Response.json({ cart: { version: 9 }, quote: { quoteId: 'new-server-priced-revision' } });
  }) as typeof fetch;
  try {
    const result = await changeOwnedCart('merchant-a', 'session-a', { kind: 'refresh' });
    assert.equal(result.quote?.quoteId, 'new-server-priced-revision');
    assert.equal(calls.length, 2);
    const posted = JSON.parse(calls[1].init.body);
    assert.equal(posted.expectedVersion, 8); assert.equal(posted.sessionId, 'session-a');
    assert.deepEqual(posted.items, [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }]);
    assert.deepEqual(Object.keys(posted).sort(), ['expectedVersion', 'idempotencyKey', 'items', 'sessionId']);
  } finally { globalThis.fetch = original; }
});

test('a locked or concurrently changed checkout cart never blindly retries a fresh revision', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    requests++;
    return init?.method ? Response.json({ error: 'Checkout reservation changed' }, { status: 409 }) : Response.json({ cart: { version: 8, items: [{ sku: 'A', quantity: 2 }], status: 'active' } });
  }) as typeof fetch;
  try { await assert.rejects(changeOwnedCart('merchant-a', 'session-a', { kind: 'refresh' }), /cart changed/); assert.equal(requests, 2); }
  finally { globalThis.fetch = original; }
});
