/**
 * What buyers often mention, on a product's details: the shop's own words, matched by the product's category or a word of its name.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/buyerFeedback.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { DEFAULT_TEMPLATES } from '@journeyax/ui-cards';
import { matchBuyerFeedback, type FeedbackRule } from '../buyerFeedback';
import { placedAtText } from '../mappers';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const rules: FeedbackRule[] = [
  { when: ['Vanities', 'Vanity'], mentions: ['Soft-close drawers feel solid', 'The gloss shows fingerprints'], watchFor: ['The mixer is sold separately'] },
  { when: ['Pavers'], mentions: ['Even colour across the pack'] },
];

console.log('what buyers often mention');

check('a product matches by its category or by a word of its name, in any case, and the first rule that fits wins', () => {
  const byCategory = matchBuyerFeedback(rules, { title: 'Boston 900mm', category: 'vanities' });
  assert.equal(byCategory?.feedbackText, '- Soft-close drawers feel solid\n- The gloss shows fingerprints');
  assert.equal(byCategory?.watchText, '- The mixer is sold separately');
  assert.equal(byCategory?.hasWatch, true);
  assert.equal(matchBuyerFeedback(rules, { title: 'Boston Wall Hung VANITY 1 Drawer', category: 'Bathroom' })?.hasFeedback, true);
  const pavers = matchBuyerFeedback(rules, { title: 'Forum Paver', category: 'Pavers' });
  assert.equal(pavers?.hasWatch, false, 'a rule with nothing to watch for shows no such section');
  assert.equal(pavers?.watchText, '');
});

check('a product no rule names, an empty list and a missing list show nothing, and a part of a word does not match', () => {
  assert.equal(matchBuyerFeedback(rules, { title: 'Pull Saw', category: 'Tools' }), undefined);
  assert.equal(matchBuyerFeedback([], { title: 'Boston Vanity', category: 'Vanities' }), undefined);
  assert.equal(matchBuyerFeedback(undefined, { title: 'Boston Vanity' }), undefined);
  assert.equal(matchBuyerFeedback(rules, { title: 'Vanitystand', category: 'Stands' }), undefined);
});

const render = (product: Record<string, unknown>) => renderToStaticMarkup(React.createElement('div', { className: 'jx-root' },
  React.createElement(CardRenderer as any, { template: DEFAULT_TEMPLATES.productDetail, stateKey: 'pd-1', state: { product, closing: 'cart' }, settings: {} })));
const base = { sku: 'V1', title: 'Boston Wall Hung Vanity', price: 815.01, currency: 'NZD', description: 'A wall hung vanity.' };

check('the details panel shows what buyers mention and what to check when the product has them, and neither heading otherwise', () => {
  const html = render({ ...base, ...matchBuyerFeedback(rules, { title: base.title, category: 'Vanities' }) });
  assert.ok(html.includes('What buyers often mention') && html.includes('Soft-close drawers feel solid'));
  assert.ok(html.includes('Worth checking before you buy') && html.includes('The mixer is sold separately'));
  const plain = render(base);
  assert.ok(!plain.includes('What buyers often mention') && !plain.includes('Worth checking before you buy'));
});

check('the details panel offers three questions: why this one, the warranty and guarantee, and who installs it', () => {
  const html = render(base);
  for (const label of ['Why this one?', 'Warranty and guarantee', 'Who installs it?']) assert.ok(html.includes(`>${label}<`), label);
});

check('the placed time reads as a date and time, not a raw timestamp, and an unreadable one is left out', () => {
  const text = placedAtText('2026-10-26T15:28:56.876Z') || '';
  assert.ok(/2026/.test(text) && !/T15:28/.test(text) && !/Z$/.test(text), text);
  assert.equal(placedAtText('not a date'), undefined);
  assert.equal(placedAtText(undefined), undefined);
});

console.log(`✅ web: what buyers mention and the details panel: ${passed} passed, 0 failed`);
