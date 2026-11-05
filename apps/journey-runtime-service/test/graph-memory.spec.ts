import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryAt, rememberContext, saveMemory, formatMemory, type MemoryNote } from '../src/conversation/graph-memory';
test('customer goals survive many dialogue turns, while corrections and edited branches remain separate', () => {
  const workspace: any = { facts: {} }; const notes: MemoryNote[] = [];
  assert.equal(rememberContext({ key: 'project', value: 'laundry', evidence: 'renovating my laundry' }, 'I am renovating my laundry', 't0', notes).ok, true);
  saveMemory(workspace, 't0', null, notes);
  let head = 't0:assistant';
  for (let i = 1; i <= 60; i++) { saveMemory(workspace, `t${i}`, head, memoryAt(workspace, head)); head = `t${i}:assistant`; }
  const inherited = memoryAt(workspace, head); assert.equal(inherited[0].value, 'laundry');
  assert.equal(rememberContext({ key: 'project', value: 'bathroom', evidence: 'bathroom instead' }, 'Actually bathroom instead', 'correction', inherited).ok, true);
  saveMemory(workspace, 'correction', head, inherited);
  assert.equal(memoryAt(workspace, 'correction:assistant')[0].value, 'bathroom');
  assert.equal(memoryAt(workspace, head)[0].value, 'laundry');
  assert.deepEqual(memoryAt(workspace, null), [], 'a fresh root cannot inherit another branch');
  assert.ok(JSON.stringify(workspace).length < 100000, 'memory snapshots remain bounded');
});
test('inferences, credentials and fabricated evidence cannot become retained customer facts', () => {
  const notes: MemoryNote[] = [];
  assert.equal(rememberContext({ key: 'room_area', value: '100 square metres', evidence: '100 miters' }, '100 miters', 't1', notes).ok, false);
  assert.equal(rememberContext({ key: 'secret', value: 'password-a', evidence: 'password-a' }, 'password-a', 't1', notes).ok, false);
  assert.equal(rememberContext({ key: 'goal', value: 'kitchen', evidence: 'kitchen' }, 'laundry', 't1', notes).ok, false);
  assert.deepEqual(notes, []);
});
test('spaced card numbers, PINs and sensitive evidence are rejected and legacy memory is filtered on read and save', () => {
  const notes: MemoryNote[] = [];
  for (const value of ['4111 1111 1111 1111', '4111-1111-1111-1111', 'PIN 1234', 'tax number 123456789']) {
    assert.equal(rememberContext({ key: 'detail', value, evidence: value }, value, 'sensitive', notes).ok, false);
  }
  assert.equal(rememberContext({ key: 'room', value: 'laundry', evidence: 'laundry; password private' }, 'laundry; password private', 'sensitive', notes).ok, false);
  const unsafe = { key: 'note', value: '4111 1111 1111 1111', evidence: '4111 1111 1111 1111', sourceTurnId: 'old' };
  const workspace: any = { facts: { jax_graph_memory: { value: { version: 1, snapshots: [{ id: 'old:assistant', parentId: null, notes: [unsafe] }] } } } };
  assert.deepEqual(memoryAt(workspace, 'old:assistant'), []);
  assert.equal(formatMemory([unsafe]), '');
  saveMemory(workspace, 'next', 'old:assistant', [unsafe]);
  assert.doesNotMatch(JSON.stringify(workspace), /4111|password/);
});
