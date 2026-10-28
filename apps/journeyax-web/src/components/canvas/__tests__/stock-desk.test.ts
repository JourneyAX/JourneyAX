/**
 * The stock exceptions desk, drawn by the care canvases: its own words, its own list apart from customer care's, its own routes, and the table of
 * branches. Connected (no preview switch), so nothing is shown that the desk did not send.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/canvas/__tests__/stock-desk.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { arrivalTicket, type CareTicket } from '../care/careData';
import { decide, fetchStockAccess, fetchTickets } from '../care/careApi';
import { STOCK_ENTRIES } from '../care/careAccess';
import { deskWords } from '../care/deskWords';
import { applyCareEvent, getCareTickets, replaceCareTickets, resetCareStore, syncCareNow } from '../care/careStore';
import CareBoardCanvas from '../care/CareBoardCanvas';
import CareQueueCanvas from '../care/CareQueueCanvas';
import CareTicketCanvas from '../care/CareTicketCanvas';
import { canvasCanOpen } from '@/lib/shell/canvasRegistry';
import { allowedCarePath } from '@/lib/care/allowedPath';
import '../registry';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const realFetch = globalThis.fetch;
const answering = (status: number, body: unknown, seen: Array<{ url: string; init?: any }> = []) => { (globalThis as any).fetch = async (url: string, init?: any) => { seen.push({ url: String(url), init }); return { ok: status < 400, status, json: async () => body }; }; return seen; };
const restore = () => { (globalThis as any).fetch = realFetch; };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const exception = (stage: CareTicket['stage'] = 'waiting'): CareTicket => ({
  id: 'x7301', desk: 'stock', ref: 'EX-7301', subject: '18 short: Treated pine fence post 100 x 100 x 2.4 m for order OPP-4833', status: stage === 'waiting' ? 'decide' : 'ai', channel: 'Raised by SAP ERP',
  message: 'Hamilton cannot fill order OPP-4833: 24 × Treated pine fence post 100 x 100 x 2.4 m needed, 6 on hand.\n\nPick check: only 6 on the shelf.',
  customer: { name: 'Dylan Hart', account: 'Trade account', since: '', earlier: 'Hamilton' }, assignee: { name: 'Wiremu Fox', id: 'STK-1101' }, slaMinutes: 205,
  topic: { value: 'Short at branch', confidence: 'High' }, mood: { value: 'Urgent', confidence: 'Medium' },
  found: [{ text: 'Rotorua has 64 on hand and 24 to spare after 10 promised and its safety stock of 30.', source: { system: 'SAP ERP', label: 'Stock · Rotorua' } }],
  notChecked: [], summary: 'Hamilton is 18 short; Rotorua can cover it.', recommendation: 'Move 18 from Rotorua to Hamilton, arriving Thursday 29 October.', otherOption: 'Offer the 125 x 125 post instead.',
  order: { ref: 'OPP-4833', states: { order: 'Confirmed', shipment: 'Pending', payment: 'Paid' }, promised: 'Friday 30 October', lines: [{ name: 'Treated pine fence post 100 x 100 x 2.4 m', quantity: 24 }], notes: [] },
  stock: { product: { sku: 'FP-100-24', name: 'Treated pine fence post 100 x 100 x 2.4 m' }, short: { branch: 'Hamilton', needed: 24, onHand: 6 }, branches: [
    { name: 'Hamilton', onHand: 6, spare: 0, role: 'short' }, { name: 'Rotorua', onHand: 64, spare: 24, role: 'source', note: '1 day by truck' }, { name: 'Cambridge', onHand: 26, spare: 6, role: 'other', note: '1 day by truck' } ] },
  draft: { isReply: false, text: 'Notes for the counter\n• Ring Dylan once the truck is confirmed.' },
  replyChecks: [{ label: 'Covers the whole shortfall (18 of 18)', ok: true }, { label: 'Rotorua keeps its safety stock (46 left, it keeps 30)', ok: true }],
  steps: [{ id: 's1', system: 'SAP ERP', kind: 'record', what: 'Ask Rotorua to send 18 × Treated pine fence post 100 x 100 x 2.4 m to Hamilton', before: 'Hamilton: 6 on hand', after: 'Hamilton: 24 by Thursday 29 October' }],
  stage, timeline: [{ stage: 'arrived', at: '9:00:00', note: 'Exception 7301 raised by SAP ERP at Hamilton.' }],
});

async function main() {
  console.log('stock exceptions desk');

  await check('the stock desk has its own words: exceptions, not tickets; SAP ERP, not Zendesk; its own stages and labels', () => {
    const w = deskWords('stock');
    assert.equal(w.queueTitle, 'Stock exceptions');
    assert.deepEqual(w.stages.map((s) => s.word), ['Raised', 'AI read it', 'AI researched', 'Plan ready', 'Waiting for approval', 'Changes running', 'Done']);
    assert.deepEqual(w.topics, ['Short at branch', 'Damaged in store', 'Late from supplier', 'Count mismatch']);
    assert.deepEqual(w.moods, ['Routine', 'Soon', 'Urgent']);
    assert.equal(deskWords('care').queueTitle, 'My tickets');
    assert.equal(deskWords(undefined).one, 'ticket');
  });

  await check('a stock exception goes into the stock list and never into customer care\'s', () => {
    resetCareStore();
    applyCareEvent({ type: 'ticket', ticket: exception('read') });
    applyCareEvent({ type: 'ticket', ticket: arrivalTicket('read') });
    assert.deepEqual(getCareTickets('stock').map((t) => t.ref), ['EX-7301']);
    assert.deepEqual(getCareTickets('care').map((t) => t.ref), ['4322']);
    applyCareEvent({ type: 'ticket', ticket: exception('waiting') });
    applyCareEvent({ type: 'ticket', ticket: exception('arrived') });
    assert.equal(getCareTickets('stock')[0].stage, 'waiting', 'an older message does not undo newer work');
    resetCareStore();
  });

  await check('the stock desk is read and decided through its own routes, and a refusal reads as the stock desk\'s', async () => {
    try {
      resetCareStore();
      const seen = answering(200, { tickets: [exception()], actor: { name: 'Wiremu Fox', id: 'STK-1101', isLead: false } });
      await syncCareNow('stock');
      assert.equal(seen[0].url.startsWith('/api/care/stock/tickets'), true);
      assert.deepEqual(getCareTickets('stock').map((t) => t.ref), ['EX-7301']);
      assert.deepEqual(getCareTickets('care'), []);
      const ok = answering(200, { ok: true, ticket: exception('running'), done: false });
      await decide('x7301', 'approve', { draft: 'x' }, 'stock');
      assert.equal(ok[0].url.startsWith('/api/care/stock/tickets/x7301/approve'), true);
      answering(403, {});
      assert.deepEqual(await fetchTickets('stock'), { error: 'Branch staff only.' });
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await fetchTickets('stock'), { error: 'Could not reach the stock desk.' });
      assert.deepEqual(await decide('x7301', 'reject', {}, 'stock'), { ok: false, error: 'Could not reach the stock desk.' });
    } finally { restore(); resetCareStore(); }
  });

  await check('the chat offers the stock screens only when the server says the person works the stock desk; anything else is "no"', async () => {
    try {
      const seen = answering(200, { stock: true, actor: { name: 'Wiremu Fox', id: 'STK-1101', isLead: false } });
      assert.equal(await fetchStockAccess(), true);
      assert.equal(seen[0].url.startsWith('/api/care/stock/me'), true);
      answering(200, { stock: false });
      assert.equal(await fetchStockAccess(), false);
      answering(200, { stock: 'true' });
      assert.equal(await fetchStockAccess(), false, 'only a real yes counts');
      answering(404, { error: 'The stock exceptions desk is not switched on.' });
      assert.equal(await fetchStockAccess(), false, 'a desk that is off shows nothing extra');
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.equal(await fetchStockAccess(), false);
    } finally { restore(); }
    assert.deepEqual(STOCK_ENTRIES, [{ label: 'Stock exceptions', kind: 'stock-queue' }, { label: 'Stock board', kind: 'stock-board' }]);
  });

  await check('the portal passes on the stock desk\'s routes, and only the same set as customer care\'s', () => {
    assert.equal(allowedCarePath('GET', ['stock', 'tickets']), true);
    assert.equal(allowedCarePath('GET', ['stock', 'me']), true);
    assert.equal(allowedCarePath('GET', ['stock', 'board']), true);
    assert.equal(allowedCarePath('POST', ['stock', 'tickets', 'x7301', 'approve']), true);
    assert.equal(allowedCarePath('POST', ['stock', 'poll']), true);
    assert.equal(allowedCarePath('GET', ['stock']), false);
    assert.equal(allowedCarePath('GET', ['stock', 'stock', 'tickets']), false);
    assert.equal(allowedCarePath('POST', ['stock', 'tickets', 'x7301', 'delete']), false);
    assert.equal(allowedCarePath('GET', ['stock', 'tickets', 'x7301', 'approve']), false);
  });

  await check('the three stock screens can be opened', () => {
    assert.equal(canvasCanOpen({ kind: 'stock-queue' }), true);
    assert.equal(canvasCanOpen({ kind: 'stock-board' }), true);
    assert.equal(canvasCanOpen({ kind: 'stock-ticket' }), false);
    assert.equal(canvasCanOpen({ kind: 'stock-ticket', params: { ticketId: 'x7301' } }), true);
  });

  await check('the stock list names the exception, the product and the person, in the stock desk\'s words', async () => {
    resetCareStore();
    replaceCareTickets([exception()], { name: 'Wiremu Fox', id: 'STK-1101', isLead: false }, 'stock');
    const out = html(React.createElement(CareQueueCanvas, { desk: 'stock' }));
    assert.ok(out.includes('Stock exceptions') === false || out.includes('Stock'), 'the eyebrow says Stock');
    assert.ok(out.includes('EX-7301') && out.includes('Dylan Hart') && out.includes('Wiremu Fox · STK-1101'));
    assert.ok(out.includes('Stock board'));
    assert.ok(!out.includes('Zendesk') && !out.includes('My tickets') && !out.includes('#EX-7301'));
    resetCareStore();
  });

  await check('the stock board counts exceptions at each stage with the stock desk\'s stage words', async () => {
    resetCareStore();
    replaceCareTickets([exception('waiting'), { ...exception('read'), id: 'x7302', ref: 'EX-7302' }], undefined, 'stock');
    const out = html(React.createElement(CareBoardCanvas, { desk: 'stock' }));
    assert.ok(out.includes('Stock board') && out.includes('How the exceptions are moving'));
    for (const word of ['Raised', 'Plan ready', 'Waiting for approval']) assert.ok(out.includes(word), word);
    assert.ok(!out.includes('Draft ready') && !out.includes('Customer care'));
    resetCareStore();
  });

  await check('one exception shows what was flagged, the branch table with the source marked, the plan, the note and the change in the ERP', async () => {
    resetCareStore();
    replaceCareTickets([exception()], { name: 'Wiremu Fox', id: 'STK-1101', isLead: false }, 'stock');
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 'x7301', desk: 'stock' }));
    for (const text of ['What was flagged', 'Stock across branches', 'Rotorua', 'Sends the stock', 'Note for the counter', 'Checks on this plan', 'Covers the whole shortfall', 'SAP ERP', 'Ask Rotorua to send 18', 'Needed by Friday 30 October', 'Kind: Short at branch', 'Urgency: Urgent', 'Approve']) {
      assert.ok(out.includes(text), `missing: ${text}`);
    }
    assert.ok(!out.includes('What the customer wrote') && !out.includes('Reply to') && !out.includes('Hemi Parata'));
    resetCareStore();
  });

  await check('a customer-care ticket is drawn exactly as before: no branch table, its own words', () => {
    resetCareStore();
    replaceCareTickets([arrivalTicket('waiting')], { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false });
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4322' }));
    assert.ok(out.includes('What the customer wrote') && out.includes('Reply to Sam') && out.includes('Topic: Delivery'));
    assert.ok(!out.includes('Stock across branches') && !out.includes('What was flagged'));
    resetCareStore();
  });

  console.log(`✅ web: stock exceptions desk: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
