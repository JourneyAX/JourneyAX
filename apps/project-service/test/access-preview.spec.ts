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

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
