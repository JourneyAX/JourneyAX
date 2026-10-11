import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { OKF_LIMITS, computeKnowledgeEntityHash, resolveOkfLimits } from '../../../packages/knowledge/src';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';
import { OkfAuthoringService } from '../src/okf-authoring.service';

const suite = createSuite('project-service: draft size ceiling');
const draftOf = () => {
  const { index: _i, evaluation: _e, ...draft } = structuredClone(buildOkfContent()) as any;
  return draft;
};
const save = (service: OkfAuthoringService) => service.saveDraft({
  projectId: 'placemakers', expectedRevision: 0, content: draftOf(), updatedBy: 'human:alice',
});

async function main() {
  await suite.test('limits are platform data with sane, validated values', () => {
    assert.ok(OKF_LIMITS.draftMaxBytes < 16 * 1024 * 1024, 'drafts stay under the per-document ceiling');
    assert.throws(() => resolveOkfLimits({ draftMaxBytes: 0 }), /Invalid OKF limit/);
  });

  await suite.test('a draft over the ceiling is rejected before anything is written', async () => {
    const db = new MemoryDb();
    const service = new OkfAuthoringService(async () => db as any, async () => ({ success: true }), { draftMaxBytes: 1024 });
    await assert.rejects(() => save(service), /draft is \d+ bytes; the limit is 1024/);
    assert.equal(db.dump('okf_drafts').length, 0);
  });

  await suite.test('a draft within the ceiling saves normally', async () => {
    const db = new MemoryDb();
    const service = new OkfAuthoringService(async () => db as any, async () => ({ success: true }));
    const saved = await save(service);
    assert.equal(saved.revision, 1);
  });

  await suite.test('saveDraft rebinds entity hashes to content, so editors never supply them', async () => {
    const db = new MemoryDb();
    const service = new OkfAuthoringService(async () => db as any, async () => ({ success: true }));
    const content = draftOf();
    content.concepts[0].name = 'Edited in the Studio form';
    content.concepts[0].contentHash = 'a'.repeat(64);
    const saved = await service.saveDraft({ projectId: 'placemakers', expectedRevision: 0, content, updatedBy: 'human:alice' });
    assert.equal(saved.content.concepts[0].contentHash, computeKnowledgeEntityHash(saved.content.concepts[0]));
    assert.ok(!saved.validation.issues.some((issue: any) => issue.code === 'content_hash_mismatch'));
  });

  await suite.test('analysis reports what stands between the draft and a safe release', async () => {
    const db = new MemoryDb();
    const service = new OkfAuthoringService(async () => db as any, async () => ({ success: true }));
    const empty = await service.analyzeDraft('placemakers', 'production');
    assert.equal(empty.ready, false);
    assert.equal(empty.checks.find((check) => check.id === 'draft_present')?.ok, false);
    const content = draftOf();
    await service.saveDraft({ projectId: 'placemakers', expectedRevision: 0, content, updatedBy: 'human:alice' });
    const analysis = await service.analyzeDraft('placemakers', 'production');
    assert.equal(analysis.revision, 1);
    assert.equal(analysis.checks.find((check) => check.id === 'release_published')?.ok, false);
    assert.ok(analysis.staleness.length > 0, 'concepts without verification records are listed');
    assert.equal(analysis.ready, false);
    await service.setArtifactPolicy('placemakers', 'production', true, 'human:alice');
    const withPolicy = await service.analyzeDraft('placemakers', 'production');
    assert.ok(withPolicy.checks.some((check) => check.id === 'artifact_exported'));
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
