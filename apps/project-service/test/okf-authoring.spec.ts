import assert from 'node:assert/strict';
import { OkfAuthoringService, OkfDraftConflictError } from '../src/okf-authoring.service';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';

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

  await test('draft save is tenant scoped, structurally typed, and compare-and-swap protected', async () => {
    const saved = await service.saveDraft({
      projectId: 'placemakers',
      environmentId: 'production',
      expectedRevision: 0,
      content: buildOkfContent(),
      updatedBy: 'author-1',
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.validation.valid, true);
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

  await test('publishing creates immutable normalized evidence and attaches the exact release to the project draft', async () => {
    const result: any = await service.publishDraft({
      projectId: 'placemakers',
      expectedRevision: 1,
      version: '1.0.0',
      publishedBy: 'publisher-1',
    });
    assert.equal(result.release.status, 'ready');
    assert.equal(result.knowledgeModel.checksum, result.release.checksum);
    assert.equal(result.nextStep, 'publish_business_pack');
    assert.equal(attached.length, 1);
    assert.equal(attached[0].projectId, 'placemakers');
    assert.equal(db.collection('okf_evidence_chunks').docs.length, 1);
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
    assert.equal(attached.length, 2);
  });

  assert.equal(passed, 4);
  console.log(`✅ OKF authoring control-plane suite: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
