/**
 * The conversation as a thread of messages with typed blocks: what is kept, how a path of it is read back, and how the history for the
 * next turn is written so that a follow-up ("the second one") can be answered from what was shown.
 */
import assert from 'node:assert/strict';
import { redactThread } from '../src/kernel/transcript.store';
import {
  assistantMessageId,
  blockForCard,
  buildTurnMessages,
  customerMessageId,
  messagesFromRecord,
  renderThread,
  shownSkus,
  threadFromRecords,
  threadPath,
  type ThreadMessage,
} from '../src/conversation/thread';

const productsCard = {
  cardType: 'products',
  state: {
    heading: 'Drills for concrete',
    products: [
      { sku: '5009059', title: '2-Piece 12V Cordless Hammer Drill Combo Kit', price: 609.01, currency: 'NZD' },
      { sku: '4914039', title: 'M18 Cordless Right Angle Drill Skin', price: 329, currency: 'NZD' },
    ],
  },
};

const turn = (id: string, parentId: string | null, customerText: string, assistantText: string, extra: Record<string, any> = {}) =>
  buildTurnMessages({ turnId: id, parentId, at: `2026-10-24T10:0${id.replace(/\D/g, '') || 0}:00.000Z`, customerText, assistantText, ...extra });

// ── 1. What a turn keeps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const [customer, assistant] = buildTurnMessages({
    turnId: 't1',
    parentId: null,
    at: '2026-10-24T10:00:00.000Z',
    customerText: 'cordless drill for concrete',
    tools: [
      { name: 'search_products', ok: true, arguments: { keywords: ['cordless', 'drill'], productType: 'drill' }, resultCount: 7 },
      { name: 'present_card', ok: true, arguments: { auto: 'searched' } },
    ],
    cards: [productsCard],
    assistantText: 'The Makita kit is the strongest match.',
  });
  assert.equal(customer.id, customerMessageId('t1'));
  assert.equal(assistant.id, assistantMessageId('t1'));
  assert.equal(customer.parentId, null);
  assert.equal(assistant.parentId, customer.id, 'the answer points at the question');
  assert.deepEqual(customer.blocks, [{ type: 'text', text: 'cordless drill for concrete' }]);
  const kinds = assistant.blocks.map((b) => b.type);
  assert.deepEqual(kinds, ['lookup', 'products', 'text'], 'an automatic card is not recorded as a lookup of the model');
  const lookup: any = assistant.blocks[0];
  assert.equal(lookup.count, 7);
  assert.match(lookup.summary, /productType: drill/);
  const products: any = assistant.blocks[1];
  assert.deepEqual(products.items.map((item: any) => item.sku), ['5009059', '4914039'], 'in the order the customer saw them');
}

// A tap is kept as an action; question cards keep their questions and choices; a quantity card keeps the number.
{
  const [customer, assistant] = buildTurnMessages({
    turnId: 't2',
    parentId: 't1:assistant',
    at: '2026-10-24T10:01:00.000Z',
    customerText: '',
    customerAction: { action: 'addToCart', detail: 'Drill kit' },
    cards: [
      { cardType: 'clarify', state: { questions: [{ id: 'size', text: 'How wide is the room?', options: [{ value: 'a', label: 'Under 3 m' }, 'Over 3 m'], unit: 'm' }] } },
      { cardType: 'quantity', state: { product: { sku: '77', title: 'Paver 300mm' }, quantity: 42, unitLabel: 'pavers' } },
    ],
    assistantText: 'Done.',
  });
  assert.deepEqual(customer.blocks, [{ type: 'action', action: 'addToCart', detail: 'Drill kit' }]);
  const [questions, quantity]: any[] = assistant.blocks;
  assert.deepEqual(questions.questions[0].options, ['Under 3 m', 'Over 3 m']);
  assert.equal(questions.questions[0].unit, 'm');
  assert.deepEqual({ sku: quantity.sku, quantity: quantity.quantity, unit: quantity.unit }, { sku: '77', quantity: 42, unit: 'pavers' });
}
assert.deepEqual(blockForCard({ cardType: 'review', state: { heading: 'Last look' } }, () => undefined), { type: 'card', cardType: 'review', heading: 'Last look' });

// ── 2. Paths: a straight conversation, a branch, a lost parent ───────────────────────────────────────────────────────────────────────────
const t1 = turn('t1', null, 'cordless drill for concrete', 'Here are two.', { cards: [productsCard] });
const t2 = turn('t2', 't1:assistant', 'the second one please', 'The M18 right angle drill.');
const t3 = turn('t3', 't2:assistant', 'how long is the warranty?', 'I cannot confirm that.');
const branch = turn('t4', 't1:assistant', 'actually a corded one', 'Here are corded drills.');
const all: ThreadMessage[] = [...t1, ...t2, ...t3, ...branch];

assert.deepEqual(threadPath(all).map((m) => m.id), ['t1:customer', 't1:assistant', 't4:customer', 't4:assistant'], 'the newest message decides the path');
assert.deepEqual(threadPath(all, 't3:assistant').map((m) => m.id), ['t1:customer', 't1:assistant', 't2:customer', 't2:assistant', 't3:customer', 't3:assistant']);
assert.deepEqual(threadPath(all, 't1:assistant').map((m) => m.id), ['t1:customer', 't1:assistant'], 'an edit and retry continues from the earlier message');
assert.deepEqual(threadPath(all, 'nope'), [], 'an unknown message is not guessed at');
assert.deepEqual(threadPath([]), []);
{
  const orphan = turn('t9', 'gone:assistant', 'hello', 'hi');
  assert.deepEqual(threadPath(orphan).map((m) => m.id), ['t9:customer', 't9:assistant'], 'a lost parent starts the path');
}

// ── 3. Turns saved before threads existed are still read ─────────────────────────────────────────────────────────────────────────────────
{
  const records = [
    { turnId: 'old1', customerMessage: 'gib', assistantReply: 'Which one?', timestamps: { receivedAt: '2026-10-01T10:00:00.000Z' } },
    { turnId: 'old2', customerMessage: 'bathroom', assistantReply: 'Aqualine.', timestamps: { receivedAt: '2026-10-01T10:01:00.000Z' } },
    { turnId: 'new3', thread: turn('new3', 'old2:assistant', 'and 10 sheets', 'Ten sheets then.') },
  ];
  const thread = threadFromRecords(records);
  assert.deepEqual(threadPath(thread).map((m) => m.id), ['old1:customer', 'old1:assistant', 'old2:customer', 'old2:assistant', 'new3:customer', 'new3:assistant']);
  assert.equal(messagesFromRecord(records[0], null)[0].blocks[0].type, 'text');
}

// ── 4. The history the next turn reads ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const rendered = renderThread(threadPath(all, 't3:assistant'));
  assert.match(rendered.text, /1\. 2-Piece 12V Cordless Hammer Drill Combo Kit \(SKU 5009059, 609\.01 NZD\); 2\. M18 Cordless Right Angle Drill Skin \(SKU 4914039/, 'the second one is a real SKU');
  assert.match(rendered.text, /Looked up|Shown on a card "Drills for concrete", in this order/);
  assert.match(rendered.text, /Customer: how long is the warranty\?/);
  assert.ok(rendered.text.indexOf('the second one please') < rendered.text.indexOf('how long is the warranty'), 'oldest first, newest last');
  assert.equal(rendered.turns, 3);
  assert.equal(rendered.compacted, 0, 'three turns fit in full');
}
{
  // A long conversation: the newest turns stay in full, older ones shrink, the oldest become one line; the header says so.
  let long: ThreadMessage[] = [];
  let parent: string | null = null;
  for (let i = 1; i <= 14; i++) {
    const messages = turn(`l${i}`, parent, `question number ${i} about decking boards and what goes with them`, `Answer number ${i}. ${'More detail about the boards and fixings. '.repeat(6)}`, { cards: [{ cardType: 'products', state: { products: [{ sku: `S${i}`, title: `Decking board ${i}` }] } }] });
    long = long.concat(messages);
    parent = messages[1].id;
  }
  const small = renderThread(threadPath(long), { maxTokens: 450, fullTurns: 2 });
  assert.ok(small.text.length <= 450 * 4 + 400, `kept within the budget (${small.text.length})`);
  assert.match(small.text, /Earlier in this conversation \(\d+ turns, summarised\)/);
  assert.match(small.text, /Customer: question number 14/, 'the newest turn is always there');
  assert.match(small.text, /Decking board 14 \(SKU S14/, 'and so is what it showed');
  assert.match(small.text, /14 turns, \d+ of them shortened/);
  const roomy = renderThread(threadPath(long), { maxTokens: 20000, fullTurns: 14 });
  assert.equal(roomy.compacted, 0);
}
assert.equal(renderThread([]).text, '');

// ── 5. What was shown, for a follow-up that names it ─────────────────────────────────────────────────────────────────────────────────────
{
  const shown = shownSkus(threadPath(all, 't3:assistant'));
  assert.equal(shown.get('4914039'), 'M18 Cordless Right Angle Drill Skin');
  assert.equal(shown.size, 2);
  const branchShown = shownSkus(threadPath(all));
  assert.equal(branchShown.size, 2, 'the branch started after the cards, so it still knows them');
  assert.equal(shownSkus(threadPath(all, 't1:customer')).size, 0, 'a path that stops before the cards does not');
}

// ── 6. What is stored is redacted like the transcript is ─────────────────────────────────────────────────────────────────────────────────
{
  const stored = redactThread(buildTurnMessages({
    turnId: 'p1', parentId: null, at: '2026-10-24T10:00:00.000Z',
    customerText: 'email me at jo@example.com about the drill',
    customerAction: { action: 'contact', detail: 'jo@example.com' },
    cards: [productsCard],
    assistantText: 'I will pass that on to jo@example.com.',
  }));
  const text = JSON.stringify(stored);
  assert.ok(!text.includes('jo@example.com'), 'no email address is kept');
  assert.ok(text.includes('[REDACTED_EMAIL]'));
  assert.ok(text.includes('2-Piece 12V Cordless Hammer Drill Combo Kit'), 'product facts are kept');
  assert.equal(redactThread(undefined), undefined);
}

console.log('✅ conversation thread: typed blocks, paths and branches, old turns, history budget, redaction');
