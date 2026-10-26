/**
 * Product recommendations (and the lists under a product: similar products, bundles, guide products) are one scrolling row of cards,
 * not a column that fills the thread.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/cards/__tests__/carousel.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { DEFAULT_TEMPLATES } from '@journeyax/ui-cards';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const product = (n: number) => ({ sku: `SKU-${n}`, title: `Product number ${n}`, price: 10 * n, currency: 'NZD', imageUrl: '', reason: n === 1 ? 'Best fit for the job' : '' });
const render = (type: keyof typeof DEFAULT_TEMPLATES, state: Record<string, unknown>) => renderToStaticMarkup(
  React.createElement('div', { className: 'jx-root' }, React.createElement(CardRenderer as any, { template: DEFAULT_TEMPLATES[type], stateKey: `${type}-1`, state, settings: {} })),
);
const count = (html: string, needle: string) => html.split(needle).length - 1;

console.log('cards as a carousel');

check('the recommendation card is one scrolling row with a card per product, and says what it is for the screen reader', () => {
  const html = render('products', { heading: 'Our picks', products: [1, 2, 3, 4, 5, 6].map(product), closing: 'bag' });
  assert.equal(count(html, 'class="jx-carousel"'), 1);
  assert.ok(html.includes('aria-roledescription="carousel"') && html.includes('aria-label="Recommended products"'));
  for (let n = 1; n <= 6; n++) assert.ok(html.includes(`Product number ${n}`), `product ${n} is in the row`);
  assert.ok(html.includes('Best fit for the job'));
});

check('a short list is still just a row: no arrows are drawn until there is more to scroll to', () => {
  const html = render('products', { products: [1, 2].map(product) });
  assert.equal(count(html, 'jx-carousel__nav'), 0);
});

check('bundles and guide products scroll the same way', () => {
  const bundle = render('bundle', { heading: 'Everything you need', items: [1, 2, 3].map(product), totals: { total: 60, currency: 'NZD' } });
  assert.equal(count(bundle, 'class="jx-carousel"'), 1);
  for (let n = 1; n <= 3; n++) assert.ok(bundle.includes(`Product number ${n}`));
});

check('similar products and suggestions under one product are rows too', () => {
  const html = render('productDetail', { product: { ...product(1), hasRelated: true, related: [2, 3, 4].map(product), hasSuggested: true, suggested: [5, 6].map(product) } });
  assert.equal(count(html, 'class="jx-carousel"'), 2);
  assert.ok(html.includes('aria-label="Similar products"') && html.includes('aria-label="Suggestions"'));
});

console.log(`✅ web: cards as a carousel: ${passed} passed, 0 failed`);
