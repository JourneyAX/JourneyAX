import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import {
  OkfIntegrityError,
  createOkfRevocation,
  liftOkfRevocation,
  listOkfRevocations,
  loadActiveOkfRevocations,
  publishOkfRelease,
  pruneOkfRevocationEvents,
  withKnowledgeEntityHash,
  COLLECTION_OKF_REVOCATION_EVENTS,
} from '../src';
import { buildOkfContent, conceptId } from './fixtures';

const suite = createSuite('knowledge: revocation lifecycle');
const TENANT = 'placemakers';
const ENV = 'production';
const NOW = new Date('2026-10-10T00:00:00.000Z');
const FUTURE = new Date('2026-11-10T00:00:00.000Z');
const WOOD = conceptId('fastenings/wood-screws');

async function setup() {
  const db = new MemoryDb();
  await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).createIndex(
    { tenantId: 1, environmentId: 1, revocationId: 1, eventType: 1 }, { unique: true });
  const content: any = buildOkfContent();
  const original = await publishOkfRelease(db as any, {
    releaseId: 'rel-1', tenantId: TENANT, environmentId: ENV, version: '1.0.0', content, publishedBy: 'tester',
  });
  return { db, original, content };
}

/** Corrected release: same graph, but the revoked concept's content really changed (re-hashed, records re-bound). */
async function publishCorrected(db: MemoryDb, content: any, mutate: (concept: any) => any) {
  const next = structuredClone(content);
  next.concepts = next.concepts.map((concept: any) => concept.conceptId === WOOD
    ? withKnowledgeEntityHash(mutate(concept)) : concept);
  const hash = next.concepts.find((concept: any) => concept.conceptId === WOOD).contentHash;
  next.verifications = next.verifications.map((record: any) =>
    record.targetType === 'concept' && record.targetId === WOOD ? { ...record, contentHash: hash } : record);
  return publishOkfRelease(db as any, {
    releaseId: 'rel-2', tenantId: TENANT, environmentId: ENV, version: '1.0.1', content: next, publishedBy: 'tester',
  });
}

const create = (db: MemoryDb, overrides: Record<string, unknown> = {}) => createOkfRevocation(db as any, {
  tenantId: TENANT, environmentId: ENV, releaseId: 'rel-1', conceptIds: [WOOD], cascade: 'descendants',
  effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'Manufacturer recall', createdBy: 'human:alice',
  expiresAt: FUTURE, now: NOW, ...overrides,
} as any);

async function rejects(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: any) => error instanceof OkfIntegrityError && error.code === code, `expected ${code}`);
}

async function main() {
  await suite.test('creating a revocation validates release scope and concept membership', async () => {
    const { db } = await setup();
    const event = await create(db);
    assert.equal(event.eventType, 'created');
    assert.equal(event.createdBy, 'human:alice');
    await rejects(() => create(db, { conceptIds: ['concept://placemakers/does-not-exist'] }), 'unknown_concept');
    await rejects(() => create(db, { releaseId: 'rel-missing' }), 'release_not_found');
    await rejects(() => create(db, { createdBy: '  ' }), 'actor_required');
  });

  await suite.test('an active revocation is returned by the safety read path until it expires', async () => {
    const { db } = await setup();
    await create(db);
    assert.equal((await loadActiveOkfRevocations(db as any, TENANT, ENV, 'rel-1', NOW)).length, 1);
    assert.equal((await loadActiveOkfRevocations(db as any, TENANT, ENV, 'rel-1', new Date('2027-01-01'))).length, 0);
  });

  await suite.test('the same revocation id cannot be created twice', async () => {
    const { db } = await setup();
    await create(db, { revocationId: 'rev-1' });
    await rejects(() => create(db, { revocationId: 'rev-1' }), 'invalid_transition');
  });

  await suite.test('lifting requires a corrected release', async () => {
    const { db } = await setup();
    const event = await create(db);
    await rejects(() => liftOkfRevocation(db as any, {
      tenantId: TENANT, environmentId: ENV, revocationId: event.revocationId, correctedReleaseId: '', liftedBy: 'human:bob', reason: 'ok', now: NOW,
    }), 'release_not_found');
  });

  await suite.test('lifting is refused when the corrected release still carries the unchanged concept', async () => {
    const { db, content } = await setup();
    const event = await create(db);
    await publishCorrected(db, content, (concept) => concept); // identical content
    await rejects(() => liftOkfRevocation(db as any, {
      tenantId: TENANT, environmentId: ENV, revocationId: event.revocationId, correctedReleaseId: 'rel-2', liftedBy: 'human:bob', reason: 'fixed', now: NOW,
    }), 'corrected_release_invalid');
    assert.equal((await loadActiveOkfRevocations(db as any, TENANT, ENV, 'rel-1', NOW)).length, 1, 'still revoked');
  });

  await suite.test('lifting succeeds once the concept content has really changed, and records who and why', async () => {
    const { db, content } = await setup();
    const event = await create(db);
    await publishCorrected(db, content, (concept) => ({ ...concept, name: `${concept.name} (corrected)` }));
    const lifted = await liftOkfRevocation(db as any, {
      tenantId: TENANT, environmentId: ENV, revocationId: event.revocationId, correctedReleaseId: 'rel-2', liftedBy: 'human:bob', reason: 'Guidance corrected', now: NOW,
    });
    assert.equal(lifted.eventType, 'lifted');
    assert.equal(lifted.correctedReleaseId, 'rel-2');
    assert.equal(lifted.createdBy, 'human:bob');
    assert.equal((await loadActiveOkfRevocations(db as any, TENANT, ENV, 'rel-1', NOW)).length, 0);
    await rejects(() => liftOkfRevocation(db as any, {
      tenantId: TENANT, environmentId: ENV, revocationId: event.revocationId, correctedReleaseId: 'rel-2', liftedBy: 'human:bob', reason: 'again', now: NOW,
    }), 'invalid_transition');
  });

  await suite.test('the corrected release must differ from the revoked one', async () => {
    const { db } = await setup();
    const event = await create(db);
    await rejects(() => liftOkfRevocation(db as any, {
      tenantId: TENANT, environmentId: ENV, revocationId: event.revocationId, correctedReleaseId: 'rel-1', liftedBy: 'human:bob', reason: 'x', now: NOW,
    }), 'corrected_release_invalid');
  });

  await suite.test('listing reports active, lifted and expired revocations', async () => {
    const { db, content } = await setup();
    const active = await create(db, { revocationId: 'rev-active' });
    await create(db, { revocationId: 'rev-expiring', expiresAt: new Date('2026-10-20T00:00:00.000Z') });
    await publishCorrected(db, content, (concept) => ({ ...concept, name: 'changed' }));
    await create(db, { revocationId: 'rev-lifted' });
    await liftOkfRevocation(db as any, { tenantId: TENANT, environmentId: ENV, revocationId: 'rev-lifted', correctedReleaseId: 'rel-2', liftedBy: 'human:bob', reason: 'fixed', now: NOW });
    const summary = await listOkfRevocations(db as any, { tenantId: TENANT, environmentId: ENV }, new Date('2026-10-25T00:00:00.000Z'));
    const status = Object.fromEntries(summary.map((entry) => [entry.revocationId, entry.status]));
    assert.deepEqual(status, { 'rev-active': 'active', 'rev-expiring': 'expired', 'rev-lifted': 'lifted' });
    assert.equal(active.revocationId, 'rev-active');
  });

  await suite.test('pruning archives only terminated history and never an active revocation', async () => {
    const { db, content } = await setup();
    await create(db, { revocationId: 'rev-active' });
    await create(db, { revocationId: 'rev-old', expiresAt: new Date('2026-10-12T00:00:00.000Z') });
    const result = await pruneOkfRevocationEvents(db as any, {
      tenantId: TENANT, environmentId: ENV, before: new Date('2026-10-20T00:00:00.000Z'), now: new Date('2026-10-25T00:00:00.000Z'),
    });
    assert.equal(result.archived, 1);
    const remaining = db.dump(COLLECTION_OKF_REVOCATION_EVENTS).map((event) => event.revocationId);
    assert.deepEqual(remaining, ['rev-active']);
    assert.equal(db.dump('okf_revocation_events_archive').length, 1);
    assert.ok(content);
  });

  await suite.test('tenant and environment scoping isolate revocations', async () => {
    const { db } = await setup();
    await create(db);
    assert.equal((await loadActiveOkfRevocations(db as any, 'workweargroup', ENV, undefined, NOW)).length, 0);
    assert.equal((await loadActiveOkfRevocations(db as any, TENANT, 'staging', undefined, NOW)).length, 0);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
