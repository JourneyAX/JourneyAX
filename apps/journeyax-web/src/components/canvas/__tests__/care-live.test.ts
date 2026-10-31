/**
 * Connected to the care desk (no preview switch): the portal starts with no tickets, shows what the desk sends, never shows a ticket that is not
 * real, and carries a decision to the desk and says plainly when it was refused.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/canvas/__tests__/care-live.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARE_TICKETS, arrivalTicket } from '../care/careData';
import { FIXTURES, decide, fetchCareAccess, fetchTickets } from '../care/careApi';
import { CARE_ENTRIES } from '../care/careAccess';
import { getCareTickets, replaceCareTickets, resetCareStore, syncCareNow } from '../care/careStore';
import CareQueueCanvas from '../care/CareQueueCanvas';
import CareTicketCanvas from '../care/CareTicketCanvas';

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const realFetch = globalThis.fetch;
const answering = (status: number, body: unknown, seen: Array<{ url: string; init?: any }> = []) => { (globalThis as any).fetch = async (url: string, init?: any) => { seen.push({ url: String(url), init }); return { ok: status < 400, status, json: async () => body }; }; return seen; };
const restore = () => { (globalThis as any).fetch = realFetch; };

async function main() {
  console.log('customer care canvases, connected');

  await check('with no preview switch the store starts empty: a care person is never shown tickets that are not real', () => {
    assert.equal(FIXTURES, false);
    resetCareStore();
    assert.equal(getCareTickets().length, 0);
    const out = renderToStaticMarkup(React.createElement(CareQueueCanvas));
    assert.ok(!out.includes('Jess Carter') && !out.includes('My vanity has not arrived'));
    assert.ok(!out.includes('Aroha Ngata'), 'no made-up person either');
  });

  await check('the desk\'s list is shown as it is sent, with the person it names, and a ticket is never taken back a stage', async () => {
    resetCareStore();
    const seen = answering(200, { tickets: [arrivalTicket('waiting')], actor: { name: 'Hemi Parata', id: 'TL-2001', isLead: true } });
    try {
      await syncCareNow();
      assert.equal(seen[0].url.startsWith('/api/care/tickets'), true);
      assert.deepEqual(getCareTickets().map((t) => t.ref), ['4322']);
      answering(200, { tickets: [arrivalTicket('read')] });
      await syncCareNow();
      assert.equal(getCareTickets()[0].stage, 'waiting', 'a slower answer does not undo what is already shown');
    } finally { restore(); resetCareStore(); }
  });

  await check('a refusal or a desk that is down is reported in plain words and changes nothing already shown', async () => {
    try {
      answering(403, { error: 'Customer care only.' });
      assert.deepEqual(await fetchTickets(), { error: 'Customer care only.' });
      answering(500, {});
      assert.deepEqual(await fetchTickets(), { error: 'Could not read the tickets.' });
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await fetchTickets(), { error: 'Could not reach the care desk.' });
      replaceCareTickets([arrivalTicket('waiting')]);
      await syncCareNow();
      assert.equal(getCareTickets().length, 1, 'the last good list stays on screen');
    } finally { restore(); resetCareStore(); }
  });

  await check('a decision is sent to the desk with the exact draft and the removed steps; a refusal comes back as its own words', async () => {
    try {
      const seen = answering(200, { ok: true, ticket: arrivalTicket('running'), done: false });
      const ok = await decide('t4322', 'approve', { draft: 'Kia ora', removedSteps: ['s3'] });
      assert.equal(ok.ok, true);
      assert.equal(seen[0].url.startsWith('/api/care/tickets/t4322/approve'), true);
      assert.deepEqual(JSON.parse(seen[0].init.body), { draft: 'Kia ora', removedSteps: ['s3'] });
      assert.equal(seen[0].init.method, 'POST');
      answering(403, { error: 'Only the team lead can decide this one.' });
      assert.deepEqual(await decide('t4322', 'approve'), { ok: false, error: 'Only the team lead can decide this one.' });
    } finally { restore(); }
  });

  await check('the chat offers the care screens only when the server says the person is care staff; anything else, or a failure, is "no"', async () => {
    try {
      const seen = answering(200, { care: true, actor: { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false } });
      assert.equal(await fetchCareAccess(), true);
      assert.equal(seen[0].url.startsWith('/api/care/me'), true);
      answering(200, { care: false });
      assert.equal(await fetchCareAccess(), false, 'signed in but not care staff');
      answering(200, {});
      assert.equal(await fetchCareAccess(), false, 'an answer that does not say yes is no');
      answering(200, { care: 'true' });
      assert.equal(await fetchCareAccess(), false, 'only a real yes counts');
      answering(401, { error: 'Sign in.' });
      assert.equal(await fetchCareAccess(), false, 'signed out');
      answering(500, {});
      assert.equal(await fetchCareAccess(), false);
      (globalThis as any).fetch = async () => { throw new Error('offline'); };
      assert.equal(await fetchCareAccess(), false, 'a desk that is down shows nothing extra');
    } finally { restore(); }
    assert.deepEqual(CARE_ENTRIES, [{ label: 'My tickets', kind: 'care-queue' }, { label: 'Care board', kind: 'care-board' }]);
  });

  await check('a ticket that is not there says so and offers the way back, with no ticket invented', () => {
    resetCareStore();
    const out = renderToStaticMarkup(React.createElement(CareTicketCanvas, { ticketId: 't4312' }));
    assert.ok(out.includes('We could not find that ticket'));
    assert.equal(CARE_TICKETS.length > 0, true);
  });

  console.log(`✅ web: customer care canvases, connected: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
