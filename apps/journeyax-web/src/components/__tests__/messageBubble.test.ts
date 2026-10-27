/**
 * Edit and Try again as the person sees them: only where the chat offers them.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/__tests__/messageBubble.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MessageBubble from '../MessageBubble';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(MessageBubble as any, props));

const user = { id: 'msg-1', role: 'user', text: 'cordless drill for concrete' };
const reply = { id: 'msg-2', role: 'ai', text: 'The Makita kit is the strongest match.' };

check('a customer message has no Edit control unless the chat offers one', () => {
  assert.ok(!render({ message: user }).includes('Edit'));
  const html = render({ message: user, onEdit: () => {} });
  assert.ok(html.includes('Edit') && html.includes('aria-label="Edit this message"'));
  assert.ok(html.includes('cordless drill for concrete'));
});

check('a reply has no Try again control unless the chat offers one', () => {
  assert.ok(!render({ message: reply }).includes('Try again'));
  const html = render({ message: reply, onRetry: () => {} });
  assert.ok(html.includes('Try again') && html.includes('aria-label="Ask for this answer again"'));
  assert.ok(html.includes('The Makita kit is the strongest match.'));
});

check('Edit is not offered on a reply and Try again is not offered on a customer message', () => {
  assert.ok(!render({ message: reply, onEdit: () => {} }).includes('Edit'));
  assert.ok(!render({ message: user, onRetry: () => {} }).includes('Try again'));
});

const replyWith = (text: string) => render({ message: { id: 'msg-3', role: 'ai', text } });
const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;

// The reply the live chat gave for a connector price question, word for word.
const PRICES = [
  'For SKU 1357685, "Rusticated Weatherboard", the trade prices (sample data) are:',
  '* **Retail Price:** NZD 25.79 per linear meter',
  '* **Bronze Tier:** NZD 24.50 per linear meter',
  '* **Silver Tier:** NZD 23.21 per linear meter',
  '* **Gold Tier:** NZD 21.92 per linear meter',
  '',
  'These prices are effective from 2026-05-25. Is there anything else I can help you with?',
].join('\n');

check('bullet lines show as a list with their bold labels, not as italics with stray asterisks', () => {
  const html = replyWith(PRICES);
  assert.equal(count(html, 'ul'), 1);
  assert.equal(count(html, 'li'), 4);
  assert.ok(html.includes('<strong>Retail Price:</strong> NZD 25.79 per linear meter'));
  assert.ok(!html.includes('<em>'), 'nothing is read as italic');
  assert.ok(!html.includes('*'), 'no asterisk is left on screen');
  assert.ok(html.includes('the trade prices (sample data) are:') && html.includes('These prices are effective from 2026-05-25.'), 'the words around the list stay');
});

check('a list is never put inside a paragraph, and the lead-in line stays a paragraph of its own', () => {
  const html = replyWith(PRICES);
  assert.ok(!/<p[^>]*>(?:(?!<\/p>)[\s\S])*<ul/.test(html), 'a list inside a paragraph is invalid markup');
  assert.ok(/<p[^>]*><span>For SKU 1357685/.test(html));
});

check('numbered lines show as an ordered list that keeps its first number; bullets and numbers stay separate lists', () => {
  const html = replyWith('Steps:\n3. Fit the bracket\n4) Fix the rail\n- Check it is level');
  assert.equal(count(html, 'ol'), 1);
  assert.ok(html.includes('<ol class="msg__list" start="3"'));
  assert.equal(count(html, 'ul'), 1);
  assert.equal(count(html, 'li'), 3);
});

check('a line that merely starts with bold or italic text, or has a dash inside a sentence, is not a list', () => {
  for (const text of ['**Note:** the price is sample data', '*Sample data* only', 'Sizes 90-120mm - ask us', '2026-05-25 is the date', '3.5 metres long']) {
    const html = replyWith(text);
    assert.equal(count(html, 'ul') + count(html, 'ol') + count(html, 'li'), 0, text);
  }
  assert.ok(replyWith('**Note:** the price is sample data').includes('<strong>Note:</strong>'));
  assert.ok(replyWith('*Sample data* only').includes('<em>Sample data</em>'));
});

check('a reply without list lines renders exactly as before: paragraphs and line breaks', () => {
  const html = replyWith('First line\nsecond line\n\nNext paragraph with **bold**.');
  assert.equal(count(html, 'p'), 2);
  assert.ok(html.includes('<span>First line</span><span><br/>second line</span>'));
  assert.ok(html.includes('Next paragraph with <strong>bold</strong>.'));
  assert.equal(count(html, 'ul') + count(html, 'ol'), 0);
});

check('links and order numbers inside a list item still work', () => {
  const html = replyWith('See:\n- [the guide](https://example.com/guide)\n- https://example.com/pergolas');
  assert.equal(count(html, 'li'), 2);
  assert.ok(html.includes('href="https://example.com/guide"') && html.includes('>the guide</a>'));
  assert.ok(html.includes('example.com/pergolas'));
});

check('a heading line shows as a bold line without its marks, and a line indented under a step stays inside that step', () => {
  const html = replyWith([
    'The guide gives these steps.',
    '',
    '### Installation and fixing',
    '1. **Footing:** Place a 100mm concrete pad.',
    '   Centralise the post and brace it.',
    '2. **Cuts:** Prime every cut.',
    '3. **Fixings:** Use galvanised bolts.',
    '   Grease them where they touch the timber.',
    '',
    'Paint within 14 days.',
  ].join('\n'));
  assert.ok(!html.includes('#'), 'no # is left on screen');
  assert.ok(html.includes('class="msg__heading"') && html.includes('Installation and fixing'));
  assert.equal(count(html, 'ol'), 1, 'one numbered list, not three');
  assert.equal(count(html, 'li'), 3);
  assert.ok(html.includes('Centralise the post and brace it.') && html.includes('Grease them where they touch the timber.'));
  const firstItem = html.slice(html.indexOf('<li>'), html.indexOf('</li>'));
  assert.ok(firstItem.includes('Footing:') && firstItem.includes('Centralise the post and brace it.'), 'the second line is inside the first step');
  assert.ok(html.includes('Paint within 14 days.'));
});

check('a line that only looks like a heading is left alone', () => {
  for (const text of ['Item #5 is out of stock', 'C#', '#hashtag only']) {
    assert.ok(!replyWith(text).includes('msg__heading'), text);
  }
});

console.log(`✅ web: message bubble: ${passed} passed, 0 failed`);
