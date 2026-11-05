import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAuth, isPlatformIdentity, scopeTenant } from '../src/lib/require-auth';
import { GET as environment } from '../src/app/api/env/route';
import { GET as proxy } from '../src/app/api/bff/[...path]/route';
import { GET as insights } from '../src/app/api/insights/route';
import { GET as transcript } from '../src/app/api/insights/session/[sessionId]/transcript/route';

test('a development flag cannot grant a missing or failed Studio session administrative access', async () => {
  const previousFlag = process.env.AUTH_DEV_BYPASS, previousFetch = globalThis.fetch;
  process.env.AUTH_DEV_BYPASS = 'true';
  try {
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('offline auth outage'); };
    const req = new Request('http://studio.test/api/insights?projectId=another-tenant');
    assert.deepEqual(await requireAuth(req, 'user.manage'), { ok: false, status: 401, message: 'Authentication required.' });
    assert.equal((await requireAuth(new Request(req, { headers: { authorization: 'Bearer invalid' } }), 'user.manage')).ok, false);
    assert.equal((await proxy(req, { params: Promise.resolve({ path: ['api', 'v1', 'projects'] }) })).status, 401);
    assert.equal((await insights(req)).status, 401);
    assert.equal((await transcript(req, { params: Promise.resolve({ sessionId: 'other-session' }) })).status, 401);
    assert.equal(calls, 1, 'unauthenticated proxies must not contact any downstream source');
    const response = await environment(); assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /AUTH_SERVICE_URL|GATEWAY_URL/);
  } finally { globalThis.fetch = previousFetch; if (previousFlag === undefined) delete process.env.AUTH_DEV_BYPASS; else process.env.AUTH_DEV_BYPASS = previousFlag; }
});
test('only a verified administrative platform identity can widen the Studio tenant scope', () => {
  const identity: any = { email: 'staff@example.test', tenantId: 'platform', role: 'buyer', permissions: [] };
  assert.equal(isPlatformIdentity(identity), false); assert.equal(scopeTenant(identity, 'another-tenant'), 'platform');
  assert.equal(isPlatformIdentity({ ...identity, tenantId: 'tenant-a', role: 'platform_admin' }), false);
  assert.equal(isPlatformIdentity({ ...identity, role: 'admin' }), true);
});
