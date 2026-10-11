import assert from 'node:assert/strict';
import { OkfAuthoringService, OkfDraftConflictError } from '../src/okf-authoring.service';
import { ProjectService } from '../src/project.service';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';
import { archiveOkfBundle, importOkfBundle } from '../../../packages/knowledge/src';

function matches(doc: any, query: any): boolean {
  return Object.entries(query || {}).every(([key, expected]) => doc[key] === expected);
}

class Cursor {
  private max = Number.MAX_SAFE_INTEGER;
  constructor(private readonly docs: any[]) {}
  sort(spec: Record<string, number>) {
    const [key, direction] = Object.entries(spec)[0];
    this.docs.sort((a, b) => ((a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction));
    return this;
  }
  limit(value: number) { this.max = value; return this; }
  async toArray() { return this.docs.slice(0, this.max).map((doc) => ({ ...doc })); }
}

class Collection {
  docs: any[] = [];
  async findOne(query: any) { return this.docs.find((doc) => matches(doc, query)) || null; }
  async insertOne(doc: any) { this.docs.push({ ...doc }); return { acknowledged: true }; }
  async insertMany(docs: any[]) { this.docs.push(...docs.map((doc) => ({ ...doc }))); return { acknowledged: true }; }
  async replaceOne(query: any, doc: any) {
    const index = this.docs.findIndex((entry) => matches(entry, query));
    if (index < 0) return { matchedCount: 0 };
    this.docs[index] = { ...doc };
    return { matchedCount: 1 };
  }
  async updateOne(query: any, update: any, options?: { upsert?: boolean }) {
    const index = this.docs.findIndex((entry) => matches(entry, query));
    if (index < 0) {
      if (options?.upsert) this.docs.push({ ...query, ...update.$set });
      return { matchedCount: 0 };
    }
    Object.assign(this.docs[index], update.$set);
    return { matchedCount: 1 };
  }
  find(query: any) { return new Cursor(this.docs.filter((doc) => matches(doc, query))); }
}

class Db {
  private readonly values = new Map<string, Collection>();
  collection(name: string) {
    if (!this.values.has(name)) this.values.set(name, new Collection());
    return this.values.get(name)!;
  }
}

async function main() {
  console.log('🧠 Running OKF authoring control-plane suite...');
  let passed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  };
  const db = new Db();
  const attached: any[] = [];
  const service = new OkfAuthoringService(
    async () => db as any,
    async (projectId, ref) => { attached.push({ projectId, ref }); return { success: true }; }
  );
  const reviewedContent = buildOkfContent();
  for (const record of reviewedContent.verifications) {
    record.verifiedBy = 'publisher-1';
    record.verifierRole = record.recordId === 'verify-leak-safety' ? 'trade_expert' : 'product_manager';
  }

  await test('draft save is tenant scoped, structurally typed, and compare-and-swap protected', async () => {
    const saved = await service.saveDraft({
      projectId: 'placemakers',
      environmentId: 'production',
      expectedRevision: 0,
      content: reviewedContent,
      updatedBy: 'author-1',
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.validation.valid, true);
    assert.equal(saved.content.index, undefined, 'draft must not retain a client-supplied index');
    assert.equal(saved.content.evaluation, undefined, 'draft must not retain a client-supplied evaluation');
    await assert.rejects(
      () => service.saveDraft({ projectId: 'placemakers', expectedRevision: 0, content: buildOkfContent(), updatedBy: 'author-2' }),
      (error: any) => error instanceof OkfDraftConflictError
    );
  });

  await test('draft preview runs the deterministic OKF gate without publication', async () => {
    const preview: any = await service.previewDraft('placemakers', { message: 'screws' });
    assert.equal(preview.previewable, true);
    assert.equal(preview.decision.mode, 'overview_then_ask');
    assert.equal(preview.decision.conceptId, 'concept://placemakers/fastenings/screws');
  });

  await test('attestation rejects any draft author and a verifier identity mismatch', async () => {
    await service.saveDraft({ projectId: 'review-tenant', environmentId: 'test', expectedRevision: 0, content: buildOkfContent(), updatedBy: 'author-a' });
    const edited = await service.saveDraft({ projectId: 'review-tenant', environmentId: 'test', expectedRevision: 1, content: buildOkfContent(), updatedBy: 'editor-b' });
    assert.deepEqual(edited.authorHistory.map(({ revision, authorId }: any) => ({ revision, authorId })), [
      { revision: 1, authorId: 'author-a' }, { revision: 2, authorId: 'editor-b' },
    ]);
    await assert.rejects(
      () => service.attestDraftVerification({ projectId: 'review-tenant', environmentId: 'test', expectedRevision: 2, recordId: 'verify-leak-safety', approvedBy: 'author-a', approverRole: 'admin' }),
      /draft author/,
    );
    await assert.rejects(
      () => service.attestDraftVerification({ projectId: 'review-tenant', environmentId: 'test', expectedRevision: 2, recordId: 'verify-leak-safety', approvedBy: 'publisher-1', approverRole: 'admin' }),
      /verifiedBy/,
    );
  });

  await test('publishing creates immutable normalized evidence and attaches the exact release to the project draft', async () => {
    await service.configureVerifierRole('placemakers', 'production', 'trade_expert', ['publisher-1'], 'admin-1');
    await service.configureVerifierRole('placemakers', 'production', 'product_manager', ['publisher-1'], 'admin-1');
    await assert.rejects(
      () => service.publishDraft({ projectId: 'placemakers', expectedRevision: 1, version: '1.0.0', publishedBy: 'publisher-1' }),
      /lacks a matching server-side attestation/
    );
    await assert.rejects(
      () => service.attestDraftVerification({ projectId: 'placemakers', expectedRevision: 1, recordId: 'verify-leak-safety', approvedBy: 'author-1', approverRole: 'admin' }),
      /different authenticated user/
    );
    await service.attestDraftVerification({ projectId: 'placemakers', expectedRevision: 1, recordId: 'verify-leak-safety', approvedBy: 'publisher-1', approverRole: 'admin' });
    await service.attestDraftVerification({ projectId: 'placemakers', expectedRevision: 1, recordId: 'verify-tapware-care', approvedBy: 'publisher-1', approverRole: 'admin' });
    const result: any = await service.publishDraft({
      projectId: 'placemakers',
      expectedRevision: 1,
      version: '1.0.0',
      publishedBy: 'publisher-1',
    });
    assert.equal(result.release.status, 'ready');
    assert.notEqual(result.release.content.index.indexChecksum, reviewedContent.index.indexChecksum);
    assert.notEqual(result.release.content.evaluation.reportId, reviewedContent.evaluation.reportId);
    assert.equal(result.release.content.evaluation.passed, true);
    assert.ok(result.release.content.evaluation.scenarioCount > 1);
    assert.ok(new Date(result.release.content.evaluation.evaluatedAt).getTime() >=
      new Date((await service.getDraft('placemakers'))!.updatedAt).getTime());
    const report = db.collection('okf_evaluation_reports').docs[0];
    assert.equal(report.reportId, result.release.content.evaluation.reportId);
    assert.equal(report.scenarios.length, result.release.content.evaluation.scenarioCount);
    assert.ok(report.scenarios.every((scenario: any) => scenario.passed));
    assert.equal(result.knowledgeModel.checksum, result.release.checksum);
    assert.equal(result.nextStep, 'publish_business_pack');
    assert.equal(attached.length, 1);
    assert.equal(attached[0].projectId, 'placemakers');
    assert.equal(attached[0].ref.knowledgeModel.modelId, result.release.content.modelId);
    assert.equal(attached[0].ref.factRegistry.facts.substrate.promptQuestion, 'What are you fixing, and into which material?');
    assert.equal(db.collection('okf_evidence_chunks').docs.length, 1);
    const replay: any = await service.publishDraft({
      projectId: 'placemakers', expectedRevision: 1, version: '1.0.0', publishedBy: 'publisher-1',
    });
    assert.equal(replay.release.checksum, result.release.checksum);
    assert.equal(replay.release.content.evaluation.evaluatedAt, result.release.content.evaluation.evaluatedAt);
    assert.equal(db.collection('okf_evaluation_reports').docs.length, 1);
  });

  await test('release history and explicit release selection preserve pack-coupled activation', async () => {
    const releases = await service.listReleases('placemakers');
    assert.equal(releases.length, 1);
    const release: any = db.collection('okf_releases').docs[0];
    const selected: any = await service.selectRelease({
      projectId: 'placemakers',
      releaseId: release.releaseId,
      version: release.version,
      checksum: release.checksum,
    });
    assert.equal(selected.nextStep, 'publish_business_pack');
    assert.equal(release.content, undefined, 'release document must stay metadata-only');
    assert.equal(selected.knowledgeModel.modelId, release.contentHeader.modelId);
    assert.equal(attached.length, 3);
    const exported = await service.exportRelease('placemakers', release.releaseId);
    assert.equal(importOkfBundle(exported, 'placemakers').draft.concepts.length, db.collection('okf_concepts').docs.length);
    await assert.rejects(() => service.exportRelease('other', release.releaseId), /not found/);
  });

  await test('real project update persists the exact OKF attachment for Business Pack compilation', async () => {
    const projectDb = new Db();
    await projectDb.collection('tenant_configs').insertOne({ projectId: 'attachment-test', name: 'Attachment test', version: 1 });
    const projects = new ProjectService();
    projects.setDbForTesting(projectDb as any);
    const knowledgeModel = { type: 'okf_release', modelId: 'knowledge', releaseId: 'okf-attachment-test', version: '1.0.0', checksum: 'sha256:test', required: true, failurePolicy: 'fail_closed' };
    const factRegistry = { version: '1.0.0', facts: { topic: { type: 'string', description: 'Topic' } } };
    const result = await projects.updateProject('attachment-test', { knowledgeModel, factRegistry } as any);
    assert.equal(result.success, true);
    const stored = await projects.getProject('attachment-test');
    assert.deepEqual(stored?.knowledgeModel, knowledgeModel);
    assert.deepEqual(stored?.factRegistry, factRegistry);
    const replacement = { version: '1.0.1', facts: { newTopic: { type: 'string', description: 'New topic' } } };
    assert.equal((await projects.updateProject('attachment-test', { factRegistry: replacement } as any)).success, true);
    assert.deepEqual((await projects.getProject('attachment-test'))?.factRegistry, replacement,
      'a new registry replaces the previous one instead of merging stale facts');
  });

  await test('foreign ZIP import creates an unverified tenant draft and never activates it', async () => {
    const archive = archiveOkfBundle({
      'sample.md': new TextEncoder().encode('---\ntype: Unfamiliar Kind\ntitle: Sample\nextra: retained\n---\n# Sample\n'),
    });
    const result = await service.importBundle({
      projectId: 'foreign', environmentId: 'test', expectedRevision: 0, archive, updatedBy: 'author-2',
    });
    assert.equal(result.draft.revision, 1);
    assert.equal(result.draft.content.concepts[0].type, 'unknown');
    assert.equal(result.draft.content.concepts[0].interchange.originalType, 'Unfamiliar Kind');
    assert.deepEqual(result.draft.content.verifications, []);
    assert.equal(db.collection('okf_releases').docs.length, 1, 'import must not publish');
    assert.equal((await service.getDraft('foreign', 'test')).tenantId, 'foreign');
    assert.equal((await service.getArtifactPolicy('foreign', 'test')).artifactRequired, false);
    assert.equal((await service.setArtifactPolicy('foreign', 'test', true, 'publisher-1')).artifactRequired, true);
    assert.equal((await service.getArtifactPolicy('foreign', 'test')).artifactRequired, true);
    assert.equal((await service.getArtifactPolicy('placemakers', 'production')).artifactRequired, false);
  });

  await test('failed project attachment stops new publication, replay, and release selection', async () => {
    const failed = new OkfAuthoringService(async () => db as any, async () => ({ success: false, message: 'project not found' }));
    const release: any = db.collection('okf_releases').docs.find((item) => item.tenantId === 'placemakers');
    await assert.rejects(
      () => failed.publishDraft({ projectId: 'placemakers', expectedRevision: 1, version: '1.0.0', publishedBy: 'publisher-1' }),
      /OKF release attachment failed: project not found/,
    );
    await assert.rejects(
      () => failed.selectRelease({ projectId: 'placemakers', releaseId: release.releaseId, version: release.version, checksum: release.checksum }),
      /OKF release attachment failed: project not found/,
    );
    await assert.rejects(
      () => failed.publishDraft({ projectId: 'placemakers', expectedRevision: 1, version: '1.0.1', publishedBy: 'publisher-1' }),
      /OKF release attachment failed: project not found/,
    );
  });

  assert.equal(passed, 8);
  console.log(`✅ OKF authoring control-plane suite: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
