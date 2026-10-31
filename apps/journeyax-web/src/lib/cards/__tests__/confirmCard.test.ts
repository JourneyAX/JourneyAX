/**
 * The ask-first card: what the person sees while it waits, what they see after answering, and what each button sends.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/confirmCard.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { CARD_TYPES, actions, getDefaultTemplate } from '@journeyax/ui-cards';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const state = {
  confirmationId: 'cf_abc',
  heading: 'Please check before I go ahead',
  summary: 'May I ask a team member to take over?',
  details: [{ label: 'Action', value: 'Hand off to human' }, { label: 'Reason', value: 'wants a person' }],
  allowLabel: 'Allow', denyLabel: 'Not now', allowedText: 'You allowed this.', deniedText: 'You chose not to.', pending: true,
};
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(CardRenderer as any, { template: getDefaultTemplate('confirm' as any), state: { ...state, ...over }, onAction: () => {} }));

check('the card type exists, its state is checked, and the answer is an action the page understands', () => {
  assert.ok((CARD_TYPES as any).confirm, 'a card type');
  assert.equal((CARD_TYPES as any).confirm.state.safeParse(state).success, true);
  assert.equal((CARD_TYPES as any).confirm.state.safeParse({ summary: 'no id' }).success, false, 'a card without a confirmation id is refused');
  assert.ok((actions as any).confirmTool, 'confirmTool is a known action');
  assert.equal((actions as any).confirmTool.params.safeParse({ confirmationId: 'cf_abc', decision: 'allow' }).success, true);
  assert.equal((actions as any).confirmTool.params.safeParse({ confirmationId: 'cf_abc', decision: 'maybe' }).success, false);
});

check('while it waits the person sees what is being asked, the details, and both buttons', () => {
  const html = render();
  for (const text of ['Please check before I go ahead', 'May I ask a team member to take over?', 'Hand off to human', 'wants a person', 'Allow', 'Not now']) assert.ok(html.includes(text), `shows "${text}"`);
});

check('once answered the buttons are gone and what the person chose is written instead', () => {
  const html = render({ pending: false, outcome: 'You allowed this.' });
  assert.ok(!html.includes('<button'), 'no button is left to press twice');
  assert.ok(html.includes('You allowed this.'));
});

check('each button sends the confirmation id from the card and its own choice, nothing else', () => {
  const text = JSON.stringify(getDefaultTemplate('confirm' as any));
  const allow = text.match(/"label":\{"\$state":"\/allowLabel"\}[\s\S]*?"decision":"allow"/);
  const deny = text.match(/"label":\{"\$state":"\/denyLabel"\}[\s\S]*?"decision":"deny"/);
  assert.ok(allow && deny, 'an Allow and a Not now button');
  assert.equal((text.match(/"action":"confirmTool"/g) || []).length, 2);
  assert.equal((text.match(/"confirmationId":\{"\$state":"\/confirmationId"\}/g) || []).length, 2, 'the id comes from the card state');
});

console.log(`✅ web: ask-first card: ${passed} passed, 0 failed`);
