import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { DeskPreparationStore } from '../src/desks/desk-preparation';
import { executeAgentTool } from '../src/agent/agent-tools';
import { readPending } from '../src/agent/confirmation';

const input = { tenantId: 'merchant-a', environmentId: 'test', principalId: 'staff-a', deskId: 'service', recordId: '42', releaseChecksum: 'release-a', sourceRevision: { updated: '2026-11-02T00:00:00Z' }, sessionId: 'private-session-a' };
test('duplicate visible-ticket requests run one investigation, persist its review and isolate people, tenants, environments and revisions', async () => {
  const db = new MemoryDb(); const store = new DeskPreparationStore(async () => db);
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; }); let calls = 0;
  const run = async () => { calls++; await waiting; return { summary: 'The recorded phone change needs human review.', cards: [{ cardType: 'confirm', state: { confirmationId: 'cf_1' } }] }; };
  const first = store.prepare(input, run);
  // Let the first request claim its record before the replica arrives.
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = await store.prepare(input, run); assert.equal(duplicate.status, 'preparing');
  finish(); assert.equal((await first).status, 'waiting_for_approval');
  const restored = await new DeskPreparationStore(async () => db).prepare(input, run);
  assert.equal(restored.status, 'waiting_for_approval'); assert.equal(calls, 1);
  const { sourceRevision, ...scope } = input;
  assert.equal((await store.read(scope, restored.workId))?.summary, restored.summary);
  for (const change of [{ principalId: 'staff-b' }, { environmentId: 'staging' }, { tenantId: 'merchant-b' }, { releaseChecksum: 'another-release' }, { recordId: 'another-record' }]) assert.equal(await store.read({ ...scope, ...change }, restored.workId), undefined);
  for (const scope of [{ principalId: 'staff-b' }, { tenantId: 'merchant-b' }, { environmentId: 'staging' }, { releaseChecksum: 'release-b' }, { sourceRevision: { updated: '2026-11-03T00:00:00Z' } }]) await store.prepare({ ...input, ...scope }, run);
  assert.equal(calls, 6);
});

test('failed preparation is visible and never called a completed resolution', async () => {
  const store = new DeskPreparationStore(async () => new MemoryDb());
  assert.equal((await store.prepare(input, async () => { throw new Error('source unavailable'); })).status, 'failed');
});

test('read-only research can keep an exact permitted proposal, but cannot execute it or prepare an unlisted customer message', async () => {
  let writes = 0;
  const ctx: any = { release: { capabilities: { toolDefinitions: [], toolBindings: [] }, extensions: {} }, tenantId: input.tenantId, environmentId: 'test', principalId: 'staff-a', principal: { audience: 'staff', groups: ['service'] }, readOnly: true, proposalTools: [{ connector: 'crm', tool: 'correct_contact' }], workspace: { facts: {} }, presentedCards: [], allowedClaimClasses: new Set(), connectorRuntime: { summaries: () => [{ connector: 'crm' }], loadTools: async () => ({ ok: true, name: 'CRM', tools: [{ name: 'correct_contact', changesData: true, inputSchema: { type: 'object', required: ['phone', 'expectedVersion'], properties: { phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' }, expectedVersion: { type: 'integer', minimum: 1 } }, additionalProperties: false } }, { name: 'send_message', changesData: true }] }), call: async () => { writes++; return { ok: true }; } } };
  const args = { connector: 'crm', tool: 'correct_contact', arguments: { phone: '+64210000001', expectedVersion: 2 } };
  const invalid = await executeAgentTool('propose_connector_action', { ...args, arguments: { phone: '+64210000001', version: 2 } }, ctx);
  assert.equal(invalid.code, 'invalid_arguments'); assert.equal(readPending(ctx.workspace).length, 0); assert.equal(ctx.presentedCards.length, 0); assert.equal(writes, 0);
  const result = await executeAgentTool('propose_connector_action', args, ctx);
  assert.equal(result.status, 'needs_confirmation'); assert.equal(writes, 0);
  assert.equal(readPending(ctx.workspace)[0].toolId, 'call_connector_tool');
  assert.deepEqual(readPending(ctx.workspace)[0].args, args);
  assert.equal(ctx.presentedCards[0].cardType, 'confirm');
  const blocked = await executeAgentTool('propose_connector_action', { ...args, tool: 'send_message' }, ctx);
  assert.equal(blocked.code, 'proposal_not_permitted'); assert.equal(readPending(ctx.workspace).length, 1);
  const direct = await executeAgentTool('call_connector_tool', args, ctx, { confirmed: true });
  assert.equal(direct.code, 'read_only_session'); assert.equal(writes, 0);
  ctx.readOnly = false;
  ctx.release.extensions.connectors = { askVia: 'card', connectors: [] };
  ctx.connectorRuntime.call = async () => ({ ok: false, status: 'needs_approval' });
  const badDirect = await executeAgentTool('call_connector_tool', { ...args, arguments: { phone: '+64210000001', version: 2 } }, ctx);
  assert.equal(badDirect.code, 'invalid_arguments'); assert.equal(readPending(ctx.workspace).length, 1); assert.equal(ctx.presentedCards.length, 1);
  ctx.principal.audience = 'shopper';
  assert.equal((await executeAgentTool('propose_connector_action', args, ctx)).code, 'not_allowed');
});
