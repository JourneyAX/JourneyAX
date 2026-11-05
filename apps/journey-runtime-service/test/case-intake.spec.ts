import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { CaseIntakeStore, CaseIntakeProcessor, type IntakePolicy, type CaseScope } from '../src/desks/case-intake';
import { materializeCaseReview } from '../src/desks/case-review';
import { instructionsForCards, withPendingApprovals } from '../src/agent/card-instructions';
import { researchQueryAllowed } from '../src/agent/iq-tools';
import { readPending, createPendingConfirmation } from '../src/agent/confirmation';
import { recordCaseAction, projectCaseProgress } from '../src/desks/case-progress';

const scope: CaseScope = { tenantId: 'merchant-a', environmentId: 'test', deskId: 'care', releaseChecksum: 'release-a' };
const policy: IntakePolicy = { enabled: true, role: 'cs', groups: ['care'], startAt: '2026-11-03T12:00:00.000Z', updatedField: 'changed', statusField: 'state', statuses: ['new', 'open'], pollSeconds: 15, maxPagesPerPoll: 2, maxJobsPerPoll: 2, maxJobsPerHour: 3, maxAttempts: 2, resultTtlSeconds: 300 };
const record = (id = '42', changed = '2026-11-03T12:00:01.000Z', state = 'new') => ({ canonicalId: id, values: { changed, state } });
const page = (records: any[], more = false, nextCursor?: string) => ({ ok: true, status: more ? 'partial' : 'complete', records, page: { more, nextCursor } });
function setup() { let at = new Date('2026-11-03T12:01:00Z'); const db = new MemoryDb(); const store = new CaseIntakeStore(async () => db, () => at); return { db, store, processor: new CaseIntakeProcessor(store), advance: (ms: number) => { at = new Date(at.getTime() + ms); } }; }

test('a source arrival is researched without a UI, once across replicas and viewers, with revision/status scope', async () => {
  const { store, processor, advance } = setup(); let calls = 0;
  const ports = { page: async () => page([record(), record('old', '2026-11-02T00:00:00Z'), record('closed', undefined, 'closed')]), research: async () => { calls++; return { summary: 'The customer requested a phone correction. Both systems were researched; human review is needed.', proposals: [{ connector: 'crm', tool: 'correct_contact', arguments: { id: 'known-account', expectedVersion: 1, phone: '+64210000001' } }] }; } };
  await Promise.all([processor.tick(scope, policy, ports), new CaseIntakeProcessor(store).tick(scope, policy, ports)]);
  assert.equal(calls, 1); assert.equal((await store.latest(scope, '42'))?.status, 'waiting_for_approval');
  assert.equal(await store.latest(scope, 'old'), undefined); assert.equal(await store.latest(scope, 'closed'), undefined);
  advance(16000); await processor.tick(scope, policy, ports); assert.equal(calls, 1);
  advance(16000); await processor.tick(scope, policy, { ...ports, page: async () => page([record('42', '2026-11-03T12:01:20Z')]) }); assert.equal(calls, 2);
  for (const changed of [{ tenantId: 'other' }, { environmentId: 'production' }, { releaseChecksum: 'other' }, { deskId: 'other' }]) assert.equal(await store.latest({ ...scope, ...changed }, '42'), undefined);
});

test('paging checkpoints survive source failures; no false empty result or skipped ticket is recorded', async () => {
  const { store, processor, advance, db } = setup(); const cursors: any[] = []; let fail = true;
  const ports = { page: async (cursor?: string) => { cursors.push(cursor); if (!cursor) return page([record('first')], true, 'next'); if (fail) throw Error('source unavailable'); return page([record('second')]); }, research: async () => ({ summary: 'Researched', proposals: [] }) };
  await assert.rejects(() => processor.tick(scope, policy, ports), /source unavailable/);
  assert.equal((await store.latest(scope, 'first'))?.status, 'queued');
  const saved = await db.collection('case_intake_streams').findOne(scope); assert.equal(saved.cursor, 'next');
  fail = false; advance(16000); await processor.tick(scope, policy, ports);
  assert.equal(cursors.at(-1), 'next'); assert.equal((await store.latest(scope, 'second'))?.status, 'ready');
});

test('failed research is retried with backoff, rate counted for each attempt, then visible terminal failure', async () => {
  const { store, processor, advance, db } = setup(); let calls = 0;
  const ports = { page: async () => page([record()]), research: async () => { calls++; throw Error('model unavailable'); } };
  await processor.tick(scope, policy, ports); assert.equal(calls, 1); assert.equal((await store.latest(scope, '42'))?.status, 'queued');
  advance(16000); await processor.tick(scope, policy, ports); assert.equal(calls, 1);
  advance(31000); await processor.tick(scope, policy, ports); assert.equal(calls, 2); assert.equal((await store.latest(scope, '42'))?.status, 'failed');
  assert.equal(await db.collection('case_intake_attempts').countDocuments(scope), 2);
  advance(31000); await processor.tick(scope, policy, ports); assert.equal(calls, 2);
});

test('old workers cannot replace reclaimed results, expired work is withheld, and human review is a single scoped claim', async () => {
  const { store, advance } = setup(); const id = await store.enqueue(scope, '42', record().values.changed, policy);
  const first = await store.claim(scope, policy); assert.ok(first); advance(121000); const second = await store.claim(scope, policy); assert.ok(second);
  await assert.rejects(() => store.finish(first!, { summary: 'stale', proposals: [] }), /stale result/);
  await store.finish(second!, { summary: 'Current source research', proposals: [] });
  assert.equal(await store.claimReview(scope, id, 'human-a'), true); assert.equal(await store.claimReview(scope, id, 'human-b'), false);
  assert.equal(await store.read({ ...scope, tenantId: 'other' }, id), undefined);
  advance(301000); assert.equal(await store.read(scope, id), undefined);
});

test('hourly model-work cap blocks even new cases until the next window', async () => {
  const { processor, advance } = setup(); let calls = 0;
  const ports = { page: async () => page([record('a'), record('b'), record('c'), record('d')]), research: async () => { calls++; return { summary: 'Ready', proposals: [] }; } };
  await processor.tick(scope, policy, ports); assert.equal(calls, 2);
  advance(16000); await processor.tick(scope, policy, ports); assert.equal(calls, 3);
  advance(16000); await processor.tick(scope, policy, ports); assert.equal(calls, 3);
  await processor.tick({ ...scope, releaseChecksum: 'new-release' }, policy, ports); assert.equal(calls, 3, 'publication cannot reset the tenant hourly allowance');
});

test('a worker crash on its final attempt becomes a visible failure rather than researching forever', async () => {
  const { store, processor, advance } = setup();
  await store.enqueue(scope, '42', record().values.changed, policy);
  await store.claim(scope, policy); advance(121000); await store.claim(scope, policy); advance(121000);
  await processor.tick(scope, policy, { page: async () => page([]), research: async () => { throw Error('Exhausted jobs must not execute again'); } });
  assert.equal((await store.latest(scope, '42'))?.status, 'failed');
});

test('committed case outcomes project through the retryable outbox, with reviewer and scope enforced', async () => {
  const db = new MemoryDb();
  const store = new CaseIntakeStore(async () => db);
  const id = await store.enqueue(scope, '42', record().values.changed, policy);
  const job = await store.claim(scope, policy); assert.ok(job);
  await store.finish(job!, { summary: 'Both changes await approval', proposals: [] });
  await store.claimReview(scope, id, 'human-a');
  const workspace: any = { ...scope, workspaceId: 'private-review', pins: { packChecksum: scope.releaseChecksum }, facts: { case_review: { source: 'system', value: { caseId: id, deskId: scope.deskId, reviewer: 'human-a' } }, conversation_history: { value: [{ role: 'assistant', content: 'CRM changed. Commerce was declined; the case remains open.' }] } } };
  recordCaseAction(workspace, 'one', { connector: 'crm', tool: 'correct_contact' }, { ok: true, result: { record: { version: 3, phone: 'private-number' } } });
  recordCaseAction(workspace, 'two', { connector: 'commerce', tool: 'correct_contact' }, undefined, true);
  await db.collection('workspaces').insertOne(workspace);
  const event = { tenantId: scope.tenantId, environmentId: scope.environmentId, payload: { workspaceId: workspace.workspaceId } };
  await projectCaseProgress(db, { ...event, tenantId: 'other' }); assert.equal((await store.read(scope, id))?.progress, undefined);
  await projectCaseProgress(db, event); await projectCaseProgress(db, event);
  const progress: any = (await store.read(scope, id))?.progress;
  assert.deepEqual(progress.actions.map((action: any) => action.outcome), ['confirmed', 'declined']);
  assert.equal(progress.actions.length, 2); assert.equal(progress.actions[0].receipt.record.phone, undefined);
  assert.match(progress.summary, /remains open/);
});

test('human adoption creates their own exact review cards without model work or any connector write', async () => {
  let sourceWrites = 0; let toolLoads = 0;
  const auth: any = { ...scope, principalId: 'human-a', principalRole: 'cs', principalGroups: ['care'], isInternal: false };
  const workspace: any = { ...scope, workspaceId: 'private-human-workspace', pins: { packChecksum: scope.releaseChecksum }, facts: {} };
  const release: any = { manifest: { tenantId: scope.tenantId }, extensions: { connectors: { askVia: 'card', connectors: [] } } };
  const desk: any = { deskId: 'care', preparation: { proposalTools: [{ connector: 'crm', tool: 'correct_contact' }, { connector: 'commerce', tool: 'correct_contact' }] } };
  const connectorRuntime: any = { loadTools: async (_r: any, _p: any, _c: any, connector: string) => { toolLoads++; return { ok: true, name: connector, tools: [{ name: 'correct_contact', changesData: true, inputSchema: { type: 'object', required: ['recordId', 'expectedVersion', 'phone'], properties: { recordId: { type: 'string' }, expectedVersion: { type: 'integer' }, phone: { type: 'string' } }, additionalProperties: false } }] }; }, call: async () => { sourceWrites++; throw Error('Must never execute during review'); } };
  const assessment: any = { ...scope, _id: 'a'.repeat(64), recordId: '42', sourceUpdatedAt: record().values.changed, summary: 'The requested phone change is prepared for both systems. Neither has changed. A customer reply remains a draft.', proposals: ['crm', 'commerce'].map(connector => ({ connector, tool: 'correct_contact', arguments: { recordId: 'verified-account', expectedVersion: 2, phone: '+64210000001' } })) };
  const result = await materializeCaseReview({ auth, workspace, release, desk, assessment, connectorRuntime });
  assert.equal(sourceWrites, 0); assert.equal(toolLoads, 2); assert.equal(result.cards.length, 2);
  assert.equal(readPending(workspace).every(entry => entry.principalId === 'human-a'), true);
  assert.deepEqual(JSON.parse(result.cards[0].state.reviewPayload as string), assessment.proposals[0]);
  await assert.rejects(() => materializeCaseReview({ auth: { ...auth, tenantId: 'other' }, workspace, release, desk, assessment, connectorRuntime }), /scope/);
});

test('automatic research cannot read a different private ticket or traverse the backlog', () => {
  const subject = { thing: 'SupportRequest', canonicalId: '42', sourceSystem: 'support-source' };
  const ontology = { links: [{ link: 'Queue.requests', to: 'SupportRequest' }] };
  assert.equal(researchQueryAllowed({ operation: 'get', subject: { thing: 'SupportRequest', canonicalId: '42' } }, ontology, subject), true);
  assert.equal(researchQueryAllowed({ operation: 'get', subject: { thing: 'SupportRequest', canonicalId: '43' } }, ontology, subject), false);
  assert.equal(researchQueryAllowed({ operation: 'find', thing: 'SupportRequest', query: 'anything' }, ontology, subject), false);
  assert.equal(researchQueryAllowed({ operation: 'related', subject: { thing: 'Queue', canonicalId: 'all' }, link: 'Queue.requests' }, ontology, subject), false);
  assert.equal(researchQueryAllowed({ operation: 'get', subject: { thing: 'Order', canonicalId: 'known-reference' } }, ontology, subject), true);
});

test('two source approvals remain two distinct cards across live and final SSE events', () => {
  const cards = [{ cardType: 'confirm', state: { confirmationId: 'crm-action' } }, { cardType: 'confirm', state: { confirmationId: 'commerce-action' } }];
  const instructions = instructionsForCards(cards, 'same-turn');
  assert.deepEqual(instructions.map(item => item.actionId), ['confirm-crm-action', 'confirm-commerce-action']);
  assert.equal(new Set(instructions.map(item => item.actionId)).size, 2);
  assert.deepEqual(instructions.map(item => item.envelope!.arguments.card.id), instructions.map(item => item.actionId));
  assert.deepEqual(instructionsForCards(cards, 'same-turn'), instructions);
});

test('a reply without tool calls restores all live approvals for this person only, without creating actions', () => {
 const workspace: any = { facts: {} };
 for (const [person, id] of [['human-a', 'crm'], ['human-a', 'commerce'], ['other', 'unrelated']]) createPendingConfirmation(workspace, { toolId: 'call_connector_tool', principalId: person, args: { connector: id }, summary: 'Exact action' });
 const before = readPending(workspace).length;
 const cards = withPendingApprovals([], workspace, 'human-a');
 assert.equal(cards.length, 2); assert.equal(readPending(workspace).length, before);
 assert.equal(withPendingApprovals(cards, workspace, 'human-a').length, 2);
 assert.equal(withPendingApprovals([], workspace, 'human-a', Date.now()+86400000).length, 0);
});
