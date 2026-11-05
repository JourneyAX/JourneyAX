import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { ProjectService } from '../src/project.service';
import { ProjectController } from '../src/project.controller';

async function fixture() {
  const db = new MemoryDb();
  await db.collection('tenant_configs').insertOne({ projectId: 'tenant-a', activeVersion: 1, environmentVersions: { test: { version: 2 } }, companyName: 'Mutable draft' });
  await db.collection('config_versions').insertOne({ projectId: 'tenant-a', version: 1, config: { projectId: 'tenant-a', companyName: 'Production snapshot' } });
  await db.collection('config_versions').insertOne({ projectId: 'tenant-a', version: 2, environmentId: 'test', config: { projectId: 'tenant-a', companyName: 'Test snapshot', ai: { apiKey: 'isolated-fixture-value' } } });
  const projectService = new ProjectService(); projectService.setDbForTesting(db);
  return { db, projectService };
}
test('each deployment reads its own published snapshot without changing the production pointer', async () => {
  const { projectService } = await fixture();
  assert.equal((await projectService.getPublishedConfig('tenant-a'))?.companyName, 'Production snapshot');
  assert.equal((await projectService.getPublishedConfig('tenant-a', 'test'))?.companyName, 'Test snapshot');
  assert.equal(await projectService.getPublishedConfig('tenant-a', 'staging'), null);
});
test('a wrong-environment pointer never falls back to the production snapshot or mutable draft', async () => {
  const { db, projectService } = await fixture();
  await db.collection('tenant_configs').updateOne({ projectId: 'tenant-a' }, { $set: { environmentVersions: { test: { version: 1 } } } });
  assert.equal(await projectService.getPublishedConfig('tenant-a', 'test'), null);
});
test('non-production snapshots require deployment authority and remain redacted', async () => {
  const { projectService } = await fixture();
  process.env.INTERNAL_API_KEY = 'isolated-deployment-fixture';
  const read = ProjectController.prototype.getPublished.bind({ projectService });
  await assert.rejects(() => read('tenant-a', undefined, 'test'), /verified deployment/);
  const snapshot = await read('tenant-a', process.env.INTERNAL_API_KEY, 'test');
  assert.equal(snapshot.companyName, 'Test snapshot');
  assert.equal(snapshot.ai?.apiKey, undefined);
  await assert.rejects(() => read('tenant-a', process.env.INTERNAL_API_KEY, 'not-an-environment'), /Unsupported/);
  delete process.env.INTERNAL_API_KEY;
});

test('anonymous published branding excludes credential headers recursively without altering the frozen snapshot', async () => {
  const { db, projectService } = await fixture();
  const extra = { headers: { Authorization: 'Bearer isolated-header-secret', 'Proxy-Authorization': ['Basic isolated-proxy-secret'], Cookie: 'session=isolated-cookie', 'Set-Cookie': ['isolated-response-secret'], 'X-Public': 'safe' }, connectionRef: 'tenant-connection://tenant-a/source', secretRef: 'tenant-secret://tenant-a/dev/source' };
  await db.collection('config_versions').updateOne({ projectId: 'tenant-a', version: 1 }, { $set: { 'config.extensions': { legacy: [extra] } } });
  const before = JSON.stringify(await db.collection('config_versions').findOne({ projectId: 'tenant-a', version: 1 }));
  const read = ProjectController.prototype.getPublished.bind({ projectService });
  const result = await read('tenant-a');
  const legacy = (result as any).extensions.legacy[0];
  assert.equal(result.companyName, 'Production snapshot');
  assert.doesNotMatch(JSON.stringify(result), /isolated-(?:header|proxy|cookie|response)-secret/);
  assert.deepEqual(legacy.headers, { AuthorizationConfigured: true, 'Proxy-AuthorizationConfigured': true, CookieConfigured: true, 'Set-CookieConfigured': true, 'X-Public': 'safe' });
  assert.equal(legacy.connectionRef, extra.connectionRef); assert.equal(legacy.secretRef, extra.secretRef);
  assert.equal(JSON.stringify(await db.collection('config_versions').findOne({ projectId: 'tenant-a', version: 1 })), before);
});
