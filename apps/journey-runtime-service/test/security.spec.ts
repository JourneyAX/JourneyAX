import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RuntimeAuthGuard, IS_INTERNAL_ONLY_KEY, IS_PUBLIC_KEY } from '../src/auth/auth.guard';
import { ApprovalStore } from '../src/approval/approval.store';
import { TurnCommandRequestSchema, DecideApprovalRequestSchema } from '../src/dto/turn.dto';
import { signGatewayAssertion } from '@journeyax/database';

function createMockExecutionContext(options: {
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, any>;
  isPublic?: boolean;
  isInternalOnly?: boolean;
}): ExecutionContext {
  const req: any = {
    params: options.params || {},
    headers: options.headers || {},
    body: options.body || {},
  };

  const reflectorMock = {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return Boolean(options.isPublic);
      if (key === IS_INTERNAL_ONLY_KEY) return Boolean(options.isInternalOnly);
      return undefined;
    },
  } as unknown as Reflector;

  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
    _reflector: reflectorMock,
  } as unknown as ExecutionContext;
}

async function runSecurityTests() {
  console.log('🔒 Running Cross-Tenant & Security Verification Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }

  const reflector = new Reflector();
  const guard = new RuntimeAuthGuard(reflector);

  // ── TEST 1: Tenant Header Mismatch Rejection ─────────────────────────────
  await test('Header mismatch: X-Tenant-ID != path param throws 403 Forbidden', async () => {
    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: { 'x-tenant-id': 'attacker-tenant' },
      body: { sessionId: 's1' },
    });
    (guard as any).reflector = (ctx as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx),
      (err: any) => err instanceof ForbiddenException && err.message.includes('Cross-tenant access forbidden')
    );
  });

  // ── TEST 2: Body Tenant Mismatch Rejection ──────────────────────────────
  await test('Body mismatch: body.tenantId != path param throws 403 Forbidden', async () => {
    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: { 'x-tenant-id': 'workweargroup' },
      body: { tenantId: 'attacker-tenant', sessionId: 's1' },
    });
    (guard as any).reflector = (ctx as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx),
      (err: any) => err instanceof ForbiddenException && err.message.includes('Cross-tenant access forbidden')
    );
  });

  // ── TEST 3: Environment Mismatch Rejection ──────────────────────────────
  await test('Environment mismatch: body.environmentId != path param throws 403 Forbidden', async () => {
    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: { 'x-tenant-id': 'workweargroup' },
      body: { environmentId: 'dev', sessionId: 's1' },
    });
    (guard as any).reflector = (ctx as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx),
      (err: any) => err instanceof ForbiddenException && err.message.includes('Environment mismatch')
    );
  });

  // ── TEST 4: External Header Spoofing Prevention ─────────────────────────
  await test('External caller cannot spoof admin role via unverified headers; role defaults to customer', async () => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.GATEWAY_ASSERTION_SECRET;
    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: {
        'x-tenant-id': 'workweargroup',
        'x-user-id': 'attacker-123',
        'x-user-role': 'admin',
      },
      body: {
        principalRole: 'super_admin',
        principalId: 'admin-root',
      },
    });
    (guard as any).reflector = (ctx as any)._reflector;

    const allowed = await guard.canActivate(ctx);
    assert.equal(allowed, true);

    const req = ctx.switchToHttp().getRequest();
    assert.equal(req.authContext.tenantId, 'workweargroup');
    assert.equal(req.authContext.principalRole, 'customer');
    assert.notEqual(req.authContext.principalRole, 'admin');
    assert.notEqual(req.authContext.principalRole, 'super_admin');
  });

  // ── TEST 4B: Cryptographically Signed Gateway Assertion Verification ────
  await test('Verified signed gateway assertion derives authenticated identity and role', async () => {
    const assertionSecret = 'gateway-secret-test-key-999';
    process.env.GATEWAY_ASSERTION_SECRET = assertionSecret;

    const assertion = signGatewayAssertion(
      {
        tenantId: 'workweargroup',
        environmentId: 'production',
        sub: 'usr-verified-456',
        role: 'manager',
      },
      assertionSecret
    );

    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: {
        'x-tenant-id': 'workweargroup',
        'x-gateway-assertion': assertion,
      },
      body: {},
    });
    (guard as any).reflector = (ctx as any)._reflector;

    const allowed = await guard.canActivate(ctx);
    assert.equal(allowed, true);

    const req = ctx.switchToHttp().getRequest();
    assert.equal(req.authContext.tenantId, 'workweargroup');
    assert.equal(req.authContext.principalId, 'usr-verified-456');
    assert.equal(req.authContext.principalRole, 'manager');
  });

  // ── TEST 5: Internal Endpoints Require Valid Key (Fail-Closed) ──────────
  await test('Internal-only endpoint rejects missing or invalid X-Internal-Key with 401', async () => {
    process.env.INTERNAL_API_KEY = 'super-secure-production-internal-key';

    // Without header
    const ctxNoKey = createMockExecutionContext({
      params: { tenantId: 'workweargroup' },
      headers: {},
      isInternalOnly: true,
    });
    (guard as any).reflector = (ctxNoKey as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctxNoKey),
      (err: any) => err instanceof UnauthorizedException && err.message.includes('valid X-Internal-Key required')
    );

    // With wrong header
    const ctxBadKey = createMockExecutionContext({
      params: { tenantId: 'workweargroup' },
      headers: { 'x-internal-key': 'wrong-key' },
      isInternalOnly: true,
    });
    (guard as any).reflector = (ctxBadKey as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctxBadKey),
      (err: any) => err instanceof UnauthorizedException && err.message.includes('valid X-Internal-Key required')
    );

    // With valid header
    const ctxValidKey = createMockExecutionContext({
      params: { tenantId: 'workweargroup' },
      headers: { 'x-internal-key': 'super-secure-production-internal-key' },
      isInternalOnly: true,
    });
    (guard as any).reflector = (ctxValidKey as any)._reflector;

    const allowed = await guard.canActivate(ctxValidKey);
    assert.equal(allowed, true);
  });

  // ── TEST 6: Internal Endpoints Fail Closed When Unconfigured ─────────────
  await test('Internal-only endpoint fails closed if INTERNAL_API_KEY is not set', async () => {
    const origKey = process.env.INTERNAL_API_KEY;
    delete process.env.INTERNAL_API_KEY;

    try {
      const ctx = createMockExecutionContext({
        params: { tenantId: 'workweargroup' },
        headers: { 'x-internal-key': 'any-key' },
        isInternalOnly: true,
      });
      (guard as any).reflector = (ctx as any)._reflector;

      await assert.rejects(
        async () => await guard.canActivate(ctx),
        (err: any) => err instanceof UnauthorizedException && err.message.includes('not configured')
      );
    } finally {
      process.env.INTERNAL_API_KEY = origKey;
    }
  });

  // ── TEST 7: Cross-Tenant Approval Tampering Prevention ──────────────────
  await test('Approval decision fails if tenantId or workspaceId does not match record', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_IN_MEMORY_APPROVALS = 'true';
    const store = new ApprovalStore();

    const req = await store.createPending(
      'order.commit',
      { amount: 100 },
      {
        tenantId: 'tenant-alpha',
        environmentId: 'production',
        workspaceId: 'ws-alpha',
        sessionId: 'sess-alpha',
        stageId: 'checkout',
        packVersionId: '1.0.0',
        principalId: 'user-alpha',
        principalRole: 'shopper',
        isInternal: false,
      } as any
    );

    assert.ok(req.approvalRequestId);

    const bravedecision = await store.decide(
      'tenant-bravo',
      'production',
      'ws-alpha',
      req.approvalRequestId,
      'approved',
      'attacker-bravo'
    );
    assert.equal(bravedecision, false, 'Cross-tenant approval MUST be rejected');

    const wsMismatchDecision = await store.decide(
      'tenant-alpha',
      'production',
      'ws-other',
      req.approvalRequestId,
      'approved',
      'attacker-workspace'
    );
    assert.equal(wsMismatchDecision, false, 'Cross-workspace approval MUST be rejected');

    const validDecision = await store.decide(
      'tenant-alpha',
      'production',
      'ws-alpha',
      req.approvalRequestId,
      'approved',
      'legit-manager'
    );
    assert.equal(validDecision, true, 'Legitimate scoped approval MUST succeed');
  });

  // ── TEST 8: DTO Runtime Schema Validation ───────────────────────────────
  await test('DTO Runtime Validation: TurnCommandRequest rejects missing sessionId/correlationId', () => {
    const invalid = { message: 'hello' };
    const parseResult = TurnCommandRequestSchema.safeParse(invalid);
    assert.equal(parseResult.success, false);

    const valid = {
      sessionId: 'sess-1',
      correlationId: 'corr-1',
      message: 'hello',
    };
    const validResult = TurnCommandRequestSchema.safeParse(valid);
    assert.equal(validResult.success, true);
  });

  await test('DTO Runtime Validation: DecideApprovalRequest rejects invalid decision enum', () => {
    const invalid = { decision: 'bypass_security' };
    const parseResult = DecideApprovalRequestSchema.safeParse(invalid);
    assert.equal(parseResult.success, false);

    const valid = { decision: 'approved', reason: 'Approved by authorized manager' };
    const validResult = DecideApprovalRequestSchema.safeParse(valid);
    assert.equal(validResult.success, true);
  });

  // ── TEST 9: Gateway Assertion Bound Claims & Replay Prevention ───────────
  await test('Gateway assertion rejects mismatched tenant binding with 401', async () => {
    const assertionSecret = 'test-secret-key-32-bytes-long!';
    process.env.GATEWAY_ASSERTION_SECRET = assertionSecret;

    const assertion = signGatewayAssertion(
      {
        tenantId: 'attacker-tenant',
        environmentId: 'production',
        sub: 'usr-admin-1',
        role: 'admin',
      },
      assertionSecret
    );

    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: {
        'x-tenant-id': 'workweargroup',
        'x-gateway-assertion': assertion,
      },
      body: {},
    });
    (guard as any).reflector = (ctx as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx),
      (err: any) => err instanceof UnauthorizedException && err.message.includes('Tenant binding mismatch')
    );
  });

  await test('Gateway assertion rejects mismatched issuer/audience with 401', async () => {
    const assertionSecret = 'test-secret-key-32-bytes-long!';
    process.env.GATEWAY_ASSERTION_SECRET = assertionSecret;

    const payload = {
      iss: 'untrusted-issuer',
      aud: 'wrong-audience',
      tenantId: 'workweargroup',
      environmentId: 'production',
      sub: 'usr-admin-1',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: `jti_test_${Date.now()}_2`,
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', assertionSecret).update(b64).digest('hex');

    const ctx = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: {
        'x-tenant-id': 'workweargroup',
        'x-gateway-assertion': `${b64}.${sig}`,
      },
      body: {},
    });
    (guard as any).reflector = (ctx as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx),
      (err: any) => err instanceof UnauthorizedException && err.message.includes('Invalid issuer')
    );
  });

  await test('Gateway assertion rejects duplicate jti replay with 401', async () => {
    const assertionSecret = 'test-secret-key-32-bytes-long!';
    process.env.GATEWAY_ASSERTION_SECRET = assertionSecret;
    const replayJti = `replay_jti_${Date.now()}`;

    const assertion = signGatewayAssertion(
      {
        tenantId: 'workweargroup',
        environmentId: 'production',
        sub: 'usr-admin-1',
        role: 'admin',
      },
      assertionSecret,
      { jti: replayJti }
    );

    // First use: passes
    const ctx1 = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: { 'x-tenant-id': 'workweargroup', 'x-gateway-assertion': assertion },
      body: {},
    });
    (guard as any).reflector = (ctx1 as any)._reflector;
    const allowed1 = await guard.canActivate(ctx1);
    assert.equal(allowed1, true);
    const req1 = ctx1.switchToHttp().getRequest();
    assert.equal(req1.authContext.principalRole, 'admin');

    // Second use (replay with same jti): throws explicit 401 Unauthorized
    const ctx2 = createMockExecutionContext({
      params: { tenantId: 'workweargroup', environmentId: 'production' },
      headers: { 'x-tenant-id': 'workweargroup', 'x-gateway-assertion': assertion },
      body: {},
    });
    (guard as any).reflector = (ctx2 as any)._reflector;

    await assert.rejects(
      async () => await guard.canActivate(ctx2),
      (err: any) => err instanceof UnauthorizedException && err.message.includes('replayed')
    );
  });

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
