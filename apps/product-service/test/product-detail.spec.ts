import assert from 'node:assert/strict';
import { buildProductDetail, humanizeMeasure, toRelated } from '../src/product-detail';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const board = {
  parentSku: '3400582',
  name: 'Insulated Board R1.8 2400 x 1200 x 50mm',
  brandCode: 'Acme',
  category: 'Polystyrene',
  categoryPath: ['Building Products', 'Insulation', 'Polystyrene'],
  description: '<p>A rigid <b>insulation</b> board&nbsp;for concrete soffits.</p>',
  imageUrl: 'http://localhost:8099/3400582.jpg',
  priceUSD: { min: 453.09, max: 453.09 },
  currency: 'NZD',
  featuresList: ['For concrete soffits', ' For concrete soffits ', 'Certified for compliance', '', '<li>3-in-1 insulation</li>'],
  specs: { Width: '120 CMT', Height: '240 CMT', 'Warranty Duration': '10 ANN', Colour: 'White', Empty: '', Nothing: null },
  documents: [
    { title: 'Supplier Information - acme.example', url: 'http://acme.example/', type: 'supplier' },
    { title: 'Installation guide.pdf', url: 'https://docs.example/install.pdf', type: 'installation' },
    { title: 'Installation guide.pdf', url: 'https://docs.example/install.pdf', type: 'installation' },
    { url: 'https://docs.example/Technical%20data_sheet.pdf' },
    { title: 'not a link', url: 'ftp://nope' },
  ],
  stock: { branchCount: 88, availableBranchCount: 2, branches: [] },
  web: { productUrl: 'https://shop.example/p/3400582' },
};

console.log('product detail: what a customer sees when they open one product');

check('a measure code is spelt out, anything else is left as written', () => {
  assert.equal(humanizeMeasure('120 CMT'), '120 cm');
  assert.equal(humanizeMeasure('10 ANN'), '10 years');
  assert.equal(humanizeMeasure('2,5 KGM'), '2,5 kg');
  assert.equal(humanizeMeasure('120 ZZZ'), '120 ZZZ');
  assert.equal(humanizeMeasure('Matte black'), 'Matte black');
});

check('the record is turned into display-ready facts without inventing any', () => {
  const detail = buildProductDetail(board);
  assert.equal(detail.sku, '3400582');
  assert.equal(detail.brand, 'Acme');
  assert.equal(detail.category, 'Polystyrene');
  assert.equal(detail.description, 'A rigid insulation board for concrete soffits.');
  assert.equal(detail.price, 453.09);
  assert.equal(detail.currency, 'NZD');
  assert.equal(detail.productUrl, 'https://shop.example/p/3400582');
  assert.deepEqual(detail.features, ['For concrete soffits', 'Certified for compliance', '3-in-1 insulation'], 'markup stripped, duplicates and blanks dropped');
  assert.deepEqual(detail.specs, [
    { label: 'Width', value: '120 cm' }, { label: 'Height', value: '240 cm' }, { label: 'Warranty Duration', value: '10 years' }, { label: 'Colour', value: 'White' },
  ], 'empty values dropped, codes spelt out');
});

check('a maker\'s home page and a link that is not http are not documents; the same document is listed once', () => {
  const detail = buildProductDetail(board);
  assert.deepEqual(detail.documents.map((d) => d.url), ['https://docs.example/install.pdf', 'https://docs.example/Technical%20data_sheet.pdf']);
  assert.equal(detail.documents[0].title, 'Installation guide');
  assert.equal(detail.documents[1].title, 'Technical data sheet', 'a missing title is read from the file name');
});

check('availability is stated as the record states it', () => {
  assert.deepEqual(buildProductDetail(board).availability, { label: 'Available at 2 of 88 branches', inStock: true, branchesWithStock: 2, branchCount: 88 });
  const none = buildProductDetail({ ...board, stock: { branchCount: 10, availableBranchCount: 0 } }).availability;
  assert.equal(none?.inStock, false);
  assert.match(none!.label, /Not showing as available at any of 10 branches/);
  assert.equal(buildProductDetail({ ...board, stock: undefined }).availability, undefined, 'no stock facts, no availability line');
});

check('related products skip the product itself, retired ones, duplicates and anything without a name; at most four', () => {
  const rel = (sku: string, extra: any = {}) => ({ parentSku: sku, name: `Item ${sku}`, priceUSD: { min: 10 }, currency: 'NZD', imageUrl: `http://localhost:8099/${sku}.jpg`, ...extra });
  const detail = buildProductDetail(board, [
    rel('3400582'), rel('A1'), rel('A1'), rel('A2', { discontinued: true }), rel('A3', { status: 'Delisted' }), { parentSku: 'A4' },
    rel('B1'), rel('B2'), rel('B3'), rel('B4'),
  ]);
  assert.deepEqual(detail.related.map((r) => r.sku), ['A1', 'B1', 'B2', 'B3']);
  assert.deepEqual(toRelated(rel('Z9')), { sku: 'Z9', title: 'Item Z9', price: 10, currency: 'NZD', imageUrl: 'http://localhost:8099/Z9.jpg' });
});

check('a record with almost nothing still builds, and shows only what is there', () => {
  const detail = buildProductDetail({ parentSku: 'X1', name: 'Plain item' });
  assert.equal(detail.title, 'Plain item');
  assert.deepEqual([detail.features, detail.specs, detail.documents, detail.related], [[], [], [], []]);
  assert.equal(detail.description, undefined);
  assert.equal(detail.availability, undefined);
  assert.equal(detail.price, null);
});

check('a long description is cut at a sentence, not mid-word', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ');
  const detail = buildProductDetail({ parentSku: 'X2', name: 'Long', description: long });
  assert.ok(detail.description!.length <= 905);
  assert.match(detail.description!, /(useful\.|…)$/);
});

console.log(`✅ product-service: product detail: ${passed} passed, 0 failed`);
