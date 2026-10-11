import assert from 'node:assert/strict';
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { signGatewayAssertion } from '@journeyax/database';
import { PERMISSION_KEY, PermissionGuard } from '../src/permission.guard';

function contextFor(headers: Record<string, string>) {
  const handler = () => undefined;
  Reflect.defineMetadata(PERMISSION_KEY, 'config.publish', handler);
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
  const secret = 'project-service-test-secret-32-chars';
  process.env.GATEWAY_ASSERTION_SECRET = secret;
  process.env.AUTH_DEV_BYPASS = 'false';
  const guard = new PermissionGuard();

  try {
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
  } finally {
    if (oldSecret === undefined) delete process.env.GATEWAY_ASSERTION_SECRET;
    else process.env.GATEWAY_ASSERTION_SECRET = oldSecret;
    if (oldBypass === undefined) delete process.env.AUTH_DEV_BYPASS;
    else process.env.AUTH_DEV_BYPASS = oldBypass;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
