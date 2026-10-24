/**
 * A number typed outside a question's usual range is questioned once ("did you mean…?"), never refused.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/numberRange.test.ts
 */
import assert from 'node:assert/strict';
import { nearbyInRange } from '@journeyax/ui-cards/answers';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check('a number a decimal place too big is offered back one place smaller', () => {
  assert.equal(nearbyInRange(18, 1, 6), 1.8);
  assert.equal(nearbyInRange(240, 1, 6), 2.4);
});

check('a number a decimal place too small is offered back one place bigger', () => {
  assert.equal(nearbyInRange(0.24, 1, 6), 2.4);
});

check('a number already inside the range, or one no shift can fix, offers nothing', () => {
  assert.equal(nearbyInRange(3, 1, 6), undefined);
  assert.equal(nearbyInRange(7.5, 1, 6), undefined);
  assert.equal(nearbyInRange(0, 1, 6), undefined);
  assert.equal(nearbyInRange(Number.NaN, 1, 6), undefined);
});

check('a range with only one end still works', () => {
  assert.equal(nearbyInRange(25, undefined, 3), 2.5);
  assert.equal(nearbyInRange(0.5, 2, undefined), 5);
});

console.log(`✅ web: number range: ${passed} passed, 0 failed`);
