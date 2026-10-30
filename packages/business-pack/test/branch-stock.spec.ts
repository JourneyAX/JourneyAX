import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BranchStockSchema, BusinessPackContentSchema } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Where a branch\'s stock figures live (extensions.branchStock)');

check('a connector and a tool are enough; inputs, fixed extras and a note are optional', () => {
  assert.equal(BranchStockSchema.safeParse({ connector: 'stock-system', tool: 'stock_by_branch' }).success, true);
  assert.equal(BranchStockSchema.safeParse({ connector: 'ace-erp', tool: 'stock_by_branch', inputs: { sku: 'sku', branch: 'branchName' }, extra: { limit: 25, includeZero: true, region: 'north' }, note: 'Branch codes are three digits.' }).success, true);
});

check('a missing or odd connector or tool, an unknown field, a stray input name or an object as an extra is refused', () => {
  for (const bad of [
    {}, { connector: 'stock-system' }, { tool: 'stock_by_branch' },
    { connector: 'stock system!', tool: 'stock_by_branch' }, { connector: 'stock-system', tool: '' },
    { connector: 'stock-system', tool: 'stock_by_branch', url: 'https://example.test' },
    { connector: 'stock-system', tool: 'stock_by_branch', inputs: { sku: 'sku', warehouse: 'w' } },
    { connector: 'stock-system', tool: 'stock_by_branch', extra: { nested: { a: 1 } } },
    { connector: 'stock-system', tool: 'stock_by_branch', note: 'x'.repeat(401) },
  ]) assert.equal(BranchStockSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

check('the draft pack\'s own setting passes, and a pack carrying it still validates its extensions', () => {
  const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
  const setting = draft.extensions.branchStock;
  assert.equal(BranchStockSchema.safeParse(setting).success, true);
  const extensions = (BusinessPackContentSchema.shape.extensions as any);
  assert.equal(extensions.safeParse({ branchStock: setting }).success, true);
  assert.equal(extensions.safeParse({ branchStock: { connector: 'ace-erp' } }).success, false, 'a half-written setting is refused inside the pack too');
});

console.log(`✅ branch stock setting: ${passed} passed, 0 failed`);
