/**
 * The page's side of the rules table.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/ruleGrid.test.ts
 */
import assert from 'node:assert/strict';
import { changedTools, countChanges, describeStatus, rulesToSend, setColumn, teamsWithAccess, type RuleEdit } from '../ruleGrid';
import type { OverviewConnectorRules } from '../types';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const system: OverviewConnectorRules = {
  connectorId: 'crm', name: 'CRM', description: 'd', owner: 'o', sample: false, enabled: true,
  tools: [{ name: 'list', label: 'List', summary: '', sideEffect: 'read' }, { name: 'read', label: 'Read', summary: '', sideEffect: 'read' }, { name: 'create', label: 'Create', summary: '', sideEffect: 'write' }],
  columns: [{ id: 'sales', name: 'Sales' }, { id: 'finance', name: 'Finance' }, { id: 'administrators', name: 'Administrators' }, { id: 'old', name: 'old', note: 'not a team' }],
  grid: {
    list: { sales: 'allow', finance: 'blocked', administrators: 'allow', old: 'blocked' },
    read: { sales: 'allow', finance: 'allow', administrators: 'allow', old: 'blocked' },
    create: { sales: 'ask', finance: 'blocked', administrators: 'ask', old: 'blocked' },
  },
  notes: { defaultRows: 0, allStaffRows: 0, everyoneRows: 0 }, base: 'b',
};
const fresh = (): RuleEdit => ({ enabled: true, grid: JSON.parse(JSON.stringify(system.grid)) });

console.log('the rules table on the page');

check('nothing is changed until a cell differs from what was read; then the tool and the count are known', () => {
  assert.deepEqual(changedTools(system, fresh()), []);
  assert.equal(countChanges(system, fresh()), 0);
  const edit = fresh();
  edit.grid.list.finance = 'allow';
  edit.grid.create.sales = 'blocked';
  assert.deepEqual(changedTools(system, edit), ['list', 'create']);
  assert.equal(countChanges(system, edit), 2);
  edit.grid.list.finance = 'blocked';
  assert.deepEqual(changedTools(system, edit), ['create'], 'putting a cell back is no change');
});

check('what is sent is the whole row (every column shown) of each changed tool and nothing for the others', () => {
  const edit = fresh();
  edit.grid.list.finance = 'ask';
  assert.deepEqual(rulesToSend(system, edit), { cells: { list: { sales: 'allow', finance: 'ask', administrators: 'allow', old: 'blocked' } } });
  assert.deepEqual(rulesToSend(system, fresh()), { cells: {} });
});

check('setting a whole column: reads allowed with changes asked first, everything asked first, or everything blocked; other columns are not touched', () => {
  const reads = setColumn(system, fresh(), 'finance', 'reads');
  assert.deepEqual([reads.grid.list.finance, reads.grid.read.finance, reads.grid.create.finance], ['allow', 'allow', 'ask'], 'a tool that changes data is never simply allowed');
  assert.equal(reads.grid.list.sales, 'allow');
  const ask = setColumn(system, fresh(), 'sales', 'ask');
  assert.deepEqual([ask.grid.list.sales, ask.grid.read.sales, ask.grid.create.sales], ['ask', 'ask', 'ask']);
  const none = setColumn(system, fresh(), 'sales', 'blocked');
  assert.deepEqual([none.grid.list.sales, none.grid.read.sales, none.grid.create.sales], ['blocked', 'blocked', 'blocked']);
  assert.equal(none.grid.list.administrators, 'allow');
  assert.equal(fresh().grid.list.sales, 'allow', 'the edit it started from is not modified');
});

check('the connection status reads plainly: connected, not connected with what it needs, or not checked', () => {
  assert.deepEqual(describeStatus(undefined), { label: 'Connection not checked', detail: '', tone: 'unknown' });
  assert.equal(describeStatus({ checked: true, connected: true, missing: [] }).tone, 'good');
  assert.deepEqual(describeStatus({ checked: true, connected: false, missing: ['A_KEY', 'B_KEY'] }), { label: 'Not connected yet', detail: 'needs A_KEY, B_KEY', tone: 'bad' });
});

check('a card counts the teams that may use a system: the administrators and groups that are not teams do not count', () => {
  assert.equal(teamsWithAccess(system), 2, 'sales and finance (finance may read)');
  const closed = { ...system, grid: { ...system.grid, read: { ...system.grid.read, finance: 'blocked' as const } } };
  assert.equal(teamsWithAccess(closed), 1);
  const open = { ...system, grid: { ...system.grid, list: { ...system.grid.list, old: 'ask' as const } } };
  assert.equal(teamsWithAccess(open), 2, 'a group that is not a team does not count');
});

console.log(`${passed} passed`);
