import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { BusinessPackContentSchema, offeredTools, toolStateFor, ToolStatesSchema, type ToolStates } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Tool states (pack extensions.toolStates): allow, ask first, blocked');

const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });
const state = (toolId: string, table: ToolStates | undefined, who: ReturnType<typeof person>) => toolStateFor(toolId, table, who);

check('a table parses; anything outside the shape is refused', () => {
  assert.equal(ToolStatesSchema.safeParse({ rows: [{ toolId: 'update_cart', audience: 'shopper', state: 'ask', prompt: 'Change your order?' }] }).success, true);
  const bad = (row: Record<string, unknown>) => ToolStatesSchema.safeParse({ rows: [{ toolId: 'update_cart', audience: 'staff', state: 'ask', ...row }] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ state: 'maybe' }), false);
  assert.equal(bad({ extra: 1 }), false);
  assert.equal(bad({ groups: ['Sales Team'] }), false);
  assert.equal(bad({ prompt: '' }), false);
  assert.equal(bad({ toolId: '' }), false);
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.equal(shape.safeParse({ toolStates: { rows: [] } }).success, true);
  assert.equal(shape.safeParse({ toolStates: { rows: [{ toolId: 'a', audience: 'staff', state: 'nope' }] } }).success, false);
});

check('with no table, or no row for the tool, everything is allowed as before', () => {
  assert.deepEqual(state('update_cart', undefined, person('customer')), { state: 'allow', via: 'open' });
  assert.deepEqual(state('update_cart', { rows: [] }, person('customer')), { state: 'allow', via: 'open' });
  assert.deepEqual(state('check_stock', { rows: [{ toolId: 'update_cart', audience: 'shopper', groups: [], state: 'ask' }] }, person('customer')), { state: 'allow', via: 'open' });
});

const table: ToolStates = {
  rows: [
    { toolId: 'update_cart', audience: 'shopper', groups: [], state: 'ask', prompt: 'Change your order?' },
    { toolId: 'update_cart', audience: 'staff', groups: ['sales'], state: 'allow' },
    { toolId: 'create_quote', audience: 'staff', groups: ['sales', 'trade-desk'], state: 'ask' },
    { toolId: 'hand_off_to_human', audience: 'shopper', groups: [], state: 'blocked' },
    { toolId: 'hand_off_to_human', audience: 'staff', groups: [], state: 'allow' },
  ],
};

check('the most specific row wins: everyone is asked, and sales staff are not', () => {
  assert.deepEqual(state('update_cart', table, person('customer')), { state: 'ask', via: 'row', prompt: 'Change your order?' });
  assert.deepEqual(state('update_cart', table, person('manager', ['sales'])), { state: 'allow', via: 'row' });
  assert.equal(state('update_cart', table, person('manager', ['branch-hamilton'])).state, 'ask', 'staff in no listed group get the row for everyone');
});

check('a tool with rows but none for this person is not theirs: a shopper cannot use a staff-only tool', () => {
  assert.equal(state('create_quote', table, person('customer')).state, 'blocked');
  assert.equal(state('create_quote', table, person('operator', ['customer-service'])).state, 'blocked');
  assert.equal(state('create_quote', table, person('manager', ['trade-desk'])).state, 'ask');
});

check('a shopper row cannot be lifted by a staff group the login claims', () => {
  assert.equal(state('update_cart', table, principalFrom({ userId: 'x@y.test', role: 'customer', groups: ['sales'] })).state, 'ask');
});

check('among rows of the same specificity the strictest wins, and its own wording is used', () => {
  const same: ToolStates = { rows: [
    { toolId: 't', audience: 'staff', groups: ['a'], state: 'allow' },
    { toolId: 't', audience: 'staff', groups: ['b'], state: 'ask', prompt: 'Sure?' },
  ] };
  assert.deepEqual(state('t', same, person('manager', ['a', 'b'])), { state: 'ask', via: 'row', prompt: 'Sure?' });
  const blocked: ToolStates = { rows: [
    { toolId: 't', audience: 'staff', groups: [], state: 'ask' },
    { toolId: 't', audience: 'staff', groups: [], state: 'blocked' },
  ] };
  assert.equal(state('t', blocked, person('manager')).state, 'blocked');
});

check('offered tools leave out the blocked ones and keep the order', () => {
  const tools = ['search_products', 'update_cart', 'hand_off_to_human', 'create_quote'];
  assert.deepEqual(offeredTools(tools, table, person('customer')).map((t) => `${t.toolId}:${t.state}`), ['search_products:allow', 'update_cart:ask']);
  assert.deepEqual(offeredTools(tools, table, person('manager', ['sales'])).map((t) => `${t.toolId}:${t.state}`), ['search_products:allow', 'update_cart:allow', 'hand_off_to_human:allow', 'create_quote:ask']);
});

console.log(`✅ tool states: ${passed} passed, 0 failed`);
