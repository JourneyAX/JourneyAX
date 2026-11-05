import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDb } from '@journeyax/test-support';
import { createPublicEvaluationStorage } from '../src/publication-evaluation-storage';
import { PublicationGateValidator } from '../src/publication-gate-validator';

const candidate = { manifest: { tenantId: 'tenant-a', environmentId: 'dev' }, evaluations: [{ sourceFixtures: { productSkus: ['P1'] } }] };

test('evaluation copies only declared, consistently owned public catalogue and guides into private storage', async () => {
  const source = new MemoryDb();
  await source.collection('products').insertMany([{ projectId: 'tenant-a', parentSku: 'P1', name: 'Public product', priceUSD: { min: 20 }, currency: 'NZD' }, { projectId: 'tenant-b', parentSku: 'P1', name: 'Other tenant' }]);
  await source.collection('product_guides').insertOne({ tenantId: 'tenant-a', skus: ['P1'], title: 'Public guide' });
  const reads: string[] = [];
  const port = { collection(name: string) { reads.push(name); assert.ok(['products', 'product_guides'].includes(name), 'no customer collection is readable'); return source.collection(name); } };
  const stored = await createPublicEvaluationStorage(port, { projectId: 'tenant-a', businessPack: candidate });
  assert.deepEqual(reads, ['products', 'product_guides']);
  assert.equal(stored.db.dump('products').length, 1);
  assert.equal(stored.db.dump('products')[0].name, 'Public product');
  await stored.db.collection('products').updateOne({ parentSku: 'P1' }, { $set: { name: 'Changed in evaluation' } });
  assert.equal(source.dump('products')[0].name, 'Public product', 'the evaluator cannot mutate the source');
  assert.equal(stored.fixtureSummary.customerRecords, 0);
});

test('missing fixtures, conflicting ownership and wrong tenant/environment fail instead of widening a source read', async () => {
  const source = new MemoryDb();
  await source.collection('products').insertOne({ projectId: 'tenant-a', tenantId: 'tenant-b', parentSku: 'P1' });
  await assert.rejects(() => createPublicEvaluationStorage(source, { projectId: 'tenant-a', businessPack: candidate }), /missing or has conflicting ownership/);
  await assert.rejects(() => createPublicEvaluationStorage(source, { projectId: 'tenant-b', businessPack: candidate }), /explicit non-production/);
  await assert.rejects(() => createPublicEvaluationStorage(source, { projectId: 'tenant-a', businessPack: { ...candidate, manifest: { ...candidate.manifest, environmentId: 'production' } } }), /explicit non-production/);
  await assert.rejects(() => createPublicEvaluationStorage(source, { projectId: 'tenant-a', businessPack: { ...candidate, evaluations: [] } }), /bounded public catalogue/);
});

test('the configured memory gate cannot run in production or for a different local tenant', async () => {
  const names = ['PUBLICATION_EVALUATION_STORAGE', 'PUBLICATION_EVALUATION_TENANT', 'COMMERCE_ENVIRONMENT', 'NODE_ENV'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { PUBLICATION_EVALUATION_STORAGE: 'public-source-memory', PUBLICATION_EVALUATION_TENANT: 'tenant-a', COMMERCE_ENVIRONMENT: 'dev', NODE_ENV: 'production' });
    assert.match((await new PublicationGateValidator().validateRelease('tenant-a', candidate, 1)).error || '', /explicitly configured local tenant/);
    process.env.NODE_ENV = 'development';
    assert.match((await new PublicationGateValidator().validateRelease('tenant-b', candidate, 1)).error || '', /explicitly configured local tenant/);
  } finally { for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
});
