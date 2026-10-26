import assert from 'node:assert/strict';
import { AccessoryHelperSchema, BuyerFeedbackSchema } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 What goes with a product (extensions.accessoryHelper) and what buyers mention (extensions.buyerFeedback)');

const rule = { when: ['Vanities'], needs: [{ label: 'Basin mixer', query: 'basin mixer', reason: 'Needed to run water to the basin', maxItems: 3 }, { label: 'Basin waste', query: 'basin waste' }] };

check('a must-have list parses: for a kind of product, what the job needs, each found by words and given a reason', () => {
  const parsed = AccessoryHelperSchema.safeParse({ labels: { suggestionsNote: 'Suggestions to check.' }, mustHave: [rule] });
  assert.equal(parsed.success, true);
  assert.equal(AccessoryHelperSchema.safeParse({}).success, true, 'every part is optional');
});

check('a rule with nothing it applies to, nothing it needs, a nameless need, too many items or an unknown field is refused', () => {
  assert.equal(AccessoryHelperSchema.safeParse({ mustHave: [{ when: [], needs: rule.needs }] }).success, false);
  assert.equal(AccessoryHelperSchema.safeParse({ mustHave: [{ when: ['Vanities'], needs: [] }] }).success, false);
  assert.equal(AccessoryHelperSchema.safeParse({ mustHave: [{ when: ['Vanities'], needs: [{ label: '', query: 'x' }] }] }).success, false);
  assert.equal(AccessoryHelperSchema.safeParse({ mustHave: [{ when: ['Vanities'], needs: [{ label: 'Mixer', query: 'x', maxItems: 20 }] }] }).success, false);
  assert.equal(AccessoryHelperSchema.safeParse({ mustHave: [{ ...rule, extra: true }] }).success, false);
  assert.equal(AccessoryHelperSchema.safeParse({ somethingElse: 1 }).success, false);
});

check('buyer feedback parses with what is mentioned and, optionally, what to watch for, and refuses empty or unknown parts', () => {
  assert.equal(BuyerFeedbackSchema.safeParse({ rules: [{ when: ['Vanity'], mentions: ['Soft-close drawers'], watchFor: ['Sold separately'] }] }).success, true);
  assert.equal(BuyerFeedbackSchema.safeParse({ rules: [] }).success, true);
  assert.equal(BuyerFeedbackSchema.safeParse({ rules: [{ when: ['Vanity'], mentions: [] }] }).success, false);
  assert.equal(BuyerFeedbackSchema.safeParse({ rules: [{ when: [], mentions: ['x'] }] }).success, false);
  assert.equal(BuyerFeedbackSchema.safeParse({ rules: [{ when: ['Vanity'], mentions: ['x'], stars: 5 }] }).success, false);
});

console.log(`✅ business-pack: accessory and feedback settings: ${passed} passed, 0 failed`);
