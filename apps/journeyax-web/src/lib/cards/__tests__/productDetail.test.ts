/**
 * What the product detail card is built from: the tile a customer tapped, completed with the catalogue's own record.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/productDetail.test.ts
 */
import assert from 'node:assert/strict';
import { buildDetailProduct, type ServerProductDetail } from '../productDetail';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const tile = { sku: 'S1', name: 'Tile title', description: 'Tile words', imageUrl: 'http://localhost:8099/S1.jpg', price: 30, category: 'Boards' };
const detail: ServerProductDetail = {
  sku: 'S1', title: 'Catalogue title', brand: 'Acme', category: 'Standard Board', description: 'Catalogue words', imageUrl: 'http://localhost:8099/S1.jpg',
  price: 31.5, currency: 'NZD', features: ['One', 'Two'],
  specs: [{ label: 'Width', value: '120 cm' }],
  documents: [{ title: 'Guide', url: 'https://docs.example/g.pdf' }],
  suggested: [{ sku: 'T1', title: 'Screws', price: 12, currency: 'NZD', imageUrl: 'http://localhost:8099/T1.jpg' }],
  related: [{ sku: 'R1', title: 'Tape', price: 9, currency: 'NZD', imageUrl: 'http://localhost:8099/R1.jpg' }],
  availability: { label: 'Available at 2 of 88 branches', inStock: true, branchesWithStock: 2, branchCount: 88 },
  productUrl: 'https://shop.example/p/S1',
};

console.log('product detail card: tile facts completed by the catalogue');

check('the catalogue\'s record wins where it has an answer', () => {
  const p: any = buildDetailProduct(tile, detail, 'S1');
  assert.equal(p.title, 'Catalogue title');
  assert.equal(p.brand, 'Acme');
  assert.equal(p.description, 'Catalogue words');
  assert.equal(p.price, 31.5);
  assert.equal(p.currency, 'NZD');
  assert.equal(p.featuresText, '- One\n- Two');
  assert.deepEqual([p.hasFeatures, p.hasSpecs, p.hasDocuments, p.hasSuggested, p.hasRelated, p.hasProductUrl], [true, true, true, true, true, true]);
  assert.equal(p.suggested[0].sku, 'T1');
  assert.equal(p.stockLabel, 'Catalogue lists 2 of 88 branches; current stock not checked');
  assert.deepEqual([p.stockOk, p.stockWarn], [false, false], 'catalogue counts are not current stock');
  assert.equal(p.related[0].sku, 'R1');
});

check('when the catalogue cannot answer, the card opens with the tile\'s own facts and no empty sections', () => {
  const p: any = buildDetailProduct(tile, null, 'S1');
  assert.equal(p.title, 'Tile title');
  assert.equal(p.description, 'Tile words');
  assert.equal(p.price, 30);
  assert.deepEqual([p.hasFeatures, p.hasSpecs, p.hasDocuments, p.hasSuggested, p.hasRelated, p.hasProductUrl], [false, false, false, false, false, false]);
  assert.equal(p.stockLabel, undefined);
  assert.deepEqual([p.stockOk, p.stockWarn], [false, false], 'no availability line at all, neither good nor bad');
});

check('a product the tile does not know still opens from the catalogue alone', () => {
  const p: any = buildDetailProduct(undefined, detail, 'S1');
  assert.equal(p.title, 'Catalogue title');
  assert.equal(p.hasSpecs, true);
});

check('a catalogue zero count remains unknown, rather than a current out-of-stock receipt', () => {
  const p: any = buildDetailProduct(tile, { ...detail, availability: { label: 'Not showing as available at any of 10 branches', inStock: false, branchesWithStock: 0, branchCount: 10 } }, 'S1');
  assert.deepEqual([p.stockOk, p.stockWarn], [false, false]);
  assert.match(p.stockLabel, /current stock not checked/);
});

check('an explicitly quarantined server record cannot refill itself from an old tile', () => {
  const p: any = buildDetailProduct({ ...tile, price: 999, specs: { Width: 'Invented' }, featuresList: ['Old claim'] }, { ...detail, integrity: { identityConsistent: false } }, 'S1');
  assert.equal(p.price, null); assert.equal(p.title, 'SKU S1');
  assert.deepEqual(p.specList, []); assert.equal(p.hasFeatures, false); assert.equal(p.imageUrl, undefined);
  assert.match(p.description, /source record needs review/);
});

check('a successful current lookup with no specifications never refills stale tile facts', () => {
  const p: any = buildDetailProduct({ ...tile, specs: { Thickness: '10 mm' } }, { ...detail, specs: [] }, 'S1');
  assert.deepEqual(p.specList, []);
  const unknownPrice: any = buildDetailProduct({ ...tile, price: 500 }, { ...detail, price: null }, 'S1');
  assert.equal(unknownPrice.price, null);
});

check('a shared "no picture" placeholder is not shown as the product photo', () => {
  const p: any = buildDetailProduct({ ...tile, imageUrl: null }, { ...detail, imageUrl: null }, 'S1');
  assert.equal(p.imageUrl, null);
});

console.log(`✅ web: product detail card: ${passed} passed, 0 failed`);
