import assert from 'node:assert/strict';
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { signGatewayAssertion } from '@journeyax/database';
import { PERMISSION_KEY, PUBLIC_PROJECT_ROUTE, PermissionGuard } from '../src/permission.guard';

function contextFor(headers: Record<string, string>, permission = 'config.publish') {
  const handler = () => undefined;
  Reflect.defineMetadata(PERMISSION_KEY, permission, handler);
  const req: any = { headers, params: { projectId: 'placemakers' }, body: {}, query: {} };
  return {
    req,
    context: {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => req }),
    } as any,
  };
}

async function main() {
  console.log('🔐 Running Project Service independent permission proof tests...');
  const oldSecret = process.env.GATEWAY_ASSERTION_SECRET;
  const oldBypass = process.env.AUTH_DEV_BYPASS;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldFetch = globalThis.fetch;
  const secret = 'project-service-test-secret-32-chars';
  process.env.GATEWAY_ASSERTION_SECRET = secret;
  process.env.AUTH_DEV_BYPASS = 'false';
  const guard = new PermissionGuard();

  try {
    const unclassified = contextFor({}, '');
    await assert.rejects(() => guard.canActivate(unclassified.context), /no configured access policy/);
    Reflect.defineMetadata(PUBLIC_PROJECT_ROUTE, true, unclassified.context.getHandler());
    assert.equal(await guard.canActivate(unclassified.context), true);
    console.log('  ✅ PASS: new routes are private unless they declare permission or explicit public access');
    const spoofed = contextFor({ 'x-user-permissions': 'config.publish', 'x-user-role': 'admin' });
    await assert.rejects(() => guard.canActivate(spoofed.context), (error: any) => error instanceof ForbiddenException);
    console.log('  ✅ PASS: raw permission and role headers cannot authorize a direct caller');

    const assertion = signGatewayAssertion({
      tenantId: 'placemakers', environmentId: 'production', sub: 'publisher-1', role: 'admin',
    }, secret);
    const signed = contextFor({ 'x-gateway-assertion': assertion });
    assert.equal(await guard.canActivate(signed.context), true);
    assert.equal(signed.req.headers['x-user-id'], 'publisher-1');
    assert.equal(signed.req.headers['x-authenticated-role'], 'admin');
    console.log('  ✅ PASS: signed gateway identity authorizes and supplies server-verified audit identity');

    let payload: any = { sub: 'manager@example.test', role: 'manager', tenantId: 'other-project' };
    globalThis.fetch = (async () => new Response(JSON.stringify({ valid: true, payload }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    await assert.rejects(() => guard.canActivate(contextFor({ authorization: 'Bearer isolated-fixture' }, 'user.read').context), /requested project/);
    payload.tenantId = 'placemakers';
    assert.equal(await guard.canActivate(contextFor({ authorization: 'Bearer isolated-fixture' }, 'user.read').context), true);
    payload = { sub: 'platform-admin@example.test', role: 'admin', tenantId: 'platform' };
    assert.equal(await guard.canActivate(contextFor({ authorization: 'Bearer isolated-fixture' }, 'project.list').context), true);
    console.log('  ✅ PASS: direct JWT calls enforce project scope and preserve explicit platform-admin access');

    process.env.NODE_ENV = 'production'; process.env.AUTH_DEV_BYPASS = 'true';
    await assert.rejects(() => guard.canActivate(contextFor({}).context), (error: any) => error instanceof ForbiddenException);
    console.log('  ✅ PASS: the development bypass cannot authorise a production request');
  } finally {
    if (oldSecret === undefined) delete process.env.GATEWAY_ASSERTION_SECRET;
    else process.env.GATEWAY_ASSERTION_SECRET = oldSecret;
    if (oldBypass === undefined) delete process.env.AUTH_DEV_BYPASS;
    else process.env.AUTH_DEV_BYPASS = oldBypass;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    globalThis.fetch = oldFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
