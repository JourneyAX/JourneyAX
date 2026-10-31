/**
 * Saved chats belong to the person who is signed in, not to the browser.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/__tests__/conversations.test.ts
 */
import assert from 'node:assert/strict';
import {
  deleteConversation, listConversations, messagesKey, resolveActiveConversation, saveConversations, setStorageOwner,
} from '../conversations';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// a tiny stand-in for the browser's storage
const store = new Map<string, string>();
(globalThis as any).window = {};
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const PROJECT = 'placemakers';

console.log('saved chats per person');

check('what one person saves is not listed for the next person on the same browser', () => {
  setStorageOwner('shopper@placemakers.demo');
  saveConversations(PROJECT, [{ id: 'c_1', title: 'Prolam posts', updatedAt: 10 }]);
  localStorage.setItem(messagesKey(PROJECT, 'c_1'), '[{"role":"user","content":"hi"}]');
  assert.deepEqual(listConversations(PROJECT).map((c) => c.id), ['c_1']);

  setStorageOwner('sales@placemakers.demo');
  assert.deepEqual(listConversations(PROJECT), [], 'the sales rep starts with no chats of their own');
  const { id, list } = resolveActiveConversation(PROJECT);
  assert.equal(list.length, 1);
  assert.notEqual(id, 'c_1');
  assert.equal(localStorage.getItem(messagesKey(PROJECT, 'c_1')), null, 'and cannot reach the shopper\'s messages');
});

check('the first person finds their own chats again, untouched', () => {
  setStorageOwner('shopper@placemakers.demo');
  assert.deepEqual(listConversations(PROJECT).map((c) => c.id), ['c_1']);
  assert.ok(localStorage.getItem(messagesKey(PROJECT, 'c_1')));
});

check('a login is read the same in any case, and a person who is signed out has a place of their own', () => {
  setStorageOwner('Shopper@PlaceMakers.demo ');
  assert.deepEqual(listConversations(PROJECT).map((c) => c.id), ['c_1']);
  setStorageOwner(null);
  assert.deepEqual(listConversations(PROJECT), []);
});

check('deleting a chat removes it only for the person who owns it', () => {
  setStorageOwner('sales@placemakers.demo');
  const [mine] = listConversations(PROJECT);
  deleteConversation(PROJECT, mine.id);
  assert.deepEqual(listConversations(PROJECT), []);
  setStorageOwner('shopper@placemakers.demo');
  assert.deepEqual(listConversations(PROJECT).map((c) => c.id), ['c_1']);
});

console.log(`\n${passed} passed`);
