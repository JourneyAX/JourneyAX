import assert from 'node:assert/strict';
import { GatewayService, isCacheable, signedSubject } from '../src/gateway.service';
import { verifyGatewayAssertion, gatewayRoleFor } from '@journeyax/database';

async function runGatewayAssertionTests() {
  console.log('=== Running API Gateway Assertion & Security Tests ===\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`✗ ${name}: ${err.message}`);
      failed++;
    }
  }

  const secret = 'gateway-secret-test-32-chars-long!';
  process.env.GATEWAY_ASSERTION_SECRET = secret;
  process.env.NODE_ENV = 'test';
  process.env.DISABLE_GCP_AUTH = 'true';

  const service = new GatewayService();

  // Test 1: Verify signed assertion generation
  await test('Gateway assertion signed and verifiable by verifyGatewayAssertion', async () => {
    // Intercept fetch or verify headers logic
    const path = '/api/v1/workweargroup/production/runtime/turn';
    let interceptedHeaders: any = null;

    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      interceptedHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      };
    };

    try {
      await service.proxyRequest(
        'POST',
        path,
        {
          'x-tenant-id': 'workweargroup',
          'x-user-id': 'usr_gw_test',
          'x-user-role': 'operator',
        },
        { message: 'ping' }
      );

      assert.ok(interceptedHeaders, 'Headers must be passed to downstream');
      const token = interceptedHeaders['X-Gateway-Assertion'];
      assert.ok(token, 'X-Gateway-Assertion header must be present');

      const payload = verifyGatewayAssertion(token, secret, {
        expectedTenantId: 'workweargroup',
        expectedEnvironmentId: 'production',
      });

      assert.equal(payload.iss, 'journeyax-api-gateway');
      assert.equal(payload.aud, 'journeyax-runtime');
      assert.equal(payload.tenantId, 'workweargroup');
      assert.equal(payload.environmentId, 'production');
      assert.equal(payload.sub, 'usr_gw_test');
      assert.equal(payload.role, 'operator');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Test 2: Role normalization
  await test('Gateway assertion normalizes invalid roles to customer', async () => {
    const path = '/api/v1/workweargroup/production/runtime/turn';
    let interceptedHeaders: any = null;

    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      interceptedHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      };
    };

    try {
      await service.proxyRequest(
        'POST',
        path,
        {
          'x-tenant-id': 'workweargroup',
          'x-user-id': 'usr_attacker',
          'x-user-role': 'god_mode_admin',
        },
        { message: 'ping' }
      );

      assert.ok(interceptedHeaders);
      const token = interceptedHeaders['X-Gateway-Assertion'];
      assert.ok(token);

      const payload = verifyGatewayAssertion(token, secret, {
        expectedTenantId: 'workweargroup',
        expectedEnvironmentId: 'production',
      });

      assert.equal(payload.role, 'customer');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Staff groups: looked up by the gateway, signed into the assertion, never taken from the browser.
  process.env.INTERNAL_API_KEY = 'internal-key-for-gateway-test';
  const withFetch = async (membership: (init: any) => any, run: (seen: { downstream: any; lookups: any[] }) => Promise<void>) => {
    const seen: { downstream: any; lookups: any[] } = { downstream: null, lookups: [] };
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, init: any) => {
      if (String(url).includes('/verify-membership')) {
        seen.lookups.push({ url: String(url), init });
        const answer = membership(init);
        return { ok: answer.status === undefined || answer.status < 300, status: answer.status ?? 200, json: async () => answer.body ?? {} };
      }
      if (String(url).includes('/published')) return { ok: true, status: 200, json: async () => ({}) };
      seen.downstream = init?.headers;
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }), headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    };
    try { await run(seen); } finally { global.fetch = originalFetch; }
  };
  const turnPath = '/api/v1/placemakers/production/runtime/turn';
  const verifyFor = (headers: any) => verifyGatewayAssertion(headers['X-Gateway-Assertion'], secret, { expectedTenantId: 'placemakers', expectedEnvironmentId: 'production' });

  await test('a member of staff gets their teams signed into the assertion, looked up with the internal key', async () => {
    await withFetch(() => ({ body: { isMember: true, teams: ['Customer Service', 'sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'manager', 'x-user-email': 'rep1@placemakers.test' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'manager');
      assert.deepEqual(payload.groups, ['customer-service', 'sales']);
      assert.equal(seen.lookups.length, 1);
      assert.equal(seen.lookups[0].init.headers['x-internal-key'], 'internal-key-for-gateway-test');
    });
  });

  await test('a shopper is never looked up and never carries groups, even if the browser sends a groups header', async () => {
    await withFetch(() => ({ body: { isMember: true, teams: ['customer-service'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'buyer', 'x-user-email': 'shopper1@example.test', 'x-user-groups': 'customer-service' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'customer');
      assert.equal(payload.groups, undefined);
      assert.equal(seen.lookups.length, 0);
    });
  });

  await test('when the lookup fails the request still goes through, with no groups', async () => {
    await withFetch(() => ({ status: 500 }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'manager', 'x-user-email': 'rep2@placemakers.test' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'manager');
      assert.equal(payload.groups, undefined);
    });
  });

  await test('the streaming path signs the same identity (it used to send none, so a streamed turn always looked like a shopper\'s)', async () => {
    await withFetch(() => ({ body: { isMember: true, teams: ['sales'] } }), async (seen) => {
      const res: any = { status() { return this; }, setHeader() {}, flushHeaders() {}, write() {}, end() {}, json() {} };
      await service.proxyStream('POST', turnPath + '/stream', { 'x-tenant-id': 'placemakers', 'x-user-role': 'manager', 'x-user-email': 'rep3@placemakers.test' }, { message: 'hi' }, res);
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'manager');
      assert.deepEqual(payload.groups, ['sales']);
    });
    await withFetch(() => ({ body: {} }), async (seen) => {
      const res: any = { status() { return this; }, setHeader() {}, flushHeaders() {}, write() {}, end() {}, json() {} };
      await service.proxyStream('POST', turnPath + '/stream', { 'x-tenant-id': 'placemakers', 'x-user-role': 'guest' }, { message: 'hi' }, res);
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'customer', 'a guest on the streaming path is a signed shopper');
    });
  });

  // The user type's own staff words (cs, rep) used to be signed as a shopper: a customer-service or sales login lost its teams and every
  // staff-only thing. They are now staff; everything that is not a known role stays a shopper.
  await test('a customer-service (cs) or sales (rep) login is signed as staff and carries its teams', async () => {
    await withFetch(() => ({ body: { isMember: true, teams: ['Customer Service'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'cs', 'x-user-email': 'csr@placemakers.test' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'consultant');
      assert.deepEqual(payload.groups, ['customer-service']);
    });
    await withFetch(() => ({ body: { isMember: true, teams: ['sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'rep', 'x-user-email': 'sales@placemakers.test' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'operator');
      assert.deepEqual(payload.groups, ['sales']);
    });
  });

  await test('gatewayRoleFor: known roles keep their meaning; buyer, guest, unknown, empty and prototype words are shoppers', () => {
    for (const [word, role] of [['admin', 'admin'], ['MANAGER', 'manager'], [' cs ', 'consultant'], ['rep', 'operator'], ['operator', 'operator'], ['consultant', 'consultant']] as const) {
      assert.equal(gatewayRoleFor(word), role, word);
    }
    for (const word of ['buyer', 'guest', 'customer', 'god_mode_admin', '', 'constructor', '__proto__', 'toString']) assert.equal(gatewayRoleFor(word), 'customer', word);
    for (const value of [undefined, null, 7, {}, ['admin']]) assert.equal(gatewayRoleFor(value), 'customer');
  });

  // The gateway cache is keyed by tenant and path, never by person, so anything that depends on who is asking must not be cached.
  await test('answers that depend on the person are never cached, however the path is written', () => {
    for (const path of [
      '/api/v1/placemakers/commerce/connectors',
      '/api/v1/placemakers/production/commerce/connectors',
      '/api/v1/placemakers/production/runtime/connectors',
      '/api/v1/placemakers/runtime/connectors?x=1',
      '/api/v1/commerce/chat',
      '/api/v1/agent/anything',
      '/auth/me',
    ]) assert.equal(isCacheable('GET', path), false, path);
    assert.equal(isCacheable('POST', '/api/v1/placemakers/products/search'), false, 'only GET is ever cached');
    for (const path of ['/api/v1/placemakers/products/search', '/api/v1/placemakers/analytics/summary']) assert.equal(isCacheable('GET', path), true, path);
  });

  await test('the platform admin carries the reserved administrators group by role; a team called Administrators puts nobody in it', async () => {
    await withFetch(() => ({ body: { isMember: true, teams: ['Sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'admin', 'x-user-email': 'admin' }, { message: 'hi' });
      assert.deepEqual(verifyFor(seen.downstream).groups, ['administrators'], 'a login name that is not an email has no teams to look up');
    });
    await withFetch(() => ({ body: { isMember: true, teams: ['Administrators', 'Sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'rep', 'x-user-email': 'sneaky@placemakers.test' }, { message: 'hi' });
      const payload = verifyFor(seen.downstream);
      assert.equal(payload.role, 'operator');
      assert.deepEqual(payload.groups, ['sales'], 'the reserved name is dropped from a team lookup');
    });
    await withFetch(() => ({ body: { isMember: true, teams: ['administrators', 'Sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'admin', 'x-user-email': 'boss@placemakers.test' }, { message: 'hi' });
      assert.deepEqual(verifyFor(seen.downstream).groups, ['administrators', 'sales'], 'an admin who is also in a team keeps both, with the reserved group once');
    });
    await withFetch(() => ({ body: { isMember: true, teams: ['sales'] } }), async (seen) => {
      await service.proxyRequest('POST', turnPath, { 'x-tenant-id': 'placemakers', 'x-user-role': 'buyer', 'x-user-email': 'shopper@placemakers.test' }, { message: 'hi' });
      assert.equal(verifyFor(seen.downstream).groups, undefined, 'a shopper has no groups at all');
    });
  });

  console.log(`\n====================================================`);
  // The signed subject is the verified login; a guest cannot pass as one.
  await test('the signed subject is the verified login, whatever x-user-id says', () => {
    assert.equal(signedSubject({ 'x-user-email': 'hemi@talbot.example', 'x-user-id': 'someone-else@example.com' }), 'hemi@talbot.example');
    assert.equal(signedSubject({ 'x-user-email': 'hemi@talbot.example' }), 'hemi@talbot.example');
  });

  await test('a guest who sends a login-shaped x-user-id or x-principal-id is signed as anonymous, not as that login', () => {
    assert.equal(signedSubject({ 'x-user-email': 'guest@anonymous', 'x-user-id': 'hemi@talbot.example' }), 'anonymous');
    assert.equal(signedSubject({ 'x-user-email': 'guest@anonymous', 'x-principal-id': 'hemi@talbot.example' }), 'anonymous');
    assert.equal(signedSubject({ 'x-user-id': 'hemi@talbot.example' }), 'anonymous');
    assert.equal(signedSubject({ 'x-user-email': 'GUEST@anonymous', 'x-user-id': 'hemi@talbot.example' }), 'anonymous');
  });

  await test('a guest may still carry a plain session id, and nobody at all is anonymous', () => {
    assert.equal(signedSubject({ 'x-user-email': 'guest@anonymous', 'x-user-id': 'sess_123' }), 'sess_123');
    assert.equal(signedSubject({ 'x-user-id': 'usr_gw_test' }), 'usr_gw_test');
    assert.equal(signedSubject({}), 'anonymous');
  });

  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`====================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runGatewayAssertionTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
