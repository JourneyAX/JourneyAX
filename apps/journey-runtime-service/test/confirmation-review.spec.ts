import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmCardState, createPendingConfirmation, readPending, takePendingConfirmation } from '../src/agent/confirmation';

test('approval review retains every nested correction and the entire customer reply, without authorising a changed payload', () => {
  const workspace: any = {};
  const args = { connector: 'commerce', tool: 'correct_contact', arguments: { accountId: 'ACC-1', expectedVersion: 7, corrections: { phone: '+64210000000', streetName: 'Reviewed street' }, reply: 'Please review this complete reply. '.repeat(20) } };
  const { pending } = createPendingConfirmation(workspace, { toolId: 'call_connector_tool', args, summary: 'Review changes', principalId: 'staff-a' });
  const card = confirmCardState(pending);
  assert.deepEqual(JSON.parse(String(card.reviewPayload)), args);
  args.arguments.corrections.phone = '+64219999999';
  assert.equal(pending.args.arguments && (pending.args.arguments as any).corrections.phone, '+64210000000');
  assert.equal(takePendingConfirmation(workspace, pending.id, 'staff-b').ok, false);
  const accepted = takePendingConfirmation(workspace, pending.id, 'staff-a');
  assert.equal(accepted.ok, true);
  assert.equal(takePendingConfirmation(workspace, pending.id, 'staff-a').ok, false);
});

test('changed or legacy incomplete reviews cannot execute, and oversized actions are never silently shortened', () => {
  for (const corrupt of [(pending: any) => { pending.args.phone = '+64218888888'; }, (pending: any) => { delete pending.reviewPayload; }]) {
    const workspace: any = {};
    const { pending } = createPendingConfirmation(workspace, { toolId: 'update_contact', args: { phone: '+64210000000' }, summary: 'Review', principalId: 'staff-a' });
    corrupt(readPending(workspace)[0]);
    assert.deepEqual(takePendingConfirmation(workspace, pending.id, 'staff-a'), { ok: false, reason: 'changed' });
  }
  assert.throws(() => createPendingConfirmation({}, { toolId: 'reply', args: { text: 'x'.repeat(64_001) }, summary: 'Review', principalId: 'staff-a' }), /too large/);
});

test('preparing another action cannot silently discard an earlier human review', () => {
  const workspace: any = {};
  for (let i = 0; i < 5; i++) createPendingConfirmation(workspace, { toolId: 'update', args: { record: i }, summary: 'Review', principalId: 'staff-a' });
  const first = readPending(workspace)[0].id;
  assert.throws(() => createPendingConfirmation(workspace, { toolId: 'update', args: { record: 6 }, summary: 'Review', principalId: 'staff-a' }), /No existing review was replaced/);
  assert.equal(readPending(workspace).length, 5);
  assert.equal(takePendingConfirmation(workspace, first, 'staff-a').ok, true);
});
