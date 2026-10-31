import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { productCardFacts } from '../src/agent/card-facts';

const suite = createSuite('runtime: what a product card says about each product');
const features = [
  'Suitable for use in bathrooms, en-suites, laundries and showers',
  'Water resistant core',
  'Taper edge/square edge',
  'Pricing displayed is for the product only',
];

async function main() {
  await suite.test('the feature that answers what the customer asked is the reason, and the rest are highlights without it', () => {
    const facts = productCardFacts(features, { customerText: "it's for a bathroom wall, about 12 square metres", locale: 'en-NZ' });
    assert.equal(facts.reason, 'Suitable for use in bathrooms, en-suites, laundries and showers', 'bathroom matches bathrooms');
    assert.deepEqual(facts.highlights, ['Water resistant core', 'Taper edge/square edge', 'Pricing displayed is for the product only']);
  });

  await suite.test('with nothing in the request that a feature answers there is no reason, only the first highlights', () => {
    const facts = productCardFacts(features, { customerText: 'gib', locale: 'en-NZ' });
    assert.equal(facts.reason, undefined);
    assert.deepEqual(facts.highlights, features.slice(0, 3));
  });

  await suite.test('the best match wins, and the same words are not counted twice', () => {
    const facts = productCardFacts(['Water tank', 'Water resistant board for wet areas'], { customerText: 'water resistant water', locale: 'en-NZ' });
    assert.equal(facts.reason, 'Water resistant board for wet areas');
  });

  await suite.test('a product with no features, or no request, says nothing it cannot back', () => {
    assert.deepEqual(productCardFacts(undefined, { customerText: 'bathroom' }), { highlights: [] });
    assert.deepEqual(productCardFacts([], { customerText: 'bathroom' }), { highlights: [] });
    assert.deepEqual(productCardFacts(['  ', ''], { customerText: 'bathroom' }), { highlights: [] });
    assert.equal(productCardFacts(features, {}).reason, undefined);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
