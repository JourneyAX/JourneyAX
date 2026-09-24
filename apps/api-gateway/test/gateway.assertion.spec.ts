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
