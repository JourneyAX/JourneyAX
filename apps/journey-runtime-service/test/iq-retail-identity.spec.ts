import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackLoader, publishBusinessPack, getVerifiedBusinessPackMetadata } from '@journeyax/business-pack';
import { IqQueryEngine, MemoryKeyRepository } from '@journeyax/jax-iq';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { minimalDictionary } from '../../../packages/jax-iq/test/fixtures/minimal.dictionary';
import { connectorsFixture } from '../../../packages/jax-iq/test/fixtures/connectors.fixture';
import { MongoRetailIqIdentityPort } from '../src/agent/iq-customer-identity';
import { executeIqTool } from '../src/agent/iq-tools';

async function fixture() {
  const db = new MemoryDb(); const ontology: any = structuredClone(minimalDictionary);
  ontology.retailCustomerIdentity = { thing: 'Account', role: 'owner', selfAlias: 'self' };
  ontology.customerAccess = [{ thing: 'Account', roles: ['owner'], facts: ['Account.name'], links: [] }];
  ontology.bindings[0].args.requesterEmail = { from: 'principal', field: 'id' };
  const connectors = structuredClone(connectorsFixture);
  connectors.policy.push({ connectorId: 'ace-erp', tool: 'account_balance', audience: 'shopper', groups: [], state: 'allow' });
  const content: any = structuredClone(rawLegacyFixture); content.extensions = { ...content.extensions, jaxOntology: ontology, connectors };
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  await publishBusinessPack(db as any, content);
  const release = await new BusinessPackLoader({ db }).loadPublished('placemakers', 'production'); const meta = getVerifiedBusinessPackMetadata(release)!;
  await db.collection('customer_profile_links').insertOne({ tenantId: 'placemakers', environmentId: 'production', principalId: 'owner@example.test', canonicalId: 'ACC-0001', status: 'ready' });
  const port = new MongoRetailIqIdentityPort(async () => db);
  const keys = new MemoryKeyRepository(); await keys.upsertMany([{ tenantId: 'placemakers', environmentId: 'production', thing: 'Account', canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001', role: 'primary', status: 'matched', evidence: 'real_field', firstSeenAt: '2026-11-03T00:00:00Z', lastVerifiedAt: '2026-11-03T00:00:00Z', builtBy: { runId: 'isolated', releaseVersion: meta.version, releaseChecksum: meta.checksum } }]);
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ ...meta, ontology, connectors }) }, reader: { read: async call => { calls.push(call); return { ok: true, data: { record: { name: 'Owned profile' } }, bytes: 50, truncated: false }; } } });
  const ctx: any = { tenantId: 'placemakers', environmentId: 'production', principalId: 'owner@example.test', principal: { audience: 'shopper', groups: [] }, companies: [{ id: 'ACC-9999', name: 'Forged company', role: 'account_admin' }], release, retailIqIdentity: port, correlationId: 'test', readSourceIds: new Set(), iqClient: { query: engine.query.bind(engine) } };
  return { db, release, port, ctx, calls };
}
test('retail self resolves only the authenticated principal profile and source arguments ignore model overrides', async () => {
  const f = await fixture();
  const response = await executeIqTool('jaxiq_get', { subject: { thing: 'Account', canonicalId: 'self' }, filters: { requesterEmail: 'another@example.test' } }, f.ctx);
  assert.equal(response.ok && response.records[0].subject.canonicalId, 'ACC-0001');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.requesterEmail, 'owner@example.test'); assert.equal(f.calls[0].args.accountId, 'ACC-0001');
});
test('wrong principal, tenant, environment, status, role and missing isolated port never acquire a retail subject', async () => {
  const f = await fixture(); const scope = { tenantId: 'placemakers', environmentId: 'production', principalId: 'owner@example.test' };
  for (const change of [{ principalId: 'another@example.test' }, { tenantId: 'other' }, { environmentId: 'dev' }]) assert.deepEqual(await f.port.forPrincipal({ ...scope, ...change }, f.release), []);
  const args = { subject: { thing: 'Account', canonicalId: 'self' } };
  for (const ctx of [{ ...f.ctx, principalId: 'another@example.test' }, { ...f.ctx, retailIqIdentity: undefined }, { ...f.ctx, retailIqIdentity: { forPrincipal: async () => [{ thing: 'Account', canonicalId: 'ACC-0001', role: 'viewer' }] } }]) {
    const response = await executeIqTool('jaxiq_get', args, ctx);
    assert.equal(response.ok, false);
  }
  assert.equal(f.calls.length, 0);
  await f.db.collection('customer_profile_links').updateOne({ principalId: scope.principalId }, { $set: { status: 'partial' } });
  assert.deepEqual(await f.port.forPrincipal(scope, f.release), []);
});
