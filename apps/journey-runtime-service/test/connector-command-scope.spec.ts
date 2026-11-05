import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, publishBusinessPack } from '@journeyax/business-pack';
import { CapabilityDispatcher, InProcessMcpTransport, McpClient, MemoryActionLedger } from '@journeyax/capability-sdk';
import { signScope, hashScopeArguments } from '@journeyax/jax-iq';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { RealConnectorServer } from '../../../packages/connectors-real/src/server';
import { ConnectorRuntime } from '../src/kernel/connector.runtime';
import { ApprovalService } from '../src/kernel/approval.service';
import { ApprovalStore } from '../src/approval/approval.store';

const secret = 'fixture-command-signing-key-over-32-characters';
const tenantId = 'placemakers'; const environmentId = 'production'; const connectionRef = 'fixture-connection';
const person: any = { audience: 'staff', groups: ['customer-service'] };
const context: any = { tenantId, environmentId, principalId: 'fixture-staff', principalRole: 'csr', principalGroups: person.groups, workspaceId: 'work-a', sessionId: 'work-a', stageId: 'agent', packVersionId: '1.0.0', correlationId: 'corr-a', idempotencyKey: 'command-a', actionId: 'action-a' };
const args = { ticketId: 7, status: 'pending', updatedStamp: '2026-11-02T00:00:00Z' };

async function setup() {
  const content: any = structuredClone(rawLegacyFixture);
  content.extensions = { ...content.extensions, connectors: { connectors: [{ connectorId: 'zendesk', displayName: 'Ticketing', description: 'Support actions', owner: 'Service', mcpServerName: 'support', connectionRef, tools: [{ name: 'update_ticket', sideEffect: 'write' }] }], policy: [{ connectorId: 'zendesk', tool: 'update_ticket', audience: 'staff', groups: person.groups, state: 'ask' }] } };
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  const db = new MemoryDb(); await publishBusinessPack(db as any, content);
  const pack = await new PackRepository(db as any).loadActivePack(tenantId, environmentId);
  let writes = 0;
  const source = new RealConnectorServer({ tenants: [tenantId], environmentId, connectionRef, commandScopeSecret: secret, apiKey: 'fixture-transport-key', connectors: [{ connectorId: 'zendesk', title: 'Ticketing', description: 'Fixture', required: [], missing: () => [], tools: [{ name: 'update_ticket', readOnly: false, staffOnly: true, description: 'Update', inputSchema: { type: 'object', properties: { ticketId: { type: 'integer' }, status: { type: 'string' }, updatedStamp: { type: 'string' } }, required: ['ticketId', 'status', 'updatedStamp'] }, run: async () => { writes++; return { record: { ticketId: 7, auditId: 42 } }; } }] }] });
  const exchanges: any[] = [];
  const request = async (message: any, meta: any) => {
    let status = 0; let payload: any;
    const req = { method: 'POST', url: '/mcp/zendesk', headers: { authorization: 'Bearer fixture-transport-key', 'x-tenant-id': meta.tenantId, 'x-environment-id': meta.environmentId, 'x-principal-id': meta.principalId, 'x-connection-ref': meta.connectionRef, 'x-caller-scope': meta.callerScope }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(message)); } };
    await (source as any).onRequest(req, { writeHead: (value: number) => { status = value; }, end: (value: string) => { payload = value ? JSON.parse(value) : undefined; } });
    exchanges.push({ message, meta, status });
    return { status, payload };
  };
  const client = new McpClient(new InProcessMcpTransport(async (message, meta) => (await request(message, meta)).payload), 'support');
  const pool: any = { getClient: async () => client };
  const dispatcher = new CapabilityDispatcher({ mcpClients: pool, actionLedger: new MemoryActionLedger(), validateConnectionOwnership: (tenant, env, ref) => tenant === tenantId && env === environmentId && ref === connectionRef });
  const runtime = new ConnectorRuntime({ dispatcher, mcpClients: pool });
  return { runtime, pack, request, exchanges, writes: () => writes, approvals: new ApprovalService(new ApprovalStore({ explicitMemory: true })) };
}

test('the real approval, dispatcher, MCP and source gates bind one command to the exact caller, arguments and release', async () => {
  const old = process.env.JAX_COMMAND_SIGNING_SECRET; process.env.JAX_COMMAND_SIGNING_SECRET = secret;
  try {
    const f = await setup();
    const waiting: any = await f.runtime.call(f.pack, person, context, 'zendesk', 'update_ticket', args, { approvals: f.approvals });
    assert.equal(waiting.status, 'needs_approval'); assert.equal(f.writes(), 0);
    assert.equal(await f.approvals.decide(tenantId, environmentId, 'work-a', waiting.approvalRequestId, 'approved', 'fixture-approver'), true);
    const result: any = await f.runtime.call(f.pack, person, context, 'zendesk', 'update_ticket', args, { approvals: f.approvals, approvalRequestId: waiting.approvalRequestId });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.record.auditId, 42); assert.equal(f.writes(), 1);
    const sent = f.exchanges.find(value => value.message.method === 'tools/call');
    assert.equal(sent.status, 200); assert.ok(sent.meta.callerScope);
    assert.equal((await f.request(sent.message, sent.meta)).status, 403, 'source rejects replay before vendor execution');
    const readGrant = JSON.parse(Buffer.from(sent.meta.callerScope.split('.')[0], 'base64url').toString());
    readGrant.operation = 'read'; readGrant.jti = 'new-jti';
    assert.equal((await f.request(sent.message, { ...sent.meta, callerScope: signScope(readGrant, secret).header })).status, 403, 'a read grant never authorises a write');
    assert.equal((await f.request({ ...sent.message, params: { ...sent.message.params, arguments: { ...args, status: 'solved' } } }, sent.meta)).status, 403);
    assert.equal((await f.request(sent.message, { ...sent.meta, tenantId: 'another-tenant' })).status, 403);
    assert.equal(f.writes(), 1);
    const unverified: any = await f.runtime.call({ ...f.pack }, person, context, 'zendesk', 'update_ticket', args, { confirmedByPerson: true });
    assert.equal(unverified.status, 'blocked'); assert.equal(f.writes(), 1);
  } finally { if (old === undefined) delete process.env.JAX_COMMAND_SIGNING_SECRET; else process.env.JAX_COMMAND_SIGNING_SECRET = old; }
});

test('a source without command authority refuses writes even with its transport key', async () => {
  const f = await setup();
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_ticket', arguments: args } };
  const metadata = { ...context, connectionRef };
  assert.equal((await f.request(message, metadata)).status, 403);
  const iat = Math.floor(Date.now() / 1000);
  const grant: any = { v: 2, operation: 'command', actionId: 'action-a', tenantId, environmentId, queryId: 'query-a', correlationId: 'corr-a', principal: { id: 'shopper-a', audience: 'shopper', groups: [] }, connectorId: 'zendesk', connectionRef, tool: 'update_ticket', toolState: 'allow', toolStateVia: 'tool', capRuleIds: [], argsHash: hashScopeArguments(args), fields: [], release: { version: '1.0.0', checksum: 'fixture' }, iat, exp: iat + 60, jti: 'shopper-command' };
  const rejected = await f.request(message, { ...metadata, principalId: 'shopper-a', callerScope: signScope(grant, secret).header });
  assert.equal(rejected.payload.error.code, -32003);
  assert.equal(f.writes(), 0);
});
