import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { zendesk } from '../src/connectors/zendesk';

function fixture(options: { collision?: boolean; missingAudit?: boolean } = {}) {
  const calls: any[] = [];
  const connector = zendesk({ ZENDESK_API_URL: 'https://vendor.test', ZENDESK_EMAIL: 'staff@example.test', ZENDESK_API_TOKEN: 'fixture-only' }, {
    now: () => Date.parse('2026-11-02T12:00:00Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      if (options.collision) return new Response(JSON.stringify({ error: 'UpdateConflict', description: 'Ticket changed.' }), { status: 409 });
      const comment = calls.at(-1).body.ticket.comment;
      return new Response(JSON.stringify({ ticket: { id: 123, status: 'pending', updated_at: '2026-11-02T12:00:01Z' }, ...(options.missingAudit ? {} : { audit: { id: 456, created_at: '2026-11-02T12:00:01Z', events: comment ? [{ id: 789, type: 'Comment', public: comment.public }] : [] } }) }), { status: 200 });
    },
  });
  const run = (name: string, args: any) => connector.tools.find(tool => tool.name === name)!.run(args);
  return { calls, run, connector };
}
const input = { ticketId: 123, updatedStamp: '2026-11-02T11:00:00Z' };

test('approved public reply uses collision protection and reports only the actual vendor receipt', async () => {
  const f = fixture();
  const result = await f.run('reply_to_ticket', { ...input, body: 'The reply the staff member approved.', status: 'pending' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'PUT');
  assert.deepEqual(f.calls[0].body.ticket, { safe_update: true, updated_stamp: input.updatedStamp, status: 'pending', comment: { body: 'The reply the staff member approved.', public: true } });
  assert.deepEqual(result.receipt, { auditId: 456, commentId: 789, createdAt: '2026-11-02T12:00:01Z' });
});

test('internal update cannot turn an approved note into a public reply', async () => {
  const f = fixture();
  await f.run('update_ticket', { ...input, note: 'An internal note.', priority: 'high', assigneeId: 8 });
  assert.equal(f.calls[0].body.ticket.comment.public, false);
  assert.equal(f.calls[0].body.ticket.comment.body, 'An internal note.');
  assert.equal(f.calls[0].body.ticket.assignee_id, 8);
  assert.equal(f.connector.tools.find(tool => tool.name === 'update_ticket')?.staffOnly, true);
});

test('stale writes and missing receipts are explicit failures without automatic write retries', async () => {
  for (const options of [{ collision: true }, { missingAudit: true }]) {
    const f = fixture(options);
    await assert.rejects(() => f.run('reply_to_ticket', { ...input, body: 'Approved reply.' }));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  await assert.rejects(() => f.run('update_ticket', input), /No ticket change/);
  await assert.rejects(() => f.run('reply_to_ticket', { ...input, updatedStamp: 'invented', body: 'Approved.' }), /timestamp/);
  assert.equal(f.calls.length, 0);
});
