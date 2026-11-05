import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { iqQueryForSource } from '../src/query/surfaces';
import { minimalDictionary } from './fixtures/minimal.dictionary';

test('desk numeric source IDs are accepted only by an explicitly integer key mapping', () => {
  const block = structuredClone(minimalDictionary);
  block.bindings[0].args = { accountId: { from: 'key', kind: 'account_number', valueType: 'integer' } };
  const read = (value: unknown) => iqQueryForSource(block, block.bindings[0].system, block.bindings[0].tool, { accountId: value });
  assert.equal((read(45).query as any)?.subject.key.value, '45');
  for (const value of [1.1, -1, Number.MAX_SAFE_INTEGER + 1, {}, null]) assert.equal(read(value).query, undefined);
  delete (block.bindings[0].args.accountId as any).valueType;
  assert.equal(read(45).query, undefined);
  assert.equal((read('ACC-0001').query as any)?.subject.key.value, 'ACC-0001');
});

test('principal-only self source tools map through the configured IQ self alias without copying caller identity filters', () => {
  const block = structuredClone(minimalDictionary);
  block.retailCustomerIdentity = { thing: 'Account', role: 'owner', selfAlias: 'self' };
  block.bindings[0].args = { requesterEmail: { from: 'principal', field: 'id' } };
  const result = iqQueryForSource(block, block.bindings[0].system, block.bindings[0].tool, { requesterEmail: 'another@example.test' });
  assert.deepEqual((result.query as any).subject, { thing: 'Account', canonicalId: 'self' });
  assert.deepEqual((result.query as any).filters, {});
  delete block.retailCustomerIdentity;
  assert.equal(iqQueryForSource(block, block.bindings[0].system, block.bindings[0].tool, { requesterEmail: 'another@example.test' }).query, undefined);
});
