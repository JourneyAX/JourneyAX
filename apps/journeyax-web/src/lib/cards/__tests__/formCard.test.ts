/**
 * The form as the person sees it: the shop's fields and words, required marks, and the sent state.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/formCard.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FormCard from '../../../components/cards/FormCard';
import { CARD_TYPES, actions } from '@journeyax/ui-cards';
import { isPanelCardType, panelCardCopy } from '../../shell/panelCards';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const state: any = {
  formId: 'contact-us', title: 'Contact us', intro: 'Tell us how we can help.',
  fields: [
    { id: 'name', label: 'Your name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'topic', label: 'Topic', type: 'select', options: ['An order', 'A product'] },
    { id: 'message', label: 'How can we help?', type: 'textarea', required: true },
    { id: 'callback', label: 'Please call me back', type: 'checkbox' },
  ],
  values: { name: 'Jo' }, submitLabel: 'Send it', status: 'open',
};
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(FormCard as any, { state: { ...state, ...over }, onAction: () => {} }));

check('the card type, the action and the side panel know about forms', () => {
  assert.ok((CARD_TYPES as any).form);
  assert.equal((CARD_TYPES as any).form.state.safeParse(state).success, true);
  assert.equal((actions as any).submitForm.params.safeParse({ formId: 'contact-us', values: { name: 'Jo', callback: true } }).success, true);
  assert.equal(isPanelCardType('form'), true);
  assert.equal(panelCardCopy({ id: 'c', cardType: 'form', state }).note, 'Opened "Contact us" in the side panel');
});

check('the shop\'s title, intro, fields, choices and button are shown, required fields marked, what is known already filled in', () => {
  const html = render();
  for (const text of ['Contact us', 'Tell us how we can help.', 'Your name *', 'Email *', 'How can we help? *', 'Please call me back', 'An order', 'A product', 'Send it']) assert.ok(html.includes(text), `shows "${text}"`);
  assert.ok(!html.includes('Topic *'), 'an optional field is not marked');
  assert.ok(/value="Jo"/.test(html), 'what the assistant already knew is in the box');
  assert.ok(html.includes('type="email"') && html.includes('<textarea') && html.includes('<select'));
});

check('once sent the boxes and the button are gone and the shop\'s words say so', () => {
  const html = render({ status: 'sent', sentText: 'Sent. Thank you.' });
  assert.ok(!html.includes('Send it'), 'no button to press twice');
  assert.ok(html.includes('Sent. Thank you.'));
  assert.ok((html.match(/disabled/g) || []).length >= 4, 'the boxes are locked');
});

console.log(`✅ web: form card: ${passed} passed, 0 failed`);
