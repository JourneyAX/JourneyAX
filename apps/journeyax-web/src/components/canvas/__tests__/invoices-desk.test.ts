/**
 * The invoices desk, drawn by the care canvases: its own words, its own list apart from the other desks', its own routes, and the invoice compared with
 * the order and the delivery as a table. Connected (no preview switch), so nothing is shown that the desk did not send.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/canvas/__tests__/invoices-desk.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { arrivalTicket, type CareTicket } from '../care/careData';
import { decide, fetchDeskAccess, fetchTickets } from '../care/careApi';
import { INVOICES_ENTRIES } from '../care/careAccess';
import { deskOf, deskWords } from '../care/deskWords';
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
  id: 'i8101', desk: 'invoices', ref: 'IX-8101', subject: 'Invoice INV-6032: Hartley Construction Ltd says it is wrong', status: stage === 'waiting' ? 'decide' : 'ai', channel: 'Raised by SAP ERP',
  message: 'Hi, the invoice for the deck order is far more than the price we were quoted. We are on silver trade prices.',
  customer: { name: 'Sam Hartley', account: 'Hartley Construction Ltd', since: '', earlier: 'Invoice INV-6032' }, assignee: { name: 'Ana Rangi', id: 'FIN-3101' }, slaMinutes: 205,
  topic: { value: 'Price mismatch', confidence: 'High' }, mood: { value: 'Soon', confidence: 'Medium' },
  found: [{ text: 'Invoice INV-6032 for Hartley Construction Ltd is $4,654.74 with GST.', source: { system: 'SAP ERP', label: 'Invoice INV-6032' } }],
  notChecked: [], summary: 'Two lines at retail: credit $404.62 with GST.', recommendation: 'Issue a credit note for $404.62 with GST and email it.', otherOption: 'Ring Sam first.',
  invoice: {
    invoiceId: 'INV-6032', orderRef: 'OPP-4851', deliveryId: 'DEL-31001', tier: 'Silver', currency: 'NZD', invoiceTotal: 4654.74, overcharge: 351.84, gst: 52.78, credit: 404.62, balanceBefore: 6000, balanceAfter: 5595.38, owner: 'Hana Williams',
    lines: [
      { sku: 'DB-140-48', name: 'Decking board 140 x 32 x 4.8 m', invoicedQty: 80, invoicedPrice: 38.4, rightQty: 80, rightPrice: 34.56, over: 307.2, why: 'Not the price on the order' },
      { sku: 'DP-25-40', name: 'Decking pedestal 25-40 mm', invoicedQty: 60, invoicedPrice: 8.82, rightQty: 60, rightPrice: 8.82, over: 0, why: 'Matches' },
    ],
  },
  draft: { isReply: true, text: 'Kia ora Sam,\n\nYou are right. We have issued a credit note for $404.62 including GST.\n\nNgā mihi,\nAna' },
  replyChecks: [{ label: 'The credit is the whole difference ($351.84 plus $52.78 GST)', ok: true }, { label: 'Amounts in the email match the credit note', ok: true }],
  steps: [
    { id: 's1', system: 'SAP ERP', kind: 'money', what: 'Issue a credit note against invoice INV-6032', before: 'Invoice $4,654.74', after: 'Credit $404.62 with GST' },
    { id: 's2', system: 'SAP ERP', kind: 'customer', what: 'Email the credit note to Sam Hartley', after: '$404.62 with GST' },
    { id: 's3', system: 'Salesforce', kind: 'record', what: 'Create a task for Hana Williams to find out how it happened', after: 'Check invoice INV-6032: price was wrong' },
  ],
  stage, timeline: [{ stage: 'arrived', at: '9:00:00', note: 'Invoice exception 8101 raised by SAP ERP for invoice INV-6032.' }],
});

async function main() {
  console.log('invoices desk');

  await check('the invoices desk has its own words: invoice exceptions, SAP ERP, its own stages and labels', () => {
    const w = deskWords('invoices');
    assert.equal(w.queueTitle, 'Invoice exceptions');
    assert.equal(w.boardTitle, 'Finance board');
    assert.deepEqual(w.stages.map((s) => s.word), ['Flagged', 'AI read it', 'AI matched it', 'Credit ready', 'Waiting for approval', 'Changes running', 'Done']);
    assert.deepEqual(w.topics, ['Price mismatch', 'Quantity mismatch', 'Duplicate invoice', 'Missing credit note']);
    assert.equal(w.noteHeading('Sam', true), 'Email to Sam');
    assert.equal(deskOf({ desk: 'invoices' }), 'invoices');
    assert.equal(deskOf({ desk: 'quotes' }), 'quotes');
    assert.equal(deskOf({}), 'care');
  });

  await check('an invoice exception goes into the invoices list and never into the other desks\'', () => {
    resetCareStore();
    applyCareEvent({ type: 'ticket', ticket: exception('read') });
    applyCareEvent({ type: 'ticket', ticket: arrivalTicket('read') });
    assert.deepEqual(getCareTickets('invoices').map((t) => t.ref), ['IX-8101']);
    assert.deepEqual(getCareTickets('care').map((t) => t.ref), ['4322']);
    assert.deepEqual(getCareTickets('stock'), []);
    assert.deepEqual(getCareTickets('quotes'), []);
    applyCareEvent({ type: 'ticket', ticket: exception('waiting') });
    applyCareEvent({ type: 'ticket', ticket: exception('arrived') });
    assert.equal(getCareTickets('invoices')[0].stage, 'waiting', 'an older message does not undo newer work');
    resetCareStore();
  });

  await check('the invoices desk is read and decided through its own routes, and a refusal reads as the invoices desk\'s', async () => {
    try {
      resetCareStore();
      const seen = answering(200, { tickets: [exception()], actor: { name: 'Ana Rangi', id: 'FIN-3101', isLead: false } });
      await syncCareNow('invoices');
      assert.equal(seen[0].url.startsWith('/api/care/invoices/tickets'), true);
      assert.deepEqual(getCareTickets('invoices').map((t) => t.ref), ['IX-8101']);
      const ok = answering(200, { ok: true, ticket: exception('running'), done: false });
      await decide('i8101', 'approve', { draft: 'x' }, 'invoices');
      assert.equal(ok[0].url.startsWith('/api/care/invoices/tickets/i8101/approve'), true);
      answering(403, {});
      assert.deepEqual(await fetchTickets('invoices'), { error: 'Finance staff only.' });
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await fetchTickets('invoices'), { error: 'Could not reach the invoices desk.' });
    } finally { restore(); resetCareStore(); }
  });

  await check('the chat offers the invoices screens only when the server says the person works the invoices desk', async () => {
    try {
      const seen = answering(200, { invoices: true });
      assert.equal(await fetchDeskAccess('invoices'), true);
      assert.equal(seen[0].url.startsWith('/api/care/invoices/me'), true);
      answering(200, { invoices: false });
      assert.equal(await fetchDeskAccess('invoices'), false);
      answering(200, { quotes: true });
      assert.equal(await fetchDeskAccess('invoices'), false, 'a yes for another desk is not a yes for this one');
      answering(404, {});
      assert.equal(await fetchDeskAccess('invoices'), false);
    } finally { restore(); }
    assert.deepEqual(INVOICES_ENTRIES, [{ label: 'Invoice exceptions', kind: 'invoices-queue' }, { label: 'Finance board', kind: 'invoices-board' }]);
  });

  await check('the portal passes on the invoices desk\'s routes, and the three screens can be opened', () => {
    assert.equal(allowedCarePath('GET', ['invoices', 'tickets']), true);
    assert.equal(allowedCarePath('POST', ['invoices', 'tickets', 'i8101', 'approve']), true);
    assert.equal(allowedCarePath('GET', ['invoices']), false);
    assert.equal(allowedCarePath('POST', ['invoices', 'tickets', 'i8101', 'delete']), false);
    assert.equal(canvasCanOpen({ kind: 'invoices-queue' }), true);
    assert.equal(canvasCanOpen({ kind: 'invoices-board' }), true);
    assert.equal(canvasCanOpen({ kind: 'invoices-ticket' }), false);
    assert.equal(canvasCanOpen({ kind: 'invoices-ticket', params: { ticketId: 'i8101' } }), true);
  });

  await check('the list and the board use the invoices desk\'s words', () => {
    resetCareStore();
    replaceCareTickets([exception(), { ...exception('read'), id: 'i8102', ref: 'IX-8102' }], { name: 'Ana Rangi', id: 'FIN-3101', isLead: false }, 'invoices');
    const list = html(React.createElement(CareQueueCanvas, { desk: 'invoices' }));
    assert.ok(list.includes('IX-8101') && list.includes('Sam Hartley') && list.includes('Ana Rangi · FIN-3101') && list.includes('Finance board'));
    assert.ok(!list.includes('Zendesk') && !list.includes('My tickets'));
    const board = html(React.createElement(CareBoardCanvas, { desk: 'invoices' }));
    assert.ok(board.includes('Finance board') && board.includes('How the invoice exceptions are moving'));
    for (const word of ['Flagged', 'AI matched it', 'Credit ready']) assert.ok(board.includes(word), word);
    assert.ok(!board.includes('Draft ready') && !board.includes('Quote ready'));
    resetCareStore();
  });

  await check('one exception shows what the customer said, the invoice compared line by line with the credit due, the email, the checks and the three changes', () => {
    resetCareStore();
    replaceCareTickets([exception()], { name: 'Ana Rangi', id: 'FIN-3101', isLead: false }, 'invoices');
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 'i8101', desk: 'invoices' }));
    for (const text of ['What the customer said', 'The invoice compared', 'Invoice INV-6032 · $4,654.74 with GST', 'order OPP-4851', 'delivery DEL-31001', 'Silver trade prices', '80 × $38.40', '80 × $34.56', '$307.20', 'Not the price on the order', 'Over-charged before GST', '$351.84', '$52.78', 'Credit due with GST', '$404.62', '$6,000.00 now, $5,595.38 after the credit', 'Account owner: Hana Williams', 'Email to Sam', 'Checks on this correction', 'Issue a credit note against invoice INV-6032', 'Moves money', 'Kind: Price mismatch', 'Approve']) {
      assert.ok(out.includes(text), `missing: ${text}`);
    }
    assert.ok(!out.includes('What the customer wrote') && !out.includes('The quote') && !out.includes('Stock across branches'));
    resetCareStore();
  });

  await check('a customer-care ticket and a quote request are drawn exactly as before: no invoice table', () => {
    resetCareStore();
    replaceCareTickets([arrivalTicket('waiting')], { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false });
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4322' }));
    assert.ok(out.includes('What the customer wrote') && out.includes('Reply to Sam'));
    assert.ok(!out.includes('The invoice compared'));
    resetCareStore();
  });

  console.log(`✅ web: invoices desk: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
