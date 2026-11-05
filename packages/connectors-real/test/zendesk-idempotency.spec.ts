import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { zendesk } from '../src/connectors/zendesk';
import type { ToolExecutionContext } from '../src/types';

const args = { subject: 'Owned support request', description: 'Please review the selected product.', requesterEmail: 'owner@example.test' };
const execution: ToolExecutionContext = { tenantId: 'fixture', environmentId: 'test', principalId: args.requesterEmail, actionId: 'approved-action', releaseChecksum: 'verified-release' };
const env = { ZENDESK_SUBDOMAIN: 'fixture', ZENDESK_EMAIL: 'agent@example.test', ZENDESK_API_TOKEN: 'fixture-token-not-real' };

test('ticket creation uses the same source idempotency key on concurrent replay and a lost response', async () => {
  const source = new Map<string, { body: string; ticket: any }>(); let created = 0, lost = true;
  const tool = zendesk(env, { now: Date.now, fetchImpl: (async (url, request) => {
    assert.equal(String(url), 'https://fixture.zendesk.com/api/v2/tickets.json');
    const key = new Headers(request?.headers).get('Idempotency-Key'); assert.match(key || '', /^[a-f0-9]{64}$/);
    const body = String(request?.body), prior = source.get(key!);
    if (prior && prior.body !== body) return Response.json({ error: 'IdempotentRequestError' }, { status: 400 });
    const row = prior ?? { body, ticket: { id: ++created, subject: args.subject, status: 'open' } }; source.set(key!, row);
    if (lost) { lost = false; throw new Error('response lost after creation'); }
    return Response.json({ ticket: row.ticket }, { status: 201 });
  }) as typeof fetch }).tools.find(t => t.name === 'create_ticket')!;
  await assert.rejects(() => tool.run(args, execution), /could not be reached/);
  const [first, second] = await Promise.all([tool.run(args, execution), tool.run(args, execution)]);
  assert.equal(created, 1); assert.equal(first.record.ticketId, second.record.ticketId);
  await assert.rejects(() => tool.run({ ...args, description: 'A changed request' }, execution), /rejected/);
  assert.equal(created, 1);
});

test('ticket creation keys are isolated by tenant, environment, principal and approved action', async () => {
  const keys: string[] = [];
  const tool = zendesk(env, { now: Date.now, fetchImpl: (async (_url, request) => { keys.push(new Headers(request?.headers).get('Idempotency-Key')!); return Response.json({ ticket: { id: keys.length, status: 'open' } }); }) as typeof fetch }).tools.find(t => t.name === 'create_ticket')!;
  for (const scope of [execution, { ...execution, tenantId: 'another' }, { ...execution, environmentId: 'dev' }, { ...execution, principalId: 'another@example.test' }, { ...execution, actionId: 'another-action' }]) await tool.run(args, scope);
  assert.equal(new Set(keys).size, keys.length);
});

test('model arguments cannot supply a missing server action identity', async () => {
  let called = false;
  const tool = zendesk(env, { now: Date.now, fetchImpl: (async () => { called = true; throw new Error('must not call'); }) as typeof fetch }).tools.find(t => t.name === 'create_ticket')!;
  await assert.rejects(() => tool.run({ ...args, actionId: 'forged', idempotencyKey: 'forged' }), /verified scoped action/);
  assert.equal(called, false);
});
