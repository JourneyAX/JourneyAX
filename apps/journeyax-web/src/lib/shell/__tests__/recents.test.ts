/**
 * Sidebar recents: grouping by day, ordering, and search.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/recents.test.ts
 */
import assert from 'node:assert/strict';
import { groupOf, groupRecents, startOfDay } from '../recents';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Local times throughout: the grouping follows the visitor's own midnights, so the test builds local dates.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 23, 15, 30); // Fri 23 Oct 2026, 3:30 pm

console.log('sidebar recents');

check('a chat is Today, Yesterday, Previous 7 days or Older by local calendar day', () => {
  assert.equal(groupOf(at(2026, 10, 23, 0, 1), NOW), 'today');
  assert.equal(groupOf(at(2026, 10, 22, 23, 59), NOW), 'yesterday', 'a chat from 11:59 pm last night is Yesterday however few hours ago');
  assert.equal(groupOf(at(2026, 10, 22, 0, 0), NOW), 'yesterday');
  assert.equal(groupOf(at(2026, 10, 21, 23, 59), NOW), 'week');
  assert.equal(groupOf(at(2026, 10, 16, 0, 0), NOW), 'week', 'seven days back is still inside the week');
  assert.equal(groupOf(at(2026, 10, 15, 23, 59), NOW), 'older');
  assert.equal(groupOf(NOW + 5 * 60_000, NOW), 'today', 'a clock slightly ahead of ours still counts as today');
});

check('groups come in a fixed order, empty ones are left out, and chats are newest first inside a group', () => {
  const items = [
    { id: 'old', title: 'Old chat', updatedAt: at(2026, 9, 1) },
    { id: 'a', title: 'Morning', updatedAt: at(2026, 10, 23, 9) },
    { id: 'wk', title: 'Last week', updatedAt: at(2026, 10, 19) },
    { id: 'b', title: 'Afternoon', updatedAt: at(2026, 10, 23, 14) },
  ];
  const groups = groupRecents(items, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Previous 7 days', 'Older']);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['b', 'a']);
  assert.deepEqual(groupRecents([], NOW), []);
});

check('search keeps only matching titles, ignoring case and surrounding spaces', () => {
  const items = [
    { id: '1', title: 'Deck framing sizes', updatedAt: at(2026, 10, 23) },
    { id: '2', title: 'Wet area lining', updatedAt: at(2026, 10, 22) },
    { id: '3', title: '', updatedAt: at(2026, 10, 22) },
  ];
  assert.deepEqual(groupRecents(items, NOW, '  DECK ').flatMap((g) => g.items.map((i) => i.id)), ['1']);
  assert.deepEqual(groupRecents(items, NOW, 'nothing like this'), []);
  assert.equal(groupRecents(items, NOW, '   ').flatMap((g) => g.items).length, 3, 'a blank query keeps everything');
});

check('start of day follows calendar dates, not 24-hour blocks', () => {
  const d = new Date(startOfDay(NOW));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getDate(), 23);
  assert.equal(new Date(startOfDay(NOW, -1)).getDate(), 22);
  assert.equal(new Date(startOfDay(NOW, -23)).getMonth(), 8); // 30 Sep
});

console.log(`✅ web: sidebar recents: ${passed} passed, 0 failed`);
