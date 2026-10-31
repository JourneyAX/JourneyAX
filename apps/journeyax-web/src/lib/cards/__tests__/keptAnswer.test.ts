/**
 * A number the card questioned and the customer kept is sent as kept, so the consultant does not ask about it again.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/keptAnswer.test.ts
 */
import assert from 'node:assert/strict';
import { KEPT_AS_TYPED, answerSummary } from '@journeyax/ui-cards/answers';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const questions = [
  { id: 'kind', text: 'What kind of wardrobe?', options: [{ value: 'modular', label: 'Ready-made modular system' }] },
  { id: 'width', text: 'Roughly how wide is the wardrobe space?', inputType: 'number', unit: 'm' },
];

check('an answer is written as before when nothing was questioned', () => {
  assert.equal(answerSummary(questions, { kind: 'modular', width: '1.2' }), 'What kind of wardrobe? → Ready-made modular system\nRoughly how wide is the wardrobe space? → 1.2 m');
  assert.equal(answerSummary(questions, { kind: 'modular', width: '1.2' }, {}), answerSummary(questions, { kind: 'modular', width: '1.2' }));
});

check('a number the customer kept after the card questioned it says so, on that line only', () => {
  const text = answerSummary(questions, { kind: 'modular', width: '120' }, { width: true, kind: false });
  assert.equal(text, `What kind of wardrobe? → Ready-made modular system\nRoughly how wide is the wardrobe space? → 120 m ${KEPT_AS_TYPED}`);
});

check('a question with no answer is never marked as kept', () => {
  assert.equal(answerSummary(questions, { kind: 'modular' }, { width: true }), 'What kind of wardrobe? → Ready-made modular system\nRoughly how wide is the wardrobe space? → Not answered');
});

console.log(`✅ web: kept answers: ${passed} passed, 0 failed`);
