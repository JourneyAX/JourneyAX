import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signScope, verifyScope, hashScopeArguments, MemoryJtiStore, type CallScope } from '../../jax-iq/src/scope';
import { RealConnectorServer, scopedAnswer } from '../src/server';
import { EnvSecretResolver, connectorSecretVariable } from '../../capability-sdk/src/mcp/secrets';

const secret = 'fixture-only-signing-secret-at-least-32';
const now = new Date(); const iat = Math.floor(now.getTime() / 1000);
const grant: CallScope = { v: 2, tenantId: 'tenant-a', environmentId: 'test', queryId: 'query-a', correlationId: 'corr-a', principal: { id: 'customer-a', audience: 'shopper', groups: [] }, connectorId: 'erp', connectionRef: 'connection-a', tool: 'get_account', toolState: 'allow', toolStateVia: 'tool', capRuleIds: [], argsHash: hashScopeArguments({ account: 'a' }), fields: ['record.balance'], release: { version: '1.0.0', checksum: 'fixture' }, iat, exp: iat + 60, jti: 'fixture-jti' };
const verify = (header: string, over: any = {}) => verifyScope(header, { secret, now, method: 'tools/call', tenantHeader: 'tenant-a', environmentHeader: 'test', connectorId: 'erp', connectionRef: 'connection-a', toolName: 'get_account', argsHash: hashScopeArguments({ account: 'a' }), seen: new MemoryJtiStore(), ...over });
test('customer source grants bind connection, identity envelope, arguments and release and cannot replay', () => {
  const header = signScope(grant, secret).header;
  const seen = new MemoryJtiStore();
  assert.equal(verify(header, { seen }).ok, true);
  assert.equal(verify(header, { seen }).ok, false);
  for (const over of [{ tenantHeader: 'tenant-b' }, { environmentHeader: 'production' }, { connectionRef: 'connection-b' }, { argsHash: hashScopeArguments({ account: 'b' }) }, { now: new Date((iat + 61) * 1000) }]) assert.equal(verify(header, over).ok, false);
  assert.throws(() => signScope({ ...grant, v: 1 }, secret));
});
test('source projection drops internal and prototype fields and preserves explicit sample provenance', () => {
  assert.deepEqual(scopedAnswer({ ok: true, sample: true, record: { balance: 20, internalNotes: 'private' } }, ['record.balance', '__proto__.polluted']), { ok: true, sample: true, record: { balance: 20 } });
});
test('a scoped connector refuses ungranted reads before touching the vendor', async () => {
  let calls = 0;
  const server = new RealConnectorServer({ tenants: ['tenant-a'], environmentId: 'test', connectionRef: 'connection-a', iqScopeSecret: secret, connectors: [{ connectorId: 'erp', title: 'ERP', description: 'ERP', required: [], missing: () => [], tools: [{ name: 'get_account', readOnly: true, description: 'Read', inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] }, run: async () => { calls++; return { record: { balance: 20, internal: 'private' } }; } }] }] });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_account', arguments: { account: 'a' } } };
  assert.ok((await server.handle('erp', request))?.error); assert.equal(calls, 0);
  assert.deepEqual((await server.handle('erp', request, grant))?.result.structuredContent, { ok: true, record: { balance: 20 } }); assert.equal(calls, 1);
  assert.throws(() => new RealConnectorServer({ tenants: ['tenant-a', 'tenant-b'], connectors: [] }));
});
test('same-named secret references are isolated by their complete tenant/environment reference', async () => {
  const a = 'tenant-secret://tenant-a/test/vendor'; const b = 'tenant-secret://tenant-b/test/vendor';
  const resolver = new EnvSecretResolver({ [connectorSecretVariable(a)]: 'fixture-a', CONNECTOR_SECRET_VENDOR: 'unsafe-shared' });
  assert.equal(await resolver.resolve(a, { tenantId: 'tenant-a', environmentId: 'test' }), 'fixture-a');
  await assert.rejects(() => resolver.resolve(b, { tenantId: 'tenant-b', environmentId: 'test' }));
  await assert.rejects(() => resolver.resolve(a, { tenantId: 'tenant-b', environmentId: 'test' }));
});
