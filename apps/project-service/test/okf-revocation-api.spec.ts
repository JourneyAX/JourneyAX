import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { can } from '@journeyax/shared-types';
import { publishOkfRelease, COLLECTION_OKF_REVOCATION_EVENTS } from '../../../packages/knowledge/src';
import { buildOkfContent, conceptId } from '../../../packages/knowledge/test/fixtures';
import { OkfAuthoringService } from '../src/okf-authoring.service';

const suite = createSuite('project-service: knowledge revocation API');
const WOOD = conceptId('fastenings/wood-screws');

async function setup() {
  const db = new MemoryDb();
  await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).createIndex(
    { tenantId: 1, environmentId: 1, revocationId: 1, eventType: 1 }, { unique: true });
  await publishOkfRelease(db as any, {
    releaseId: 'rel-1', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0',
    content: buildOkfContent() as any, publishedBy: 'tester',
  });
  const service = new OkfAuthoringService(async () => db as any, async () => ({ success: true }));
  return { db, service };
}

const base = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'placemakers', releaseId: 'rel-1', conceptIds: [WOOD], reason: 'Recall',
  expiresAt: '2099-01-01T00:00:00.000Z', actor: 'human:alice', ...overrides,
});

async function main() {
  await suite.test('only managers and admins hold knowledge.revoke', () => {
    assert.equal(can('manager', 'knowledge.revoke'), true);
    assert.equal(can('admin', 'knowledge.revoke'), true);
    assert.equal(can('buyer', 'knowledge.revoke'), false);
    assert.equal(can('guest', 'knowledge.revoke'), false);
  });

  await suite.test('a revocation needs an authenticated principal, a reason and a valid expiry', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.createRevocation(base({ actor: undefined })), /authenticated principal/);
    await assert.rejects(() => service.createRevocation(base({ actor: '  ' })), /authenticated principal/);
    await assert.rejects(() => service.createRevocation(base({ reason: '  ' })), /reason is required/);
    await assert.rejects(() => service.createRevocation(base({ expiresAt: 'not-a-date' })), /valid date/);
  });

  await suite.test('creating records the actor and defaults to suppressing claims and retrieval for descendants', async () => {
    const { service, db } = await setup();
    const event = await service.createRevocation(base());
    assert.equal(event.createdBy, 'human:alice');
    assert.equal(event.cascade, 'descendants');
    assert.deepEqual(event.effect, { suppressClaims: true, suppressRetrieval: true });
    assert.equal(db.dump(COLLECTION_OKF_REVOCATION_EVENTS).length, 1);
    const listed = await service.listRevocations('placemakers', 'production');
    assert.deepEqual(listed.map((entry) => entry.status), ['active']);
  });

  await suite.test('revocations never cross tenants or environments', async () => {
    const { service } = await setup();
    await assert.rejects(() => service.createRevocation(base({ projectId: 'workweargroup' })), /not found/);
    await assert.rejects(() => service.createRevocation(base({ environmentId: 'staging' })), /not found/);
    await assert.rejects(() => service.createRevocation(base({ environmentId: 'qa' })), /Invalid environmentId/);
  });

  await suite.test('lifting without a corrected release or principal is refused', async () => {
    const { service } = await setup();
    const event = await service.createRevocation(base());
    await assert.rejects(() => service.liftRevocation({ projectId: 'placemakers', revocationId: event.revocationId, correctedReleaseId: 'rel-1', actor: 'human:bob' }), /differ/);
    await assert.rejects(() => service.liftRevocation({ projectId: 'placemakers', revocationId: event.revocationId, correctedReleaseId: 'rel-x', actor: undefined }), /authenticated principal/);
    await assert.rejects(() => service.liftRevocation({ projectId: 'placemakers', revocationId: event.revocationId, correctedReleaseId: 'rel-x', actor: 'human:bob' }), /not found/);
  });

  await suite.test('pruning requires a principal and a valid cutoff and keeps active revocations', async () => {
    const { service } = await setup();
    await service.createRevocation(base());
    await assert.rejects(() => service.pruneRevocations('placemakers', 'production', '2030-01-01', undefined), /authenticated principal/);
    await assert.rejects(() => service.pruneRevocations('placemakers', 'production', 'nope', 'human:alice'), /valid date/);
    assert.deepEqual(await service.pruneRevocations('placemakers', 'production', '2030-01-01', 'human:alice'), { archived: 0 });
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
