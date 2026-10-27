/**
 * The dashboard answer as the page reads it.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/dashboard.test.ts
 */
import assert from 'node:assert/strict';
import { homeSections, parseDashboard, parseRow, scopeWords, splitFigures, tileHasGap, updatedWords } from '../dashboard';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const answer = {
  dashboard: {
    title: 'My day',
    subtitle: 'Your deals and the cases waiting on you.',
    scope: 'mine',
    name: 'Jess Penrose',
    asOf: '2026-10-27T01:00:00.000Z',
    tile: [
      { id: 'open-deals', label: 'Open deals', value: '22', tone: 'neutral', hint: 'worth $78,511', ok: true },
      { id: 'closing', label: 'Closing in 14 days', value: '6', tone: 'warn', ok: true },
      { id: 'cases', label: 'Open cases', value: '–', tone: 'neutral', ok: false },
    ],
    metrics: [{ id: 'open-deals', label: 'Open deals', value: '22', tone: 'neutral', ask: 'Show me my open deals.', ok: true }],
    sections: [
      { id: 'deals', title: 'Closing soon', state: 'ok', total: 6, rows: [{ title: 'Ngata & Penrose Joinery', subtitle: 'Garrison roof garden', badge: 'Propose', tone: 'warn', amount: '$6,612', ask: 'Tell me about it' }], more: { label: 'See all', prompt: 'Show my deals' } },
      { id: 'cases', title: 'Cases', state: 'blocked', total: 0, rows: [] },
    ],
  },
};

console.log('dashboard: reading the answer');

check('a good answer is read in full', () => {
  const data = parseDashboard(answer)!;
  assert.equal(data.title, 'My day');
  assert.equal(data.scope, 'mine');
  assert.equal(data.tile.length, 3);
  assert.equal(data.tile[0].hint, 'worth $78,511');
  assert.equal(data.tile[2].ok, false);
  assert.equal(data.sections[0].rows[0].amount, '$6,612');
  assert.deepEqual(data.sections[0].more, { label: 'See all', prompt: 'Show my deals' });
  assert.equal(data.sections[1].state, 'blocked');
});

check('anything malformed is dropped, and no usable tile means no dashboard', () => {
  assert.equal(parseDashboard(undefined), undefined);
  assert.equal(parseDashboard({}), undefined);
  assert.equal(parseDashboard({ dashboard: 'x' }), undefined);
  assert.equal(parseDashboard({ dashboard: { title: 'My day', tile: [] } }), undefined);
  assert.equal(parseDashboard({ dashboard: { title: '', tile: answer.dashboard.tile } }), undefined);
  const messy = parseDashboard({ dashboard: { ...answer.dashboard, tile: [...answer.dashboard.tile, { nope: true }, null], sections: [{ id: 'x' }, 7, ...answer.dashboard.sections] } })!;
  assert.equal(messy.tile.length, 3, 'a figure with no label or value is dropped');
  assert.equal(messy.sections.length, 2, 'a section with no title is dropped');
});

check('the tile never has more than three figures and a section never more than ten rows', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: 'L', value: String(i) }));
  const rows = Array.from({ length: 15 }, (_, i) => ({ title: `row ${i}` }));
  const data = parseDashboard({ dashboard: { title: 'T', tile: many, sections: [{ id: 's', title: 'S', rows }] } })!;
  assert.equal(data.tile.length, 3);
  assert.equal(data.sections[0].rows.length, 10);
});

check('a tone the page does not know is neutral, and a badge keeps its tone only when it has a badge', () => {
  assert.equal(parseDashboard({ dashboard: { title: 'T', tile: [{ id: 'a', label: 'A', value: '1', tone: 'loud' }] } })!.tile[0].tone, 'neutral');
  assert.deepEqual(parseRow({ title: 'x', tone: 'bad' }), { title: 'x' });
  assert.deepEqual(parseRow({ title: 'x', badge: 'High', tone: 'bad' }), { title: 'x', badge: 'High', tone: 'bad' });
  assert.equal(parseRow({ subtitle: 'no title' }), undefined);
});

check('"updated" is worded the way people say it', () => {
  const now = new Date('2026-10-27T01:30:00Z');
  assert.equal(updatedWords('2026-10-27T01:29:40Z', now), 'Updated just now');
  assert.equal(updatedWords('2026-10-27T01:29:00Z', now), 'Updated a minute ago');
  assert.equal(updatedWords('2026-10-27T01:15:00Z', now), 'Updated 15 minutes ago');
  assert.equal(updatedWords('2026-10-27T00:20:00Z', now), 'Updated an hour ago');
  assert.equal(updatedWords('2026-10-26T22:00:00Z', now), 'Updated 3 hours ago');
  assert.equal(updatedWords('not a date', now), '');
});

check('whose figures these are, and whether the tile has a gap', () => {
  assert.equal(scopeWords({ scope: 'mine', name: 'Jess Penrose' }), "Showing Jess Penrose's deals");
  assert.equal(scopeWords({ scope: 'team' }), 'Showing the whole team');
  assert.equal(scopeWords({ scope: 'mine' }), 'Showing the whole team', 'no name, no claim of being theirs');
  assert.equal(tileHasGap(parseDashboard(answer)!), true);
});

const fig = (id: string, value: string, tone: string, ok = true) => ({ id, label: id, value, tone, ok });
const withMetrics = (metrics: unknown[], tile: unknown[] = [fig('t', '1', 'neutral')]) =>
  parseDashboard({ dashboard: { title: 'T', tile, metrics, sections: [] } })!;

check('home: red and amber figures that are not zero form the "needs you now" band, red first, and nothing is shown twice', () => {
  const data = withMetrics([fig('open', '24', 'neutral'), fig('late', '3', 'warn'), fig('urgent', '6', 'bad'), fig('quiet', '0', 'bad'), fig('cases', '25+', 'neutral'), fig('esc', '5+', 'bad')]);
  const { alerts, rest } = splitFigures(data);
  assert.deepEqual(alerts.map((f) => f.id), ['urgent', 'esc', 'late'], "red before amber, each in the pack's own order");
  assert.deepEqual(rest.map((f) => f.id), ['open', 'quiet', 'cases'], 'a figure that is zero stays with the plain ones');
});

check('home: a figure that could not be read is never an alert, the band has a limit, and the tile stands in when there are no figures', () => {
  const unread = splitFigures(withMetrics([fig('a', '–', 'bad', false), fig('b', '2', 'bad')]));
  assert.deepEqual(unread.alerts.map((f) => f.id), ['b']);
  assert.deepEqual(unread.rest.map((f) => f.id), ['a']);
  const many = splitFigures(withMetrics(Array.from({ length: 7 }, (_, i) => fig(`f${i}`, '3', 'bad'))));
  assert.equal(many.alerts.length, 4);
  assert.equal(many.rest.length, 3);
  const fromTile = splitFigures(withMetrics([], [fig('open', '22', 'neutral'), fig('soon', '6', 'warn')]));
  assert.deepEqual(fromTile.alerts.map((f) => f.id), ['soon']);
  assert.deepEqual(fromTile.rest.map((f) => f.id), ['open']);
});

check('home: a list the team may not read is left off the home screen, and one that is only unavailable stays', () => {
  const data = parseDashboard({ dashboard: { title: 'T', tile: [fig('t', '1', 'neutral')], sections: [
    { id: 'a', title: 'A', state: 'ok', total: 1, rows: [{ title: 'x' }] },
    { id: 'b', title: 'B', state: 'blocked', total: 0, rows: [] },
    { id: 'c', title: 'C', state: 'unavailable', total: 0, rows: [] },
  ] } })!;
  assert.deepEqual(homeSections(data).map((s) => s.id), ['a', 'c']);
});

console.log(`\n${passed} passed`);
