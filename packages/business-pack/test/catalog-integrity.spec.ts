import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogProduct, resolveCatalogMapping } from '../src/catalog-mapping';

const labels = { title: 'Product', category: 'Category' };
test('conflicting mapped source identities cannot produce trusted commerce or presentation facts', () => {
  const raw = { sku: 'SOURCE-A', name: 'Renamed product', url: 'https://shop.example/new-path/p/SOURCE-A', web: { productUrl: 'https://shop.example/original-path/p/SOURCE-A' },
    price: { amount: 50, currency: 'NZD' }, inStock: true, specs: { Width: '90 CMT', 'Warranty Duration': '5 ANN' }, featuresList: ['Original product feature'], rating: { value: 4.9 }, imageUrl: 'https://shop.example/product.jpg' };
  const original = structuredClone(raw);
  const result = normalizeCatalogProduct(raw, resolveCatalogMapping(), labels);
  assert.equal(result.integrity.identityConsistent, false);
  assert.equal(result.integrity.issues[0].code, 'conflicting_source_identity');
  assert.deepEqual(result.specs, {}); assert.deepEqual(result.attributes, {});
  assert.deepEqual(result.highlights, []); assert.equal(result.priceCents, null);
  assert.equal(result.warrantyDuration, undefined); assert.equal(result.rating, undefined); assert.equal(result.inStock, undefined);
  assert.equal(result.sourceUrl, undefined); assert.equal(result.imageUrl, '');
  assert.deepEqual(raw, original, 'the merchant source record is never repaired or overwritten');
});

test('equivalent mapped specification units agree; conflicting representations are withheld by field', () => {
  const equivalent = normalizeCatalogProduct({ sku: 'A', specs: { Width: '60 CMT', Height: '90 CMT' }, specifications: { Width: '600 mm' } }, resolveCatalogMapping(), labels);
  assert.equal(equivalent.integrity.status, 'clear');
  assert.equal(equivalent.specs.Width, '600 mm');
  const conflict = normalizeCatalogProduct({ sku: 'A', specs: { Width: '60 CMT', Height: '90 CMT' }, specifications: { Width: '900 mm' } }, resolveCatalogMapping(), labels);
  assert.equal(conflict.specs.Width, undefined); assert.equal(conflict.attributes.Width, undefined);
  assert.equal(conflict.specs.Height, '90 CMT');
  assert.deepEqual(conflict.integrity.issues[0], { code: 'conflicting_specification_sources', field: 'specs.Width', paths: ['specifications.Width', 'specs.Width'] });
});

test('source units are preserved without invented corrections or fit assurance', () => {
  const result = normalizeCatalogProduct({ sku: 'A', specs: { Width: '121 CMT', Depth: '580 CMT' } }, resolveCatalogMapping(), labels);
  assert.equal(result.specs.Depth, '580 CMT'); assert.equal(result.integrity.fitVerified, false);
});

test('declared price-source disagreement remains visible and mapping precedence is explicit', () => {
  const result = normalizeCatalogProduct({ sku: 'A', priceCents: 5000, currency: 'NZD', price: { amount: 60, currency: 'NZD' } }, resolveCatalogMapping(), labels);
  assert.equal(result.priceCents, 5000, 'no invented replacement price');
  assert.equal(result.integrity.issues[0].code, 'conflicting_price_sources');
  const otherCurrency = normalizeCatalogProduct({ sku: 'A', priceCents: 5000, currency: 'NZD', price: { amount: 60, currency: 'USD' } }, resolveCatalogMapping(), labels);
  assert.equal(otherCurrency.integrity.status, 'clear', 'different currencies are not compared as equivalent amounts');
});

test('query/trailing-slash differences and distinct vendor hosts do not fabricate identity conflicts', () => {
  const mapped = resolveCatalogMapping();
  for (const webUrl of ['https://shop.example/product/?campaign=one', 'https://manufacturer.example/manual/product']) {
    const result = normalizeCatalogProduct({ sku: 'A', url: 'https://shop.example/product', web: { productUrl: webUrl } }, mapped, labels);
    assert.equal(result.integrity.identityConsistent, true);
  }
  const local = normalizeCatalogProduct({ sku: 'A', imageUrl: 'http://localhost:8099/product.jpg' }, mapped, labels);
  assert.equal(local.imageUrl, 'http://localhost:8099/product.jpg', 'local source is labelled rather than falsely declared broken');
  assert.equal(local.integrity.issues[0].code, 'nonportable_image');
});
