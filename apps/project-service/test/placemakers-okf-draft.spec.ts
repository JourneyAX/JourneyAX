import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { hydrateOkfReleaseEnvelope, resolveOkfGate } from '../../../packages/knowledge/src';
import { OkfAuthoringService } from '../src/okf-authoring.service';

const suite = createSuite('project-service: PlaceMakers OKF draft');
const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/migrations/placemakers-okf-draft.json'), 'utf8'));
const id = (p: string) => `concept://placemakers/${p}`;

async function publish() {
  const db = new MemoryDb();
  const attached: any[] = [];
  const service = new OkfAuthoringService(async () => db as any, async (_p, update) => { attached.push(update); return { success: true }; });
  const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'staging', expectedRevision: 0, content: draft, updatedBy: 'human:author' });
  assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues));
  const result: any = await service.publishDraft({
    projectId: 'placemakers', environmentId: 'staging', expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:author',
  });
  const stored = await db.collection('okf_releases').findOne({ tenantId: 'placemakers', releaseId: result.release.releaseId });
  const release = await hydrateOkfReleaseEnvelope(db as any, stored);
  return { service, db, attached, result, release };
}

async function main() {
  await suite.test('the shipped draft saves, evaluates and publishes to staging', async () => {
    const { result, release, attached } = await publish();
    assert.equal(result.release.environmentId, 'staging');
    assert.equal(release.content.evaluation.passed, true);
    assert.equal(attached.length, 1, 'the release is staged on the project draft');
    assert.deepEqual(Object.keys(attached[0].factRegistry.facts).sort(), ['fastener_substrate', 'leak_location']);
  });

  await suite.test('"screw" shows grouped examples first and asks what it is going into', async () => {
    const { release } = await publish();
    const decision = resolveOkfGate(release.content, {
      tenantId: 'placemakers', environmentId: 'staging', releaseId: release.releaseId, message: 'screw',
      matchedConcepts: [{ id: id('fastenings/screws'), score: 1, matchedBy: 'test' }],
    });
    assert.equal(decision.mode, 'overview_then_ask');
    assert.equal(decision.clarification?.factKey, 'fastener_substrate');
    assert.deepEqual(decision.retrieval.groups.map((g: any) => g.conceptId).sort(),
      [id('fastenings/masonry-anchors'), id('fastenings/metal-screws'), id('fastenings/wood-screws')]);
    assert.equal(decision.commerce.checkout, 'requires_compatibility_resolution');
  });

  await suite.test('"bathroom is leaking" is safety first, pauses products and never claims unverified guidance', async () => {
    const { release } = await publish();
    const decision = resolveOkfGate(release.content, {
      tenantId: 'placemakers', environmentId: 'staging', releaseId: release.releaseId, message: 'bathroom is leaking',
      matchedConcepts: [{ id: id('problems/bathroom-leak'), score: 1, matchedBy: 'test' }],
    });
    assert.equal(decision.mode, 'safety_then_diagnose');
    assert.equal(decision.retrieval.permission, 'blocked');
    assert.equal(decision.safety?.blocksProducts, true);
    assert.equal(decision.safety?.guidanceUnavailable, true, 'model-drafted wording is not presented as verified guidance');
    assert.equal(decision.commerce.addToCart, 'blocked');
  });

  await suite.test('the same leak inside an order question still goes to safety', async () => {
    const { release } = await publish();
    const decision = resolveOkfGate(release.content, {
      tenantId: 'placemakers', environmentId: 'staging', releaseId: release.releaseId,
      message: 'Where is my order? My bathroom is leaking',
      matchedConcepts: [{ id: id('problems/bathroom-leak'), score: 1, matchedBy: 'test' }],
    });
    assert.equal(decision.mode, 'safety_then_diagnose');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
