/**
 * Putting a question to the assistant from a dashboard line or a card.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/askInChat.test.ts
 */
import assert from 'node:assert/strict';
import { askInChat, registerAskHandler } from '../askInChat';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('askInChat');

check('nothing is sent when the chat is not listening, or the question is empty', () => {
  assert.equal(askInChat('Show me my deals'), false);
  const stop = registerAskHandler(() => true);
  assert.equal(askInChat('   '), false);
  stop();
});

check('the chat receives a tidy question and says whether it took it', () => {
  const seen: string[] = [];
  const stop = registerAskHandler((text) => { seen.push(text); return text !== 'busy'; });
  assert.equal(askInChat('  Tell me   about\nthe deal  '), true);
  assert.deepEqual(seen, ['Tell me about the deal']);
  assert.equal(askInChat('busy'), false, 'a chat that is mid-answer says no');
  stop();
  assert.equal(askInChat('after'), false, 'once the chat stops listening nothing arrives');
});

check('a newer chat takes over, and the older one stopping does not unplug it', () => {
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = registerAskHandler((t) => { first.push(t); return true; });
  const stopSecond = registerAskHandler((t) => { second.push(t); return true; });
  stopFirst();
  askInChat('hello');
  assert.deepEqual(second, ['hello']);
  assert.deepEqual(first, []);
  stopSecond();
});

check('a question is cut to a sensible length', () => {
  let got = '';
  const stop = registerAskHandler((t) => { got = t; return true; });
  askInChat('x'.repeat(2000));
  assert.equal(got.length, 600);
  stop();
});

console.log(`\n${passed} passed`);
