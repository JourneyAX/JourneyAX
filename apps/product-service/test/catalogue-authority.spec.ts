import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, publishBusinessPack } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { ProductService } from '../src/product.service';

async function fixture() {
  const db = new MemoryDb(), raw: any = structuredClone(rawLegacyFixture); raw.manifest.environmentId = 'test';
  await publishBusinessPack(db as any, raw);
  const pack = await new PackRepository(db).loadActivePack('placemakers', 'test');
  const service = new ProductService(undefined as any);
  (service as any).cataloguePack = async () => pack; (service as any).getDb = async () => db;
  return { db, pack, service };
}

test('detail and pricebook share the same mapped source identity guard; RAG chunks cannot repair a conflicted record', async () => {
  const { db, pack, service } = await fixture();
  await db.collection('products').insertMany([
    { projectId: 'placemakers', sku: 'CLEAN', name: 'Source product', price: { amount: 25, currency: 'NZD' }, specs: { Width: '60 CMT' }, stock: { branchCount: 8, availableBranchCount: 2 }, colors: [{ name: 'Source colour' }], sizes: ['Source size'], rating: { value: 4.5, count: 12 }, completeTheLook: [{ name: 'Merchant suggestion', productId: 'OTHER-REAL', price: 'Ask for a quote' }] },
    { projectId: 'placemakers', sku: 'CONFLICT', name: 'Renamed source', price: { amount: 25, currency: 'NZD' }, url: 'https://shop.example/new', web: { productUrl: 'https://shop.example/old' }, specs: { Width: '90 CMT' }, featuresList: ['Wrong feature'] },
    { projectId: 'placemakers', tenantId: 'other', sku: 'OTHER', name: 'Conflicting owner', price: { amount: 100, currency: 'NZD' } },
  ]);
  await db.collection('documents').insertOne({ brand: 'placemakers', metadata: { sku: 'CONFLICT', price: 1, currency: 'NZD' }, title: 'Old RAG copy' });
  const result = await (service as any).readPricebook('placemakers', ['CLEAN', 'CONFLICT', 'OTHER', 'MISSING'], pack);
  assert.deepEqual(result.found, ['CLEAN']); assert.equal(result.items[0].price, 25); assert.equal(result.items[0].inStock, undefined);
  assert.deepEqual(result.items[0].colors, [{ name: 'Source colour' }]); assert.deepEqual(result.items[0].sizes, ['Source size']);
  assert.equal(result.items[0].rating.value, 4.5); assert.equal(result.items[0].completeTheLook[0].productId, 'OTHER-REAL');
  assert.deepEqual(result.missing, ['CONFLICT', 'OTHER', 'MISSING']);
  const quarantined = await service.getProductDetail('placemakers', 'CONFLICT');
  assert.equal(quarantined?.integrity?.identityConsistent, false); assert.equal(quarantined?.price, null); assert.deepEqual(quarantined?.specs, []); assert.deepEqual(quarantined?.features, []);
  assert.equal(await service.getProductDetail('placemakers', 'OTHER'), null);
  const clean = await service.getProductDetail('placemakers', 'CLEAN');
  assert.equal(clean?.availability?.inStock, undefined); assert.equal(clean?.availability?.branchChecked, false); assert.match(clean?.availability?.label || '', /current stock not checked/);
});

test('same-tenant duplicate identity is ambiguous before integrity or lifecycle filtering can select a winner', async () => {
  for (const suffix of ['conflict', 'retired', 'clean']) {
    const { db, pack, service } = await fixture(), sku = `DUP-${suffix}`;
    const first = { projectId: 'placemakers', sku, name: 'First row', price: { amount: 25, currency: 'NZD' }, url: 'https://shop.example/a' };
    const second = { ...first, name: 'Second row', ...(suffix === 'conflict' ? { web: { productUrl: 'https://shop.example/b' } } : suffix === 'retired' ? { discontinued: true } : {}) };
    await db.collection('products').insertMany([first, second]);
    const book = await (service as any).readPricebook('placemakers', [sku], pack);
    assert.deepEqual(book.items, []); assert.deepEqual(book.missing, [sku]);
    const detail = await service.getProductDetail('placemakers', sku);
    assert.equal(detail?.integrity?.identityConsistent, false); assert.equal(detail?.integrity?.issues[0].code, 'ambiguous_identifier'); assert.equal(detail?.price, null);
  }
});
