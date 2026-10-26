/**
 * Editing skills: what a save or a delete changes, and the checks that keep the pack consistent.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/skillEdit.test.ts
 */
import assert from 'node:assert/strict';
import {
  ACCESS_PRESETS, applySkillDelete, applySkillSave, cleanAccessRows, fingerprintInState, fingerprintOf, formRowsFromEntries, presetOf, presetRows,
  slugifySkillId, toolWarnings, validateSkill, type EditContext, type ProjectSkillState, type SkillInput,
} from '../skillEdit';
import type { OverviewToolOption } from '../types';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const CONTEXT: EditContext = { platformTools: ['present_card', 'check_stock'], connectorTools: ['salesforce.list_cases', 'salesforce.list_opportunities', 'commercetools.get_order'], agentIds: ['advisor', 'service', 'sales'] };
const state = (): ProjectSkillState => ({
  skills: [
    { skillId: 'greet', name: 'Greeting', description: 'How to open', instructions: 'Say hello.', tier: 'always', tools: ['present_card'], future: 'kept' },
    { skillId: 'account-360', name: 'Account 360', description: 'One account', instructions: 'Look it up.', tier: 'on_demand', tools: ['salesforce.list_cases'] },
  ],
  agents: [
    { agentId: 'advisor', name: 'Advisor', skills: ['greet'] },
    { agentId: 'service', name: 'Service', skills: ['account-360'] },
    { agentId: 'sales', name: 'Sales' },
  ],
  accessRows: [{ skillId: 'account-360', audience: 'staff', groups: ['customer-service', 'administrators'], level: 'available' }],
  plugins: { plugins: [{ pluginId: 'desk', name: 'Desk', provides: { agents: [], skills: ['account-360', 'greet'], forms: [], connectors: [], tools: [] } }], access: [{ pluginId: 'desk', audience: 'staff', groups: [], level: 'available' }] },
});
const input = (over: Partial<SkillInput> = {}): SkillInput => ({
  name: 'Order enquiry', description: 'When a colleague asks about an order', tier: 'on_demand', instructions: 'Find the order with get_order.',
  tools: ['commercetools.get_order'], access: [{ audience: 'staff', groups: ['customer-service', 'branch'], level: 'available' }], agents: ['service'], ...over,
});

console.log('editing skills');

check('an id is made from the name once: lower case with hyphens, and new among the ids taken', () => {
  assert.equal(slugifySkillId('Order enquiry'), 'order-enquiry');
  assert.equal(slugifySkillId('  Account 360 — before a call! '), 'account-360-before-a-call');
  assert.equal(slugifySkillId('Greeting', ['greeting']), 'greeting-2');
  assert.equal(slugifySkillId('Greeting', ['greeting', 'greeting-2']), 'greeting-3');
  assert.equal(slugifySkillId('???'), 'skill');
  assert.match(slugifySkillId('x'.repeat(200)), /^[a-z0-9][a-z0-9_-]*$/);
});

check('access rows are made valid: ids normalised, the admin group added to a staff row that names teams, a shopper row never names any, duplicates dropped', () => {
  assert.deepEqual(cleanAccessRows([
    { audience: 'staff', groups: ['Customer Service', 'customer-service', ' Branch '], level: 'available' },
    { audience: 'staff', groups: ['customer-service', 'branch', 'administrators'], level: 'available' },
    { audience: 'shopper', groups: ['sales'], level: 'default' },
    { audience: 'staff', groups: [], level: 'default' },
  ]), [
    { audience: 'staff', groups: ['customer-service', 'branch', 'administrators'], level: 'available' },
    { audience: 'shopper', groups: [], level: 'default' },
    { audience: 'staff', groups: [], level: 'default' },
  ]);
});

check('a good form passes; every kind of mistake is named in plain words', () => {
  assert.deepEqual(validateSkill(input(), CONTEXT), { ok: true, errors: [] });
  const bad = validateSkill(input({ name: ' ', description: '', instructions: '', tools: ['made_up', 'salesforce.nope'], agents: ['ghost'], access: [{ audience: 'shopper', groups: ['sales'], level: 'available' }] }), CONTEXT);
  assert.equal(bad.ok, false);
  for (const expected of [/name/i, /when the assistant should use/i, /instructions/i, /made_up/, /salesforce\.nope/, /ghost/, /cannot name teams/i]) assert.ok(bad.errors.some((e) => expected.test(e)), String(expected));
  assert.ok(!validateSkill(input({ instructions: 'x'.repeat(20001) }), CONTEXT).ok);
  assert.ok(!validateSkill(input({ name: 'n'.repeat(81) }), CONTEXT).ok);
  assert.ok(validateSkill(input({ instructions: 'x'.repeat(20000) }), CONTEXT).ok, 'a long skill is allowed: the limit is generous');
});

check('creating a skill adds it, its rows and its agent, leaves everything else as it was, and says only what changed', () => {
  const before = state();
  const done = applySkillSave(before, input(), CONTEXT, 'create');
  assert.equal(done.ok, true);
  const good = done as Extract<typeof done, { ok: true }>;
  assert.equal(good.skillId, 'order-enquiry');
  assert.deepEqual(good.patch.skills!.map((s) => s.skillId), ['greet', 'account-360', 'order-enquiry']);
  assert.deepEqual(good.patch.skills!.at(-1), { skillId: 'order-enquiry', name: 'Order enquiry', description: 'When a colleague asks about an order', tier: 'on_demand', instructions: 'Find the order with get_order.', tools: ['commercetools.get_order'] });
  assert.deepEqual(good.patch.agents!.find((a) => a.agentId === 'service')!.skills, ['account-360', 'order-enquiry']);
  assert.equal(good.patch.agents!.find((a) => a.agentId === 'advisor'), before.agents[0], 'an untouched agent is the same object');
  assert.deepEqual(good.patch.extensions!.skillAccess!.rows.at(-1), { skillId: 'order-enquiry', audience: 'staff', groups: ['customer-service', 'branch', 'administrators'], level: 'available' });
  assert.equal(good.patch.extensions!.skillAccess!.rows.length, 2, 'the other skill\'s row is kept');
  assert.equal(good.patch.extensions!.plugins, undefined, 'plugins are not touched by a save');
  assert.deepEqual(before, state(), 'the input state is not changed');
});

check('a second skill with the same name gets its own id; an unknown tool or agent is refused and nothing is returned to write', () => {
  const twice = applySkillSave(state(), input({ name: 'Greet' }), CONTEXT, 'create') as Extract<ReturnType<typeof applySkillSave>, { ok: true }>;
  assert.equal(twice.skillId, 'greet-2', 'the id greet is taken');
  const refused = applySkillSave(state(), input({ tools: ['nope'] }), CONTEXT, 'create');
  assert.equal(refused.ok, false);
});

check('changing a skill keeps its id and unknown fields, replaces its rows, moves it between agents, and omits what did not change', () => {
  const edited = applySkillSave(state(), input({ skillId: 'greet', name: 'Greeting v2', agents: ['advisor', 'sales'], access: [], tools: ['present_card'] }), CONTEXT, 'update') as Extract<ReturnType<typeof applySkillSave>, { ok: true }>;
  assert.equal(edited.skillId, 'greet');
  assert.deepEqual(edited.patch.skills![0], { skillId: 'greet', name: 'Greeting v2', description: 'When a colleague asks about an order', tier: 'on_demand', instructions: 'Find the order with get_order.', tools: ['present_card'], future: 'kept' });
  assert.deepEqual(edited.patch.agents!.find((a) => a.agentId === 'sales')!.skills, ['greet'], 'added to sales');
  assert.equal(edited.patch.extensions, undefined, 'no rows before and none now: the access table is not rewritten');
  const same = applySkillSave(state(), input({ skillId: 'account-360', name: 'Account 360', description: 'One account', instructions: 'Look it up.', tier: 'on_demand', tools: ['salesforce.list_cases'], access: [{ audience: 'staff', groups: ['customer-service'], level: 'available' }], agents: ['service'] }), CONTEXT, 'update') as Extract<ReturnType<typeof applySkillSave>, { ok: true }>;
  assert.equal(same.patch.agents, undefined);
  assert.equal(same.patch.extensions, undefined, 'identical rows (the admin group is added back) are not rewritten');
  const removed = applySkillSave(state(), input({ skillId: 'account-360', agents: [] }), CONTEXT, 'update') as Extract<ReturnType<typeof applySkillSave>, { ok: true }>;
  assert.deepEqual(removed.patch.agents!.find((a) => a.agentId === 'service')!.skills, []);
});

check('changing a skill that is not there is refused', () => {
  assert.equal(applySkillSave(state(), input({ skillId: 'ghost' }), CONTEXT, 'update').ok, false);
  assert.equal(applySkillSave(state(), input(), CONTEXT, 'update').ok, false);
});

check('deleting removes the skill, its rows, its place on agents and in plugins, and reports what it touched', () => {
  const done = applySkillDelete(state(), 'account-360') as Extract<ReturnType<typeof applySkillDelete>, { ok: true }>;
  assert.deepEqual(done.patch.skills!.map((s) => s.skillId), ['greet']);
  assert.deepEqual(done.patch.agents!.find((a) => a.agentId === 'service')!.skills, []);
  assert.deepEqual(done.patch.extensions!.skillAccess!.rows, []);
  assert.deepEqual(done.patch.extensions!.plugins!.plugins[0].provides.skills, ['greet']);
  assert.deepEqual(done.patch.extensions!.plugins!.access, state().plugins!.access);
  assert.deepEqual(done.affected, { agents: ['service'], plugins: ['desk'], rows: 1 });
  const lone = applySkillDelete(state(), 'greet') as Extract<ReturnType<typeof applySkillDelete>, { ok: true }>;
  assert.equal(lone.patch.extensions?.skillAccess, undefined, 'a skill with no rows leaves the table alone');
  assert.equal(applySkillDelete(state(), 'ghost').ok, false);
});

check('a fingerprint ignores the order of rows, groups, tools and agents, and changes with anything a person could have edited', () => {
  const s = state();
  const f = fingerprintInState(s, 'account-360')!;
  assert.equal(fingerprintInState(s, 'ghost'), undefined);
  const parts = { name: 'Account 360', description: 'One account', tier: 'on_demand', instructions: 'Look it up.', tools: ['salesforce.list_cases'], rows: [{ audience: 'staff', groups: ['administrators', 'customer-service'], level: 'available' }], agents: ['service'] };
  assert.equal(fingerprintOf(parts), f, 'the same as read from the project settings');
  assert.equal(fingerprintOf({ ...parts, instructions: ' Look it up. ' }), f, 'surrounding spaces do not matter');
  for (const changed of [{ ...parts, instructions: 'Look it up now.' }, { ...parts, tools: [] }, { ...parts, agents: [] }, { ...parts, rows: [] }, { ...parts, tier: 'always' }, { ...parts, name: 'Account three sixty' }]) assert.notEqual(fingerprintOf(changed), f);
  const moved = state();
  moved.accessRows = [{ skillId: 'account-360', audience: 'staff', groups: ['customer-service', 'administrators'], level: 'available' }];
  assert.equal(fingerprintInState(moved, 'account-360'), f);
});

check('the form can start from a skill\'s rows (the admin group is hidden) and from a preset, and tell which preset a set of rows is', () => {
  assert.deepEqual(formRowsFromEntries([{ audience: 'staff', groups: ['customer-service', 'administrators'], level: 'available' }, { audience: 'shopper', groups: [], level: 'not_available' }]), [{ audience: 'staff', groups: ['customer-service'], level: 'available' }]);
  assert.deepEqual(presetRows('everyone', ['sales']), []);
  assert.deepEqual(presetRows('staff-always', ['sales']), [{ audience: 'staff', groups: ['sales'], level: 'default' }]);
  assert.equal(presetOf([]), 'everyone');
  assert.equal(presetOf(presetRows('staff-on-demand', ['sales'])), 'staff-on-demand');
  assert.equal(presetOf([{ audience: 'shopper', groups: [], level: 'default' }]), undefined);
  assert.equal(Object.keys(ACCESS_PRESETS).length, 3);
});

const TEAMS = [{ id: 'customer-service', name: 'Customer Service' }, { id: 'sales', name: 'Sales' }];
const OPTIONS: OverviewToolOption[] = [
  { id: 'present_card', label: 'Show a card', systemId: 'platform', system: 'Built-in tools', summary: '', enabled: true },
  { id: 'salesforce.list_opportunities', label: 'List opportunities', systemId: 'salesforce', system: 'Salesforce', summary: '', sideEffect: 'read', enabled: true, states: { shopper: 'blocked', 'customer-service': 'blocked', sales: 'allow' } },
  { id: 'zendesk.find_tickets', label: 'Find tickets', systemId: 'zendesk', system: 'Zendesk', summary: '', sideEffect: 'read', enabled: false, states: { shopper: 'blocked', 'customer-service': 'allow', sales: 'allow' } },
];

check('warnings name the team that cannot use a tool, a system that is switched off, and the shoppers who have no connectors at all', () => {
  const rows = [{ audience: 'staff' as const, groups: ['customer-service', 'sales'], level: 'available' as const }];
  const w = toolWarnings(['present_card', 'salesforce.list_opportunities', 'zendesk.find_tickets'], rows, OPTIONS, TEAMS);
  assert.deepEqual(w.map((x) => `${x.tool}|${x.who}|${x.state}`), ['salesforce.list_opportunities|Customer Service|blocked', 'zendesk.find_tickets|Zendesk|off']);
  assert.match(w[0].text, /Customer Service cannot use "List opportunities"/);
  const all = toolWarnings(['salesforce.list_opportunities'], [{ audience: 'staff', groups: [], level: 'available' }], OPTIONS, TEAMS);
  assert.deepEqual(all.map((x) => x.who), ['Customer Service'], 'a row for all staff is checked team by team');
  const everyone = toolWarnings(['salesforce.list_opportunities'], [], OPTIONS, TEAMS);
  assert.ok(everyone.some((x) => x.who === 'Shoppers'), 'no rows means everyone, shoppers included');
  assert.deepEqual(toolWarnings(['present_card'], [], OPTIONS, TEAMS), [], 'a built-in tool is not governed by team rules');
});

console.log(`${passed} passed`);
