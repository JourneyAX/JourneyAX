import assert from 'node:assert/strict';
import { MemoryOkfArtifactStore } from '@journeyax/knowledge';
import { buildStoredOkfRelease } from '../../../packages/knowledge/test/fixtures';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';

async function main() {
  const release = buildStoredOkfRelease();
  const db = {
    collection(name: string) {
      if (name === 'okf_releases') return {
        async findOne(query: any) {
          return query.tenantId === release.tenantId && query.environmentId === release.environmentId &&
            query.releaseId === release.releaseId && query.version === release.version ? release : null;
        },
        async updateOne(_query: any, update: any) {
          Object.assign(release, update.$set);
          return { matchedCount: 1 };
        },
      };
      if (name === 'okf_revocation_events') return { find() { return { sort() { return { async toArray() { return []; } }; } }; } };
      throw new Error(`Unexpected collection: ${name}`);
    },
  };
  const store = new MemoryOkfArtifactStore();
  const worker = new OutboxWorkerService();
  worker.configureHandlers({ db: db as any, okfArtifactStore: store });
  const handler = (worker as any).handlers.get('okf.release.export_requested');
  assert.equal(typeof handler, 'function');
  const event = {
    tenantId: release.tenantId,
    environmentId: release.environmentId,
    payload: { releaseId: release.releaseId, version: release.version, checksum: release.checksum },
  };
  await handler(event);
  assert.equal(release.artifact?.status, 'ready');
  assert.match(release.artifactUri, /^gs:\/\/isolated-okf-test\/placemakers\/production\//);
  await handler(event);
  assert.equal(release.artifact?.status, 'ready', 'replayed event must remain idempotent');
  await assert.rejects(() => handler({ ...event, tenantId: 'other' }), /not found/);
  release.artifact = { status: 'pending' };
  const priorBucket = process.env.OKF_ARTIFACT_BUCKET;
  delete process.env.OKF_ARTIFACT_BUCKET;
  try {
    const missingBucketWorker = new OutboxWorkerService();
    missingBucketWorker.configureHandlers({ db: db as any });
    const missingBucketHandler = (missingBucketWorker as any).handlers.get('okf.release.export_requested');
    await assert.rejects(() => missingBucketHandler(event), /OKF_ARTIFACT_BUCKET/);
    assert.equal(release.artifact?.status, 'failed', 'missing export infrastructure must be visible on release metadata');
  } finally {
    if (priorBucket === undefined) delete process.env.OKF_ARTIFACT_BUCKET;
    else process.env.OKF_ARTIFACT_BUCKET = priorBucket;
  }
  console.log('✅ OKF export outbox suite passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
