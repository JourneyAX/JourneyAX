import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IqQueryEngine, JaxOntologyReleaseSchema, MemoryKeyRepository, type KeyRow } from '../../jax-iq/src';
import { ConnectorsSchema } from '@journeyax/business-pack';
import { zendesk } from '../src/connectors/zendesk';

test('zendesk-ticket-read: actual adapter output satisfies the IQ fact and numeric-key bindings, including paged comments', async () => {
  const ontology = JaxOntologyReleaseSchema.parse(JSON.parse(readFileSync(resolve(__dirname, '../../../docs/integration-contracts/zendesk/tickets.json'), 'utf8')));
  ontology.permissionRules = [{ ruleId: 'read', mode: 'see', target: { thing: 'Ticket', facts: ontology.facts.map(fact => fact.fact) }, who: [{ audience: 'staff', groups: ['support'] }] }];
  const connector = zendesk({ ZENDESK_API_URL: 'https://vendor.test', ZENDESK_EMAIL: 'staff@example.test', ZENDESK_API_TOKEN: 'fixture-only' }, { now: () => Date.now(), fetchImpl: async (url) => {
    const address = new URL(String(url));
    if (address.pathname === '/api/v2/tickets/123.json') return Response.json({ ticket: { id: 123, subject: 'Source subject', status: 'open', requester_id: 7, created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T11:00:00Z' } });
    if (address.pathname === '/api/v2/tickets/123/comments.json') {
      const second = address.searchParams.get('page[after]') === 'cursor-1';
      return Response.json({ comments: [{ id: second ? 2 : 1, author_id: 7, public: !second, plain_body: second ? 'Internal note' : 'Customer message', created_at: '2026-11-02T10:00:00Z' }], meta: { has_more: !second, after_cursor: second ? 'cursor-2' : 'cursor-1' } });
    }
    if (address.pathname === '/api/v2/users/show_many.json') return Response.json({ users: [{ id: 7, name: 'Fixture requester', email: 'fixture@example.test' }] });
    throw new Error('Unexpected source request.');
  } });
  const connectors = ConnectorsSchema.parse({ connectors: [{ connectorId: 'zendesk', displayName: 'Zendesk', description: 'Tickets', owner: 'Support', tools: [{ name: 'get_ticket', sideEffect: 'read' }] }], policy: [{ connectorId: 'zendesk', tool: 'get_ticket', audience: 'staff', groups: ['support'], state: 'allow' }] });
  const keys = new MemoryKeyRepository();
  const at = new Date().toISOString();
  const row: KeyRow = { tenantId: 'tenant-a', environmentId: 'test', thing: 'Ticket', canonicalId: '123', system: 'zendesk', keyKind: 'ticket_id', systemKey: '123', status: 'matched', role: 'primary', evidence: 'real_field', firstSeenAt: at, lastVerifiedAt: at, builtBy: { runId: 'contract', releaseVersion: '1', releaseChecksum: 'fixture' } };
  assert.equal((await keys.upsertMany([row])).ok, true);
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ version: '1', checksum: 'fixture', ontology, connectors }) }, reader: { read: async call => {
    calls.push(call.args);
    const data = await connector.tools.find(tool => tool.name === call.tool)!.run(call.args);
    return { ok: true, data, truncated: false, incomplete: data.more === true, bytes: 100 };
  } } });
  const ctx: any = { tenantId: 'tenant-a', environmentId: 'test', queryId: 'contract-read', correlationId: 'contract-read', release: { version: '1', checksum: 'fixture' }, principal: { id: 'staff', audience: 'staff', groups: ['support'], subjects: [] } };
  const first = await engine.query({ operation: 'get', subject: { thing: 'Ticket', canonicalId: '123' }, facts: ['Ticket.subject', 'Ticket.status', 'Ticket.conversation', 'Ticket.more', 'Ticket.nextCursor'] }, ctx);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.status, 'partial');
  assert.equal(first.records[0].facts.find(fact => fact.fact === 'Ticket.nextCursor')?.value, 'cursor-1');
  assert.equal(calls[0].ticketId, 123);
  const next = await engine.query({ operation: 'get', subject: { thing: 'Ticket', canonicalId: '123' }, filters: { afterCursor: 'cursor-1' } }, ctx);
  assert.equal(next.ok && next.status, 'complete');
  assert.equal(calls[1].afterCursor, 'cursor-1');
  assert.equal(next.ok && next.records[0].facts.find(fact => fact.fact === 'Ticket.more')?.value, false);
});
