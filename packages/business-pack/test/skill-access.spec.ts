import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { BusinessPackContentSchema, resolveSkillTiers, SkillAccessSchema, type SkillAccess } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Skill access (pack extensions.skillAccess): who has which skill, and how');

const skills = [
  { skillId: 'voice', tier: 'always' as const },
  { skillId: 'order-help', tier: 'on_demand' as const },
  { skillId: 'credit-rules', tier: 'always' as const },
  { skillId: 'pictures', tier: 'on_demand' as const },
];
const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });
const summary = (result: ReturnType<typeof resolveSkillTiers>) => result.map((entry) => `${entry.skill.skillId}:${entry.tier}${entry.level ? `(${entry.level})` : ''}`);

check('a table parses; anything outside the shape is refused', () => {
  assert.equal(SkillAccessSchema.safeParse({ rows: [{ skillId: 'voice', audience: 'shopper', level: 'default' }] }).success, true);
  const bad = (row: Record<string, unknown>) => SkillAccessSchema.safeParse({ rows: [{ skillId: 'voice', audience: 'staff', level: 'available', ...row }] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ extra: 1 }), false);
  assert.equal(bad({ level: 'owner' }), false);
  assert.equal(bad({ groups: ['Customer Service'] }), false, 'a group id is in its clean form');
  assert.equal(bad({ skillId: '' }), false);
  assert.equal(SkillAccessSchema.safeParse({ rows: Array.from({ length: 401 }, () => ({ skillId: 'a', audience: 'staff', level: 'available' })) }).success, false);
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.equal(shape.safeParse({ skillAccess: { rows: [] } }).success, true);
  assert.equal(shape.safeParse({ skillAccess: { rows: [{ skillId: 'a', audience: 'staff', level: 'owner' }] } }).success, false);
});

check('with no table (or no rows) every skill is carried as its own tier says: nothing changes for a pack that has no table', () => {
  for (const table of [undefined, { rows: [] } as SkillAccess]) {
    assert.deepEqual(summary(resolveSkillTiers(skills, table, person('customer'))), ['voice:always', 'order-help:on_demand', 'credit-rules:always', 'pictures:on_demand']);
  }
});

const table: SkillAccess = {
  rows: [
    { skillId: 'order-help', audience: 'staff', groups: ['customer-service'], level: 'default' },
    { skillId: 'order-help', audience: 'staff', groups: ['sales'], level: 'available' },
    { skillId: 'credit-rules', audience: 'staff', groups: ['trade-desk'], level: 'required' },
    { skillId: 'pictures', audience: 'shopper', groups: [], level: 'not_available' },
  ],
};

check('a shopper does not get a staff skill, and a not-available row hides a skill from everyone it covers', () => {
  assert.deepEqual(summary(resolveSkillTiers(skills, table, person('customer'))), ['voice:always'], 'order-help and credit-rules have staff rows only; pictures is switched off');
});

check('a customer-service rep gets order help installed (always in the prompt), the voice, and not the trade desk\'s rules', () => {
  assert.deepEqual(summary(resolveSkillTiers(skills, table, person('operator', ['customer-service']))), ['voice:always', 'order-help:always(default)']);
});

check('a sales person has order help on demand; a trade desk person has the credit rules, required', () => {
  assert.deepEqual(summary(resolveSkillTiers(skills, table, person('manager', ['sales']))), ['voice:always', 'order-help:on_demand(available)']);
  assert.deepEqual(summary(resolveSkillTiers(skills, table, person('manager', ['trade-desk']))), ['voice:always', 'credit-rules:always(required)']);
});

check('several groups: the highest level wins and each group adds its skills', () => {
  const result = resolveSkillTiers(skills, table, person('manager', ['sales', 'customer-service', 'trade-desk']));
  assert.deepEqual(summary(result), ['voice:always', 'order-help:always(default)', 'credit-rules:always(required)']);
});

check('a shopper row with the skill on demand turns an always-on skill into an on-demand one for everyone', () => {
  const onDemand: SkillAccess = { rows: [{ skillId: 'voice', audience: 'shopper', groups: [], level: 'available' }] };
  assert.deepEqual(summary(resolveSkillTiers(skills.slice(0, 1), onDemand, person('customer'))), ['voice:on_demand(available)']);
  assert.deepEqual(summary(resolveSkillTiers(skills.slice(0, 1), onDemand, person('manager', ['sales']))), ['voice:on_demand(available)'], 'staff may use a shopper row too');
});

check('a shopper who carries a staff group in their login is still a shopper', () => {
  assert.deepEqual(summary(resolveSkillTiers(skills, table, principalFrom({ userId: 'x@y.test', role: 'customer', groups: ['customer-service'] }))), ['voice:always']);
});

check('order is the order given, and a skill that is not in the list is never invented from the table', () => {
  const ghost: SkillAccess = { rows: [{ skillId: 'ghost', audience: 'shopper', groups: [], level: 'default' }] };
  assert.deepEqual(summary(resolveSkillTiers(skills, ghost, person('customer'))), ['voice:always', 'order-help:on_demand', 'credit-rules:always', 'pictures:on_demand']);
});

console.log(`✅ skill access: ${passed} passed, 0 failed`);
