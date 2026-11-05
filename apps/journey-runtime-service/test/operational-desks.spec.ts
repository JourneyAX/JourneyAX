import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, OperationalDesksSchema, publishBusinessPack, getVerifiedBusinessPackMetadata } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { minimalDictionary } from '../../../packages/jax-iq/test/fixtures/minimal.dictionary';
import { deskSummaries, readOperationalDesk } from '../src/desks/operational-desks';
import { executeAgentTool } from '../src/agent/agent-tools';

const desk = { deskId: 'accounts', title: 'Account research', groups: ['research'], source: { connector: 'jax-iq', tool: 'get', args: { thing: 'Account', canonicalId: 'ACC-0001', facts: 'Account.name' } }, columns: [{ field: 'name', label: 'Account' }], detail: { source: { connector: 'jax-iq', tool: 'get', args: { thing: 'Account', canonicalId: '$recordId', facts: 'Account.name' } }, fields: [{ field: 'name', label: 'Trading name' }] }, ask: 'Research {recordId} in desk {deskId}. Explain what is known and ask what I want to do next.' };
async function fixture(source = desk.source) {
  const db = new MemoryDb();
  const raw: any = structuredClone(rawLegacyFixture);
  raw.experience.cards.allowedCardTypes.push('records');
  raw.manifest.environmentId = 'test';
  raw.extensions.jaxOntology = structuredClone(minimalDictionary);
  raw.extensions.operationalDesks = { desks: [{ ...desk, source }] };
  await publishBusinessPack(db as any, raw);
  const release = await new PackRepository(db as any).loadActivePack('placemakers', 'test');
  assert.ok(getVerifiedBusinessPackMetadata(release));
  const calls: any[] = [];
  let partial = false;
  const client: any = { query: async (query: any, context: any) => {
    calls.push({ query, context });
    return { ok: true, queryId: context.queryId, release: context.release, status: partial ? 'partial' : 'complete', records: [{ subject: { thing: 'Account', canonicalId: query.subject.canonicalId }, facts: [{ fact: 'Account.name', status: 'ok', value: 'Verified source name', source: { system: 'demo-erp', displayName: 'ERP demonstration', sample: true }, bindingIds: [], notes: [], crossChecks: [] }] }], sources: [{ system: 'demo-erp', sample: true, truncated: partial }], untrustedText: true };
  } };
  const ctx: any = { tenantId: 'placemakers', environmentId: 'test', principalId: 'staff-a', principal: { audience: 'staff', groups: ['research'] }, correlationId: 'desk-read', release, readSourceIds: new Set(), iqClient: client };
  return { ctx, calls, client, partial: () => { partial = true; } };
}

test('desk canvas and agent tool call the same pinned IQ query with verified staff scope', async () => {
  const { ctx, calls } = await fixture();
  assert.deepEqual(deskSummaries(ctx).map(item => item.deskId), ['accounts']);
  const canvas = await readOperationalDesk('accounts', 'ACC-0001', ctx);
  const chat = await executeAgentTool('read_desk', { deskId: 'accounts', recordId: 'ACC-0001', tenantId: 'other' }, ctx);
  assert.equal(canvas.ok, true);
  if (!canvas.ok) return;
  assert.deepEqual(chat.records, canvas.records.map(({ ask, ...record }: any) => record));
  assert.equal('ask' in chat.records[0], false, 'the model must not mistake a UI question template for source facts');
  assert.equal('columns' in chat, false);
  assert.deepEqual(calls[0].query, calls[1].query);
  assert.equal(calls[0].context.principal.id, 'staff-a');
  assert.equal(calls[0].context.tenantId, 'placemakers');
  assert.equal(calls[0].context.environmentId, 'test');
  assert.equal(canvas.records[0].values.name, 'Verified source name');
  assert.match(canvas.records[0].ask, /ACC-0001/);
});

test('an optional operational card uses only the authorised desk rows and merchant labels', async () => {
  const { ctx } = await fixture();
  ctx.presentedCards = []; ctx.catalogProductCache = new Map(); ctx.turnProductSkus = new Set(); ctx.allowedClaimClasses = new Set();
  const forged = { cardType: 'records', state: { heading: 'Forged', rows: [{ title: 'Another customer', amount: '$999' }] } };
  assert.equal((await executeAgentTool('present_card', forged, ctx)).code, 'record_source_required');
  await executeAgentTool('read_desk', { deskId: 'accounts', recordId: 'ACC-0001' }, ctx);
  assert.equal(ctx.presentedCards.length, 0, 'a successful read does not force a card');
  assert.equal((await executeAgentTool('present_card', forged, ctx)).ok, true);
  const shown = ctx.presentedCards[0].state;
  assert.equal(shown.heading, 'Account research'); assert.equal(shown.rows[0].title, 'ACC-0001');
  assert.equal(shown.rows[0].detail, 'Trading name: Verified source name');
  assert.equal(shown.rows[0].badge, 'Sample data'); assert.equal(JSON.stringify(shown).includes('$999'), false);
  assert.equal((await executeAgentTool('present_card', { cardType: 'records', state: { recordId: 'OTHER' } }, ctx)).code, 'record_source_required');
  await executeAgentTool('read_desk', { deskId: 'not-permitted' }, ctx);
  assert.equal((await executeAgentTool('present_card', forged, ctx)).code, 'record_source_required', 'a failed read cannot replay stale rows');
});

test('shoppers, unrelated staff and unverified/mismatched releases cannot read a desk', async () => {
  const { ctx, calls } = await fixture();
  for (const principal of [{ audience: 'shopper', groups: ['research'] }, { audience: 'staff', groups: ['other'] }]) {
    assert.deepEqual(deskSummaries({ ...ctx, principal }), []);
    assert.equal((await readOperationalDesk('accounts', undefined, { ...ctx, principal })).ok, false);
  }
  for (const change of [{ environmentId: 'production' }, { tenantId: 'other' }, { release: structuredClone(ctx.release) }]) assert.equal((await readOperationalDesk('accounts', undefined, { ...ctx, ...change })).ok, false);
  assert.equal(calls.length, 0);
});

test('partial and demonstration source marks survive canvas shaping', async () => {
  const f = await fixture(); f.partial();
  const result = await readOperationalDesk('accounts', undefined, f.ctx);
  assert.equal(result.ok && result.sample, true);
  assert.equal(result.ok && result.status, 'partial');
  assert.equal(result.ok && result.records[0].provenance[0].source.sample, true);
});

test('missing IQ coverage never falls back to a vendor or the old care processor', async () => {
  const { ctx, calls } = await fixture();
  // Configuration validation catches structural errors, including a detail read not bound to the selection.
  assert.equal(OperationalDesksSchema.safeParse({ desks: [{ ...desk, detail: { ...desk.detail, source: desk.source } }] }).success, false);
  assert.equal(OperationalDesksSchema.safeParse({ desks: [{ ...desk, board: { title: 'Board', groupBy: 'privateValue', titleField: 'name', groups: [{ value: 'open', label: 'Open' }] } }] }).success, false, 'a board cannot display or count fields absent from the permitted read');
  const missing = await fixture({ connector: 'missing-source', tool: 'find', args: {} as any });
  assert.deepEqual(await readOperationalDesk('accounts', undefined, missing.ctx), { ok: false, code: 'missing_iq_mapping' });
  assert.equal(missing.calls.length, 0);
  const unconfigured = { ...ctx, release: { extensions: { jaxOntology: { enabled: false } } } };
  assert.equal((await readOperationalDesk('accounts', undefined, unconfigured)).ok, false);
  assert.equal(calls.length, 0);
});
