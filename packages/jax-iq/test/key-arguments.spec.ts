import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planBindingArguments, ArgSourceSchema } from '../src';

const binding: any = { system: 'support', args: { ticketId: { from: 'key', kind: 'ticket_id', valueType: 'integer' } } };
const key = (systemKey: string): any => ({ system: 'support', keyKind: 'ticket_id', systemKey, role: 'primary', status: 'matched' });

test('numeric source identifiers use the binding contract, never field-name heuristics or model overrides', () => {
  assert.deepEqual({ ...planBindingArguments(binding, [key('123')], { ticketId: 999 }) }, { ticketId: 123 });
  const stringBinding = { ...binding, args: { ticketId: { from: 'key', kind: 'ticket_id' } } } as any;
  assert.equal(planBindingArguments(stringBinding, [key('123')])?.ticketId, '123');
  assert.equal(ArgSourceSchema.safeParse({ from: 'key', kind: 'ticket_id', valueType: 'integer' }).success, true);
});

test('ambiguous, malformed, unsafe and wrong-system identifiers cannot become numeric source arguments', () => {
  for (const value of ['00123', '1.5', '1e3', '-1', '9007199254740992', '123a', ' 123']) assert.equal(planBindingArguments(binding, [key(value)]), undefined);
  assert.equal(planBindingArguments(binding, [key('123'), key('456')]), undefined);
  assert.equal(planBindingArguments(binding, [{ ...key('123'), system: 'other-system' }]), undefined);
});

test('principal arguments use only the signed context and cannot be overwritten by a request filter', () => {
  const bound: any = { system: 'commerce', args: { requesterEmail: { from: 'principal', field: 'id' } } };
  assert.equal(planBindingArguments(bound, [], { requesterEmail: 'another@example.test', id: 'another@example.test' }, { id: 'owner@example.test' })?.requesterEmail, 'owner@example.test');
  assert.equal(planBindingArguments(bound, [], { requesterEmail: 'another@example.test' }), undefined);
  assert.equal(planBindingArguments(bound, [], {}, { id: 'anonymous' }), undefined);
  assert.equal(ArgSourceSchema.safeParse({ from: 'principal', field: 'email_from_model' }).success, false);
});
