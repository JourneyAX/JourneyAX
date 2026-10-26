import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { CareDesk } from '../src/care/care.desk';
import { CareEvents } from '../src/care/care.events';
import { CareIntake } from '../src/care/care.intake';
import { CareProcessor } from '../src/care/care.processor';
import { DEFAULT_TEAM } from '../src/care/care.playbook';
import { MemoryCareStore } from '../src/care/care.store';
import { ConnectorCallError, type ConnectorCaller } from '../src/care/connector-rpc';
import { UnavailableWriteBack, type CareActor, type CareWriteBack } from '../src/care/care.writeback';
import type { CareEvent } from '../src/care/care.types';

/**
 * A person decides, and only then do the systems change. This suite checks who may decide, that what is approved is exactly what was shown,
 * that each change is carried out and announced in turn, that a failure stops the run and can be retried, and that nothing runs without an approval.
 */
const suite = createSuite('care: who may decide, what is approved, and how the changes run');
const TENANT = 'placemakers';
const NOW = new Date('2026-10-26T09:44:00.000Z');
const aroha: CareActor = { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false };
const tane: CareActor = { name: 'Tane Walker', id: 'CSR-1042', isLead: false };
const hemi: CareActor = { name: 'Hemi Parata', id: 'TL-2001', isLead: true };

const ticket = (over: Record<string, unknown> = {}) => ({ ticketId: 4322, subject: 'Where is my pergola order?', status: 'new', created: '2026-10-26T09:43:50Z', updated: '2026-10-26T09:43:50Z', requester: { name: 'Sam Shopper', email: 'sam@example.test' }, description: 'Order B13E7A55: when will it arrive?', via: 'web', ...over });
const connectors = (...tickets: any[]): ConnectorCaller => ({
  async call(connector, tool) {
    if (`${connector}.${tool}` === 'zendesk.list_recent_tickets') return { records: tickets };
    if (`${connector}.${tool}` === 'zendesk.find_tickets') return { records: [] };
    if (`${connector}.${tool}` === 'commercetools.get_order') return { record: { orderNumber: 'B13E7A55', state: 'Confirmed', shipmentState: 'Ready', paymentState: 'Paid', total: 289.5, currency: 'NZD', lines: [{ name: 'Posts', quantity: 4 }] } };
    throw new ConnectorCallError('not set up', 'not_connected');
  },
});

async function desk(writeBack: CareWriteBack, tickets: any[] = [ticket()]) {
  const store = new MemoryCareStore();
  const events = new CareEvents();
  const heard: CareEvent[] = [];
  events.subscribe(TENANT, (e) => heard.push(e));
  const c = connectors(...tickets);
  const intake = new CareIntake({ store, events, connectors: c, now: () => NOW });
  const processor = new CareProcessor({ store, events, connectors: c, model: null, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW });
  const d = new CareDesk({ store, events, processor, intake, writeBack, team: DEFAULT_TEAM, now: () => NOW });
  await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
  assert.equal(await d.pollOnce(TENANT), tickets.length);
  await d.idle();
  return { d, store, heard };
}
const recording = (failOn?: string) => {
  const ran: string[] = [];
  let failed = false;
  const writeBack: CareWriteBack = { async run(_t, _doc, step, ctx) { ran.push(`${step.system}:${step.action?.tool}${step.action?.tool === 'reply_to_ticket' ? `:${ctx.draft.slice(0, 8)}` : ''}`); if (failOn === step.id && !failed) { failed = true; return { ok: false, message: 'Zendesk did not accept it.' }; } return { ok: true }; } };
  return { ran, writeBack };
};

async function main() {
  await suite.test('a polled ticket is worked in the background and arrives at "waiting" with its steps; the list shows the soonest promised first', async () => {
    const { d } = await desk(new UnavailableWriteBack(), [ticket(), ticket({ ticketId: 4323, created: '2026-10-26T06:00:00Z', updated: '2026-10-26T09:43:55Z' })]);
    const list = await d.list(TENANT);
    assert.deepEqual(list.map((t) => t.ref), ['4323', '4322'], 'the older ticket is closer to late');
    assert.ok(list.every((t) => t.stage === 'waiting'));
    assert.equal((await d.board(TENANT)).byStage.waiting, 2);
  });

  await suite.test('only the assigned rep or the team lead may decide; another rep may not; a ticket held for the lead is not the rep\'s', async () => {
    const { d, store } = await desk(recording().writeBack);
    const mine = (await d.get(TENANT, 't4322'))!;
    assert.equal(mine.assignee.id, 'CSR-1041');
    const other = await d.approve(TENANT, 't4322', tane, {});
    assert.equal(other.ok, false);
    assert.equal(other.ok === false && other.code, 'not_allowed');
    assert.equal((await d.reject(TENANT, 't4322', tane)).ok, false);
    const doc = (await store.get(TENANT, 't4322'))!;
    await store.save({ ...doc, needsLead: true, status: 'lead' });
    const rep = await d.approve(TENANT, 't4322', aroha, {});
    assert.equal(rep.ok === false && rep.message, 'Only the team lead can decide this one.');
    assert.equal((await d.approve(TENANT, 'nope', aroha, {})).ok, false);
  });

  await suite.test('approving carries out exactly the steps that were kept, in order, with the reply the person edited, and announces each; then the ticket is done', async () => {
    const { ran, writeBack } = recording();
    const { d, heard } = await desk(writeBack);
    const before = heard.length;
    const result = await d.approve(TENANT, 't4322', aroha, { draft: 'Kia ora Sam,\n\nYour posts are due soon. I will confirm the day.\n\nNgā mihi,\nAroha', removedSteps: ['s3'] });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.done, true);
    assert.deepEqual(ran, ['Zendesk:reply_to_ticket:Kia ora ', 'commercetools:add_order_note'], 'the removed Salesforce step never ran');
    const view = result.ok ? result.ticket : null;
    assert.equal(view!.stage, 'done');
    assert.equal(view!.approval!.by.id, 'CSR-1041');
    assert.equal(view!.approval!.edited, true);
    assert.deepEqual(view!.approval!.removedSteps, ['s3']);
    assert.ok(!('contentHash' in (view!.approval as any)), 'the fingerprint stays on the server');
    assert.ok(view!.timeline.at(-1)!.note.startsWith('Approved by Aroha Ngata'));
    assert.ok(heard.length - before >= 4, 'running, one per step, then done');
    assert.equal((await d.approve(TENANT, 't4322', aroha, {})).ok, false, 'an approval is used once');
  });

  await suite.test('an empty reply, a step that is not on the ticket, or every step removed is refused and changes nothing', async () => {
    const { ran, writeBack } = recording();
    const { d } = await desk(writeBack);
    assert.equal((await d.approve(TENANT, 't4322', aroha, { draft: '  ' })).ok, false);
    assert.equal((await d.approve(TENANT, 't4322', aroha, { removedSteps: ['s9'] })).ok, false);
    assert.equal((await d.approve(TENANT, 't4322', aroha, { removedSteps: ['s1', 's2', 's3'] })).ok, false);
    assert.deepEqual(ran, []);
    assert.equal((await d.get(TENANT, 't4322'))!.stage, 'waiting');
  });

  await suite.test('a change that fails stops the run, says which and why, leaves the ticket open, and a retry carries on from it without repeating what worked', async () => {
    const { ran, writeBack } = recording('s2');
    const { d } = await desk(writeBack);
    const first = await d.approve(TENANT, 't4322', aroha, {});
    assert.equal(first.ok && first.done, false);
    const view = first.ok ? first.ticket : null;
    assert.equal(view!.stage, 'running');
    assert.deepEqual(view!.approval!.results.map((r) => [r.stepId, r.ok]), [['s1', true], ['s2', false]]);
    assert.equal(view!.approval!.results[1].message, 'Zendesk did not accept it.');
    assert.deepEqual(ran, ['Zendesk:reply_to_ticket:Kia ora ', 'commercetools:add_order_note']);
    assert.equal((await d.retry(TENANT, 't4322', tane)).ok, false, 'someone else cannot retry for the approver');
    const second = await d.retry(TENANT, 't4322', aroha);
    assert.equal(second.ok && second.done, true);
    assert.deepEqual(ran.slice(2), ['commercetools:add_order_note', 'Salesforce:create_case'], 'the reply was not sent twice');
    assert.equal((await d.get(TENANT, 't4322'))!.stage, 'done');
  });

  await suite.test('until write-back is switched on, an approval changes nothing and says so', async () => {
    const { d } = await desk(new UnavailableWriteBack());
    const result = await d.approve(TENANT, 't4322', aroha, {});
    assert.equal(result.ok && result.done, false);
    const view = result.ok ? result.ticket : null;
    assert.equal(view!.approval!.results[0].ok, false);
    assert.match(view!.approval!.results[0].message!, /not switched on yet. Nothing was changed/);
  });

  await suite.test('a rep can hand a ticket up; it then belongs to the team lead, who alone may decide it', async () => {
    const { d } = await desk(recording().writeBack);
    assert.equal((await d.toLead(TENANT, 't4322', tane)).ok, false);
    const handed = await d.toLead(TENANT, 't4322', aroha);
    assert.equal(handed.ok && handed.ticket.assignee.id, 'TL-2001');
    assert.equal(handed.ok && handed.ticket.status, 'lead');
    assert.equal((await d.approve(TENANT, 't4322', aroha, {})).ok, false);
    assert.equal((await d.approve(TENANT, 't4322', hemi, {})).ok, true);
  });

  await suite.test('rejecting changes nothing and is recorded; the ticket stays waiting for the person', async () => {
    const { ran, writeBack } = recording();
    const { d } = await desk(writeBack);
    const rejected = await d.reject(TENANT, 't4322', aroha);
    assert.equal(rejected.ok, true);
    assert.deepEqual(ran, []);
    const view = (await d.get(TENANT, 't4322'))!;
    assert.equal(view.stage, 'waiting');
    assert.ok(view.timeline.at(-1)!.note.includes('did not approve it and will handle it'));
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
