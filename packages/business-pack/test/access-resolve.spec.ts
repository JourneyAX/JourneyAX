import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { resolveAccess, rowApplies, shopperCanUse, type AgentAccess } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 resolveAccess: who may use which agent');

const agents = [{ agentId: 'shopping-consultant' }, { agentId: 'order-help' }, { agentId: 'trade-credit-check' }, { agentId: 'quote-desk' }];
// The PlaceMakers example from the plan: order help for customer service, credit check for the trade desk only.
const access: AgentAccess = {
  rows: [
    { agentId: 'shopping-consultant', audience: 'shopper', groups: [], level: 'default' },
    { agentId: 'order-help', audience: 'staff', groups: ['customer-service'], level: 'default' },
    { agentId: 'order-help', audience: 'staff', groups: ['sales'], level: 'available' },
    { agentId: 'trade-credit-check', audience: 'staff', groups: ['trade-desk'], level: 'available' },
  ],
};
const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });
const ids = (result: ReturnType<typeof resolveAccess>) => result.agents.map((a) => a.agentId);

check('with no table every agent is open to everyone, as before the table existed', () => {
  for (const who of [person('customer'), person('manager', ['sales'])]) {
    assert.deepEqual(ids(resolveAccess(agents, undefined, who)), agents.map((a) => a.agentId));
    assert.deepEqual(ids(resolveAccess(agents, { rows: [] }, who)), agents.map((a) => a.agentId));
  }
});

check('a shopper gets the shopping consultant and the agents nobody has restricted, and never a staff agent', () => {
  const result = resolveAccess(agents, access, person('customer'));
  assert.deepEqual(ids(result), ['shopping-consultant', 'quote-desk']);
  assert.equal(result.defaultAgentId, 'shopping-consultant');
});

check('a customer-service rep gets order help as their default, and still the shopping consultant', () => {
  const result = resolveAccess(agents, access, person('operator', ['customer-service']));
  assert.deepEqual(ids(result), ['shopping-consultant', 'order-help', 'quote-desk']);
  assert.equal(result.defaultAgentId, 'order-help');
  assert.equal(ids(result).includes('trade-credit-check'), false, 'the trade desk\'s agent is not theirs');
});

check('a member of staff with no group, or only an unrelated group, gets what a shopper gets', () => {
  assert.deepEqual(ids(resolveAccess(agents, access, person('manager'))), ['shopping-consultant', 'quote-desk']);
  assert.deepEqual(ids(resolveAccess(agents, access, person('manager', ['branch-hamilton']))), ['shopping-consultant', 'quote-desk']);
});

check('several groups: the highest level wins, and each group adds its agents', () => {
  const result = resolveAccess(agents, access, person('manager', ['sales', 'customer-service', 'trade-desk']));
  assert.equal(result.agents.find((a) => a.agentId === 'order-help')?.level, 'default', 'default beats available');
  assert.ok(ids(result).includes('trade-credit-check'));
});

check('a not-available row hides an agent, and a staff row can still grant it to staff', () => {
  const table: AgentAccess = { rows: [
    { agentId: 'quote-desk', audience: 'shopper', groups: [], level: 'not_available' },
    { agentId: 'quote-desk', audience: 'staff', groups: ['sales'], level: 'available' },
  ] };
  assert.equal(ids(resolveAccess(agents, table, person('customer'))).includes('quote-desk'), false);
  assert.equal(ids(resolveAccess(agents, table, person('manager', ['support']))).includes('quote-desk'), false);
  assert.equal(ids(resolveAccess(agents, table, person('manager', ['sales']))).includes('quote-desk'), true);
});

check('a required row locks the person to that one agent', () => {
  const table: AgentAccess = { rows: [{ agentId: 'order-help', audience: 'staff', groups: ['trainee'], level: 'required' }] };
  const result = resolveAccess(agents, table, person('operator', ['trainee']));
  assert.deepEqual(ids(result), ['order-help']);
  assert.equal(result.lockedAgentId, 'order-help');
  assert.equal(resolveAccess(agents, table, person('operator', ['sales'])).lockedAgentId, undefined);
});

check('a staff row never applies to a shopper, even one who claims the group', () => {
  const row = access.rows[1];
  assert.equal(rowApplies(row, { audience: 'staff', groups: ['customer-service'] }), true);
  assert.equal(rowApplies(row, { audience: 'shopper', groups: ['customer-service'] }), false);
  assert.equal(ids(resolveAccess(agents, access, { audience: 'shopper', groups: ['customer-service'] })).includes('order-help'), false);
});

check('a row for an agent that is not in the pack is ignored, and nothing is added for it', () => {
  const table: AgentAccess = { rows: [{ agentId: 'ghost', audience: 'staff', groups: [], level: 'default' }] };
  const result = resolveAccess(agents, table, person('manager'));
  assert.equal(ids(result).includes('ghost'), false);
  assert.equal(result.defaultAgentId, undefined);
});

check('the publication gate can ask whether a shopper can use an agent', () => {
  assert.equal(shopperCanUse('shopping-consultant', access), true);
  assert.equal(shopperCanUse('quote-desk', access), true, 'no row means open');
  assert.equal(shopperCanUse('order-help', access), false);
  assert.equal(shopperCanUse('order-help', undefined), true);
});

console.log(`✅ resolveAccess: ${passed} passed, 0 failed`);
