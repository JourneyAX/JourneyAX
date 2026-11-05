import './setup/no-world';
import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { IqQueryEngine, MemoryKeyRepository, type IqContext, type KeyRow, type LoadedRelease } from '../src';
import { minimalDictionary } from './fixtures/minimal.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';

const suite = createSuite('IQ shared queries');
const context: IqContext = { tenantId: 'tenant-a', environmentId: 'test', queryId: 'q-1', correlationId: 'trace-1', release: { version: '1', checksum: 'abc' }, principal: { id: 'staff-1', audience: 'staff', groups: ['sales'], subjects: [] } };
const key = (id: string): KeyRow => ({ tenantId: 'tenant-a', environmentId: 'test', thing: 'Account', canonicalId: id, system: 'ace-erp', keyKind: 'account_number', systemKey: id, status: 'matched', role: 'primary', evidence: 'real_field', firstSeenAt: '2026-11-01T00:00:00Z', lastVerifiedAt: '2026-11-01T00:00:00Z', builtBy: { runId: 'r-1', releaseVersion: '1', releaseChecksum: 'abc' } });
async function fixture(maxSourceCalls?: number) {
  const ontology = structuredClone(minimalDictionary);
  ontology.permissionRules = [{ ruleId: 'names', mode: 'see', target: { thing: 'Account', facts: ['Account.name'] }, who: [{ audience: 'staff', groups: ['sales'] }] }];
  ontology.customerAccess = [{ thing: 'Account', facts: ['Account.name'], links: [] }];
  ontology.things[0].lookups = [{ system: 'ace-erp', tool: 'find_account', queryArg: 'query', rows: 'records', keyField: 'id', keyKind: 'account_number', labelField: 'name' }];
  const connectors = structuredClone(connectorsFixture);
  connectors.policy.push({ connectorId: 'ace-erp', tool: 'account_balance', audience: 'shopper', groups: [], state: 'allow' });
  const keys = new MemoryKeyRepository();
  assert.equal((await keys.upsertMany([key('ACC-0001'), key('ACC-0002')])).ok, true);
  const calls: Array<{ system: string; tool: string; args: Record<string, unknown> }> = [];
  let fail = false;
  let mismatch = false;
  const release: LoadedRelease = { version: '1', checksum: 'abc', ontology, connectors };
  const engine = new IqQueryEngine({ keys, maxSourceCalls, releases: { load: async () => mismatch ? { ...release, checksum: 'wrong' } : release }, reader: { read: async call => {
    calls.push(call);
    if (fail) return { ok: false, kind: 'timeout', message: 'untrusted secret vendor error' };
    return { ok: true, truncated: false, bytes: 100, data: call.tool === 'find_account'
      ? { records: [{ id: 'ACC-0001', name: 'Hartley Concrete' }, { id: 'ACC-0002', name: 'Hartley Electrical' }] }
      : { record: { name: call.args.accountId === 'ACC-0001' ? 'Hartley Concrete' : 'Hartley Electrical', secret: 'must never leave' } } };
  } } });
  return { engine, ontology, connectors, keys, calls, setFail: () => { fail = true; }, setMismatch: () => { mismatch = true; } };
}

async function main() {
  await suite.test('source data is field-cut, labelled demo and release-pinned', async () => {
    const f = await fixture();
    const result = await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.records[0].facts[0].value, 'Hartley Concrete');
    assert.equal(result.records[0].facts[0].source?.sample, true);
    assert.equal(result.untrustedText, true);
    assert.equal(JSON.stringify(result).includes('must never leave'), false);
    assert.equal(f.calls[0].args.accountId, 'ACC-0001');
  });
  await suite.test('similar names are candidates, never first-match selection', async () => {
    const f = await fixture();
    const result = await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley' }, context);
    assert.equal(result.ok && result.status, 'ambiguous');
    assert.equal(result.ok && result.records.length, 2);
  });
  await suite.test('customers can only read server-linked subjects', async () => {
    const f = await fixture();
    const customer: IqContext = { ...context, principal: { id: 'buyer-1', audience: 'shopper', groups: [], subjects: [{ thing: 'Account', canonicalId: 'ACC-0001' }] } };
    assert.equal((await f.engine.query({ operation: 'get', subject: customer.principal.subjects[0] }, customer)).ok, true);
    f.calls.length = 0;
    assert.deepEqual(await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0002' } }, customer), { ok: false, code: 'refused_by_rule', queryId: 'q-1' });
    assert.equal(f.calls.length, 0);
  });
  await suite.test('an old staff-only release still denies all customers', async () => {
    const f = await fixture(); delete f.ontology.customerAccess;
    const customer: IqContext = { ...context, principal: { id: 'buyer', audience: 'shopper', groups: ['sales'], subjects: [{ thing: 'Account', canonicalId: 'ACC-0001' }] } };
    assert.equal((await f.engine.query({ operation: 'get', subject: customer.principal.subjects[0] }, customer)).ok, false);
    assert.equal(f.calls.length, 0);
  });
  await suite.test('a financial role in one company cannot widen access to another company', async () => {
    const f = await fixture(); f.ontology.customerAccess![0].roles = ['account_admin'];
    const customer: IqContext = { ...context, principal: { id: 'buyer', audience: 'shopper', groups: [], subjects: [{ thing: 'Account', canonicalId: 'ACC-0001', role: 'account_admin' }, { thing: 'Account', canonicalId: 'ACC-0002', role: 'buyer' }] } };
    assert.equal((await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, customer)).ok, true);
    f.calls.length = 0;
    assert.equal((await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0002' } }, customer)).ok, false);
    assert.equal(f.calls.length, 0);
  });
  await suite.test('missing fact permissions and write bindings make no source calls', async () => {
    const f = await fixture(); f.ontology.permissionRules = [];
    assert.equal((await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, context)).ok, false);
    assert.equal(f.calls.length, 0);
  });
  await suite.test('cross-tenant and cross-environment key tables cannot resolve a record', async () => {
    const f = await fixture();
    for (const ctx of [{ ...context, tenantId: 'tenant-b' }, { ...context, environmentId: 'staging' as const }]) {
      assert.equal((await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, ctx)).ok, false);
    }
    assert.equal(f.calls.length, 0);
  });
  await suite.test('a checksum mismatch fails before calling a connector', async () => {
    const f = await fixture(); f.setMismatch();
    const result = await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley' }, context);
    assert.equal(!result.ok && result.code, 'release_mismatch'); assert.equal(f.calls.length, 0);
  });
  await suite.test('partial source failures return unavailable facts, no fabricated value or vendor error', async () => {
    const f = await fixture(); f.setFail();
    const result = await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, context);
    assert.equal(result.ok && result.status, 'partial');
    assert.equal(result.ok && result.records[0].facts[0].status, 'not_available');
    assert.equal(JSON.stringify(result).includes('untrusted secret'), false);
  });
  await suite.test('a failed source discovery is unavailable, never a no-match business answer', async () => {
    const f = await fixture(); f.setFail();
    const result = await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley' }, context);
    assert.equal(!result.ok && result.code, 'source_unavailable');
    assert.equal(JSON.stringify(result).includes('untrusted secret'), false);
  });
  await suite.test('caller context and raw queries cannot be injected into a tool request', async () => {
    const f = await fixture();
    const result = await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley', principal: { audience: 'staff' } }, context);
    assert.equal(!result.ok && result.code, 'invalid_request'); assert.equal(f.calls.length, 0);
  });
  await suite.test('turn-disabled source connectors cannot be queried through IQ as a bypass', async () => {
    const f = await fixture();
    const disabled = { ...context, disabledConnectors: ['ace-erp'] };
    const answer = await f.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, disabled);
    assert.equal(f.calls.length, 0);
    assert.equal(answer.ok && answer.records.some(record => record.facts.some(fact => fact.status === 'ok')), false);
  });
  await suite.test('query source-call ceiling bounds composite reads and never reports partial research as complete', async () => {
    const f = await fixture(1);
    const result = await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley' }, context);
    assert.deepEqual(result, { ok: false, code: 'source_budget_exceeded', queryId: 'q-1' });
    assert.equal(f.calls.length, 1);
    const zero = await fixture(0);
    assert.equal((await zero.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, context)).ok, false);
    assert.equal(zero.calls.length, 0);
  });
  await suite.test('merchant limits can reduce but cannot increase the service source-call ceiling', async () => {
    const f = await fixture(1);
    f.ontology.settings.push({ key: 'limit.sourceCalls', label: 'Source call budget', kind: 'limit', unit: 'count', ownerRole: 'owner', value: 100 });
    assert.equal((await f.engine.query({ operation: 'find', thing: 'Account', query: 'Hartley' }, context)).ok, false);
    assert.equal(f.calls.length, 1);
    const reduced = await fixture(8);
    reduced.ontology.settings.push({ key: 'limit.sourceCalls', label: 'Source call budget', kind: 'limit', unit: 'count', ownerRole: 'owner', value: 0 });
    assert.equal((await reduced.engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, context)).ok, false);
    assert.equal(reduced.calls.length, 0);
  });
  suite.finish();
}
main().catch(error => { console.error(error); process.exit(1); });
