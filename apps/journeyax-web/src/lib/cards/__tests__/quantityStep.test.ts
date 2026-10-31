/**
 * The "how many?" step before an add.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/quantityStep.test.ts
 */
import assert from 'node:assert/strict';
import { MAX_QUANTITY, clampQuantity, closeQuantityStep, getQuantityRequest, requestQuantity } from '../quantityStep';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('quantity step');

check('a quantity is a whole number from 1 up, and anything else becomes the fallback', () => {
  assert.equal(clampQuantity(5), 5);
  assert.equal(clampQuantity('12'), 12);
  assert.equal(clampQuantity(2.9), 2);
  assert.equal(clampQuantity(0), 1);
  assert.equal(clampQuantity(-4, 3), 3);
  assert.equal(clampQuantity('abc', 7), 7);
  assert.equal(clampQuantity(undefined), 1);
  assert.equal(clampQuantity(1e9), MAX_QUANTITY);
});

check('a tap opens the step with its own number, and closing it clears it', () => {
  let confirmed = 0;
  let helped = 0;
  requestQuantity({ sku: ' P1 ', title: '  Forum Paver  ', initial: 0, onConfirm: (n) => { confirmed = n; }, onWorkItOut: () => { helped++; } });
  const open = getQuantityRequest()!;
  assert.equal(open.sku, 'P1');
  assert.equal(open.title, 'Forum Paver');
  assert.equal(open.initial, 1, 'a missing or zero number starts at one');
  open.onConfirm(63);
  open.onWorkItOut();
  assert.equal(confirmed, 63);
  assert.equal(helped, 1);
  closeQuantityStep();
  assert.equal(getQuantityRequest(), null);
  closeQuantityStep();
  assert.equal(getQuantityRequest(), null, 'closing twice is harmless');
});

check('a request with no title shows its SKU', () => {
  requestQuantity({ sku: 'P2', title: ' ', initial: 3, onConfirm: () => {}, onWorkItOut: () => {} });
  assert.equal(getQuantityRequest()!.title, 'P2');
  closeQuantityStep();
});

console.log(`✅ web: quantity step: ${passed} passed, 0 failed`);
