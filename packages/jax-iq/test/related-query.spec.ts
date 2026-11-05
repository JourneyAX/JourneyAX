import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IqQueryEngine, MemoryKeyRepository, relationshipPath, validIqResponse } from '../src';
import { minimalDictionary } from './fixtures/minimal.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';

const scope = { tenantId: 'tenant-a', environmentId: 'test' as const };
const context: any = { ...scope, queryId: 'query-a', correlationId: 'trace-a', release: { version: '1', checksum: 'abc' }, principal: { id: 'staff-a', audience: 'staff', groups: ['sales'], subjects: [] } };
async function fixture(options: { paging?: boolean; invalidPage?: boolean; numericLookup?: boolean; rowProjection?: boolean; parentIdentity?: boolean; wrongParentIdentity?: boolean } = {}) {
  const ontology: any = structuredClone(minimalDictionary);
  for (const [thing, keyKind, system, labelFact] of [['Order', 'order_number', 'ace-erp', 'Order.name'], ['Ticket', 'ticket_number', 'zendesk', 'Ticket.subject']]) {
    ontology.things.push({ thing, meaning: `${thing} records.`, aliases: [], group: 'Operations', status: 'active', key: { canonical: keyKind, pattern: '.+' }, keyKinds: [{ kind: keyKind, system, evidence: 'real_field', caseRule: 'as_is', ready: true }, ...(thing === 'Order' ? [{ kind: keyKind, system: 'zendesk', evidence: 'real_field', caseRule: 'as_is', ready: true }] : [])], labelFact, searchFacts: [labelFact], defaultFacts: [labelFact], expectedIn: [system] });
    ontology.facts.push({ fact: labelFact, thing, label: 'Label', meaning: 'Source label.', type: 'text', freshnessKind: 'reference', allowStale: true });
  }
  ontology.links = [{ link: 'Account.orders', from: 'Account', to: 'Order', meaning: 'Account orders.', cardinality: '1:n' }, { link: 'Order.tickets', from: 'Order', to: 'Ticket', meaning: 'Tickets linked by order.', cardinality: '1:n' }, { link: 'Account.tickets', from: 'Account', to: 'Ticket', meaning: 'Tickets about this account’s orders.', cardinality: '1:n', via: ['Account.orders', 'Order.tickets'] }];
  const base = ontology.bindings[0];
  ontology.bindings.push({ ...base, bindingId: 'Order.name@ace-erp.get_order', target: { kind: 'fact', fact: 'Order.name' }, tool: 'get_order', args: { orderId: { from: 'key', kind: 'order_number' } }, select: 'record.name' },
    { ...base, bindingId: 'Ticket.subject@zendesk.get_ticket', target: { kind: 'fact', fact: 'Ticket.subject' }, system: 'zendesk', tool: 'get_ticket', args: { ticketId: { from: 'key', kind: 'ticket_number', valueType: 'integer' } }, select: 'record.subject' },
    { ...base, bindingId: 'Account.orders@ace-erp.list_orders', target: { kind: 'link', link: 'Account.orders' }, tool: 'list_orders', rows: { path: 'records', keyField: 'orderId', keyKind: 'order_number' }, select: 'records' },
    { ...base, bindingId: 'Order.tickets@zendesk.order_tickets', target: { kind: 'link', link: 'Order.tickets' }, system: 'zendesk', tool: 'order_tickets', args: { orderId: { from: 'key', kind: 'order_number' } }, rows: { path: 'records', keyField: 'ticketId', keyKind: 'ticket_number' }, select: 'records' });
  ontology.permissionRules = ontology.things.map((thing: any) => ({ ruleId: `read-${thing.thing}`, mode: 'see', target: { thing: thing.thing, facts: [thing.labelFact] }, who: [{ audience: 'staff', groups: ['sales'] }] }));
  if (options.paging) {
    const binding = ontology.bindings.find((entry: any) => entry.bindingId === 'Order.tickets@zendesk.order_tickets');
    binding.page = { morePath: 'more', nextCursorPath: 'nextCursor', cursorParam: 'afterCursor' };
    binding.args.afterCursor = { from: 'request', param: 'afterCursor', optional: true };
  }
  if (options.rowProjection) ontology.bindings.find((entry: any) => entry.bindingId === 'Order.tickets@zendesk.order_tickets').rows.factFields = { 'Ticket.subject': 'subject' };
  if (options.parentIdentity) ontology.bindings.find((entry: any) => entry.bindingId === 'Account.orders@ace-erp.list_orders').identity = { keyKind: 'account_number', select: 'record.accountNumber' };
  if (options.numericLookup) ontology.things.find((thing: any) => thing.thing === 'Ticket').lookups = [{ system: 'zendesk', tool: 'order_tickets', queryArg: 'query', rows: 'records', keyField: 'ticketId', keyKind: 'ticket_number', labelField: 'subject' }];
  ontology.customerAccess = ontology.things.map((thing: any) => ({ thing: thing.thing, facts: [thing.labelFact], links: ontology.links.filter((link: any) => link.from === thing.thing).map((link: any) => link.link) }));
  const connectors: any = structuredClone(connectorsFixture);
  for (const [system, tool] of [['ace-erp', 'list_orders'], ['ace-erp', 'get_order'], ['zendesk', 'order_tickets'], ['zendesk', 'get_ticket']]) {
    const connector = connectors.connectors.find((entry: any) => entry.connectorId === system);
    if (!connector.tools.some((entry: any) => entry.name === tool)) connector.tools.push({ name: tool, sideEffect: 'read' });
    connectors.policy.push({ connectorId: system, tool, audience: 'staff', groups: ['sales'], state: 'allow' }, { connectorId: system, tool, audience: 'shopper', groups: [], state: 'allow' });
  }
  const keys = new MemoryKeyRepository();
  for (const [thing, canonicalId, system, keyKind, systemKey] of [['Account', 'ACC-0001', 'ace-erp', 'account_number', 'ACC-0001'], ['Order', 'ORD-1', 'ace-erp', 'order_number', 'ORD-1'], ['Order', 'ORD-1', 'zendesk', 'order_number', 'ZD-ORDER-1'], ['Ticket', 'T-7', 'zendesk', 'ticket_number', '7']]) await keys.upsertMany([{ ...scope, thing, canonicalId, system, keyKind, systemKey, status: 'matched', role: 'primary', evidence: 'real_field', firstSeenAt: '2026-11-01T00:00:00Z', lastVerifiedAt: '2026-11-01T00:00:00Z', builtBy: { runId: 'offline', releaseVersion: '1', releaseChecksum: 'abc' } }]);
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ version: '1', checksum: 'abc', ontology, connectors }) }, reader: { read: async call => {
    calls.push(call);
    if (call.tool === 'list_orders') { assert.equal(call.args.accountId, 'ACC-0001'); return { ok: true, truncated: false, bytes: 100, data: { records: [{ orderId: 'ORD-1' }], ...(options.parentIdentity ? { record: { accountNumber: options.wrongParentIdentity ? 'ACC-0002' : 'ACC-0001' } } : {}) } }; }
    if (call.tool === 'order_tickets') {
      if (!options.numericLookup) assert.equal(call.args.orderId, 'ZD-ORDER-1');
      return { ok: true, truncated: false, bytes: 100, data: { records: [{ ticketId: 7, subject: 'Delivery question' }], ...(options.paging ? { more: !call.args.afterCursor, ...(!options.invalidPage && !call.args.afterCursor ? { nextCursor: 'source-page-token' } : {}) } : {}) } };
    }
    assert.equal(call.tool, 'get_ticket'); assert.equal(call.args.ticketId, 7);
    return { ok: true, truncated: false, bytes: 100, data: { record: { subject: 'Delivery question' } } };
  } } });
  return { ontology, calls, engine };
}

test('one IQ request follows a declared multi-system relationship, resolves each source key and returns grounded target facts', async () => {
  const f = await fixture();
  const result = await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' }, context);
  assert.equal(result.ok && result.status, 'complete', JSON.stringify(result));
  assert.equal(result.ok && result.records[0].subject.canonicalId, 'T-7');
  assert.equal(result.ok && result.records[0].facts[0].value, 'Delivery question');
  assert.deepEqual(f.calls.map(call => call.tool), ['list_orders', 'order_tickets', 'get_ticket']);
});

test('paged operational reads preserve source cursor and parent identity, and resume only through a declared request parameter', async () => {
  const f = await fixture({ paging: true });
  const first = await f.engine.query({ operation: 'related', subject: { thing: 'Order', canonicalId: 'ORD-1' }, link: 'Order.tickets' }, context);
  assert.equal(first.ok && first.status, 'partial'); assert.equal(validIqResponse(first), true);
  assert.deepEqual(first.ok && first.pages, [{ bindingId: 'Order.tickets@zendesk.order_tickets', subject: { thing: 'Order', canonicalId: 'ORD-1' }, cursorParam: 'afterCursor', more: true, nextCursor: 'source-page-token' }]);
  const second = await f.engine.query({ operation: 'related', subject: { thing: 'Order', canonicalId: 'ORD-1' }, link: 'Order.tickets', filters: { afterCursor: 'source-page-token' } }, context);
  assert.equal(second.ok && second.status, 'complete');
  assert.equal(f.calls.find(call => call.args.afterCursor)?.args.afterCursor, 'source-page-token');
  assert.equal(second.ok && second.pages?.[0].more, false);
  const broken = await fixture({ paging: true, invalidPage: true });
  const refused = await broken.engine.query({ operation: 'related', subject: { thing: 'Order', canonicalId: 'ORD-1' }, link: 'Order.tickets' }, context);
  assert.equal(!refused.ok && refused.code, 'source_page_invalid');
});

test('numeric source identifiers participate in name discovery without guessing another canonical record', async () => {
  const f = await fixture({ numericLookup: true });
  const found = await f.engine.query({ operation: 'find', thing: 'Ticket', query: 'Delivery' }, context);
  assert.equal(found.ok && found.records[0]?.subject.canonicalId, 'T-7', JSON.stringify(found));
  assert.equal(found.ok && found.records[0]?.facts[0]?.value, 'Delivery question');
});

test('permitted list-row facts keep actual list-source provenance without an additional detail fetch', async () => {
  const f = await fixture({ rowProjection: true });
  const result = await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' }, context);
  assert.equal(result.ok && result.status, 'complete', JSON.stringify(result));
  assert.equal(result.ok && result.records[0].facts[0].value, 'Delivery question');
  assert.equal(result.ok && result.records[0].facts[0].source?.tool, 'order_tickets');
  assert.deepEqual(f.calls.map(call => call.tool), ['list_orders', 'order_tickets']);
});

test('relationship lists confirm their declared parent source identity before revealing child records', async () => {
  const correct = await fixture({ parentIdentity: true });
  const query = { operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' };
  const answer = await correct.engine.query(query, context);
  assert.equal(answer.ok && answer.status, 'complete');
  assert.ok(correct.calls[0].fields.includes('record.accountNumber'));
  const wrong = await fixture({ parentIdentity: true, wrongParentIdentity: true });
  const refused = await wrong.engine.query(query, context);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, 'source_unavailable');
  assert.deepEqual(wrong.calls.map(call => call.tool), ['list_orders']);
  assert.doesNotMatch(JSON.stringify(refused), /T-7|Delivery question/);
});

test('a customer needs every hop’s explicit scope; the composite name cannot bypass an intermediate permission', async () => {
  const f = await fixture();
  f.ontology.customerAccess.find((entry: any) => entry.thing === 'Order').links = [];
  const customer = { ...context, principal: { id: 'buyer-a', audience: 'shopper', groups: [], subjects: [{ thing: 'Account', canonicalId: 'ACC-0001', role: 'buyer' }] } };
  const result = await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' }, customer);
  assert.equal(result.ok, false); assert.equal(!result.ok && result.code, 'refused_by_rule'); assert.equal(f.calls.length, 1);
});

test('a shopper can traverse only from their linked account, and only through the declared relationships', async () => {
  const f = await fixture();
  const customer = { ...context, principal: { id: 'buyer-a', audience: 'shopper', groups: [], subjects: [{ thing: 'Account', canonicalId: 'ACC-0001', role: 'buyer' }] } };
  const result = await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' }, customer);
  assert.equal(result.ok && result.status, 'complete', JSON.stringify(result));
  f.calls.length = 0;
  const other = await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0002' }, link: 'Account.tickets' }, customer);
  assert.equal(!other.ok && other.code, 'refused_by_rule'); assert.equal(f.calls.length, 0);
});

test('disconnected and cyclic relationship definitions are refused before any source read', async () => {
  const f = await fixture();
  f.ontology.links[2].via = ['Order.tickets'];
  assert.equal(relationshipPath(f.ontology.links, 'Account.tickets'), undefined);
  assert.equal((await f.engine.query({ operation: 'related', subject: { thing: 'Account', canonicalId: 'ACC-0001' }, link: 'Account.tickets' }, context)).ok, false);
  f.ontology.links[2].via = ['Account.tickets'];
  assert.equal(relationshipPath(f.ontology.links, 'Account.tickets'), undefined); assert.equal(f.calls.length, 0);
});
