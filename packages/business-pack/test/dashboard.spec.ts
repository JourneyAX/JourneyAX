import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { DashboardSchema, buildDashboard, callKey, fillTemplate, recordCardsFor, recordsOf, resolveArgs, todayIn, dashboardCalls, dashboardFor, dashboardName, type CallOutcome } from '../src';
import fixture from './fixtures/dashboard-salesforce.json';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Dashboard (pack extensions.dashboard): the corner tile, the dashboard and the chat cards');

const format = { today: '2026-10-27', currency: 'NZD', locale: 'en-NZ' };

const DEAL_ROW = {
  title: '{account}',
  subtitle: '{name|clean}',
  detail: 'Closes {closeDate|date} · {owner}',
  badge: '{stage}',
  amount: '{amount|money}',
  ask: 'Tell me about the {account} deal',
};
const CASE_ROW = {
  title: '{subject}',
  subtitle: '{account}',
  detail: '{status} · opened {created|date}',
  badge: '{priority}',
  tones: { High: 'bad', Medium: 'warn', Low: 'good' },
  ask: 'What is happening with the case for {account}?',
};

const setting = DashboardSchema.parse({
  people: { 'Sales@Placemakers.demo': { name: 'Jess Penrose' } },
  entries: [
    {
      groups: ['sales'],
      title: 'My day',
      subtitle: 'Your deals and the cases waiting on you.',
      tile: ['open-deals', 'closing-soon', 'open-cases'],
      metrics: [
        { id: 'open-deals', label: 'Open deals', source: { connector: 'salesforce', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, measure: 'count', hint: { field: 'amount', format: 'money', text: 'worth {value}' }, ask: 'Show me my open deals.' },
        { id: 'closing-soon', label: 'Closing in 14 days', source: { connector: 'salesforce', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, measure: 'count', where: [{ field: 'closeDate', op: 'withinDays', value: 14 }], tone: [{ atLeast: 1, tone: 'warn' }] },
        { id: 'open-cases', label: 'Open cases', source: { connector: 'salesforce', tool: 'list_cases', args: { status: 'open', limit: 25 } }, measure: 'count', tone: [{ atLeast: 1, tone: 'warn' }, { atLeast: 5, tone: 'bad' }] },
        { id: 'worth', label: 'Pipeline value', source: { connector: 'salesforce', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, measure: 'sum', field: 'amount', format: 'money' },
      ],
      sections: [
        { id: 'deals', title: 'Closing soon', source: { connector: 'salesforce', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, sort: { field: 'closeDate' }, limit: 3, row: DEAL_ROW, empty: 'Nothing is closing soon.', more: { label: 'See all in chat', prompt: 'Show me my open deals.' } },
        { id: 'cases', title: 'Cases', source: { connector: 'salesforce', tool: 'list_cases', args: { status: 'open', limit: 25 } }, where: [{ field: 'priority', op: 'equals', value: 'High' }], row: CASE_ROW },
      ],
      cards: [
        { connector: 'salesforce', tool: 'list_opportunities', heading: 'Open deals', sort: { field: 'closeDate' }, limit: 4, row: DEAL_ROW },
        { connector: 'salesforce', tool: 'list_cases', heading: 'Open cases', limit: 5, row: CASE_ROW },
        { connector: 'salesforce', tool: 'get_account', heading: 'The customer', from: 'record', row: { title: '{name}', subtitle: '{city} · {industry}', detail: 'Account owner {owner}' } },
        { connector: 'salesforce', tool: 'get_account', heading: 'Their open cases', from: 'record.cases', limit: 3, row: CASE_ROW },
      ],
    },
    { audience: 'staff', title: 'Today', tile: ['n'], metrics: [{ id: 'n', label: 'Cases', source: { connector: 'salesforce', tool: 'list_cases' }, measure: 'count' }], sections: [], cards: [] },
  ],
});

const person = (role: string, groups: string[] = [], userId = `${role}@x.test`) => ({ ...principalFrom({ userId, role, groups }), userId });
const entry = dashboardFor(setting, person('rep', ['sales']))!;
const jess = 'Jess Penrose';

const outcomesFor = (name: string | undefined, overrides: Record<string, CallOutcome> = {}) => {
  const out = new Map<string, CallOutcome>();
  for (const call of dashboardCalls(entry, name)) {
    const data = call.tool === 'list_opportunities' ? fixture.opps : fixture.cases;
    out.set(call.key, overrides[call.tool] ?? { ok: true, data });
  }
  return out;
};

check('the setting is checked: a tile figure must be one of the metrics, and ids may not repeat', () => {
  const bad = (patch: Record<string, unknown>) => DashboardSchema.safeParse({ entries: [{ groups: ['sales'], title: 'x', tile: ['a'], metrics: [{ id: 'a', label: 'A', source: { connector: 'c', tool: 't' }, measure: 'count' }], sections: [], cards: [], ...patch }] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ tile: ['missing'] }), false);
  assert.equal(bad({ tile: ['a', 'b', 'c', 'd'] }), false, 'at most three on the tile');
  assert.equal(bad({ metrics: [{ id: 'a', label: 'A', source: { connector: 'c', tool: 't' }, measure: 'sum' }] }), false, 'a sum needs a field');
  assert.equal(bad({ groups: undefined }), false, 'an entry names who it is for');
  assert.equal(bad({ unknownKey: 1 }), false);
});

check('a team gets its own entry, then the staff entry, and a shopper gets none', () => {
  assert.equal(dashboardFor(setting, person('rep', ['sales']))?.title, 'My day');
  assert.equal(dashboardFor(setting, person('rep', ['finance']))?.title, 'Today');
  assert.equal(dashboardFor(setting, person('customer', []).audience === 'shopper' ? { audience: 'shopper', groups: [] } : person('customer')), undefined);
  assert.equal(dashboardFor(undefined, person('rep', ['sales'])), undefined);
  assert.equal(dashboardFor({ entries: 'nonsense' }, person('rep', ['sales'])), undefined, 'a broken setting shows nothing instead of failing');
});

check('the person is found by login in any case, and an unknown login has no name', () => {
  assert.equal(dashboardName(setting, 'sales@placemakers.demo'), jess);
  assert.equal(dashboardName(setting, 'someone.else@x.test'), undefined);
  assert.equal(dashboardName(setting, undefined), undefined);
});

check('inputs say {me.name} for the person; without a name the input is left out, so the number becomes the team’s', () => {
  const source = (setting.entries[0].metrics[0] as any).source;
  assert.deepEqual(resolveArgs(source.args, jess), { args: { stage: 'open', owner: jess, limit: 25 }, usedName: true });
  assert.deepEqual(resolveArgs(source.args, undefined), { args: { stage: 'open', limit: 25 }, usedName: false });
});

check('each distinct call is asked once, however many figures and lists use it', () => {
  const calls = dashboardCalls(entry, jess);
  assert.equal(calls.length, 2, 'open deals (4 uses) and open cases (2 uses)');
  assert.deepEqual(calls.map((c) => c.tool).sort(), ['list_cases', 'list_opportunities']);
  assert.equal(calls[0].key, callKey(calls[0], calls[0].args));
});

check('figures are counted and added up from the tool’s answer, with the hint worded by the pack', () => {
  const view = buildDashboard(entry, outcomesFor(jess), { format, name: jess });
  const byId = Object.fromEntries(view.metrics.map((m) => [m.id, m]));
  assert.equal(byId['open-deals'].value, String(fixture.opps.total));
  assert.equal(byId['open-deals'].hint, `worth ${new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(fixture.opps.records.reduce((s: number, r: any) => s + r.amount, 0))}`);
  const closing = fixture.opps.records.filter((r: any) => r.closeDate >= '2026-10-27' && r.closeDate <= '2026-11-10').length;
  assert.ok(closing > 0, 'the fixture has deals closing soon');
  assert.equal(byId['closing-soon'].value, String(closing));
  assert.equal(byId['closing-soon'].tone, 'warn');
  assert.equal(byId['open-cases'].value, `${fixture.cases.total}+`, 'the tool stopped at its limit (more: true), so the count is “at least”');
  assert.equal(byId['open-cases'].tone, 'bad', 'the highest threshold reached wins');
  assert.match(byId.worth.value, /^\$[\d,]+$/);
  assert.deepEqual(view.tile.map((t) => t.id), ['open-deals', 'closing-soon', 'open-cases']);
});

check('the figures are the person’s own when the pack names them, and the team’s when it does not', () => {
  assert.equal(buildDashboard(entry, outcomesFor(jess), { format, name: jess }).scope, 'mine');
  const team = buildDashboard(entry, outcomesFor(undefined), { format });
  assert.equal(team.scope, 'team');
  assert.equal(team.name, undefined);
});

check('a figure from a list the tool cut short is a lower bound, and says so with a plus', () => {
  const cut: CallOutcome = { ok: true, data: { ...fixture.opps, total: 40, returned: fixture.opps.records.length, more: true } };
  const view = buildDashboard(entry, outcomesFor(jess, { list_opportunities: cut }), { format, name: jess });
  const byId = Object.fromEntries(view.metrics.map((m) => [m.id, m]));
  assert.equal(byId['open-deals'].value, '40', 'the tool’s own total is exact');
  assert.ok(byId['closing-soon'].value.endsWith('+'));
  assert.ok(byId.worth.value.endsWith('+'));
});

check('a call that was blocked or did not answer leaves only its own number blank', () => {
  const view = buildDashboard(entry, outcomesFor(jess, { list_cases: { ok: false, reason: 'blocked' } }), { format, name: jess });
  const byId = Object.fromEntries(view.metrics.map((m) => [m.id, m]));
  assert.equal(byId['open-cases'].value, '–');
  assert.equal(byId['open-cases'].ok, false);
  assert.equal(byId['open-deals'].ok, true);
  assert.equal(view.sections.find((s) => s.id === 'cases')?.state, 'blocked');
  assert.equal(view.sections.find((s) => s.id === 'deals')?.state, 'ok');
  const missing = buildDashboard(entry, new Map(), { format, name: jess });
  assert.ok(missing.tile.every((t) => t.value === '–'));
  assert.ok(missing.sections.every((s) => s.state === 'unavailable'));
});

check('a list is filtered, sorted and cut to the pack’s length, and says how many there were', () => {
  const view = buildDashboard(entry, outcomesFor(jess), { format, name: jess });
  const deals = view.sections.find((s) => s.id === 'deals')!;
  assert.equal(deals.rows.length, 3);
  assert.equal(deals.total, fixture.opps.records.length);
  const soonest = [...fixture.opps.records].sort((a: any, b: any) => a.closeDate.localeCompare(b.closeDate))[0] as any;
  assert.equal(deals.rows[0].title, soonest.account);
  assert.equal(deals.rows[0].amount, new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(soonest.amount));
  assert.deepEqual(deals.more, { label: 'See all in chat', prompt: 'Show me my open deals.' });
  const cases = view.sections.find((s) => s.id === 'cases')!;
  assert.equal(cases.total, fixture.cases.records.filter((r: any) => r.priority === 'High').length);
  assert.ok(cases.rows.every((r) => r.tone === 'bad' && r.badge === 'High'));
});

check('words come only from the record: a deal’s number in brackets is dropped, dates read as people say them, an empty piece takes its words with it', () => {
  const record = { name: 'Ngata & Penrose Joinery: Garrison Sloping Roof Garden and 2 more [OPP-0006]', closeDate: '2026-11-01', created: '2025-12-30T07:26:59.000+0000', owner: 'Jess Penrose' };
  assert.equal(fillTemplate('{name|clean}', record, format), 'Ngata & Penrose Joinery: Garrison Sloping Roof Garden and 2 more');
  assert.equal(fillTemplate('{name|item}', record, format), 'Garrison Sloping Roof Garden and 2 more', 'the account the name starts with is not said twice');
  assert.equal(fillTemplate('{name|item}', { name: 'Pool gate [OPP-0001]' }, format), 'Pool gate', 'a name with no account is kept whole');
  assert.equal(fillTemplate('Closes {closeDate|date} · {owner}', record, format), 'Closes 1 Nov · Jess Penrose');
  assert.equal(fillTemplate('Closes {closeDate|date} · {nobody}', record, format), 'Closes 1 Nov', 'a missing field leaves out its whole piece');
  assert.equal(fillTemplate('opened {created|date}', record, format), 'opened 30 Dec 2025', 'another year shows the year');
  assert.equal(fillTemplate('{amount|money}', {}, format), '');
});

check('money is written in the shop’s currency, and never in a guessed one when the pack names none', () => {
  assert.equal(fillTemplate('{amount|money}', { amount: 6612 }, format), '$6,612');
  assert.equal(fillTemplate('{amount|money}', { amount: 6612 }, { today: format.today }), '6,612', 'a plain number, with no currency sign');
});

check('a count is written with its thousands, and a word where a number was expected is left as it is', () => {
  assert.equal(fillTemplate('{views|number} views', { views: 9111 }, format), '9,111 views');
  assert.equal(fillTemplate('{views|number}', { views: '44851' }, format), '44,851', 'a number a system wrote as text');
  assert.equal(fillTemplate('{views|number}', { views: 'n/a' }, format), 'n/a');
  assert.equal(fillTemplate('{views|number} views', {}, format), '', 'a missing count takes its words with it');
});

check('a status written with underscores is read as words', () => {
  assert.equal(fillTemplate('{status|words}', { status: 'out_for_delivery' }, format), 'Out for delivery');
  assert.equal(fillTemplate('{status|words}', { status: 'delivered' }, format), 'Delivered');
  assert.equal(fillTemplate('{status|words} today', {}, format), '', 'a missing status takes its words with it');
});

check('chat cards: a lookup the pack has a card for becomes a card, newest facts only, with nothing invented', () => {
  const cards = recordCardsFor(entry, 'salesforce', 'list_opportunities', fixture.opps, format);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].heading, 'Open deals');
  assert.equal(cards[0].shown, 4);
  assert.equal(cards[0].total, fixture.opps.records.length);
  assert.ok(cards[0].rows.every((row) => !/\[OPP-/.test(`${row.title} ${row.subtitle}`)), 'no deal numbers on the card');
  assert.deepEqual(recordCardsFor(entry, 'salesforce', 'find_account', fixture.find, format), [], 'a tool with no card makes none');
  assert.deepEqual(recordCardsFor(entry, 'salesforce', 'list_cases', { records: [] }, format), [], 'an empty answer makes no empty card');
});

check('one answer can make several cards: the customer and, under it, their cases', () => {
  const cards = recordCardsFor(entry, 'salesforce', 'get_account', fixture.account, format);
  assert.deepEqual(cards.map((c) => c.heading), ['The customer', 'Their open cases']);
  assert.equal(cards[0].rows[0].title, 'Harlow & Talbot Landscapes Ltd');
  assert.equal(cards[0].rows[0].subtitle, 'Silverdale · Construction');
  assert.equal(cards[1].rows.length, 2);
  assert.equal(cards[1].rows[0].badge, 'High');
});

check('the answer’s list is found whether the tool calls it records, stages, or gives one record', () => {
  assert.equal(recordsOf(fixture.opps).length, fixture.opps.records.length);
  assert.equal(recordsOf(fixture.pipeline).length, 6, 'the stages');
  assert.equal(recordsOf(fixture.account).length, 1, 'a single record');
  assert.deepEqual(recordsOf(null), []);
  assert.deepEqual(recordsOf({ records: 'no' }), []);
});

check('today is the shop’s own date, not the server’s', () => {
  const instant = new Date('2026-10-26T22:30:00Z');
  assert.equal(todayIn('Pacific/Auckland', instant), '2026-10-27');
  assert.equal(todayIn('UTC', instant), '2026-10-26');
  assert.equal(todayIn('Not/AZone', instant), '2026-10-26', 'a bad zone falls back to UTC');
});

check('a figure can count the records whose field is one of a short list, and a lower-case word gets its capital', () => {
  const tickets = { ok: true, total: 4, returned: 4, records: [
    { status: 'open', priority: 'urgent' }, { status: 'open', priority: 'high' }, { status: 'pending', priority: 'normal' }, { status: 'open' },
  ] };
  const desk = DashboardSchema.parse({
    entries: [{
      groups: ['customer-service'], title: 'My desk', tile: ['loud'], sections: [], cards: [],
      metrics: [{ id: 'loud', label: 'Urgent or high', source: { connector: 'zendesk', tool: 'find_tickets' }, measure: 'count', where: [{ field: 'priority', op: 'in', value: 'High, Urgent' }] }],
    }],
  });
  const source = desk.entries[0].metrics[0].source;
  const outcomes = new Map<string, CallOutcome>([[callKey(source, {}), { ok: true, data: tickets }]]);
  const built = buildDashboard(desk.entries[0], outcomes, { format });
  assert.equal(built.tile[0].value, '2', 'urgent and high are counted; normal, and a ticket with no priority, are not');
  assert.equal(fillTemplate('{status|title} · {kind|title}', { status: 'pending', kind: 'public reply' }, format), 'Pending · Public reply');
  assert.equal(fillTemplate('{priority|title}', { priority: '' }, format), '', 'an empty field stays empty');
  assert.equal(fillTemplate('{total|money}', { total: 3253.75 }, format), '$3,254', 'a deal is shown in whole dollars');
  assert.equal(fillTemplate('{total|price}', { total: 3253.75 }, format), '$3,253.75', 'an order is shown to the cent');
  assert.equal(fillTemplate('{total|price}', { total: 478.8 }, { today: format.today, locale: 'en-NZ' }), '478.80', 'with no currency it is a plain number, still to the cent');
});

check('a count over a list the tool cut short says "25+"; a count the tool gave for the whole search is exact', () => {
  const cases = { ok: true, total: 25, returned: 25, more: true, records: Array.from({ length: 25 }, (_, i) => ({ status: i < 5 ? 'Escalated' : 'New' })) };
  const tickets = { ok: true, total: 61, returned: 25, more: true, records: Array.from({ length: 25 }, () => ({ status: 'open' })) };
  const desk = DashboardSchema.parse({
    entries: [{
      groups: ['customer-service'], title: 'My desk', tile: ['cases'], sections: [], cards: [],
      metrics: [
        { id: 'cases', label: 'Open cases', source: { connector: 'salesforce', tool: 'list_cases' }, measure: 'count' },
        { id: 'escalated', label: 'Escalated', source: { connector: 'salesforce', tool: 'list_cases' }, measure: 'count', where: [{ field: 'status', op: 'equals', value: 'Escalated' }] },
        { id: 'tickets', label: 'Open tickets', source: { connector: 'zendesk', tool: 'find_tickets' }, measure: 'count' },
      ],
    }],
  });
  const [cs, , zd] = desk.entries[0].metrics.map((m) => m.source);
  const outcomes = new Map<string, CallOutcome>([[callKey(cs, {}), { ok: true, data: cases }], [callKey(zd, {}), { ok: true, data: tickets }]]);
  const byId = Object.fromEntries(buildDashboard(desk.entries[0], outcomes, { format }).metrics.map((m) => [m.id, m]));
  assert.equal(byId.cases.value, '25+', 'the tool said it stopped at 25');
  assert.equal(byId.escalated.value, '5+');
  assert.equal(byId.tickets.value, '61', 'the tool counted the whole search itself');
});

check('a card says how many there are: the tool’s own count when it gave one, “at least” when it stopped at its limit', () => {
  const card = { connector: 'zendesk', tool: 'find_tickets', heading: 'Tickets', limit: 2, row: { title: '{subject}' } };
  const desk = DashboardSchema.parse({ entries: [{ groups: ['customer-service'], title: 'My desk', tile: ['n'], metrics: [{ id: 'n', label: 'Tickets', source: { connector: 'zendesk', tool: 'find_tickets' }, measure: 'count' }], sections: [], cards: [card] }] });
  const records = [{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }];
  const make = (data: unknown) => recordCardsFor(desk.entries[0], 'zendesk', 'find_tickets', data, format)[0];
  assert.deepEqual([make({ records }).total, make({ records }).atLeast], [3, undefined], 'the tool returned everything');
  assert.deepEqual([make({ total: 61, returned: 3, more: true, records }).total, make({ total: 61, returned: 3, more: true, records }).atLeast], [61, undefined], 'the tool counted the whole search');
  assert.deepEqual([make({ total: 3, returned: 3, more: true, records }).total, make({ total: 3, returned: 3, more: true, records }).atLeast], [3, true], 'the tool only repeated how many it returned, then stopped');
});

check('a time written in UTC is read as the shop’s day, and "the last N days" counts back from today', () => {
  const nz = { ...format, today: '2026-10-27', timeZone: 'Pacific/Auckland' };
  // 22:57 UTC on the 25th is 11:57 on the 26th in Auckland; Salesforce writes the zone as +0000.
  assert.equal(fillTemplate('{created|date}', { created: '2026-10-25T22:57:42.000+0000' }, nz), '26 Oct');
  assert.equal(fillTemplate('{created|date}', { created: '2026-10-25T22:57:42Z' }, nz), '26 Oct');
  assert.equal(fillTemplate('{created|date}', { created: '2026-10-25T22:57:42Z' }, format), '25 Oct', 'with no zone given the written day stands');
  assert.equal(fillTemplate('{closeDate|date}', { closeDate: '2026-11-01' }, nz), '1 Nov', 'a plain date is never moved');
  const desk = DashboardSchema.parse({
    entries: [{
      groups: ['branch'], title: 'My branch', tile: ['today', 'week'], sections: [], cards: [],
      metrics: [
        { id: 'today', label: 'Placed today', source: { connector: 'commercetools', tool: 'list_orders' }, measure: 'count', where: [{ field: 'created', op: 'withinLastDays', value: 0 }] },
        { id: 'week', label: 'Placed this week', source: { connector: 'commercetools', tool: 'list_orders' }, measure: 'count', where: [{ field: 'created', op: 'withinLastDays', value: 7 }] },
      ],
    }],
  });
  const orders = { ok: true, total: 4, returned: 4, records: [
    { created: '2026-10-26T19:38:51Z' }, // 08:38 on the 27th in Auckland: today
    { created: '2026-10-26T01:00:00Z' }, // 14:00 on the 26th: yesterday
    { created: '2026-10-20T01:00:00Z' }, // the 20th: exactly 7 days back
    { created: '2026-10-19T01:00:00Z' }, // 8 days back
  ] };
  const outcomes = new Map<string, CallOutcome>([[callKey(desk.entries[0].metrics[0].source, {}), { ok: true, data: orders }]]);
  const byId = Object.fromEntries(buildDashboard(desk.entries[0], outcomes, { format: nz }).metrics.map((m) => [m.id, m]));
  assert.equal(byId.today.value, '1');
  assert.equal(byId.week.value, '3');
});

check('a list says how many there are in the same way as a card does', () => {
  const desk = DashboardSchema.parse({
    entries: [{
      groups: ['branch'], title: 'My branch', tile: ['n'], cards: [],
      metrics: [{ id: 'n', label: 'Orders', source: { connector: 'commercetools', tool: 'list_orders' }, measure: 'count' }],
      sections: [{ id: 'newest', title: 'Newest orders', source: { connector: 'commercetools', tool: 'list_orders' }, limit: 2, row: { title: '{orderNumber}' } }],
    }],
  });
  const records = [{ orderNumber: 'a' }, { orderNumber: 'b' }, { orderNumber: 'c' }];
  const sectionOf = (data: unknown) => buildDashboard(desk.entries[0], new Map<string, CallOutcome>([[callKey(desk.entries[0].sections[0].source, {}), { ok: true, data }]]), { format }).sections[0];
  assert.deepEqual([sectionOf({ records }).total, sectionOf({ records }).atLeast], [3, undefined]);
  assert.deepEqual([sectionOf({ total: 39, returned: 3, more: true, records }).total, sectionOf({ total: 39, returned: 3, more: true, records }).atLeast], [39, undefined], 'the order system counted all 39');
  assert.deepEqual([sectionOf({ total: 3, returned: 3, more: true, records }).total, sectionOf({ total: 3, returned: 3, more: true, records }).atLeast], [3, true], 'stopped at its limit');
});

check('a list that counted more than it returned is cut short even when it does not say "more"', () => {
  const desk = DashboardSchema.parse({
    entries: [{
      groups: ['marketing'], title: 'My campaigns', tile: ['all', 'opened'], sections: [], cards: [],
      metrics: [
        { id: 'all', label: 'Messages sent', source: { connector: 'marketing-cloud', tool: 'list_messages' }, measure: 'count' },
        { id: 'opened', label: 'Opened', source: { connector: 'marketing-cloud', tool: 'list_messages' }, measure: 'count', where: [{ field: 'status', op: 'equals', value: 'opened' }] },
      ],
    }],
  });
  const messages = { ok: true, total: 34, returned: 4, records: [{ status: 'opened' }, { status: 'opened' }, { status: 'delivered' }, { status: 'opened' }] };
  const outcomes = new Map<string, CallOutcome>([[callKey(desk.entries[0].metrics[0].source, {}), { ok: true, data: messages }]]);
  const byId = Object.fromEntries(buildDashboard(desk.entries[0], outcomes, { format }).metrics.map((m) => [m.id, m]));
  assert.equal(byId.all.value, '34', 'the tool counted all 34');
  assert.equal(byId.opened.value, '3+', 'three of the four it returned; the rest were not looked at');
});

console.log(`\n✅ ${passed} dashboard checks passed`);
