import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dropAdded, RECOMMENDATION_CARDS, skusInCart } from '../src/agent/already-added';

/**
 * A product the customer has already added is not recommended to them again: the server takes it off the recommendation cards.
 */
const product = (sku: string) => ({ sku, title: `Product ${sku}`, price: 10 });

describe('what the customer has already added', () => {
  test('the cart is read from every place the runtime keeps it (items, lines, line items), and the customer\'s own tap this turn counts', () => {
    const added = skusInCart({
      carts: [{ items: [{ sku: 'A1' }] }, { lines: [{ productId: 'B2' }] }, { lineItems: [{ variant: { sku: 'C3' } }] }, undefined, null, { items: 'nonsense' }],
      event: { type: 'addToCart', payload: { sku: 'D4', items: [{ sku: 'E5' }] } },
    });
    assert.deepEqual([...added].sort(), ['A1', 'B2', 'C3', 'D4', 'E5']);
  });

  test('an event that is not an add (opening a product, ticking one to compare) adds nothing', () => {
    assert.equal(skusInCart({ event: { type: 'viewProduct', payload: { sku: 'X' } } }).size, 0);
    assert.equal(skusInCart({ event: { type: 'compareProducts', payload: { skus: ['X', 'Y'] } } }).size, 0);
    assert.equal(skusInCart({}).size, 0);
  });

  test('a recommendation card loses the products already in the cart and keeps the rest, in order', () => {
    const state = { heading: 'Our picks', products: [product('A1'), product('F6'), product('G7')] };
    const result = dropAdded('products', state, new Set(['A1']));
    assert.deepEqual(result.state.products.map((p: any) => p.sku), ['F6', 'G7']);
    assert.deepEqual(result.removed, ['A1']);
    assert.equal(result.empty, false);
    assert.equal(state.products.length, 3, 'the original is not changed');
    assert.equal(result.state.heading, 'Our picks');
  });

  test('a bundle and an accessories card are cleaned the same way, including products inside groups; a group left empty goes', () => {
    const bundle = dropAdded('bundle', { items: [product('A1'), product('H8')] }, new Set(['A1']));
    assert.deepEqual(bundle.state.items.map((p: any) => p.sku), ['H8']);
    const accessories = dropAdded('accessories', { groups: [{ title: 'Fixings', items: [product('A1')] }, { title: 'Sealants', items: [product('J9'), product('A1')] }] }, new Set(['A1']));
    assert.deepEqual(accessories.state.groups.map((g: any) => [g.title, g.items.map((p: any) => p.sku)]), [['Sealants', ['J9']]]);
  });

  test('a card with nothing left to recommend is said to be empty, so it is not shown', () => {
    assert.equal(dropAdded('products', { products: [product('A1'), product('B2')] }, new Set(['A1', 'B2'])).empty, true);
    assert.equal(dropAdded('accessories', { groups: [{ title: 'Fixings', items: [product('A1')] }] }, new Set(['A1'])).empty, true);
  });

  test('a card the customer asked for is left alone: product detail, comparison, the review of the order', () => {
    for (const cardType of ['productDetail', 'comparison', 'review', 'quantity', 'clarify']) {
      assert.ok(!RECOMMENDATION_CARDS.includes(cardType), cardType);
      const state = { product: product('A1'), products: [product('A1'), product('B2')] };
      const result = dropAdded(cardType, state, new Set(['A1']));
      assert.equal(result.state, state, cardType);
      assert.deepEqual(result.removed, []);
      assert.equal(result.empty, false);
    }
  });

  test('nothing in the cart, or an empty card, changes nothing', () => {
    const state = { products: [product('A1')] };
    assert.equal(dropAdded('products', state, new Set()).state, state);
    assert.equal(dropAdded('products', { products: [] }, new Set(['A1'])).empty, false);
    assert.equal(dropAdded('products', null as any, new Set(['A1'])).empty, false);
  });
});
