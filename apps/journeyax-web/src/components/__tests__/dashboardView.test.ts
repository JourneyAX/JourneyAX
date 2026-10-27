/**
 * The record card in the thread, the corner tile and the dashboard canvas as the person sees them.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/__tests__/dashboardView.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as any).window = {};
(globalThis as any).document = { visibilityState: 'visible' };
const dashboard = {
  title: 'My day', subtitle: 'Your deals and the cases waiting on you.', scope: 'mine', name: 'Jess Penrose', asOf: new Date().toISOString(),
  tile: [{ id: 'd', label: 'Open deals', value: '22', tone: 'neutral', ok: true }, { id: 'c', label: 'Closing in 14 days', value: '6', tone: 'warn', ok: true }, { id: 'k', label: 'Open cases', value: '10', tone: 'bad', ok: true }],
  metrics: [
    { id: 'd', label: 'Open deals', value: '22', tone: 'neutral', hint: 'worth $78,511', ask: 'Show me my open deals.', ok: true },
    { id: 'k', label: 'Open cases', value: '–', tone: 'neutral', ok: false },
  ],
  sections: [
    { id: 'deals', title: 'Closing soon', state: 'ok', total: 6, rows: [{ title: 'Ngata & Penrose Joinery', subtitle: 'Garrison roof garden', detail: 'Closes 1 Nov', badge: 'Propose', tone: 'warn', amount: '$6,612', ask: 'Tell me about the Ngata deal' }], more: { label: 'See all in chat', prompt: 'Show me my open deals.' } },
    { id: 'cases', title: 'Cases', state: 'blocked', total: 0, rows: [] },
    { id: 'quotes', title: 'Quotes', state: 'unavailable', total: 0, rows: [] },
    { id: 'empty', title: 'Nothing here', state: 'ok', total: 0, rows: [], empty: 'No quotes are ending soon.' },
  ],
};
(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ dashboard }) });

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

async function main() {
  const RecordsCard = (await import('../cards/RecordsCard')).default;
  const { trackDashboard, loadDashboard } = await import('../../lib/shell/dashboardStore');
  const MyDayTile = (await import('../shell/MyDayTile')).default;
  const DashboardCanvas = (await import('../canvas/dashboard/DashboardCanvas')).default;

  console.log('dashboard: card, tile, canvas');

  await check('a records card shows its rows, how many of how many, and presses only where a question is attached', () => {
    const out = html(React.createElement(RecordsCard as any, { state: { heading: 'Open deals', total: 22, shown: 2, rows: [
      { title: 'Ngata & Penrose Joinery', subtitle: 'Garrison roof garden', badge: 'Propose', tone: 'warn', amount: '$6,612', ask: 'Tell me about it' },
      { title: 'Okafor & Yardley', detail: 'Closes 4 Nov' },
    ] } }));
    assert.match(out, /Open deals/);
    assert.match(out, /2 of 22/);
    assert.match(out, /\$6,612/);
    assert.match(out, /rec__badge--warn/);
    assert.equal((out.match(/<button/g) || []).length, 1, 'only the row with a question is a button');
    assert.match(out, /Closes 4 Nov/);
  });

  await check('a card with no rows, or no heading, draws nothing; and no count is shown when all of them are there', () => {
    assert.equal(html(React.createElement(RecordsCard as any, { state: { heading: 'x', rows: [] } })), '');
    assert.equal(html(React.createElement(RecordsCard as any, { state: { heading: '', rows: [{ title: 'a' }] } })), '');
    assert.doesNotMatch(html(React.createElement(RecordsCard as any, { state: { heading: 'x', total: 1, rows: [{ title: 'a' }] } })), /of 1/);
  });

  await check('the tile draws nothing until the dashboard has arrived, then the three figures and a button that says what it does', async () => {
    assert.equal(html(React.createElement(MyDayTile, { person: null })), '');
    trackDashboard('sales@placemakers.demo', 'placemakers');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const out = html(React.createElement(MyDayTile, { person: 'sales@placemakers.demo' }));
    assert.match(out, /class="myday"/);
    assert.match(out, />My day</);
    assert.match(out, /22/);
    assert.match(out, /Closing in 14 days/);
    assert.match(out, /myday__val--bad/);
    assert.match(out, /aria-label="My day: 22 Open deals, 6 Closing in 14 days, 10 Open cases\. Open the dashboard"/);
    assert.match(out, /aria-pressed="false"/);
  });

  await check('the dashboard shows every figure with its hint, and says plainly what could not be read or is not for this team', async () => {
    await loadDashboard();
    const out = html(React.createElement(DashboardCanvas));
    assert.match(out, /Showing Jess Penrose&#x27;s deals/);
    assert.match(out, /worth \$78,511/);
    assert.match(out, /Could not be read just now/);
    assert.match(out, /This one is not available to your team\./);
    assert.match(out, /Could not be read just now\. It will try again in a minute\./);
    assert.match(out, /No quotes are ending soon\./);
    assert.match(out, /Ngata &amp; Penrose Joinery/);
    assert.match(out, /See all in chat/);
    assert.match(out, /Updated just now/);
    assert.equal((out.match(/dash__fig--ask/g) || []).length, 1, 'only a figure with a question is a button');
  });

  await check('with no dashboard the canvas says so instead of showing an empty page', () => {
    trackDashboard(null, undefined);
    const out = html(React.createElement(DashboardCanvas));
    assert.match(out, /Getting your figures|There is no dashboard/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
