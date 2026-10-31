import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { accessoriesCardFrom, formatPrefetched, prefetchCallsFor } from '../src/agent/event-prefetch';

const suite = createSuite('runtime: lookups made when a card tap arrives');

const config = {
  addToCart: [{ tool: 'get_related_products', args: { sku: '{sku}' } }, { tool: 'get_warranty', args: { productOrBrand: '{title}', note: 'qty {quantity}' } }],
  viewProduct: [{ tool: 'get_product', args: { sku: '{sku}' } }],
};

async function main() {
  await suite.test('the calls for a tap name the tapped product, whatever the casing or punctuation of the tap\'s name', () => {
    const calls = prefetchCallsFor(config, { type: 'add_to_cart', payload: { sku: 'P1', title: 'Forum Paver', quantity: 83 } });
    assert.deepEqual(calls, [
      { tool: 'get_related_products', args: { sku: 'P1' } },
      { tool: 'get_warranty', args: { productOrBrand: 'Forum Paver', note: 'qty 83' } },
    ]);
    assert.equal(prefetchCallsFor(config, { type: 'viewproduct', payload: { skus: ['A', 'B'] } })[0].args.sku, 'A', 'a list of SKUs names its first');
  });

  await suite.test('nothing is looked up for a tap with no configured calls, no product to name, or no settings at all', () => {
    assert.deepEqual(prefetchCallsFor(config, { type: 'removeFromCart', payload: { sku: 'P1' } }), []);
    assert.deepEqual(prefetchCallsFor(config, { type: 'addToCart', payload: {} }), [], 'a call that needs the product is not made without one');
    assert.deepEqual(prefetchCallsFor(undefined, { type: 'addToCart', payload: { sku: 'P1' } }), []);
    assert.deepEqual(prefetchCallsFor({ addToCart: 'nonsense' }, { type: 'addToCart', payload: { sku: 'P1' } }), []);
    assert.deepEqual(prefetchCallsFor(config, undefined), []);
  });

  await suite.test('a lookup marked to show as accessories becomes a card of exactly the groups and SKUs it returned', () => {
    const calls = prefetchCallsFor({ addToCart: [{ tool: 'get_related_products', args: { sku: '{sku}' }, showAs: 'accessories' }, { tool: 'get_warranty', args: { productOrBrand: '{sku}' } }] }, { type: 'addToCart', payload: { sku: 'P1' } });
    assert.equal(calls[0].showAs, 'accessories');
    assert.equal(calls[1].showAs, undefined);
    const card = accessoriesCardFrom({ note: 'Suggestions to check.', groups: [{ key: 'g', label: 'Suggested', items: [{ sku: 'S1', title: 'Sand' }, { title: 'no sku' }] }, { key: 'empty', label: 'Nothing here', items: [] }, { key: 'nolabel', label: '', items: [{ sku: 'X' }] }] }, 'P1');
    assert.deepEqual(card, { cardType: 'accessories', state: { forSku: 'P1', note: 'Suggestions to check.', groups: [{ key: 'g', label: 'Suggested', items: [{ sku: 'S1' }] }] } });
    assert.equal(accessoriesCardFrom({ groups: [] }, 'P1'), undefined, 'no groups, no card');
    assert.equal(accessoriesCardFrom(undefined, 'P1'), undefined);
  });

  await suite.test('looked-up results are shown to the agent with the tap, long ones shortened', () => {
    assert.equal(formatPrefetched([]), '');
    const text = formatPrefetched([{ call: { tool: 'get_warranty', args: { productOrBrand: 'P1' } }, result: { found: false } }, { call: { tool: 'x', args: {} }, result: { big: 'y'.repeat(5000) } }], 200);
    assert.match(text, /<already_looked_up_for_you>/);
    assert.match(text, /tool="get_warranty"/);
    assert.match(text, /do not repeat them/);
    assert.match(text, /shortened/);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
