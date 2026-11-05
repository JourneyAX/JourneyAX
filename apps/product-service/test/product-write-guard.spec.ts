import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductWriteGuard } from '../src/product-write.guard';
const context = (headers: any = {}, projectId = 'merchant-a') => ({ switchToHttp: () => ({ getRequest: () => ({ headers, params: { projectId } }) }) }) as any;
test('forged privilege headers do not authorise a product ingest or purge', async () => {
  await assert.rejects(() => new ProductWriteGuard().canActivate(context({ 'x-user-permissions': 'knowledge.ingest', 'x-user-role': 'admin' })), /Verified/);
});
test('verified knowledge administrators remain tenant-scoped and an auth outage refuses the write', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ valid: true, payload: { sub: 'admin-a', tenantId: 'merchant-a', role: 'admin' } }), { status: 200 });
    assert.equal(await new ProductWriteGuard().canActivate(context({ authorization: 'Bearer legitimate' })), true);
    await assert.rejects(() => new ProductWriteGuard().canActivate(context({ authorization: 'Bearer legitimate' }, 'merchant-b')), /tenant-scoped/);
    globalThis.fetch = async () => { throw Error('unavailable'); };
    await assert.rejects(() => new ProductWriteGuard().canActivate(context({ authorization: 'Bearer legitimate' })), /tenant-scoped/);
  } finally { globalThis.fetch = previous; }
});
