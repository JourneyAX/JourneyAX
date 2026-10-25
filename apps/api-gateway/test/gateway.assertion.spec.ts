import assert from 'node:assert/strict';
import { GatewayService } from '../src/gateway.service';
import { verifyGatewayAssertion } from '@journeyax/database';

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

  console.log(`\n====================================================`);
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
