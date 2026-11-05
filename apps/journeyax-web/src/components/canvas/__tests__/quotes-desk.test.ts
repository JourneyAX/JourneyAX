/**
 * The quotes desk, drawn by the care canvases: its own words, its own list apart from the other desks', its own routes, and the priced quote as a
 * table. Connected (no preview switch), so nothing is shown that the desk did not send.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/canvas/__tests__/quotes-desk.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { arrivalTicket, type CareTicket } from '../care/careData';
import { decide, fetchDeskAccess, fetchTickets } from '../care/careApi';
import { QUOTES_ENTRIES } from '../care/careAccess';
import { dayLabel, deskOf, deskWords, formatMoney } from '../care/deskWords';
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

const request = (stage: CareTicket['stage'] = 'waiting'): CareTicket => ({
  id: 'q501', desk: 'quotes', ref: 'QT-501', subject: 'Quote for Hartley Construction Ltd: 3 products', status: stage === 'waiting' ? 'decide' : 'ai', channel: 'Raised by Salesforce',
  message: 'Hi, we are building a 40 square metre deck for a client in Hamilton and want to lock in pricing.',
  customer: { name: 'Sam Hartley', account: 'Hartley Construction Ltd', since: '', earlier: 'Deal OPP-0912' }, assignee: { name: 'Hana Williams', id: 'SLS-2101' }, slaMinutes: 205,
  topic: { value: 'New quote', confidence: 'High' }, mood: { value: 'Soon', confidence: 'Medium' },
  found: [{ text: 'Hartley Construction Ltd is on Silver trade prices, terms 20th of the month. Nothing is overdue.', source: { system: 'SAP ERP', label: 'Account ACC-9001' } }],
  notChecked: [], summary: '3 lines at Silver trade prices: $4,250.12 with GST.', recommendation: 'Send the quote at Silver trade prices and hold the stock.', otherOption: 'Ring Sam first to go through the quote.',
  quote: {
    tier: 'Silver', currency: 'NZD', validUntil: '2026-11-11', branch: 'Hamilton', subtotal: 3695.76, gst: 554.36, total: 4250.12, discountPercent: 10,
    lines: [
      { sku: 'DB-140-48', name: 'Decking board 140 x 32 x 4.8 m', quantity: 80, unit: 'each', retailPrice: 38.4, unitPrice: 34.56, lineTotal: 2764.8, stock: '110 in stock at Hamilton' },
      { sku: 'FR-100-36', name: 'Treated pine fence rail 100 x 50 x 3.6 m', quantity: 24, unit: 'each', retailPrice: 18.6, unitPrice: 16.74, lineTotal: 401.76, stock: '60 in stock at Hamilton' },
    ],
  },
  draft: { isReply: true, text: 'Kia ora Sam,\n\nYour quote is attached: $3,695.76 before GST, $4,250.12 with GST.\n\nNgā mihi,\nHana' },
  replyChecks: [{ label: 'Every line is priced at Silver trade prices (3 of 3)', ok: true }, { label: 'Amounts in the email match the quote', ok: true }],
  steps: [
    { id: 's1', system: 'Salesforce', kind: 'record', what: 'Create the quote for Hartley Construction Ltd on deal OPP-0912', before: 'Deal stage: Propose', after: 'Quote $4,250.12 with GST, valid to Wednesday 11 November' },
    { id: 's2', system: 'Salesforce', kind: 'customer', what: 'Email the quote to Sam Hartley', after: '$4,250.12 with GST' },
    { id: 's3', system: 'SAP ERP', kind: 'record', what: 'Hold the stock at Hamilton', after: 'Held until Wednesday 11 November' },
  ],
  stage, timeline: [{ stage: 'arrived', at: '9:00:00', note: 'Quote request 501 raised by Salesforce for deal OPP-0912.' }],
});

async function main() {
  console.log('quotes desk');

  await check('the quotes desk has its own words: quote requests, Salesforce, its own stages and labels', () => {
    const w = deskWords('quotes');
    assert.equal(w.queueTitle, 'Quote requests');
    assert.deepEqual(w.stages.map((s) => s.word), ['Requested', 'AI read it', 'AI priced it', 'Quote ready', 'Waiting for approval', 'Changes running', 'Done']);
    assert.deepEqual(w.topics, ['New quote', 'Repeat order', 'Large job', 'Price check']);
    assert.equal(w.noteHeading('Sam', true), 'Email to Sam');
    assert.equal(deskWords('stock').queueTitle, 'Stock exceptions');
    assert.equal(deskOf({ desk: 'quotes' }), 'quotes');
    assert.equal(deskOf({ desk: 'stock' }), 'stock');
    assert.equal(deskOf({}), 'care');
  });

  await check('money and days read the New Zealand way', () => {
    assert.equal(formatMoney(4250.12, 'NZD'), '$4,250.12');
    assert.equal(formatMoney(5, 'NZD'), '$5.00');
    assert.equal(formatMoney(4250.12), '4,250.12', 'with no declared currency there is no symbol');
    assert.equal(dayLabel('2026-11-11'), 'Wednesday 11 November');
    assert.equal(dayLabel('soon'), '');
  });

  await check('a quote request goes into the quotes list and never into the other desks\'', () => {
    resetCareStore();
    applyCareEvent({ type: 'ticket', ticket: request('read') });
    applyCareEvent({ type: 'ticket', ticket: arrivalTicket('read') });
    assert.deepEqual(getCareTickets('quotes').map((t) => t.ref), ['QT-501']);
    assert.deepEqual(getCareTickets('care').map((t) => t.ref), ['4322']);
    assert.deepEqual(getCareTickets('stock'), []);
    applyCareEvent({ type: 'ticket', ticket: request('waiting') });
    applyCareEvent({ type: 'ticket', ticket: request('arrived') });
    assert.equal(getCareTickets('quotes')[0].stage, 'waiting', 'an older message does not undo newer work');
    resetCareStore();
  });

  await check('the quotes desk is read and decided through its own routes, and a refusal reads as the quotes desk\'s', async () => {
    try {
      resetCareStore();
      const seen = answering(200, { tickets: [request()], actor: { name: 'Hana Williams', id: 'SLS-2101', isLead: false } });
      await syncCareNow('quotes');
      assert.equal(seen[0].url.startsWith('/api/care/quotes/tickets'), true);
      assert.deepEqual(getCareTickets('quotes').map((t) => t.ref), ['QT-501']);
      assert.deepEqual(getCareTickets('stock'), []);
      const ok = answering(200, { ok: true, ticket: request('running'), done: false });
      await decide('q501', 'approve', { draft: 'x' }, 'quotes');
      assert.equal(ok[0].url.startsWith('/api/care/quotes/tickets/q501/approve'), true);
      answering(403, {});
      assert.deepEqual(await fetchTickets('quotes'), { error: 'Sales staff only.' });
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await fetchTickets('quotes'), { error: 'Could not reach the quotes desk.' });
      assert.deepEqual(await decide('q501', 'reject', {}, 'quotes'), { ok: false, error: 'Could not reach the quotes desk.' });
    } finally { restore(); resetCareStore(); }
  });

  await check('the chat offers the quotes screens only when the server says the person works the quotes desk; anything else is "no"', async () => {
    try {
      const seen = answering(200, { quotes: true, actor: { name: 'Hana Williams', id: 'SLS-2101', isLead: false } });
      assert.equal(await fetchDeskAccess('quotes'), true);
      assert.equal(seen[0].url.startsWith('/api/care/quotes/me'), true);
      answering(200, { quotes: false });
      assert.equal(await fetchDeskAccess('quotes'), false);
      answering(200, { stock: true });
      assert.equal(await fetchDeskAccess('quotes'), false, 'a yes for another desk is not a yes for this one');
      answering(404, { error: 'That desk is not switched on.' });
      assert.equal(await fetchDeskAccess('quotes'), false);
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.equal(await fetchDeskAccess('quotes'), false);
    } finally { restore(); }
    assert.deepEqual(QUOTES_ENTRIES, [{ label: 'Quote requests', kind: 'quotes-queue' }, { label: 'Quotes board', kind: 'quotes-board' }]);
  });

  await check('the portal passes on the quotes desk\'s routes, the same set as the other desks\'', () => {
    assert.equal(allowedCarePath('GET', ['quotes', 'tickets']), true);
    assert.equal(allowedCarePath('GET', ['quotes', 'me']), true);
    assert.equal(allowedCarePath('POST', ['quotes', 'tickets', 'q501', 'approve']), true);
    assert.equal(allowedCarePath('GET', ['quotes']), false);
    assert.equal(allowedCarePath('GET', ['quotes', 'quotes', 'tickets']), false);
    assert.equal(allowedCarePath('POST', ['quotes', 'tickets', 'q501', 'delete']), false);
    assert.equal(allowedCarePath('GET', ['other', 'tickets']), false);
  });

  await check('the retired fixture quote screens stay closed in the real registry', () => {
    assert.equal(canvasCanOpen({ kind: 'quotes-queue' }), false, 'retired fixture surfaces stay unregistered');
    assert.equal(canvasCanOpen({ kind: 'quotes-board' }), false);
    assert.equal(canvasCanOpen({ kind: 'quotes-ticket' }), false);
    assert.equal(canvasCanOpen({ kind: 'quotes-ticket', params: { ticketId: 'q501' } }), false);
  });

  await check('the quote list names the request, the contact and the person, in the quotes desk\'s words', () => {
    resetCareStore();
    replaceCareTickets([request()], { name: 'Hana Williams', id: 'SLS-2101', isLead: false }, 'quotes');
    const out = html(React.createElement(CareQueueCanvas, { desk: 'quotes' }));
    assert.ok(out.includes('QT-501') && out.includes('Sam Hartley') && out.includes('Hana Williams · SLS-2101') && out.includes('Quotes board'));
    assert.ok(!out.includes('Zendesk') && !out.includes('My tickets') && !out.includes('Stock exceptions'));
    resetCareStore();
  });

  await check('the quotes board counts requests at each stage with the quotes desk\'s stage words', () => {
    resetCareStore();
    replaceCareTickets([request('waiting'), { ...request('read'), id: 'q502', ref: 'QT-502' }], undefined, 'quotes');
    const out = html(React.createElement(CareBoardCanvas, { desk: 'quotes' }));
    assert.ok(out.includes('Quotes board') && out.includes('How the quote requests are moving'));
    for (const word of ['Requested', 'AI priced it', 'Quote ready', 'Waiting for approval']) assert.ok(out.includes(word), word);
    assert.ok(!out.includes('Draft ready') && !out.includes('Plan ready'));
    resetCareStore();
  });

  await check('one quote request shows what the customer asked, the priced quote as a table with totals, the email, the checks and the three changes', () => {
    resetCareStore();
    replaceCareTickets([request()], { name: 'Hana Williams', id: 'SLS-2101', isLead: false }, 'quotes');
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 'q501', desk: 'quotes' }));
    for (const text of ['What the customer asked', 'The quote', 'Silver trade prices · 10% under retail · delivered from Hamilton', 'prices and stock hold to Wednesday 11 November', '$34.56', '$2,764.80', 'Subtotal before GST', '$3,695.76', 'GST 15%', '$554.36', 'Total with GST', '$4,250.12', '110 in stock at Hamilton', 'Email to Sam', 'This is emailed to Sam Hartley', 'Checks on this quote', 'Email the quote to Sam Hartley', 'Hold the stock at Hamilton', 'Kind: New quote', 'Urgency: Soon', 'Approve']) {
      assert.ok(out.includes(text), `missing: ${text}`);
    }
    assert.ok(!out.includes('What the customer wrote') && !out.includes('Hemi Parata') && !out.includes('Stock across branches'));
    resetCareStore();
  });

  await check('a customer-care ticket is drawn exactly as before: no quote table, its own words', () => {
    resetCareStore();
    replaceCareTickets([arrivalTicket('waiting')], { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false });
    const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4322' }));
    assert.ok(out.includes('What the customer wrote') && out.includes('Reply to Sam') && out.includes('Topic: Delivery'));
    assert.ok(!out.includes('The quote') && !out.includes('What the customer asked'));
    resetCareStore();
  });

  console.log(`✅ web: quotes desk: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
