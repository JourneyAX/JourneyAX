import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { buildAccessPreview } from '../src/access-preview';

const suite = createSuite('project-service: "view as" access preview');

const project = (rows?: any[], extra: Record<string, unknown> = {}) => ({
  agents: [
    { agentId: 'shopping-consultant', name: 'Shopping consultant', isDefault: true },
    { agentId: 'order-help', name: 'Order help' },
    { agentId: 'trade-credit-check', name: 'Trade credit check' },
  ],
  extensions: rows ? { agentAccess: { rows } } : {},
  ...extra,
});
const rows = [
  { agentId: 'shopping-consultant', audience: 'shopper', groups: [], level: 'available' },
  { agentId: 'order-help', audience: 'staff', groups: ['customer-service'], level: 'default' },
  { agentId: 'trade-credit-check', audience: 'staff', groups: ['trade-desk'], level: 'available' },
];
const teams = [{ teamId: 'team_customer_service', name: 'Customer Service' }, { teamId: 'team_sales', name: 'Sales' }];

async function main() {
  await suite.test('without a table every agent is open to everyone, and the preview says there is no table', () => {
    for (const audience of ['shopper', 'staff'] as const) {
      const preview = buildAccessPreview(project(), teams, { audience, groups: [] });
      assert.deepEqual(preview.agents.map((a) => a.agentId), ['shopping-consultant', 'order-help', 'trade-credit-check']);
      assert.equal(preview.hasTable, false);
      assert.equal(preview.agents.find((a) => a.opensFirst)?.agentId, 'shopping-consultant', 'the pack\'s own default opens');
    }
  });

  await suite.test('a customer-service rep sees order help first, and a shopper sees only the shopping consultant', () => {
    const rep = buildAccessPreview(project(rows), teams, { audience: 'staff', groups: ['Customer Service'] });
    assert.deepEqual(rep.groups, ['customer-service']);
    assert.deepEqual(rep.agents.map((a) => `${a.agentId}:${a.level}${a.opensFirst ? '*' : ''}`), ['shopping-consultant:available', 'order-help:default*']);
    assert.equal(rep.hasTable, true);
    const shopper = buildAccessPreview(project(rows), teams, { audience: 'shopper', groups: ['customer-service'] });
    assert.deepEqual(shopper.groups, [], 'a shopper has no groups, whatever the preview is asked');
    assert.deepEqual(shopper.agents.map((a) => a.agentId), ['shopping-consultant']);
    assert.equal(shopper.agents[0].opensFirst, true);
  });

  await suite.test('a group the table names that matches no team is flagged, so a typo does not pass quietly', () => {
    const preview = buildAccessPreview(project(rows), teams, { audience: 'staff', groups: ['sales', 'saels'] });
    assert.deepEqual(preview.unknownGroups, ['saels', 'trade-desk']);
    assert.ok(preview.knownGroups.includes('customer-service') && preview.knownGroups.includes('team-sales'));
  });

  await suite.test('a locked person is shown with the one agent and nothing else', () => {
    const locked = buildAccessPreview(project([{ agentId: 'order-help', audience: 'staff', groups: ['sales'], level: 'required' }]), teams, { audience: 'staff', groups: ['sales'] });
    assert.deepEqual(locked.agents.map((a) => a.agentId), ['order-help']);
    assert.equal(locked.lockedAgentId, 'order-help');
  });

  await suite.test('a missing project, no agents, or a table of the wrong shape is read as "no table", never as an error', () => {
    assert.deepEqual(buildAccessPreview(null, [], { audience: 'shopper', groups: [] }).agents, []);
    assert.equal(buildAccessPreview({ agents: [] }, [], { audience: 'staff', groups: [] }).agents.length, 0);
    const bad = buildAccessPreview(project(undefined, { extensions: { agentAccess: { rows: [{ nope: true }] } } }), teams, { audience: 'staff', groups: [] });
    assert.equal(bad.hasTable, false);
    assert.equal(bad.agents.length, 3);
  });

  const skillDefs = [
    { skillId: 'voice', name: 'Voice', description: 'How we sound', instructions: 'Speak as the team.', tier: 'always' },
    { skillId: 'order-help', name: 'Order help', description: 'Order questions', instructions: 'Look the order up.', tier: 'on_demand' },
    { skillId: 'credit-rules', name: 'Credit rules', description: 'Trade credit', instructions: 'Check the limit.', tier: 'always' },
  ];
  const skillRows = [
    { skillId: 'order-help', audience: 'staff', groups: ['customer-service'], level: 'default' },
    { skillId: 'credit-rules', audience: 'staff', groups: ['trade-desk'], level: 'required' },
  ];

  await suite.test('the preview lists the skills a person would have, how each is carried, and the ones that are not theirs', () => {
    const base = project(rows, { extensions: { agentAccess: { rows }, skills: skillDefs, skillAccess: { rows: skillRows } } });
    const shopper = buildAccessPreview(base, teams, { audience: 'shopper', groups: [] });
    assert.deepEqual(shopper.skills.map((k) => `${k.skillId}:${k.tier}`), ['voice:always']);
    assert.deepEqual(shopper.hiddenSkills.map((k) => k.skillId), ['order-help', 'credit-rules']);
    assert.equal(shopper.hasSkillTable, true);
    const rep = buildAccessPreview(base, teams, { audience: 'staff', groups: ['customer-service'] });
    assert.deepEqual(rep.skills.map((k) => `${k.skillId}:${k.tier}:${k.level}:${k.via}`), ['voice:always:null:own', 'order-help:always:default:row']);
    assert.deepEqual(rep.hiddenSkills.map((k) => k.skillId), ['credit-rules']);
  });

  await suite.test('without a skill table every skill is carried as its own tier says, from either place the skills may be kept', () => {
    const plain = buildAccessPreview(project(rows, { extensions: { agentAccess: { rows }, skills: skillDefs } }), teams, { audience: 'shopper', groups: [] });
    assert.deepEqual(plain.skills.map((k) => `${k.skillId}:${k.tier}`), ['voice:always', 'order-help:on_demand', 'credit-rules:always']);
    assert.equal(plain.hasSkillTable, false);
    assert.deepEqual(plain.hiddenSkills, []);
    const topLevel = buildAccessPreview(project(rows, { skills: skillDefs }), teams, { audience: 'shopper', groups: [] });
    assert.equal(topLevel.skills.length, 3);
    assert.deepEqual(buildAccessPreview(null, [], { audience: 'shopper', groups: [] }).skills, [], 'a missing project has no skills');
  });

  await suite.test('a group a skill row names that matches no team is flagged like an agent row\'s', () => {
    const preview = buildAccessPreview(project(rows, { extensions: { agentAccess: { rows }, skills: skillDefs, skillAccess: { rows: [{ skillId: 'order-help', audience: 'staff', groups: ['custmer-service'], level: 'available' }] } } }), teams, { audience: 'staff', groups: [] });
    assert.ok(preview.unknownGroups.includes('custmer-service'));
  });

  await suite.test('the preview says what each named tool may do for the person: asks first, blocked or free', () => {
    const tools = { rows: [
      { toolId: 'update_cart', audience: 'shopper', groups: [], state: 'ask', prompt: 'Change your order?' },
      { toolId: 'update_cart', audience: 'staff', groups: ['sales'], state: 'allow' },
      { toolId: 'hand_off_to_human', audience: 'staff', groups: [], state: 'allow' },
    ] };
    const base = project(rows, { extensions: { agentAccess: { rows }, toolStates: tools } });
    const state = (audience: 'shopper' | 'staff', groups: string[]) => Object.fromEntries(buildAccessPreview(base, teams, { audience, groups }).tools.map((t) => [t.toolId, t.state]));
    assert.deepEqual(state('shopper', []), { update_cart: 'ask', hand_off_to_human: 'blocked' });
    assert.deepEqual(state('staff', ['sales']), { update_cart: 'allow', hand_off_to_human: 'allow' });
    assert.deepEqual(buildAccessPreview(project(rows), teams, { audience: 'shopper', groups: [] }).tools, [], 'no table: nothing to say');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
