/**
 * Which cards keep their own place instead of replacing the last card of their type.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/appendOnly.test.ts
 */
import assert from 'node:assert/strict';
import { keepsOwnPlace } from '../appendOnly';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('appendOnly');

check('record cards each keep their own place, so the customer and their cases both show', () => {
  assert.equal(keepsOwnPlace({ cardType: 'records' }), true);
});

check('a card that asks to be appended is, and the product cards still replace the last one as before', () => {
  assert.equal(keepsOwnPlace({ cardType: 'products', variant: 'append' }), true);
  assert.equal(keepsOwnPlace({ cardType: 'products' }), false);
  assert.equal(keepsOwnPlace({ cardType: 'comparison' }), false);
});

console.log(`\n${passed} passed`);
