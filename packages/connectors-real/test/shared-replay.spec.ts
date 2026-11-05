import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { MongoReplayStore, COLLECTION_GATEWAY_ASSERTION_NONCES } from '@journeyax/database';
import { signScope, hashScopeArguments } from '@journeyax/jax-iq';
import { RealConnectorServer } from '../src/server';

const secret = 'offline-shared-source-replay-authority-'.repeat(2);
const tenantId = 'tenant-a'; const environmentId = 'test'; const connectionRef = 'connection-a';
const args = { id: 'record-a' };
const grant = (jti: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return signScope({ v: 2, operation: 'command', actionId: 'action-a', tenantId, environmentId, queryId: 'query-a', correlationId: 'trace-a', principal: { id: 'staff-a', audience: 'staff', groups: ['service'] }, connectorId: 'vendor', connectionRef, tool: 'update', toolState: 'allow', toolStateVia: 'tool', capRuleIds: [], argsHash: hashScopeArguments(args), fields: [], release: { version: '1.0.0', checksum: 'fixture' }, iat, exp: iat + 60, jti }, secret).header;
};
async function request(server: RealConnectorServer, token: string, principalId = 'staff-a') {
  let status = 0; let body: any;
  const req = { method: 'POST', url: '/mcp/vendor', headers: { authorization: 'Bearer fixture-key', 'x-tenant-id': tenantId, 'x-environment-id': environmentId, 'x-connection-ref': connectionRef, 'x-principal-id': principalId, 'x-caller-scope': token }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update', arguments: args } })); } };
  await (server as any).onRequest(req, { writeHead: (value: number) => { status = value; }, end: (value: string) => { body = value ? JSON.parse(value) : undefined; } });
  return { status, body };
}
function server(replayStore: any, executed: () => void) {
  return new RealConnectorServer({ tenants: [tenantId], environmentId, connectionRef, commandScopeSecret: secret, apiKey: 'fixture-key', replayStore, connectors: [{ connectorId: 'vendor', title: 'Vendor', description: 'Offline command source', required: [], missing: () => [], tools: [{ name: 'update', readOnly: false, staffOnly: true, description: 'Fixture update', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, run: async () => { executed(); return { record: { id: 'record-a' } }; } }] }] });
}

test('two source replicas and a restart share one atomic nonce claim through the existing Mongo replay repository', async () => {
  const db = new MemoryDb();
  await db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES).createIndex({ jti: 1 }, { unique: true });
  const store = () => new MongoReplayStore(async () => ({ db: db as any }));
  let executed = 0; const token = grant('nonce-a');
  const answers = await Promise.all([request(server(store(), () => executed++), token), request(server(store(), () => executed++), token)]);
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 403]); assert.equal(executed, 1);
  assert.equal((await request(server(store(), () => executed++), token)).status, 403);
  assert.equal(executed, 1); assert.equal(db.dump(COLLECTION_GATEWAY_ASSERTION_NONCES).length, 1);
});

test('identity mismatches do not spend a valid scope and a shared-store outage never falls back to memory execution', async () => {
  const db = new MemoryDb(); await db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES).createIndex({ jti: 1 }, { unique: true });
  const store = new MongoReplayStore(async () => ({ db: db as any })); let executed = 0;
  const source = server(store, () => executed++); const token = grant('nonce-b');
  assert.equal((await request(source, token, 'another-staff')).status, 403);
  assert.equal(db.dump(COLLECTION_GATEWAY_ASSERTION_NONCES).length, 0);
  assert.equal((await request(source, token)).status, 200); assert.equal(executed, 1);
  const unavailable = server({ claim: async () => { throw new Error('storage unavailable'); } }, () => executed++);
  assert.equal((await request(unavailable, grant('nonce-c'))).status, 503); assert.equal(executed, 1);
});

test('signed production sources refuse process-local replay state', () => {
  const before = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.throws(() => server(undefined, () => {}), /shared replay/); }
  finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});
