import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackContentSchema, computePackChecksum, normalizeCatalogProduct, publishBusinessPack, resolveCatalogMapping, validateBusinessPack, verifyPersistedBusinessPackRelease } from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

test('historical price flags remain checksum-verifiable without generating prices, while new publication refuses them', async () => {
  const content = BusinessPackContentSchema.parse({ ...structuredClone(rawLegacyFixture), catalogMapping: { pricing: { demoFallback: { enabled: true, currency: 'NZD', min: 1, max: 100 } } } });
  const checksum = computePackChecksum(content);
  const stored = { ...content, tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', versionId: '1.0.0', status: 'published', checksum, publishedAt: new Date('2026-01-01'), publishedBy: 'historical-publisher' };
  const verified = verifyPersistedBusinessPackRelease(stored, { tenantId: 'placemakers', environmentId: 'production', pointerChecksum: checksum });
  assert.equal(verified.checksum, checksum);
  assert.equal(verified.content.catalogMapping?.pricing?.demoFallback?.enabled, true);
  const mapping = resolveCatalogMapping(verified.content.catalogMapping);
  assert.equal(normalizeCatalogProduct({ sku: 'missing-price', currency: 'NZD' }, mapping, { title: 'Item', category: '' }).priceCents, null);
  assert.equal(normalizeCatalogProduct({ sku: 'real-price', priceCents: 2500, currency: 'NZD' }, mapping, { title: 'Item', category: '' }).priceCents, 2500);
  assert.equal(validateBusinessPack(content).valid, false);
  const db = new MemoryDb();
  await assert.rejects(() => publishBusinessPack(db as any, content), /Generated prices/);
  assert.equal(db.dump('business_pack_releases').length, 0);
  assert.throws(() => verifyPersistedBusinessPackRelease({ ...stored, checksum: '0'.repeat(64) }), /checksum/);
});
