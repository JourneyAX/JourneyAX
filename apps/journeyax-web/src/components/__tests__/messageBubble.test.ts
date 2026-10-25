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

console.log(`✅ web: message bubble: ${passed} passed, 0 failed`);
