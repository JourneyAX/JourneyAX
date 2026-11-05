import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKeyRepository } from '../src/keys';
import { sourceIdentityKeys } from '../src/query/source-identity';
import { minimalDictionary } from './fixtures/minimal.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';
import { IqQueryEngine } from '../src/query';

const scope = { tenantId: 'tenant-a', environmentId: 'test' as const, release: { version: '5', checksum: 'pinned' } };
const keyScope = { tenantId: scope.tenantId, environmentId: scope.environmentId, thing: 'Account' };
function fixture() {
  const block = structuredClone(minimalDictionary);
  block.things[0].keyKinds[0].caseRule = 'as_is';
  block.things[0].sourceIdentity = { system: 'ace-erp', keyKind: 'account_number' };
  const repository = new MemoryKeyRepository();
  return { block, repository, keys: sourceIdentityKeys(repository, block, scope, () => new Date('2026-11-02T00:00:00Z')) };
}
test('explicit native source IDs need no pre-seeded cross-system link and never write one', async () => {
  const { keys, repository } = fixture();
  const found = await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001');
  assert.equal(found?.canonicalId, 'ACC-0001');
  assert.deepEqual(found?.builtBy, { runId: 'source-native-identity', releaseVersion: '5', releaseChecksum: 'pinned' });
  assert.equal((await keys.findByCanonicalId(keyScope, 'ACC-0001')).length, 1);
  assert.equal((await repository.findByCanonicalId(keyScope, 'ACC-0001')).length, 0);
});
test('native IDs cannot guess another source, scope, name match or undeclared identity', async () => {
  const { keys, block } = fixture();
  assert.equal(await keys.findBySystemKey({ ...keyScope, tenantId: 'other' }, 'ace-erp', 'account_number', 'ACC-0001'), undefined);
  assert.equal(await keys.findBySystemKey(keyScope, 'salesforce', 'account_number', 'ACC-0001'), undefined);
  assert.equal(await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'some company'), undefined);
  block.things[0].keyKinds[0].evidence = 'name_only';
  assert.equal(await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001'), undefined);
  delete block.things[0].sourceIdentity;
  assert.equal(await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001'), undefined);
});
test('persisted conflict or retirement cannot be revived by native-ID configuration', async () => {
  const { keys, repository } = fixture();
  const row = await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001');
  await repository.upsertMany([{ ...row!, status: 'conflict' }]);
  assert.equal((await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001'))?.status, 'conflict');
  assert.equal((await keys.findByCanonicalId(keyScope, 'ACC-0001'))[0].status, 'conflict');
});

test('finding an exact native ID reads that source record rather than searching the ID as a company name', async () => {
  const { block, repository } = fixture();
  block.permissionRules = [{ ruleId: 'read-label', mode: 'see', target: { thing: 'Account', facts: ['Account.name'] }, who: [{ audience: 'staff', groups: ['sales'] }] }];
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys: repository, releases: { load: async () => ({ ...scope.release, ontology: block, connectors: connectorsFixture }) }, reader: { read: async call => { calls.push(call); return { ok: true, data: { record: { name: 'Source trading name' } }, bytes: 50, truncated: false }; } } });
  const context: any = { ...scope, queryId: 'native-find', correlationId: 'test', principal: { id: 'staff', audience: 'staff', groups: ['sales'], subjects: [] } };
  const result = await engine.query({ operation: 'find', thing: 'Account', query: 'ACC-0001' }, context);
  assert.equal(result.ok && result.status, 'complete');
  assert.equal(result.ok && result.records[0]?.facts[0]?.value, 'Source trading name');
  assert.equal(calls.length, 1); assert.equal(calls[0].tool, 'account_balance'); assert.equal(calls[0].args.accountId, 'ACC-0001');
  calls.length = 0;
  const customer = await engine.query({ operation: 'find', thing: 'Account', query: 'ACC-0001' }, { ...context, principal: { id: 'customer', audience: 'shopper', groups: [], subjects: [] } });
  assert.equal(customer.ok && customer.records.length, 0);
  assert.equal(calls.length, 0);
});

test('an exact registered business reference uses verified cross-system keys before a name lookup; conflicts and another tenant remain inaccessible', async () => {
  const { block, repository, keys } = fixture();
  const row = await keys.findBySystemKey(keyScope, 'ace-erp', 'account_number', 'ACC-0001');
  await repository.upsertMany([row!]);
  delete block.things[0].sourceIdentity;
  block.permissionRules = [{ ruleId: 'read-label', mode: 'see', target: { thing: 'Account', facts: ['Account.name'] }, who: [{ audience: 'staff', groups: ['sales'] }] }];
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys: repository, releases: { load: async () => ({ ...scope.release, ontology: block, connectors: connectorsFixture }) }, reader: { read: async call => { calls.push(call); return { ok: true, data: { record: { name: 'Verified account' } }, bytes: 50, truncated: false }; } } });
  const context: any = { ...scope, queryId: 'registered-key', correlationId: 'test', principal: { id: 'staff', audience: 'staff', groups: ['sales'], subjects: [] } };
  const found = await engine.query({ operation: 'find', thing: 'Account', query: 'ACC-0001' }, context);
  assert.equal(found.ok && found.records[0]?.subject.canonicalId, 'ACC-0001'); assert.equal(calls.length, 1);
  calls.length = 0;
  await repository.upsertMany([{ ...row!, status: 'conflict' }]);
  const conflict = await engine.query({ operation: 'find', thing: 'Account', query: 'ACC-0001' }, context);
  assert.equal(conflict.ok && conflict.status, 'ambiguous'); assert.equal(calls.length, 0);
  const other = await engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, { ...context, tenantId: 'another' });
  assert.ok(!other.ok || other.records.length === 0); assert.equal(calls.length, 0);
});
