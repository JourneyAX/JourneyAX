import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthGuard } from '../src/auth.guard';

test('the real guest guard removes forged identity, permissions and internal credentials before forwarding', async () => {
  const request: any = { originalUrl: '/api/v1/merchant-a/products/maintenance', method: 'POST', headers: { 'x-tenant-id': 'merchant-a', 'x-user-permissions': 'knowledge.ingest,user.manage', 'x-user-role': 'admin', 'x-user-name': 'Forged', 'x-principal-id': 'victim', 'x-auth-type': 'jwt', 'x-internal-key': 'forged', 'x-gateway-assertion': 'forged' } };
  let called = 0; const response: any = { status: () => response, json: () => { throw Error('Unexpected response'); } };
  await new AuthGuard().use(request, response, () => { called++; });
  assert.equal(called, 1);
  assert.equal(request.headers['x-user-role'], 'guest');
  assert.equal(request.headers['x-auth-type'], 'anonymous');
  for (const key of ['x-user-permissions', 'x-user-name', 'x-internal-key', 'x-gateway-assertion', 'x-principal-id']) assert.equal(request.headers[key], undefined, key);
});
