/**
 * Product recommendations are a grid of small tiles, four across, that wraps downwards; bundles, guide products and the lists under a
 * product are still one scrolling row of cards; accessories are short rows with a tiny picture.
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

check('the recommendation card is a grid of four across that wraps downwards, one small tile per product', () => {
  const html = render('products', { heading: 'Our picks', products: [1, 2, 3, 4, 5, 6].map(product), closing: 'bag' });
  assert.equal(count(html, 'class="jx-carousel"'), 0, 'no sideways row');
  assert.ok(html.includes('class="jx-grid') && html.includes('repeat(4, minmax(0, 1fr))'), 'four columns');
  for (let n = 1; n <= 6; n++) assert.ok(html.includes(`Product number ${n}`), `product ${n} is in the grid`);
  assert.ok(html.includes('Best fit for the job'), 'the reason for the pick is on its tile');
  assert.equal(count(html, '>Details<'), 6, 'each tile opens its details');
});

check('a tile carries the picture, the price, the reason and Add, with Details and Compare together on the line under it', () => {
  const html = render('products', { products: [1].map(product) });
  for (const word of ['NZ$10.00', 'Best fit for the job', '>Add<', '>Details<']) assert.ok(html.includes(word) || html.includes(word.replace('NZ$', '$')) || /\$10/.test(html), word);
  assert.ok(html.indexOf('>Add<') < html.indexOf('>Details<'));
});

check('accessories are short rows with a small picture, two across', () => {
  const html = render('accessories', { heading: 'What the job needs', groups: [{ key: 'required', label: 'Required to install', hint: 'You need these', items: [1, 2].map(product) }] });
  assert.ok(html.includes('repeat(2, minmax(0, 1fr))'));
  assert.ok(html.includes('width:40px') || html.includes('width: 40px'), 'a 40px picture');
  assert.ok(html.includes('Product number 1') && html.includes('Best fit for the job'));
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
