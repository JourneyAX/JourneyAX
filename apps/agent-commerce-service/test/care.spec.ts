import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { CareEvents } from '../src/care/care.events';
import { CareIntake } from '../src/care/care.intake';
import { CareProcessor, type CareModel } from '../src/care/care.processor';
import { DEFAULT_TEAM, assign, orderNumbersIn, readByWords, stepsFor } from '../src/care/care.playbook';
import { checkReply, dateKeys } from '../src/care/care.checks';
import { MemoryCareStore } from '../src/care/care.store';
import { ConnectorCallError, httpConnectorCaller, type ConnectorCaller } from '../src/care/connector-rpc';
import { toView } from '../src/care/care.view';
import { stageRank, type CareEvent, type CareStage } from '../src/care/care.types';

/**
 * A ticket that reaches the ticket desk is noticed, worked through stage by stage by the AI, and handed to a named person. Nothing is sent to a
 * customer or changed in any system on the way: this suite checks reading only, and that what the AI may propose is always one of a few known actions.
 */
const suite = createSuite('care: a ticket reaches the desk, the AI works it stage by stage, a person gets it');
const TENANT = 'placemakers';
const NOW = new Date('2026-10-26T09:44:00.000Z');

const ticket = (over: Record<string, unknown> = {}) => ({
  ticketId: 4322, subject: 'Where is my pergola order?', status: 'new', created: '2026-10-26T09:43:50Z', updated: '2026-10-26T09:43:50Z',
  requester: { name: 'Sam Shopper', email: 'sam@example.test' }, description: 'I ordered the posts last week, order B13E7A55. The page says processing. When will they be here?', via: 'web', ...over,
});
const order = { orderNumber: 'B13E7A55', state: 'Confirmed', shipmentState: 'Ready', paymentState: 'Paid', total: 289.5, currency: 'NZD', itemCount: 4, shipTo: { city: 'Auckland', postalCode: '1010' }, lines: [{ sku: 'GP-88', name: 'Glulam post 88 x 88 2.7m', quantity: 4, total: 289.5 }] };

function connectors(handlers: Record<string, (args: any) => any> = {}): ConnectorCaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call(connector, tool, args) {
      calls.push(`${connector}.${tool}`);
      const handler = handlers[`${connector}.${tool}`];
      if (!handler) throw new ConnectorCallError(`${connector} is not set up.`, 'not_connected');
      return handler(args);
    },
  };
}
const desk = (...tickets: any[]) => ({ 'zendesk.list_recent_tickets': () => ({ records: tickets }), 'zendesk.find_tickets': () => ({ records: [{ ticketId: 4322 }] }), 'commercetools.get_order': () => ({ record: order }) });
const newStore = () => new MemoryCareStore();
const model = (answers: any[]): CareModel & { asked: string[] } => { const asked: string[] = []; return { asked, async json(system, user) { asked.push(user); return answers.shift() ?? null; } }; };

async function main() {
  await suite.test('plain words are read as a topic and a mood, never with High confidence; order numbers are eight letters and digits', () => {
    assert.equal(readByWords('Please cancel my order', '').topic, 'Cancel order');
    assert.equal(readByWords('', 'The mixer came cracked').topic, 'Damaged item');
    assert.equal(readByWords('Third time!', 'I want to close my account').topic, 'Complaint');
    assert.equal(readByWords('Third time!', 'I want to close my account').mood, 'Angry');
    assert.equal(readByWords('Hello', 'Do you stock this post?').topic, 'Product question');
    assert.equal(readByWords('Hello', 'Do you stock this post?').topicConfidence, 'Low');
    assert.notEqual(readByWords('cancel', '').topicConfidence, 'High');
    assert.deepEqual(orderNumbersIn('my order b13e7a55 and 0960C27F, not DEADBEEF or 12345678'), ['B13E7A55', '0960C27F'], 'a word of only letters, or a number of only digits, is not an order number');
  });

  await suite.test('the list of changes comes from the playbook: a reply and a status first, a note on the order, a case; a complaint is reassigned, never emailed', () => {
    const base = { ticketId: 4322, customerName: 'Sam', subject: 'Where is it', message: 'Where?', repName: 'Aroha Ngata' };
    const delivery = stepsFor({ ...base, topic: 'Delivery', orderRef: 'B13E7A55' });
    assert.deepEqual(delivery.map((s) => [s.system, s.kind]), [['Zendesk', 'customer'], ['commercetools', 'internal'], ['Salesforce', 'record']]);
    assert.equal(delivery[0].after, 'Pending');
    assert.equal(delivery[0].action?.tool, 'reply_to_ticket');
    const cancel = stepsFor({ ...base, topic: 'Cancel order', orderRef: 'B13E7A55', orderTotal: 412.5, currency: 'NZD' });
    assert.equal(cancel[1].kind, 'money');
    assert.equal(cancel[0].after, 'Solved');
    const complaint = stepsFor({ ...base, topic: 'Complaint' });
    assert.ok(complaint.every((s) => s.kind !== 'customer'), 'a complaint sends nothing to the customer');
    const noOrder = stepsFor({ ...base, topic: 'Delivery' });
    assert.ok(noOrder.every((s) => s.system !== 'commercetools'), 'no order, no step on an order');
  });

  await suite.test('who gets it: the rep with the skill and the fewest open tickets; the lead for what only a lead decides', () => {
    assert.equal(assign(DEFAULT_TEAM, 'Damaged item', {}, false).id, 'CSR-1042');
    assert.equal(assign(DEFAULT_TEAM, 'Delivery', { 'CSR-1041': 3 }, false).id, 'CSR-1041', 'only one rep has the skill');
    assert.equal(assign(DEFAULT_TEAM, 'Invoice', { 'CSR-1043': 1 }, false).id, 'CSR-1043');
    assert.equal(assign(DEFAULT_TEAM, 'Delivery', {}, true).id, 'TL-2001');
    assert.equal(assign(DEFAULT_TEAM, 'Something else', { 'CSR-1041': 2, 'CSR-1042': 0, 'CSR-1043': 1 }, false).id, 'CSR-1042', 'no skill matches: the least busy');
  });

  await suite.test('a draft that promises a refund, an amount or a date the systems did not show is flagged for the person, not blocked', () => {
    const facts = ['Order B13E7A55 is confirmed, shipment ready. Promised for 29 Oct.'];
    assert.deepEqual(dateKeys('Due on 29 October, or Wednesday, or tomorrow'), ['29 oct', 'wednesday', 'tomorrow']);
    const ok = checkReply('Your posts are due on 29 October.', { facts, steps: [], isReply: true });
    assert.deepEqual(ok.map((c) => c.ok), [true, true]);
    const promise = checkReply('I will refund NZ$50 and deliver tomorrow.', { facts, steps: [], isReply: true });
    assert.equal(promise[0].ok, false);
    assert.match(promise[0].label, /no step covers/);
    assert.equal(promise[1].ok, false);
    assert.match(promise[1].label, /tomorrow/);
    const refundStep = stepsFor({ ticketId: 1, topic: 'Cancel order', customerName: 'Lina', orderRef: 'B13E7A55', orderTotal: 412.5, currency: 'NZD', subject: 's', message: 'm', repName: 'Aroha' });
    const named = checkReply('Your refund of NZ$412.50 goes back to your card.', { facts, steps: refundStep, isReply: true });
    assert.match(named[0].label, /holds only if you approve/);
    assert.equal(checkReply('Call notes', { facts, steps: [], isReply: false })[0].ok, true);
  });

  await suite.test('the first look only sets the starting point: tickets already in Zendesk are never processed', async () => {
    const store = newStore();
    const c = connectors(desk(ticket()));
    const intake = new CareIntake({ store, events: new CareEvents(), connectors: c, now: () => NOW });
    assert.deepEqual(await intake.poll(TENANT), []);
    assert.equal(c.calls.length, 0, 'the first look does not even ask Zendesk');
    assert.equal(await store.getCursor(TENANT), NOW.toISOString());
  });

  await suite.test('a new ticket becomes a case file at stage "arrived" and is announced; the same ticket is never made twice; solved ones are left alone', async () => {
    const store = newStore();
    const events = new CareEvents();
    const heard: CareEvent[] = [];
    events.subscribe(TENANT, (e) => heard.push(e));
    const records = [ticket(), ticket({ ticketId: 4300, status: 'solved' })];
    const intake = new CareIntake({ store, events, connectors: connectors(desk(...records)), now: () => NOW });
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    const first = await intake.poll(TENANT);
    assert.deepEqual(first.map((d) => d.id), ['t4322']);
    assert.equal(first[0].stage, 'arrived');
    assert.equal(first[0].status, 'ai');
    assert.equal(first[0].channel, 'Contact form');
    assert.equal(first[0].timeline[0].note, 'Ticket 4322 reached Zendesk (Contact form).');
    assert.equal(heard.length, 1);
    assert.equal(heard[0].ticket.stage, 'arrived');
    assert.equal(await store.getCursor(TENANT), '2026-10-26T09:43:50Z', 'the cursor moves to the newest change');
    assert.deepEqual(await intake.poll(TENANT), [], 'the same ticket again makes nothing');
    assert.equal(heard.length, 1);
  });

  await suite.test('a cap on new cases per hour stops a flood from running up a bill', async () => {
    const store = newStore();
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    const many = [1, 2, 3, 4].map((n) => ticket({ ticketId: 5000 + n, updated: `2026-10-26T09:4${n}:00Z` }));
    const intake = new CareIntake({ store, events: new CareEvents(), connectors: connectors(desk(...many)), now: () => NOW, maxPerHour: 2 });
    assert.equal((await intake.poll(TENANT)).length, 2);
  });

  await suite.test('the AI works the ticket stage by stage, announcing each; the person gets a summary, a reply and a list of changes; nothing is written anywhere', async () => {
    const store = newStore();
    const events = new CareEvents();
    const stages: CareStage[] = [];
    events.subscribe(TENANT, (e) => stages.push(e.ticket.stage));
    const c = connectors(desk(ticket()));
    const m = model([
      { topic: 'Delivery', topicConfidence: 'High', mood: 'Neutral', moodConfidence: 'High', orderNumber: 'B13E7A55' },
      { summary: 'Picked and ready. Give a firm date.', recommendation: 'Tell Sam the posts are picked and the carrier has them next.', otherOption: 'Offer pick-up from the nearest branch.', reply: 'Kia ora Sam,\n\nYour posts are picked and ready for the carrier. I will confirm the day as soon as the carrier does.\n\nNgā mihi,\nAroha' },
    ]);
    const intake = new CareIntake({ store, events, connectors: c, now: () => NOW });
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    await intake.poll(TENANT);
    const processor = new CareProcessor({ store, events, connectors: c, model: m, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW });
    const done = await processor.run(TENANT, 't4322');
    assert.deepEqual(stages, ['arrived', 'read', 'researched', 'drafted', 'waiting']);
    assert.equal(done!.status, 'decide');
    assert.equal(done!.assignee.id, 'CSR-1041');
    assert.equal(done!.topic.value, 'Delivery');
    assert.equal(done!.order?.ref, 'B13E7A55');
    assert.ok(done!.found.some((f) => f.source.system === 'commercetools' && f.text.includes('shipment ready')));
    assert.deepEqual(done!.steps.map((s) => s.system), ['Zendesk', 'commercetools', 'Salesforce']);
    assert.ok(done!.replyChecks.every((x) => x.ok));
    assert.deepEqual(done!.timeline.map((e) => e.stage), ['arrived', 'read', 'researched', 'drafted', 'waiting']);
    assert.equal(done!.draft.text, done!.draft.original, 'the AI version is kept to compare with what the person approves');
    assert.ok(!c.calls.some((x) => x.includes('reply') || x.includes('create') || x.includes('update') || x.includes('note')), `only reads: ${c.calls.join(', ')}`);
    assert.equal(m.asked.length, 2, 'two model calls: read and draft');
  });

  await suite.test('asking to process a case twice does nothing the second time, and a stage never goes backwards', async () => {
    const store = newStore();
    const events = new CareEvents();
    const c = connectors(desk(ticket()));
    const intake = new CareIntake({ store, events, connectors: c, now: () => NOW });
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    await intake.poll(TENANT);
    const processor = new CareProcessor({ store, events, connectors: c, model: null, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW });
    await processor.run(TENANT, 't4322');
    const callsAfterFirst = c.calls.length;
    await processor.run(TENANT, 't4322');
    assert.equal(c.calls.length, callsAfterFirst, 'the second run asked nobody');
    const doc = (await store.get(TENANT, 't4322'))!;
    await store.save({ ...doc, stage: 'arrived', status: 'ai' });
    assert.ok(stageRank((await store.get(TENANT, 't4322'))!.stage) >= stageRank('waiting'), 'an older copy cannot undo newer work');
  });

  await suite.test('with no model, plain words still give the person a draft; with no connector server, it says nothing was looked at; a missing order is said plainly', async () => {
    const store = newStore();
    const events = new CareEvents();
    const intake = new CareIntake({ store, events, connectors: connectors(desk(ticket({ description: 'My mixer came cracked. Order 9A6E10C4.' }))), now: () => NOW });
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    await intake.poll(TENANT);
    const none = new CareProcessor({ store, events, connectors: null, model: null, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW });
    const doc = (await none.run(TENANT, 't4322'))!;
    assert.equal(doc.topic.value, 'Damaged item');
    assert.equal(doc.assignee.id, 'CSR-1042');
    assert.ok(doc.notChecked[0].includes('not connected'));
    assert.ok(doc.draft.text.includes('Kia ora Sam'));
    assert.equal(doc.stage, 'waiting');
    const store2 = newStore();
    const c2 = connectors({ ...desk(ticket()), 'commercetools.get_order': () => { throw new ConnectorCallError('not found', 'not_found'); } });
    const intake2 = new CareIntake({ store: store2, events, connectors: c2, now: () => NOW });
    await store2.setCursor(TENANT, '2026-10-26T09:00:00Z');
    await intake2.poll(TENANT);
    const d2 = (await new CareProcessor({ store: store2, events, connectors: c2, model: null, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW }).run(TENANT, 't4322'))!;
    assert.ok(d2.notChecked.includes('Order B13E7A55 was not found in commercetools.'));
    assert.equal(d2.order, undefined);
  });

  await suite.test('a complaint, an angry customer, a low-confidence reading, or money over the limit goes to the team lead and has no reply to the customer', async () => {
    const run = async (t: any, m: any, limit = 500, handlers = desk(t)) => {
      const store = newStore();
      const events = new CareEvents();
      const c = connectors(handlers);
      const intake = new CareIntake({ store, events, connectors: c, now: () => NOW });
      await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
      await intake.poll(TENANT);
      return (await new CareProcessor({ store, events, connectors: c, model: m, team: DEFAULT_TEAM, refundLimit: limit, now: () => NOW }).run(TENANT, 't4322'))!;
    };
    const complaint = await run(ticket({ subject: 'Third time!', description: 'This is the third time. I want to close my account.' }), null);
    assert.equal(complaint.status, 'lead');
    assert.equal(complaint.assignee.id, 'TL-2001');
    assert.equal(complaint.draft.isReply, false);
    assert.ok(complaint.steps.every((s) => s.kind !== 'customer'));
    const money = await run(ticket({ subject: 'Please cancel', description: 'Cancel order B13E7A55 please.' }), null, 100);
    assert.equal(money.status, 'lead', 'a refund over the limit is the lead\'s to decide');
    const small = await run(ticket({ subject: 'Please cancel', description: 'Cancel order B13E7A55 please.' }), null, 500);
    assert.equal(small.status, 'decide');
    const unsure = await run(ticket({ subject: 'Hello', description: 'Do you stock the thing?' }), null);
    assert.equal(unsure.status, 'lead', 'a ticket the AI cannot read with confidence goes up, not down');
  });

  await suite.test('what the portal receives never carries the action behind a step, and the promised-time clock goes negative when late', async () => {
    const store = newStore();
    const old = ticket({ created: '2026-10-26T05:00:00Z', updated: '2026-10-26T09:43:00Z' });
    const intake = new CareIntake({ store, events: new CareEvents(), connectors: connectors(desk(old)), now: () => NOW });
    await store.setCursor(TENANT, '2026-10-26T09:00:00Z');
    await intake.poll(TENANT);
    const c = connectors(desk(old));
    const processed = (await new CareProcessor({ store, events: new CareEvents(), connectors: c, model: null, team: DEFAULT_TEAM, refundLimit: 500, now: () => NOW }).run(TENANT, 't4322'))!;
    assert.ok(processed.steps.every((s) => s.action), 'the server keeps the action');
    const view: any = toView(processed, NOW.getTime());
    assert.ok(view.steps.every((s: any) => !('action' in s)), 'the portal never sees it');
    assert.equal(view.tenantId, undefined);
    assert.equal(view.zendeskId, undefined);
    assert.equal(view.slaMinutes, -44, 'created at 05:00, a first reply is promised within four hours, so at 09:44 it is 44 minutes late');
  });

  await suite.test('the connector door sends the shop\'s key and tenant, reads the tool\'s payload, and reports a refusal in plain words; with no key there is no caller', async () => {
    assert.equal(httpConnectorCaller({ env: {} }), null);
    const sent: any[] = [];
    const env = { CONNECTOR_MCP_SERVERS: JSON.stringify({ zendesk: 'http://connectors.test/mcp/zendesk' }), CONNECTOR_SECRET_REAL_CONNECTORS_KEY: 'key-1' };
    const ok = httpConnectorCaller({ env, fetchImpl: (async (url: string, init: any) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ result: { content: [{ text: JSON.stringify({ records: [{ ticketId: 1 }] }) }] } }) } as any; }) as any })!;
    const payload = await ok.call('zendesk', 'list_recent_tickets', { limit: 5 }, TENANT);
    assert.deepEqual(payload.records, [{ ticketId: 1 }]);
    assert.equal(sent[0].url, 'http://connectors.test/mcp/zendesk');
    assert.equal(sent[0].init.headers.authorization, 'Bearer key-1');
    assert.equal(sent[0].init.headers['x-tenant-id'], TENANT);
    assert.equal(JSON.parse(sent[0].init.body).params.name, 'list_recent_tickets');
    await assert.rejects(ok.call('salesforce', 'x', {}, TENANT), /not set up/);
    const refused = httpConnectorCaller({ env, fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ result: { isError: true, content: [{ text: JSON.stringify({ ok: false, error: { code: 'rejected', message: 'Zendesk said no.' } }) }] } }) })) as any })!;
    await assert.rejects(refused.call('zendesk', 'x', {}, TENANT), /Zendesk said no/);
    const down = httpConnectorCaller({ env, fetchImpl: (async () => ({ ok: false, status: 502 })) as any })!;
    await assert.rejects(down.call('zendesk', 'x', {}, TENANT), /answered 502/);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
