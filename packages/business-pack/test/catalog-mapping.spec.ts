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

console.log(`✅ Business Pack catalogMapping: ${passed} passed, 0 failed`);
