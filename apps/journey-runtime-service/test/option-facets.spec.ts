import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { summariseOptions, variantLabels } from '../src/agent/option-facets';

const suite = createSuite('runtime: what a group of products can be told apart by');

const pavers = [
  { title: 'Forum Paver 400 x 400 x 50mm Volcanic Ash Honed', brand: 'Firth' },
  { title: 'Forum Paver 400 x 400 x 50mm Glacier Honed', brand: 'Firth' },
  { title: 'Forum Paver 400 x 400 x 50mm Black Sands Honed', brand: 'Firth' },
  { title: 'Piazza Paver 400 x 200 x 50mm Glacier Honed', brand: 'Firth' },
  { title: 'Piazza Paver 400 x 200 x 50mm Volcanic Ash Honed', brand: 'Firth' },
  { title: 'Holland Paver 200 x 100 x 80mm Black Sands', brand: 'Holland' },
  { title: 'Holland Paver 200 x 100 x 80mm Natural', brand: 'Holland' },
];

async function main() {
  await suite.test('the words that end the names of products in one range are offered as the variants', () => {
    const { labels, products } = variantLabels(pavers.map((p) => p.title));
    assert.ok(labels.includes('Glacier Honed') || labels.includes('Honed'), JSON.stringify(labels));
    assert.ok(products >= 5, 'the products of ranges that differ only by their ending are counted');
    assert.ok(!labels.some((label) => /\d/.test(label)), 'an ending with digits is a size, not a variant');
  });

  await suite.test('a range of one product, or of products with the same ending, offers no variants', () => {
    assert.deepEqual(variantLabels(['Plain Widget Small']).labels, []);
    assert.deepEqual(variantLabels(['Widget Pro Blue', 'Widget Pro Blue']).labels, []);
  });

  await suite.test('brands, sizes the catalogue mapping extracts and variants are listed with counts; a facet with one value is left out', () => {
    const sizeOf = (title: string) => {
      const match = title.match(/(\d{2,4}\s*x\s*\d{2,4}\s*x\s*\d{2,4})/i);
      return match ? { size: match[1].replace(/\s+/g, '') } : {};
    };
    const summary = summariseOptions(pavers, { attributesFromTitle: sizeOf });
    assert.equal(summary.matched, 7);
    const names = summary.facets.map((facet) => facet.name);
    assert.deepEqual(names.filter((name) => name !== 'variant'), ['brand', 'size']);
    const brand = summary.facets.find((facet) => facet.name === 'brand')!;
    assert.deepEqual(brand.values[0], { value: 'Firth', count: 5 });
    const size = summary.facets.find((facet) => facet.name === 'size')!;
    assert.equal(size.values.length, 3);
    assert.equal(size.coverage, 1);
    const onlyOneBrand = summariseOptions(pavers.filter((p) => p.brand === 'Firth'), { attributesFromTitle: sizeOf });
    assert.ok(!onlyOneBrand.facets.some((facet) => facet.name === 'brand'), 'one brand is nothing to choose between');
  });

  await suite.test('pack sizes are read whatever the spelling and offered as one value each', () => {
    const summary = summariseOptions([
      { title: 'Wall Paint 4L Low Sheen' },
      { title: 'Wall Paint 4 litres Low Sheen' },
      { title: 'Wall Paint 10L Low Sheen' },
      { title: 'Primer 450ml' },
    ]);
    const pack = summary.facets.find((facet) => facet.name === 'pack')!;
    assert.deepEqual(pack.values.map((value) => [value.value, value.count]), [['4L', 2], ['10L', 1], ['450ml', 1]]);
    assert.equal(pack.coverage, 1);
  });

  await suite.test('no products give no facets and a count of zero', () => {
    assert.deepEqual(summariseOptions([]), { matched: 0, facets: [] });
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
