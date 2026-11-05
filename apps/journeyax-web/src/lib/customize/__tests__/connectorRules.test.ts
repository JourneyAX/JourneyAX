/**
 * The connector rules table: what it shows, and that a change to it is written back as the pack's own rows without changing anything else.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/connectorRules.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connectorToolState, type ConnectorsExtension } from '@journeyax/business-pack';
import { applyRulesChange, buildConnectorRules, connectorFingerprint, type RulesResult } from '../connectorRules';
import type { ToolState } from '../types';

const STATES = ['allow', 'ask', 'blocked'] as const;
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const ext = (): ConnectorsExtension => JSON.parse(JSON.stringify(draft.extensions.connectors));
const TEAMS = ['Customer Service', 'Sales', 'Sales Managers', 'Branch', 'Finance', 'Marketing', 'Insights', 'Leadership'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const view = (e: ConnectorsExtension, id: string) => buildConnectorRules(e, TEAMS).find((v) => v.connectorId === id)!;
const asIfOn = (e: ConnectorsExtension) => ({ ...e, connectors: e.connectors.map((c) => ({ ...c, enabled: true })) });
const engine = (e: ConnectorsExtension, id: string, tool: string, group: string) => connectorToolState(asIfOn(e), id, tool, { audience: 'staff', groups: [group] }).state;
const good = (r: RulesResult) => { assert.equal(r.ok, true, r.ok === false ? r.errors.join(' | ') : ''); return r as Extract<RulesResult, { ok: true }>; };

console.log('the connector rules table');

check('every system of the pack is listed, switched on or off, with a column for each team, the administrators, and any group a rule names that is not a team', () => {
  const all = buildConnectorRules(ext(), TEAMS);
  assert.equal(all.length, draft.extensions.connectors.connectors.length);
  const powerBi = all.find((v) => v.connectorId === 'power-bi')!;
  assert.equal(powerBi.enabled, false);
  assert.equal(all.find((v) => v.connectorId === 'zendesk')!.enabled, true);
  assert.deepEqual(powerBi.columns.map((c) => c.id), [...TEAMS.map((t) => t.id), 'administrators']);
  const odd = ext();
  odd.policy.push({ connectorId: 'salesforce', tool: 'list_cases', audience: 'staff', groups: ['old-team'], state: 'allow' });
  const salesforce = view(odd, 'salesforce');
  assert.deepEqual(salesforce.columns.at(-1), { id: 'old-team', name: 'old-team', note: 'Named by a rule, but not a team of this project.' });
  assert.equal(salesforce.grid.list_cases['old-team'], 'allow');
});

check('each cell is the pack\'s own answer for that team: what is allowed, asked first or blocked, and a switched-off system still shows what its rules say', () => {
  const sf = view(ext(), 'salesforce');
  assert.equal(sf.grid.list_opportunities.sales, 'allow');
  assert.equal(sf.grid.list_opportunities['customer-service'], 'blocked');
  assert.equal(sf.grid.create_case['customer-service'], 'ask');
  assert.equal(sf.grid.create_case.sales, 'ask', 'Sales and Branch may raise a case (asked first)');
  assert.equal(sf.grid.create_case.branch, 'ask');
  assert.equal(sf.grid.create_case.finance, 'blocked');
  assert.equal(sf.grid.create_case['sales-managers'], 'blocked');
  assert.equal(view(ext(), 'commercetools').grid.add_to_cart.branch, 'ask');
  assert.equal(view(ext(), 'zendesk').grid.find_tickets['customer-service'], 'allow');
  assert.equal(view(ext(), 'power-bi').grid.list_reports['sales-managers'], 'allow', 'a switched-off system still shows what its rules say');
  for (const v of buildConnectorRules(ext(), TEAMS)) for (const tool of v.tools) for (const column of v.columns) assert.equal(v.grid[tool.name][column.id], engine(ext(), v.connectorId, tool.name, column.id), `${v.connectorId}.${tool.name} ${column.id}`);
});

check('the table says what it hides: default rows, rows for all staff, and rows for everyone', () => {
  const parked = view(ext(), 'sap-commerce');
  assert.deepEqual(parked.notes, { defaultRows: 1, allStaffRows: 2, everyoneRows: 0 }, 'the default row, which counts as an all-staff row too, and one more');
  assert.deepEqual(view(ext(), 'ace-erp').notes, { defaultRows: 0, allStaffRows: 0, everyoneRows: 0 }, 'the ERP has a rule per tool and no default');
  assert.deepEqual(view(ext(), 'salesforce').notes, { defaultRows: 0, allStaffRows: 0, everyoneRows: 5 }, 'five newly registered tools carry explicit everyone-block rows, not an allow default');
});

check('a system carries the fingerprint of its switch, tools and rows; it changes when any of them does and not otherwise', () => {
  const e = ext();
  const f = connectorFingerprint(e, 'salesforce')!;
  assert.equal(view(e, 'salesforce').base, f);
  assert.equal(connectorFingerprint(ext(), 'salesforce'), f, 'the same pack gives the same fingerprint');
  const reordered = ext(); reordered.policy.reverse();
  assert.equal(connectorFingerprint(reordered, 'salesforce'), f, 'row order does not matter');
  const flipped = ext(); flipped.connectors.find((c) => c.connectorId === 'salesforce')!.enabled = false;
  assert.notEqual(connectorFingerprint(flipped, 'salesforce'), f);
  const edited = ext(); edited.policy.find((r) => r.connectorId === 'salesforce' && r.tool === 'list_cases')!.state = 'ask';
  assert.notEqual(connectorFingerprint(edited, 'salesforce'), f);
  assert.equal(connectorFingerprint(edited, 'commercetools'), connectorFingerprint(ext(), 'commercetools'), 'another system is not affected');
  assert.equal(connectorFingerprint(e, 'ghost'), undefined);
});

console.log('changing the table');

check('a change to one cell rewrites that tool\'s rows and nothing else, and the table then shows the new state', () => {
  const before = ext();
  const v = view(before, 'salesforce');
  const cells = { list_cases: { ...v.grid.list_cases, 'sales-managers': 'blocked' as ToolState } };
  const done = good(applyRulesChange(before, { connectorId: 'salesforce', cells }));
  assert.deepEqual(done.changes, { tools: ['list_cases'], cells: 1 });
  assert.equal(view(done.extension, 'salesforce').grid.list_cases['sales-managers'], 'blocked');
  for (const column of v.columns) if (column.id !== 'sales-managers') assert.equal(view(done.extension, 'salesforce').grid.list_cases[column.id], v.grid.list_cases[column.id], column.id);
  const others = (e: ConnectorsExtension) => e.policy.filter((r) => !(r.connectorId === 'salesforce' && r.tool === 'list_cases'));
  assert.deepEqual(others(done.extension), others(before), 'every other row is exactly as it was, in the same order');
  assert.deepEqual(done.extension.connectors, before.connectors, 'the systems themselves are untouched');
  assert.deepEqual(before, ext(), 'the input is not modified');
});

check('the rows written are one per state (allow, ask first), the administrators last, and a blocked team has no row unless something else would let it through', () => {
  const e = ext();
  const v = view(e, 'commercetools');
  const wanted: Record<string, ToolState> = { ...v.grid.get_order, finance: 'ask', branch: 'blocked' };
  const done = good(applyRulesChange(e, { connectorId: 'commercetools', cells: { get_order: wanted } }));
  const rows = done.extension.policy.filter((r) => r.connectorId === 'commercetools' && r.tool === 'get_order');
  assert.deepEqual(rows.map((r) => r.state), ['allow', 'ask']);
  assert.ok(rows[0].groups.at(-1) === 'administrators' && !rows[0].groups.includes('branch') && !rows[0].groups.includes('finance'));
  assert.deepEqual(rows[1].groups, ['finance']);
  assert.equal(rows.every((r) => r.audience === 'staff'), true);
});

check('a system with a default row (every tool with no row of its own) gets an explicit blocked row so a blocked team really is blocked', () => {
  const e = ext();
  const v = view(e, 'mulesoft');
  assert.equal(v.grid.order_sync_status.sales, 'allow', 'the default row lets all staff in');
  const wanted = { ...v.grid.order_sync_status, sales: 'blocked' as ToolState };
  const done = good(applyRulesChange(e, { connectorId: 'mulesoft', cells: { order_sync_status: wanted } }));
  const after = view(done.extension, 'mulesoft');
  assert.equal(after.grid.order_sync_status.sales, 'blocked');
  assert.equal(after.grid.order_sync_status.finance, 'allow');
  assert.equal(after.grid.integration_run_log.sales, 'allow', 'tools that were not edited still follow the default row');
  assert.ok(done.extension.policy.some((r) => r.connectorId === 'mulesoft' && r.tool === 'order_sync_status' && r.state === 'blocked' && r.groups.includes('sales')));
  assert.ok(done.extension.policy.some((r) => r.connectorId === 'mulesoft' && r.tool === '*'), 'the default row stays');
});

check('a tool that changes data cannot be set to allow, for anyone; ask first and blocked are fine', () => {
  const e = ext();
  const v = view(e, 'salesforce');
  const refused = applyRulesChange(e, { connectorId: 'salesforce', cells: { create_case: { ...v.grid.create_case, sales: 'allow' } } });
  assert.equal(refused.ok, false);
  assert.match((refused as { errors: string[] }).errors.join(' '), /changes data in Salesforce.*Ask first or Blocked/);
  good(applyRulesChange(e, { connectorId: 'salesforce', cells: { create_case: { ...v.grid.create_case, finance: 'ask' } } }));
});

check('a rule for everyone (shoppers too) is left alone, and a change it would defeat is refused with the reason', () => {
  const e = ext();
  const existingEveryoneRows = e.policy.filter(row => row.audience === 'shopper').length;
  const existingSalesforceRows = view(e, 'salesforce').notes.everyoneRows;
  e.policy.push({ connectorId: 'salesforce', tool: 'get_case', audience: 'shopper', groups: [], state: 'ask' });
  const v = view(e, 'salesforce');
  assert.equal(v.notes.everyoneRows, existingSalesforceRows + 1);
  assert.equal(v.grid.get_case.sales, 'ask', 'the rule for everyone makes the strictest of the rows apply');
  const lessStrict = applyRulesChange(e, { connectorId: 'salesforce', cells: { get_case: { ...v.grid.get_case, sales: 'allow' } } });
  assert.equal(lessStrict.ok, false);
  assert.match((lessStrict as { errors: string[] }).errors.join(' '), /rule that applies to everyone/);
  const stricter = good(applyRulesChange(e, { connectorId: 'salesforce', cells: { get_case: { ...v.grid.get_case, sales: 'blocked' } } }));
  assert.equal(view(stricter.extension, 'salesforce').grid.get_case.sales, 'blocked');
  assert.equal(stricter.extension.policy.filter((r) => r.audience === 'shopper').length, existingEveryoneRows + 1, 'all prior blocked rows and the added rule remain');
});

check('a group a tool\'s rows name that the request does not show keeps the state it has', () => {
  const e = ext();
  e.policy.push({ connectorId: 'salesforce', tool: 'list_cases', audience: 'staff', groups: ['old-team'], state: 'ask' });
  const v = view(e, 'salesforce');
  const { ['old-team']: _hidden, ...shown } = v.grid.list_cases;
  const done = good(applyRulesChange(e, { connectorId: 'salesforce', cells: { list_cases: { ...shown, finance: 'ask' } } }));
  assert.equal(view(done.extension, 'salesforce').grid.list_cases['old-team'], 'ask');
});

check('random edits of mutable tool rules preserve globally protected tools and all other systems', () => {
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (const connector of draft.extensions.connectors.connectors) {
    const e = ext();
    const v = view(e, connector.connectorId);
    const protectedTools = new Set(e.policy.filter(row => row.connectorId === connector.connectorId && row.audience === 'shopper').map(row => row.tool));
    const edited = v.tools.filter((tool, i) => i % 2 === 0 && !protectedTools.has('*') && !protectedTools.has(tool.name)).map((t) => t.name);
    const cells: Record<string, Record<string, ToolState>> = {};
    for (const name of edited) {
      const write = v.tools.find((t) => t.name === name)!.sideEffect === 'write';
      cells[name] = Object.fromEntries(v.columns.map((c) => [c.id, (write ? (['ask', 'blocked'] as const) : STATES)[next() % (write ? 2 : 3)]]));
    }
    const done = applyRulesChange(e, { connectorId: connector.connectorId, cells });
    if (done.ok === false) { assert.match(done.errors.join(' '), /Nothing was changed/, `${connector.connectorId}: ${done.errors.join(' ')}`); continue; }
    const after = view(done.extension, connector.connectorId);
    for (const tool of v.tools) for (const column of v.columns) {
      const want = edited.includes(tool.name) ? cells[tool.name][column.id] : v.grid[tool.name][column.id];
      assert.equal(after.grid[tool.name][column.id], want, `${connector.connectorId}.${tool.name} ${column.id}`);
    }
    assert.deepEqual(done.extension.policy.filter((r) => r.connectorId !== connector.connectorId), e.policy.filter((r) => r.connectorId !== connector.connectorId), 'other systems\' rows are untouched');
    for (const other of buildConnectorRules(done.extension, TEAMS)) if (other.connectorId !== connector.connectorId) assert.equal(other.base, view(e, other.connectorId).base);
  }
});

check('a system can be switched on or off on its own, and the table warns when it is on but nobody may use it', () => {
  const e = ext();
  const off = good(applyRulesChange(e, { connectorId: 'salesforce', enabled: false }));
  assert.deepEqual(off.changes, { enabled: false, tools: [], cells: 0 });
  assert.equal(off.extension.connectors.find((c) => c.connectorId === 'salesforce')!.enabled, false);
  assert.deepEqual(off.extension.policy, e.policy, 'switching off does not touch the rules');
  const on = good(applyRulesChange(e, { connectorId: 'power-bi', enabled: true }));
  assert.equal(on.extension.connectors.find((c) => c.connectorId === 'power-bi')!.enabled, true);
  const v = view(e, 'power-bi');
  const allBlocked = Object.fromEntries(v.tools.map((t) => [t.name, Object.fromEntries(v.columns.map((c) => [c.id, 'blocked' as ToolState]))]));
  const nobody = good(applyRulesChange(e, { connectorId: 'power-bi', enabled: true, cells: allBlocked }));
  assert.ok(nobody.warnings.some((w) => /no team may use any of its tools/.test(w)));
});

check('mistakes are refused with a reason: an unknown system, tool, state or team id, and a change that changes nothing', () => {
  const e = ext();
  assert.equal(applyRulesChange(e, { connectorId: 'ghost', enabled: true }).ok, false);
  assert.match((applyRulesChange(e, { connectorId: 'salesforce', cells: { nope: { sales: 'allow' } } }) as { errors: string[] }).errors.join(' '), /no tool called "nope"/);
  assert.equal(applyRulesChange(e, { connectorId: 'salesforce', cells: { list_cases: { sales: 'maybe' as ToolState } } }).ok, false);
  assert.equal(applyRulesChange(e, { connectorId: 'salesforce', cells: { list_cases: { 'Sales Team': 'allow' } } }).ok, false);
  const v = view(e, 'salesforce');
  assert.match((applyRulesChange(e, { connectorId: 'salesforce', cells: { list_cases: v.grid.list_cases } }) as { errors: string[] }).errors.join(' '), /Nothing was changed/);
});

console.log(`${passed} passed`);
