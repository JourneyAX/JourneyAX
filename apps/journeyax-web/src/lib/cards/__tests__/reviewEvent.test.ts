/**
 * The last look before payment: what the checkout button asks for, and when it asks.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/reviewEvent.test.ts
 */
import assert from 'node:assert/strict';
import { buildReviewEvent, reviewFingerprint } from '../reviewEvent';
import { readableAnswers, readableUserText } from '../../chat/readableText';
import { formatMoney, orderIdForRef, orderRef, rememberOrder } from '../../../components/canvas/money';
import { answerSummary } from '@journeyax/ui-cards/answers';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('before you pay');

check('the order\'s lines, quantities and branch become the tap the consultant reviews', () => {
  const event = buildReviewEvent(
    [{ sku: 'P1', name: 'Forum Paver', quantity: 83, branchStock: { status: 'In Stock' } }, { sku: ' S1 ', name: 'Sand' }, { name: 'No code' }],
    { id: '600', name: 'Takapuna' },
  )!;
  assert.equal(event.type, 'reviewCart');
  assert.deepEqual(event.payload.items, [{ sku: 'P1', title: 'Forum Paver', quantity: 83, stock: { status: 'In Stock' } }, { sku: 'S1', title: 'Sand', quantity: 1 }]);
  assert.deepEqual(event.payload.branch, { id: '600', name: 'Takapuna' });
  assert.equal(buildReviewEvent([], undefined), null);
  assert.equal(buildReviewEvent([{ name: 'No code' }], undefined), null);
  assert.equal(buildReviewEvent([{ sku: 'P1', quantity: 0 }], {})!.payload.items[0].quantity, 1);
  assert.equal(buildReviewEvent([{ sku: 'P1' }], {})!.payload.branch, undefined);
});

check('a changed order, quantity or branch is looked at again; the same order is not', () => {
  const a = reviewFingerprint([{ sku: 'P1', quantity: 2 }, { sku: 'S1', quantity: 1 }], '600');
  assert.equal(reviewFingerprint([{ sku: 'S1', quantity: 1 }, { sku: 'P1', quantity: 2 }], '600'), a, 'order of lines does not matter');
  assert.notEqual(reviewFingerprint([{ sku: 'P1', quantity: 3 }, { sku: 'S1', quantity: 1 }], '600'), a);
  assert.notEqual(reviewFingerprint([{ sku: 'P1', quantity: 2 }, { sku: 'S1', quantity: 1 }], '700'), a);
});

check('a submitted question card reads as what the customer chose, with a number\'s unit, and other messages are left alone', () => {
  const questions = [
    { id: 'a', text: 'What sort of space?', options: [{ value: 'deck', label: 'Deck area' }] },
    { id: 'b', text: 'What look?', options: [{ value: 'nat', label: 'Natural timber' }] },
    { id: 'c', text: 'How big?', inputType: 'number', unit: 'm²' },
  ];
  const text = `My answers:\n${answerSummary(questions, { a: 'deck', b: 'nat', c: '20' })}`;
  assert.match(text, /How big\? → 20 m²/);
  assert.equal(readableAnswers(text), 'Deck area, Natural timber and 20 m²');
  assert.equal(readableUserText(text), 'Deck area, Natural timber and 20 m²');
  assert.equal(readableAnswers('My answers:\nWhat? → Not answered'), undefined);
  assert.equal(readableUserText('I want a deck'), 'I want a deck');
  assert.equal(readableUserText('[addToCart: Forum Paver]'), 'Add to cart: Forum Paver');
  assert.equal(readableUserText('[reviewCart: my order before I pay]'), 'Review cart: my order before I pay');
});

check('money is the order\'s own, a short order number is readable, and a number in a message finds its order', () => {
  assert.equal(formatMoney(1234.5, '$', 'NZD'), '$1,234.50 NZD');
  assert.equal(formatMoney(120, 'NZ$'), 'NZ$120');
  assert.equal(formatMoney(null), 'Price on request');
  assert.equal(formatMoney(0, '$', undefined, true), 'Price on request');
  assert.equal(orderRef('ord_0123456789abcdef0123456789abcdef'), '89ABCDEF');
  const id = 'ord_ffeeddccbbaa99887766554433221100';
  rememberOrder(id);
  assert.equal(orderRef(id), '33221100');
  assert.equal(orderIdForRef('33221100'), id);
  assert.equal(orderIdForRef('00000000'), undefined);
});

console.log(`✅ web: before you pay: ${passed} passed, 0 failed`);
