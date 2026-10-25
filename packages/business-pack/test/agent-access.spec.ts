import assert from 'node:assert/strict';
import { AgentAccessSchema, BusinessPackContentSchema } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Agent access table (pack extensions.agentAccess)');

const table = {
  rows: [
    { agentId: 'shopping-consultant', audience: 'shopper', level: 'default' },
    { agentId: 'order-help', audience: 'staff', groups: ['customer-service'], level: 'default' },
    { agentId: 'order-help', audience: 'staff', groups: ['sales'], level: 'available' },
  ],
};

check('a table parses, and a row without groups means every group (an empty list)', () => {
  const parsed = AgentAccessSchema.parse(table);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0].groups, []);
  assert.deepEqual(parsed.rows[1].groups, ['customer-service']);
});

check('anything outside the shape is refused: unknown fields, levels and audiences, odd group ids, too many rows', () => {
  const bad = (row: Record<string, unknown>) => AgentAccessSchema.safeParse({ rows: [{ agentId: 'a', audience: 'staff', level: 'available', ...row }] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ extra: 1 }), false);
  assert.equal(bad({ level: 'admin' }), false);
  assert.equal(bad({ audience: 'customer' }), false);
  assert.equal(bad({ groups: ['Customer Service'] }), false, 'a group id is in its clean form');
  assert.equal(bad({ groups: ['<x>'] }), false);
  assert.equal(bad({ agentId: '' }), false);
  assert.equal(AgentAccessSchema.safeParse({ rows: Array.from({ length: 201 }, () => ({ agentId: 'a', audience: 'staff', level: 'available' })) }).success, false);
  assert.equal(AgentAccessSchema.safeParse({ rows: [], extra: true }).success, false);
});

check('the pack accepts the table under extensions and still accepts a pack without it', () => {
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.ok(shape, 'the pack declares extensions');
  assert.equal(shape.safeParse({ agentAccess: table }).success, true);
  assert.equal(shape.safeParse({}).success, true);
  assert.equal(shape.safeParse({ agentAccess: { rows: [{ agentId: 'a', audience: 'staff', level: 'owner' }] } }).success, false);
});

console.log(`✅ agent access table: ${passed} passed, 0 failed`);
