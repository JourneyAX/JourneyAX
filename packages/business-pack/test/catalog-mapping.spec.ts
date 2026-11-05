import assert from 'node:assert/strict';
import {
  BusinessPackContentSchema,
  CANONICAL_CONTENT_KEYS,
  computePackChecksum,
  extractPackContent,
  resolveCatalogMapping,
  normalizeCatalogProduct,
} from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Business Pack catalogMapping');
const base = BusinessPackContentSchema.parse(rawLegacyFixture);

check('catalogMapping is a canonical, checksum-bound content key', () => {
  assert.ok((CANONICAL_CONTENT_KEYS as readonly string[]).includes('catalogMapping'));
});

check('legacy packs are unchanged: no default is injected, checksum is stable', () => {
  assert.equal('catalogMapping' in base, false);
  assert.equal(computePackChecksum(base), computePackChecksum(extractPackContent(base)));
});

check('changing the mapping changes the checksum', () => {
  const withMapping = BusinessPackContentSchema.parse({ ...rawLegacyFixture, catalogMapping: { candidateLimit: 50 } });
  assert.notEqual(computePackChecksum(withMapping), computePackChecksum(base));
  assert.equal(extractPackContent(withMapping).catalogMapping?.candidateLimit, 50);
});

check('schema rejects operator-shaped paths and unknown keys', () => {
  assert.equal(BusinessPackContentSchema.safeParse({ ...rawLegacyFixture, catalogMapping: { searchPaths: ['$where'] } }).success, false);
  assert.equal(BusinessPackContentSchema.safeParse({ ...rawLegacyFixture, catalogMapping: { surprise: 1 } }).success, false);
});

check('tenant arrays replace defaults wholesale; unspecified fields keep platform defaults', () => {
  const mapping = resolveCatalogMapping({ identifierPaths: ['partCode'] });
  assert.deepEqual(mapping.identifierPaths, ['partCode']);
  assert.ok(mapping.titlePaths.includes('name'));
});

check('normalisation never invents a currency', () => {
  const mapping = resolveCatalogMapping();
  const undeclared = normalizeCatalogProduct({ sku: 'x', name: 'n', priceCents: 500 }, mapping, { title: 'P', category: 'G' });
  assert.equal(undeclared.priceCents, null);
  assert.equal(undeclared.currency, undefined);
  assert.equal(undeclared.currencyUndeclared, true);
  const declared = normalizeCatalogProduct({ sku: 'x', name: 'n', priceCents: 500, currency: 'nzd' }, mapping, { title: 'P', category: 'G' });
  assert.equal(declared.priceCents, 500);
  assert.equal(declared.currency, 'NZD');
});

const DEMO = { enabled: true, currency: 'nzd', min: 4.9, max: 480 };
const demoMapping = () => resolveCatalogMapping({ pricing: { demoFallback: DEMO } });
const labels = { title: 'P', category: 'G' };

check('demo prices are off unless the mapping asks for them: an unpriced product stays without a price', () => {
  const plain = normalizeCatalogProduct({ sku: '1015371', name: 'Radiata framing' }, resolveCatalogMapping(), labels);
  assert.equal(plain.priceCents, null);
  assert.equal(plain.priceIsDemo, undefined);
  assert.equal(resolveCatalogMapping().pricing.demoFallback, undefined);
});

check('legacy demo flags cannot invent a price, even across repeated reads', () => {
  const doc = { sku: '1015371', name: 'Radiata framing' };
  const first = normalizeCatalogProduct(doc, demoMapping(), labels);
  const again = normalizeCatalogProduct({ ...doc }, demoMapping(), labels);
  assert.equal(first.priceCents, null);
  assert.equal(again.priceCents, null);
  assert.equal(first.currency, undefined);
  assert.equal(first.priceIsDemo, undefined);
  assert.equal(demoMapping().pricing.demoFallback, undefined);
});

check('a real price always wins, and is never marked as a demo price', () => {
  const real = normalizeCatalogProduct({ sku: '2200499', name: 'Fascia', priceCents: 2750, currency: 'NZD' }, demoMapping(), labels);
  assert.equal(real.priceCents, 2750);
  assert.equal(real.priceIsDemo, undefined);
});

check('a product marked as having no price (price on application) stays unpriced, and a product with no identifier gets nothing', () => {
  const poa = normalizeCatalogProduct({ sku: '77', name: 'Custom', status: 'POA' }, demoMapping(), labels);
  assert.equal(poa.availability, 'unpriced');
  assert.equal(poa.priceCents, null);
  const nameless = normalizeCatalogProduct({ name: 'No id' }, demoMapping(), labels);
  assert.equal(nameless.priceCents, null);
});

check('the setting is checked: a three-letter currency, positive numbers, and a maximum that is not below the minimum', () => {
  const bad = (demoFallback: unknown) => { try { resolveCatalogMapping({ pricing: { demoFallback } }); return false; } catch { return true; } };
  assert.equal(bad({ enabled: true, currency: 'NZ', min: 1, max: 2 }), true);
  assert.equal(bad({ enabled: true, currency: 'NZD', min: 0, max: 2 }), true);
  assert.equal(bad({ enabled: true, currency: 'NZD', min: 5, max: 2 }), true);
  assert.equal(bad({ enabled: false, currency: 'NZD', min: 1, max: 2 }), false, 'switched off is still a valid setting');
});

console.log(`✅ Business Pack catalogMapping: ${passed} passed, 0 failed`);
