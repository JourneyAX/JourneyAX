import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackLoader, getVerifiedBusinessPackMetadata, publishBusinessPack } from '@journeyax/business-pack';
import { IqQueryEngine, MemoryKeyRepository } from '@journeyax/jax-iq';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { minimalDictionary } from '../../../packages/jax-iq/test/fixtures/minimal.dictionary';
import { connectorsFixture } from '../../../packages/jax-iq/test/fixtures/connectors.fixture';
import { executeCustomerAccountTool } from '../src/agent/customer-account';

test('account pricing carries the authenticated company and SKU through IQ, without direct connector escape', async () => {
  const ontology: any = structuredClone(minimalDictionary);
  ontology.customerIdentity = { thing: 'Account', keyKind: 'account_number' };
  ontology.facts.push({ fact: 'Account.tier', thing: 'Account', label: 'Tier', meaning: 'The authenticated account tier.', type: 'text', freshnessKind: 'reference', allowStale: true },
    { fact: 'Account.silverPrice', thing: 'Account', label: 'Account product price', meaning: 'The source price for this account and requested SKU.', type: 'money', freshnessKind: 'reference', allowStale: true });
  const base = ontology.bindings[0];
  ontology.bindings.push({ ...base, bindingId: 'Account.tier@ace-erp.account_balance', target: { kind: 'fact', fact: 'Account.tier' }, select: 'record.tier' },
    { ...base, bindingId: 'Account.silverPrice@ace-erp.trade_price', target: { kind: 'fact', fact: 'Account.silverPrice' }, tool: 'trade_price', args: { accountId: { from: 'key', kind: 'account_number' }, sku: { from: 'request', param: 'sku' } }, select: 'record.silverPrice', currencyFrom: 'record.currency', contract: { unit: 'each', currency: 'NZD', tax: 'excludes_tax', asOf: 'retrieved', counts: 'one requested catalogue SKU for the linked account' } });
  ontology.customerAccess = [{ thing: 'Account', facts: ['Account.name', 'Account.tier', 'Account.silverPrice'], links: [] }];
  const connectors: any = structuredClone(connectorsFixture);
  connectors.connectors.find((entry: any) => entry.connectorId === 'ace-erp').tools.push({ name: 'trade_price', sideEffect: 'read' });
  for (const tool of ['account_balance', 'trade_price']) connectors.policy.push({ connectorId: 'ace-erp', tool, audience: 'shopper', groups: [], state: 'allow' });
  const content: any = structuredClone(rawLegacyFixture);
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  content.extensions = { ...content.extensions, jaxOntology: ontology, connectors,
    customerAccount: { enabled: true, connector: 'ace-erp', tools: { balance: 'account_balance', deliveries: 'list_deliveries', price: 'trade_price' }, pricingFields: { silver: 'silverPrice' } } };
  const db = new MemoryDb(); await publishBusinessPack(db as any, content);
  const pack = await new BusinessPackLoader({ db }).loadPublished('placemakers', 'production');
  const meta = getVerifiedBusinessPackMetadata(pack)!;
  const keys = new MemoryKeyRepository();
  await keys.upsertMany([{ tenantId: 'placemakers', environmentId: 'production', thing: 'Account', canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001', status: 'matched', role: 'primary', evidence: 'real_field', firstSeenAt: '2026-11-01T00:00:00Z', lastVerifiedAt: '2026-11-01T00:00:00Z', builtBy: { runId: 'offline', releaseVersion: meta.version, releaseChecksum: meta.checksum } }]);
  const calls: any[] = [];
  const engine = new IqQueryEngine({ keys, releases: { load: async () => ({ version: meta.version, checksum: meta.checksum, ontology: pack.extensions!.jaxOntology!, connectors: pack.extensions!.connectors! }) }, reader: { read: async call => {
    calls.push(call); assert.equal(call.args.accountId, 'ACC-0001');
    if (call.tool === 'trade_price') { assert.equal(call.args.sku, 'SKU-A'); return { ok: true, truncated: false, bytes: 100, data: { record: { silverPrice: 70, currency: 'NZD', goldPrice: 1 } } }; }
    return { ok: true, truncated: false, bytes: 100, data: { record: { name: 'Linked account', tier: 'silver' } } };
  } } });
  const ctx: any = { release: pack, tenantId: 'placemakers', environmentId: 'production', principalId: 'buyer-a', principal: { audience: 'shopper', groups: [] }, companies: [{ id: 'ACC-0001', name: 'Linked account', role: 'buyer' }], readSourceIds: new Set(), allowedClaimClasses: new Set(), iqClient: { query: engine.query.bind(engine) }, connectorRuntime: { callRead: () => { throw new Error('Direct read must not run'); } } };
  const result = await executeCustomerAccountTool('my_price', { sku: 'SKU-A', accountId: 'ACC-9999' }, ctx, { tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId } as any);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.yourPrice, 70); assert.equal(result.yourTier, 'silver');
  assert.equal(JSON.stringify(result).includes('goldPrice'), false);
  assert.equal(calls.filter(call => call.tool === 'trade_price').length, 1);
});
