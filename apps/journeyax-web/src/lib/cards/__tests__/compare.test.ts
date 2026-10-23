/**
 * Comparing products: the ticked selection, the words on a product row, and the side-by-side table.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/compare.test.ts
 */
import assert from 'node:assert/strict';
import { MAX_COMPARE, clearCompare, getCompareSelection, toggleCompare } from '../compareStore';
import { decorateProductRows } from '../productTiles';
import { buildComparisonCard, toCompareSource } from '../comparison';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('comparing products');

check('ticking adds a product, ticking again removes it, and the selection is capped', () => {
  clearCompare();
  assert.equal(toggleCompare({ sku: 'A', title: 'Board A' }), true);
  assert.equal(toggleCompare({ sku: 'B', title: 'Board B' }), true);
  assert.deepEqual(getCompareSelection().map((entry) => entry.sku), ['A', 'B']);
  assert.equal(toggleCompare({ sku: 'A', title: 'Board A' }), true);
  assert.deepEqual(getCompareSelection().map((entry) => entry.sku), ['B']);
  for (const sku of ['C', 'D', 'E']) toggleCompare({ sku, title: sku });
  assert.equal(getCompareSelection().length, MAX_COMPARE);
  assert.equal(toggleCompare({ sku: 'F', title: 'F' }), false, 'a full selection refuses another');
  assert.equal(toggleCompare({ sku: ' ', title: '' }), false, 'a blank product is refused');
  clearCompare();
  assert.deepEqual(getCompareSelection(), []);
});

check('a product row says whether it is ticked, where it is held, and what to ask when it has no price', () => {
  const [a, b]: any[] = decorateProductRows([
    { sku: 'A', title: 'Wet Area Board', price: 40, highlights: ['Water resistant core', 'Taper edge'], branchesAvailable: 22, branchesTotal: 87 },
    { sku: 'B', title: 'Standard Board', price: null },
  ], { comparing: new Set(['B']) });
  assert.equal(a.comparing, false);
  assert.equal(a.compareLabel, 'Compare');
  assert.equal(a.highlightsText, 'Water resistant core · Taper edge');
  assert.equal(a.stockLabel, 'Available at 22 of 87 branches');
  assert.equal(a.priceMissing, false);
  assert.equal(b.comparing, true);
  assert.equal(b.compareLabel, 'Comparing ✓');
  assert.equal(b.priceMissing, true);
  assert.match(b.askPriceText, /Standard Board/);
  assert.equal(b.highlightsText, undefined, 'no highlights, no line');
  assert.equal(b.stockLabel, undefined, 'no branch figures, no availability line');
});

check('a stock label the card already carries is kept, and a zero price counts as no price', () => {
  const [row]: any[] = decorateProductRows([{ sku: 'C', title: 'C', price: 0, stockLabel: 'In stock', branchesAvailable: 1, branchesTotal: 5 }], { comparing: new Set() });
  assert.equal(row.stockLabel, 'In stock');
  assert.equal(row.priceMissing, true);
});

check('a warning the catalogue gives is passed on as a caution line, never as a highlight', () => {
  const [row]: any[] = decorateProductRows([{ sku: 'W', title: 'Trim', cautions: ['Should not be used where it will be exposed to water', 'Second'], highlights: ['Primed'] }], { comparing: new Set() });
  assert.equal(row.cautionText, 'Should not be used where it will be exposed to water');
  assert.equal(row.highlightsText, 'Primed');
  const [plain]: any[] = decorateProductRows([{ sku: 'P', title: 'Plain' }], { comparing: new Set() });
  assert.equal(plain.cautionText, undefined);
});

const detail = (sku: string, over: Record<string, unknown> = {}) => ({ sku, title: `Board ${sku}`, price: null, features: [], specs: [], ...over }) as any;

check('the table lists what differs first, then what is the same, and shows a dash for what a product does not list', () => {
  const a = toCompareSource(undefined, detail('A', { price: 40, currency: 'NZD', specs: [{ label: 'Thickness', value: '10 mm' }, { label: 'Width', value: '120 cm' }], features: ['Water resistant core', 'Taper edge'], availability: { label: 'Available at 22 of 87 branches', inStock: true, branchesWithStock: 22, branchCount: 87 }, rating: { value: 4.9, count: 88 } }), 'A');
  const b = toCompareSource(undefined, detail('B', { specs: [{ label: 'Thickness', value: '13 mm' }, { label: 'Width', value: '120 cm' }, { label: 'Edge', value: 'Square' }] }), 'B');
  const card: any = buildComparisonCard([a, b]);
  assert.deepEqual(card.columns, ['', 'Board A', 'Board B']);
  const byName = Object.fromEntries(card.rows.map((row: string[]) => [row[0], row.slice(1)]));
  assert.match(byName.Price[0], /40/);
  assert.equal(byName.Price[1], 'Price on request');
  assert.deepEqual(byName.Thickness, ['10 mm', '13 mm']);
  assert.deepEqual(byName.Edge, ['—', 'Square'], 'a spec only one product lists is a dash for the other');
  assert.deepEqual(byName.Rating, ['4.9 (88)', '—']);
  assert.deepEqual(byName.Availability, ['Available at 22 of 87 branches', '—']);
  assert.equal(byName['Key features'][0], 'Water resistant core; Taper edge');
  const names = card.rows.map((row: string[]) => row[0]);
  assert.ok(names.indexOf('Thickness') < names.indexOf('Width'), 'a difference comes before something the two share');
  assert.equal(card.intro, '6 differences, 1 thing the same');
  assert.deepEqual(card.dimensions, names);
  assert.deepEqual(card.products.map((p: any) => p.sku), ['A', 'B']);
});

check('rows nobody has anything for are left out, and the tile fills what the catalogue cannot answer', () => {
  const sources = [
    toCompareSource({ sku: 'A', title: 'Tile A', price: 12, imageUrl: 'https://img.example/a.jpg' }, null, 'A'),
    toCompareSource({ sku: 'B', name: 'Tile B' }, null, 'B'),
  ];
  const card: any = buildComparisonCard(sources);
  const names = card.rows.map((row: string[]) => row[0]);
  assert.deepEqual(names, ['Price'], 'no availability, rating, specs or features rows when nobody lists them');
  assert.deepEqual(card.columns, ['', 'Tile A', 'Tile B']);
  assert.equal(card.products[0].imageUrl, 'https://img.example/a.jpg');
});

console.log(`✅ web: comparing products: ${passed} passed, 0 failed`);
