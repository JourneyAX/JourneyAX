import './setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IqQueryEngine } from '../src/query';
import { MemoryKeyRepository } from '../src/keys';
import { minimalDictionary } from './fixtures/minimal.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';

function fixture(receipt: unknown) {
  const block = structuredClone(minimalDictionary);
  block.things[0].keyKinds[0].caseRule = 'as_is';
  block.things[0].sourceIdentity = { system: 'ace-erp', keyKind: 'account_number' };
  block.bindings[0].identity = { keyKind: 'account_number', select: 'record.accountNumber' };
  block.permissionRules = [{ ruleId: 'read-label', mode: 'see', target: { thing: 'Account', facts: ['Account.name'] }, who: [{ audience: 'staff', groups: ['sales'] }] }];
  const calls: any[] = [];
  const ctx: any = { tenantId: 'fixture', environmentId: 'test', queryId: 'identity-check', correlationId: 'test', release: { version: '1', checksum: 'verified' }, principal: { id: 'staff', audience: 'staff', groups: ['sales'], subjects: [] } };
  const engine = new IqQueryEngine({ keys: new MemoryKeyRepository(), releases: { load: async () => ({ ...ctx.release, ontology: block, connectors: connectorsFixture }) }, reader: { read: async call => { calls.push(call); return { ok: true, data: receipt, truncated: false, bytes: 100 }; } } });
  return { engine, ctx, calls };
}

test('native key inference accepts facts only after the source confirms the exact identity', async () => {
  const { engine, ctx, calls } = fixture({ record: { name: 'Actual account', accountNumber: 'ACC-0001' } });
  const result = await engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, ctx);
  assert.equal(result.ok && result.records[0].facts[0].value, 'Actual account');
  assert.ok(calls[0].fields.includes('record.accountNumber'), 'identity is bound into the signed source field scope');
});

test('a source UUID/alias, a different record or an omitted identity cannot be relabelled as the canonical record', async () => {
  for (const accountNumber of ['a8fbf021-811a-4203-8aae-c410280a7f98', 'ACC-0002', undefined]) {
    const { engine, ctx } = fixture({ record: { name: 'Do not leak this account', ...(accountNumber ? { accountNumber } : {}) } });
    const result = await engine.query({ operation: 'get', subject: { thing: 'Account', canonicalId: 'ACC-0001' } }, ctx);
    assert.equal(result.ok && result.status, 'partial');
    assert.equal(result.ok && result.records[0].facts[0].status, 'not_available');
    assert.equal(result.ok && result.records[0].facts[0].unavailable?.code, 'source_identity_mismatch');
    assert.doesNotMatch(JSON.stringify(result), /Do not leak/);
  }
});
