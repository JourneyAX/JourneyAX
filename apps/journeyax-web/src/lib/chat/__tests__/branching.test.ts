/**
 * Try again and edit: which messages may be sent again, from where, and which cards go with the replaced turn.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/chat/__tests__/branching.test.ts
 */
import assert from 'node:assert/strict';
import {
  ROOT_MESSAGE, answerWithId, branchBase, canBranchAt, cardCountToKeep, keepCardsUpTo, retryableIndex, withMessageIds, type ChatMessage,
} from '../branching';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const ids = (turn: string) => ({ customer: `${turn}:customer`, assistant: `${turn}:assistant` });

/** One finished turn the way the chat builds it: the customer message, stamped, then the reply with its id. */
const finish = (before: ChatMessage[], text: string, turn: string, extra: Partial<ChatMessage> = {}): ChatMessage[] => {
  const asked = [...before, { role: 'user', content: text, ...extra }];
  const stamped = withMessageIds(asked, ids(turn));
  return [...stamped, answerWithId({ role: 'assistant', content: `Answer to ${text}` } as ChatMessage, ids(turn))];
};

check('the first customer message is stamped with the root as its parent, and the reply keeps its id', () => {
  const thread = finish([], 'cordless drill for concrete', 't1');
  assert.equal(thread[0].messageId, 't1:customer');
  assert.equal(thread[0].parentMessageId, ROOT_MESSAGE);
  assert.equal(thread[1].messageId, 't1:assistant');
});

check('a later customer message continues from the reply before it', () => {
  const thread = finish(finish([], 'drill', 't1'), 'the second one', 't2');
  assert.equal(thread[2].parentMessageId, 't1:assistant');
  assert.equal(thread[3].messageId, 't2:assistant');
});

check('stamping twice changes nothing, and a turn without ids leaves the messages alone', () => {
  const once = finish([], 'drill', 't1');
  const again = withMessageIds(once, ids('t1'));
  assert.deepEqual(again, once);
  const plain: ChatMessage[] = [{ role: 'user', content: 'hello' }];
  assert.equal(withMessageIds(plain, undefined), plain);
  assert.equal(withMessageIds(plain, {}), plain);
  assert.equal(answerWithId({ role: 'assistant', content: 'x' }, undefined).messageId, undefined);
});

check('where the chain is not known, no parent is recorded and nothing can be edited', () => {
  // A saved thread from before ids existed: the reply has no id, so the next message cannot say what it continues from.
  const old: ChatMessage[] = [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }];
  const thread = finish(old, 'new question', 't9');
  assert.equal(thread[2].messageId, 't9:customer');
  assert.equal(thread[2].parentMessageId, undefined);
  assert.equal(canBranchAt(thread, 2), false);
  assert.equal(retryableIndex(thread), -1);
  assert.equal(canBranchAt(thread, 0), false);
});

check('a typed message with a known place can be edited; taps, quiet events, empty text and replies cannot', () => {
  const thread = finish(finish([], 'drill', 't1'), 'the second one', 't2');
  assert.equal(canBranchAt(thread, 0), true);
  assert.equal(canBranchAt(thread, 2), true);
  assert.equal(canBranchAt(thread, 1), false, 'a reply');
  assert.equal(canBranchAt(thread, 9), false, 'no such message');
  const tapped = finish(thread, 'Added the kit to my cart', 't3', { customerEvent: { type: 'addToCart' } });
  assert.equal(canBranchAt(tapped, 4), false, 'a card tap may change a cart, so it is never sent again');
  const quiet = finish(thread, 'Payment received for order 1', 't4', { silent: true });
  assert.equal(canBranchAt(quiet, 4), false);
  const blank = finish([], '   ', 't5');
  assert.equal(canBranchAt(blank, 0), false);
});

check('only the last reply can be tried again, and only when it follows a message that can be sent again', () => {
  const two = finish(finish([], 'drill', 't1'), 'the second one', 't2');
  assert.equal(retryableIndex(two), 2);
  assert.equal(retryableIndex(two.slice(0, 3)), -1, 'the reply is not there yet');
  assert.equal(retryableIndex([]), -1);
  const afterTap = finish(two, 'Added the kit', 't3', { customerEvent: { type: 'addToCart' } });
  assert.equal(retryableIndex(afterTap), -1, 'the last turn was a tap');
  const noReplyId = [...two.slice(0, 3), { role: 'assistant', content: 'streamed but the turn did not report ids' }];
  assert.equal(retryableIndex(noReplyId), -1);
});

check('replacing a message keeps what came before it and nothing else', () => {
  const thread = finish(finish([], 'drill', 't1'), 'the second one', 't2');
  assert.deepEqual(branchBase(thread, 2).map((m) => m.messageId), ['t1:customer', 't1:assistant']);
  assert.deepEqual(branchBase(thread, 0), []);
  assert.deepEqual(branchBase(thread, -3), []);
});

check('cards of the replaced turn and of later turns go; earlier cards and unstamped ones stay', () => {
  // Greeting = message 1, turn 1 = messages 2 and 3, turn 2 = messages 4 and 5. A card made while turn 2 ran is stamped 4 (right after the customer).
  const cards = [{ id: 'a', createdAt: '2' }, { id: 'b', createdAt: '3' }, { id: 'c', createdAt: '4' }, { id: 'd', createdAt: 5 }, { id: 'e' }];
  assert.equal(cardCountToKeep(2), 3, 'editing the customer message at index 2 keeps the greeting and the first turn');
  assert.deepEqual(keepCardsUpTo(cards, cardCountToKeep(2)).map((c) => c.id), ['a', 'b', 'e']);
  assert.deepEqual(keepCardsUpTo(cards, cardCountToKeep(0)).map((c) => c.id), ['e'], 'editing the first message clears every stamped card');
  assert.deepEqual(keepCardsUpTo(cards, cardCountToKeep(0, 0)).map((c) => c.id), ['e']);
});

console.log(`\n✅ branching: ${passed} checks`);
