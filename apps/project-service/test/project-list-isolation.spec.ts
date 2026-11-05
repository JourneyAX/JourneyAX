import '../../../packages/jax-iq/test/setup/no-world';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDb } from '@journeyax/test-support';
import { signGatewayAssertion } from '@journeyax/database';
import { ProjectService } from '../src/project.service';
import { ProjectController } from '../src/project.controller';
import { PermissionGuard, PERMISSION_KEY } from '../src/permission.guard';

test('project lists filter at storage and redact secrets even for an authenticated tenant administrator', async () => {
  const db = new MemoryDb(), service = new ProjectService();
  (service as any).isConnected = true; (service as any).projectsCol = db.collection('tenant_configs');
  await db.collection('tenant_configs').insertOne({ projectId: 'tenant-a', orgId: 'org-shared', status: 'active', pricing: {}, openaiApiKey: 'private-source-key-tenant-a' });
  await db.collection('tenant_configs').insertOne({ projectId: 'tenant-b', orgId: 'org-shared', status: 'active', pricing: {}, openaiApiKey: 'private-source-key-tenant-b' });
  const controller = new ProjectController(service);
  const request = { projectAccess: { tenantId: 'tenant-a', platformAdmin: false, internal: false } };
  const rows = await controller.listProjects('org-shared', 'active', request);
  assert.deepEqual(rows.map(row => row.projectId), ['tenant-a']);
  assert.doesNotMatch(JSON.stringify(rows), /private-source-key/);
  const all = await controller.listProjects(undefined, undefined, { projectAccess: { tenantId: 'platform', platformAdmin: true, internal: false } });
  assert.equal(all.length, 2); assert.doesNotMatch(JSON.stringify(all), /private-source-key/);
  await assert.rejects(() => controller.listProjects(), /Verified project list scope/);
});

test('a signed tenant admin cannot use project creation or a development switch to acquire global scope', async () => {
  const previous = { secret: process.env.GATEWAY_ASSERTION_SECRET, bypass: process.env.AUTH_DEV_BYPASS, node: process.env.NODE_ENV };
  const secret = 'isolated-project-list-secret-'.repeat(2);
  process.env.GATEWAY_ASSERTION_SECRET = secret; process.env.AUTH_DEV_BYPASS = 'true'; process.env.NODE_ENV = 'development';
  try {
    const handler = () => {}; Reflect.defineMetadata(PERMISSION_KEY, 'user.manage', handler);
    const req: any = { headers: { 'x-tenant-id': 'tenant-a', 'x-gateway-assertion': signGatewayAssertion({ tenantId: 'tenant-a', environmentId: 'production', sub: 'tenant-admin', role: 'admin' }, secret) }, params: {}, body: { projectId: 'tenant-b' } };
    const context: any = { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req }) };
    const guard = new PermissionGuard();
    await assert.rejects(() => guard.canActivate(context), /cannot create another project/);
    req.body.projectId = 'tenant-a'; assert.equal(await guard.canActivate(context), true); assert.equal(req.projectAccess.platformAdmin, false);
    req.headers = {}; req.body = {};
    await assert.rejects(() => guard.canActivate(context), /requires the/);
  } finally {
    for (const [key,value] of [['GATEWAY_ASSERTION_SECRET',previous.secret],['AUTH_DEV_BYPASS',previous.bypass],['NODE_ENV',previous.node]]) { if (value === undefined) delete process.env[key!]; else process.env[key!]=value; }
  }
});
