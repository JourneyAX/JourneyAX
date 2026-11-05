import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectorToolState } from '@journeyax/business-pack';
import { IqQueryEngine, MemoryKeyRepository, type KeyRow } from '../src';
import { buildIqIdentityCandidate } from '../../../scripts/integrations/iq-identity-candidate';
import { minimalDictionary } from './fixtures/minimal.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';

function fixture() {
  const ontology = structuredClone(minimalDictionary);
  ontology.customerAccess = [{ thing: 'Account', facts: ['Account.name'], links: [], roles: ['buyer'] }];
  ontology.customerIdentity = { thing: 'Account', keyKind: 'account_number' };
  const connectors = structuredClone(connectorsFixture);
  for (const source of connectors.connectors) if (['salesforce', 'commercetools'].includes(source.connectorId)) source.connectionRef = `test-${source.connectorId}`;
  const customerPart = JSON.parse(readFileSync(resolve(__dirname, '../../../docs/integration-contracts/placemakers/iq-customer.json'), 'utf8'));
  const guards = [{ thing: 'Account', system: 'ace-erp', tool: 'account_balance', keyKind: 'account_number', select: 'record.accountNumber' }];
  return { ontology, connectors, customerPart, guards };
}

test('the candidate preserves trade ownership and adds retail identity only to explicit staff readers', () => {
  const input = fixture(); const before = JSON.stringify(input);
  const next = buildIqIdentityCandidate(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(next.jaxOntology.customerAccess, input.ontology.customerAccess);
  assert.deepEqual(next.jaxOntology.customerIdentity, input.ontology.customerIdentity);
  assert.deepEqual(next.jaxOntology.things.map(thing => thing.thing), ['Account', 'Customer']);
  assert.equal(next.jaxOntology.things.find(thing => thing.thing === 'Customer')?.keyKinds.find(kind => kind.system === 'salesforce' && kind.kind === 'customer_ref')?.evidence, 'text_note');
  for (const source of ['salesforce', 'commercetools']) {
    assert.equal(connectorToolState(next.connectors, source, 'get_customer_profile', { audience: 'staff', groups: ['customer-service'] }).state, 'allow');
    assert.equal(connectorToolState(next.connectors, source, 'get_customer_profile', { audience: 'staff', groups: ['sales'] }).state, 'blocked');
    assert.equal(connectorToolState(next.connectors, source, 'get_customer_profile', { audience: 'shopper', groups: [] }).state, 'blocked');
  }
  assert.equal(next.changedBindings.length, 1);
  assert.deepEqual(buildIqIdentityCandidate({ ...input, ontology: next.jaxOntology, connectors: next.connectors }), next);
});

test('new exact blocked descriptor rows are replaced narrowly; a broad wildcard exposure is rejected', () => {
  const input = fixture();
  input.connectors.policy.push({ connectorId: 'salesforce', tool: 'get_customer_profile', audience: 'shopper', groups: [], state: 'blocked' });
  assert.doesNotThrow(() => buildIqIdentityCandidate(input));
  input.connectors.policy.push({ connectorId: 'salesforce', tool: '*', audience: 'staff', groups: [], state: 'allow' });
  assert.throws(() => buildIqIdentityCandidate(input), /outside its staff groups/);
});

test('a missing or foreign source identity guard and duplicate business concepts cannot silently enter a candidate', () => {
  const missing = fixture(); missing.guards[0].tool = 'not_declared';
  assert.throws(() => buildIqIdentityCandidate(missing), /No declared bindings/);
  const foreign = fixture(); foreign.guards[0].keyKind = 'undeclared_key';
  assert.throws(() => buildIqIdentityCandidate(foreign), /identity/i);
  const duplicate = fixture(); duplicate.customerPart.things[0].thing = 'Account';
  assert.throws(() => buildIqIdentityCandidate(duplicate), /conflict/);
});

test('retail Customer joins exactly two registered source identities and rejects a changed canonical receipt', async () => {
  const next = buildIqIdentityCandidate(fixture());
  const canonicalId = `jax_${'a'.repeat(64)}`;
  const keys = new MemoryKeyRepository();
  const scope = { tenantId: 'fixture', environmentId: 'test' as const, thing: 'Customer' };
  const rows = [
    { system: 'salesforce', keyKind: 'sf_contact_id', systemKey: '003000000000001AAA', evidence: 'real_field' },
    { system: 'salesforce', keyKind: 'customer_ref', systemKey: canonicalId, evidence: 'text_note' },
    { system: 'commercetools', keyKind: 'ct_customer_id', systemKey: '01234567-0123-4567-89ab-0123456789ab', evidence: 'real_field' },
    { system: 'commercetools', keyKind: 'customer_ref', systemKey: canonicalId, evidence: 'real_field' },
  ].map(row => ({ ...scope, canonicalId, ...row, role: 'primary', status: 'matched', firstSeenAt: '2026-11-03T00:00:00Z', lastVerifiedAt: '2026-11-03T00:00:00Z', builtBy: { runId: 'isolated-customer-check', releaseVersion: '1', releaseChecksum: 'fixture' } })) as KeyRow[];
  assert.equal((await keys.upsertMany(rows)).ok, true);
  let wrongCrmReference = false; const calls: any[] = [];
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ version: '1', checksum: 'fixture', ontology: next.jaxOntology, connectors: next.connectors }) }, reader: { read: async call => {
    calls.push(call);
    const data = call.system === 'salesforce' ? { record: { accountId: '001000000000001AAA', contactId: '003000000000001AAA', externalCustomerKey: wrongCrmReference ? `jax_${'b'.repeat(64)}` : canonicalId } } : { record: { customerId: '01234567-0123-4567-89ab-0123456789ab', externalCustomerKey: canonicalId, version: 3 } };
    return { ok: true, data, bytes: 300, truncated: false };
  } } });
  const context: any = { tenantId: scope.tenantId, environmentId: scope.environmentId, queryId: 'isolated-customer-query', correlationId: 'test', release: { version: '1', checksum: 'fixture' }, principal: { id: 'staff', audience: 'staff', groups: ['customer-service'], subjects: [] } };
  const query: any = { operation: 'get', subject: { thing: 'Customer', canonicalId } };
  const answer = await engine.query(query, context);
  assert.equal(answer.ok && answer.status, 'complete');
  assert.equal(answer.ok && answer.records[0].facts.length, 5);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => ({ ...call.args })), [{ customerId: '01234567-0123-4567-89ab-0123456789ab' }, { contactId: '003000000000001AAA' }]);
  calls.length = 0;
  const byVendorId = await engine.query({ operation: 'find', thing: 'Customer', query: '003000000000001AAA' }, context);
  assert.equal(byVendorId.ok && byVendorId.records[0]?.subject.canonicalId, canonicalId);
  assert.equal(byVendorId.ok && byVendorId.records[0]?.facts[0]?.value, canonicalId);
  assert.equal(calls.length, 2);
  calls.length = 0; wrongCrmReference = true;
  const mixed = await engine.query(query, context);
  assert.equal(mixed.ok && mixed.status, 'partial');
  assert.equal(mixed.ok && mixed.records[0].facts.find(fact => fact.fact === 'Customer.crmContactId')?.unavailable?.code, 'source_identity_mismatch');
  assert.doesNotMatch(JSON.stringify(mixed), /003000000000001AAA/);
  calls.length = 0;
  const shopper = await engine.query(query, { ...context, principal: { id: 'shopper', audience: 'shopper', groups: [], subjects: [] } });
  assert.equal(calls.length, 0);
  assert.ok(!shopper.ok || shopper.records.length === 0);
});

test('the same registered source identifier in different systems cannot select a customer by first match', async () => {
  const next = buildIqIdentityCandidate(fixture());
  const thing = next.jaxOntology.things.find(value => value.thing === 'Customer')!;
  thing.keyKinds.push({ kind: 'external_contact', system: 'salesforce', pattern: '^shared-id$', caseRule: 'as_is', evidence: 'real_field', ready: true }, { kind: 'external_contact', system: 'commercetools', pattern: '^shared-id$', caseRule: 'as_is', evidence: 'real_field', ready: true });
  const keys = new MemoryKeyRepository();
  for (const [system, character] of [['salesforce', 'a'], ['commercetools', 'b']]) await keys.upsertMany([{ tenantId: 'fixture', environmentId: 'test', thing: 'Customer', canonicalId: `jax_${character.repeat(64)}`, system, keyKind: 'external_contact', systemKey: 'shared-id', role: 'primary', status: 'matched', evidence: 'real_field', firstSeenAt: '2026-11-03T00:00:00Z', lastVerifiedAt: '2026-11-03T00:00:00Z', builtBy: { runId: 'isolated', releaseVersion: '1', releaseChecksum: 'fixture' } }]);
  let calls = 0;
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ version: '1', checksum: 'fixture', ontology: next.jaxOntology, connectors: next.connectors }) }, reader: { read: async () => { calls++; throw new Error('Ambiguity must be resolved before a source read.'); } } });
  const answer = await engine.query({ operation: 'find', thing: 'Customer', query: 'shared-id' }, { tenantId: 'fixture', environmentId: 'test', queryId: 'collision', correlationId: 'test', release: { version: '1', checksum: 'fixture' }, principal: { id: 'staff', audience: 'staff', groups: ['customer-service'], subjects: [] } });
  assert.equal(answer.ok && answer.status, 'ambiguous'); assert.equal(answer.ok && answer.records.length, 0); assert.equal(calls, 0);
});
