import assert from 'node:assert/strict';
import { audienceForRole, isStaffRole, MAX_GROUPS, MAX_GROUP_ID_LENGTH, normaliseGroupId, normaliseGroups, principalFrom } from '@journeyax/shared-types';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Principal: shopper or staff, and groups');

check('every role name of the four old lists lands on the right side', () => {
  for (const staff of ['admin', 'manager', 'operator', 'consultant', 'cs', 'rep', 'owner', 'analyst', 'viewer']) assert.equal(audienceForRole(staff), 'staff', staff);
  for (const shopper of ['customer', 'buyer', 'guest', 'anonymous']) assert.equal(audienceForRole(shopper), 'shopper', shopper);
});

check('an unknown, empty or non-text role is a shopper, and case and spaces do not matter', () => {
  for (const odd of ['superuser', '', '   ', undefined, null, 42, {}]) assert.equal(audienceForRole(odd), 'shopper', String(odd));
  assert.equal(isStaffRole('  Manager '), true);
  assert.equal(isStaffRole('MANAGER'), true);
});

check('a group id is stored in one plain form and cannot carry odd text', () => {
  assert.equal(normaliseGroupId('Customer Service'), 'customer-service');
  assert.equal(normaliseGroupId('  trade_desk  '), 'trade-desk');
  assert.equal(normaliseGroupId('Branch:Hamilton'), 'branch:hamilton');
  assert.equal(normaliseGroupId('<script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(normaliseGroupId('--a--b--'), 'a-b');
  assert.equal(normaliseGroupId(''), '');
  assert.equal(normaliseGroupId(7), '');
  assert.equal(normaliseGroupId('x'.repeat(500)).length, MAX_GROUP_ID_LENGTH);
});

check('a list of groups loses duplicates and empties, accepts a comma list, and is capped', () => {
  assert.deepEqual(normaliseGroups(['Sales', 'sales', ' ', 'Customer Service']), ['sales', 'customer-service']);
  assert.deepEqual(normaliseGroups('Sales, Trade Desk,,sales'), ['sales', 'trade-desk']);
  assert.deepEqual(normaliseGroups(undefined), []);
  assert.deepEqual(normaliseGroups({ not: 'a list' }), []);
  assert.equal(normaliseGroups(Array.from({ length: 500 }, (_, i) => `group-${i}`)).length, MAX_GROUPS);
});

check('a member of staff carries their groups; a shopper never does, whatever was claimed', () => {
  const rep = principalFrom({ userId: 'u1', tenantId: 'placemakers', role: 'cs', groups: ['Customer Service', 'sales'] });
  assert.deepEqual(rep, { userId: 'u1', tenantId: 'placemakers', audience: 'staff', roleType: 'cs', groups: ['customer-service', 'sales'] });
  const shopper = principalFrom({ userId: 'u2', role: 'buyer', groups: ['customer-service'] });
  assert.equal(shopper.audience, 'shopper');
  assert.deepEqual(shopper.groups, [], 'a claimed staff group does not lift a shopper');
});

check('no role and no user make an anonymous shopper', () => {
  assert.deepEqual(principalFrom({}), { userId: 'anonymous', audience: 'shopper', roleType: 'customer', groups: [] });
  assert.equal(principalFrom({ role: 'unknown-role', groups: ['sales'] }).audience, 'shopper');
});

console.log(`✅ principal: ${passed} passed, 0 failed`);
