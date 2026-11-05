/**
 * The customer-care canvases: the promised-time clock, which ticket is "next", what a care person may and may not approve, and that every
 * status is a word as well as a colour.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/canvas/__tests__/care.test.ts
 */
import './fixtures-on';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARE_STAGES, CARE_TICKETS, arrivalTicket, nextCareTicket, slaClock, stageIndex, STATUS_WORD } from '../care/careData';
import { applyCareEvent, getCareTickets, resetCareStore } from '../care/careStore';
import CareQueueCanvas from '../care/CareQueueCanvas';
import CareTicketCanvas from '../care/CareTicketCanvas';
import CareBoardCanvas from '../care/CareBoardCanvas';
import { canvasCanOpen } from '@/lib/shell/canvasRegistry';
import '../registry';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

console.log('customer care canvases');

check('the clock is fine over 15 minutes, close under, late when negative, and always carries words and an icon', () => {
  assert.deepEqual(slaClock(192), { text: '3h 12m left', tone: 'ok', icon: '✓' });
  assert.equal(slaClock(15).tone, 'warn');
  assert.equal(slaClock(11).text, '11m left');
  assert.deepEqual(slaClock(-12), { text: 'Late 12m', tone: 'bad', icon: '▲' });
});

check('the next ticket is the closest to late among those the person can decide; a team-lead ticket is never offered', () => {
  const next = nextCareTicket();
  assert.equal(next?.ref, '4315');
  const lead = CARE_TICKETS.find((t) => t.status === 'lead');
  assert.ok(lead && lead.slaMinutes < next!.slaMinutes, 'the lead ticket is later than every other, and still not offered');
  assert.equal(nextCareTicket(CARE_TICKETS.filter((t) => t.status === 'lead')), undefined);
});

check('every status has a word, an icon and a tone, so colour is never the only signal', () => {
  for (const s of Object.values(STATUS_WORD)) assert.ok(s.word.length > 2 && s.icon.length > 0 && s.tone.length > 0);
});

check('fixture care surfaces cannot open in the real canvas registry, even when a ticket id is supplied', () => {
  assert.equal(canvasCanOpen({ kind: 'care-queue' }), false);
  assert.equal(canvasCanOpen({ kind: 'care-board' }), false);
  assert.equal(canvasCanOpen({ kind: 'care-ticket' }), false);
  assert.equal(canvasCanOpen({ kind: 'care-ticket', params: { ticketId: 't4312' } }), false);
});

check('the queue counts what the person decides apart from what the team lead decides, and offers the right ticket next', () => {
  const out = html(React.createElement(CareQueueCanvas));
  assert.ok(out.includes('3 for you to decide'));
  assert.ok(out.includes('1 waiting for the team lead'));
  assert.ok(out.includes('Take the next one (#4315)'));
  assert.ok(out.includes('Needs attention (4)'));
});

check('a ticket for the rep can be approved: it says what is emailed and offers Approve; nothing runs until then', () => {
  const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4312' }));
  assert.ok(out.includes('>Approve<'));
  assert.ok(out.includes('is emailed to Jess Carter and anyone copied in'));
  assert.ok(out.includes('Nothing is sent or changed until you approve'));
  assert.ok(out.includes('commercetools · Order 7C41D9A2'), 'each fact carries its source');
  assert.ok(out.includes('Not checked:'));
  assert.ok(!out.includes('Done.'), 'nothing is done yet');
});

check('a ticket only the team lead may approve has no Approve button, and says why', () => {
  const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4321' }));
  assert.ok(!out.includes('>Approve<'));
  assert.ok(out.includes('Only the team lead can approve this one'));
  assert.ok(out.includes('Send to Hemi Parata (TL-2001)'));
  assert.ok(out.includes('Internal only'), 'call notes never go to the customer');
});

check('a reply that names a refund is flagged for the person to look at', () => {
  const out = html(React.createElement(CareTicketCanvas, { ticketId: 't4315' }));
  assert.ok(out.includes('cv__check--look'));
  assert.ok(out.includes('Moves money'));
});

check('an unknown ticket gets a plain message and a way back', () => {
  const out = html(React.createElement(CareTicketCanvas, { ticketId: 'nope' }));
  assert.ok(out.includes('We could not find that ticket') && out.includes('Back to my tickets'));
});

check('the board shows the seven stages the tickets move through, says its time figures are medians, and splits the AI drafts three ways', () => {
  const out = html(React.createElement(CareBoardCanvas));
  assert.ok(out.includes('time figures are medians'));
  assert.ok(out.includes('Sent as written 61%') && out.includes('Edited 31%') && out.includes('Discarded 8%'));
  assert.ok(out.includes('How the tickets are moving'));
  for (const word of ['Arrived', 'AI read it', 'AI researched', 'Draft ready', 'Waiting for approval', 'Changes running', 'Done']) assert.ok(out.includes(word), word);
});

check('a ticket moves through the stages in order, and each stage says what it does', () => {
  assert.deepEqual(CARE_STAGES.map((s) => s.id), ['arrived', 'read', 'researched', 'drafted', 'waiting', 'running', 'done']);
  for (const s of CARE_STAGES) assert.ok(s.word.length > 3 && s.doing.length > 10);
  assert.ok(stageIndex('read') < stageIndex('researched') && stageIndex('waiting') < stageIndex('running'));
});

check('the timeline grows by one dated line per stage, and the AI stages say what the AI did', () => {
  const lengths = (['arrived', 'read', 'researched', 'drafted', 'waiting'] as const).map((st) => arrivalTicket(st).timeline.length);
  assert.deepEqual(lengths, [1, 2, 3, 4, 5]);
  const full = arrivalTicket('waiting');
  assert.ok(full.timeline[0].note.includes('reached Zendesk'));
  assert.ok(full.timeline[1].note.includes('topic delivery'));
  assert.ok(full.timeline[2].note.includes('commercetools'));
  assert.ok(full.timeline.every((e) => /^\d+:\d\d:\d\d$/.test(e.at)));
  assert.equal(arrivalTicket('read').status, 'ai');
  assert.equal(arrivalTicket('waiting').status, 'decide');
});

check('a new ticket appears at the top the moment it arrives, moves on stage by stage, and never goes backwards', () => {
  resetCareStore();
  const before = getCareTickets().length;
  applyCareEvent({ type: 'ticket', ticket: arrivalTicket('arrived') });
  assert.equal(getCareTickets().length, before + 1);
  assert.equal(getCareTickets()[0].ref, '4322');
  applyCareEvent({ type: 'ticket', ticket: arrivalTicket('researched') });
  assert.equal(getCareTickets().length, before + 1, 'the same ticket is replaced, not added twice');
  assert.equal(getCareTickets()[0].stage, 'researched');
  applyCareEvent({ type: 'ticket', ticket: arrivalTicket('read') });
  assert.equal(getCareTickets()[0].stage, 'researched', 'an older message does not undo newer work');
  resetCareStore();
  assert.equal(getCareTickets().length, before);
});

console.log(`✅ web: customer care canvases: ${passed} passed, 0 failed`);
