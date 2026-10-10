import assert from 'node:assert/strict';
import {
  BusinessPackContentSchema,
  computePackChecksum,
} from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../business-pack/test/fixtures/legacy-pack.fixture';
import {
  ReleaseActivationRepository,
  ReleaseActivationValidationError,
} from '../src/cutover.repository';
import {
  COLLECTION_BUSINESS_PACK_POINTERS,
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_CUTOVER_AUDIT_LOGS,
  COLLECTION_TENANT_CUTOVERS,
} from '../src/types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function canonicalRelease() {
  const content: any = BusinessPackContentSchema.parse(clone(rawLegacyFixture));
  const checksum = computePackChecksum(content);
  return {
    content,
    checksum,
    document: {
      tenantId: content.manifest.tenantId,
      environmentId: content.manifest.environmentId,
      version: content.manifest.version,
      versionId: content.manifest.version,
      status: 'published',
      checksum,
      ...content,
    },
  };
}

function createHarness(releaseDocument: any, pointerPatch: Record<string, unknown> = {}) {
  const release = canonicalRelease();
  const releases = [releaseDocument];
  const pointers = [{
    tenantId: 'placemakers',
    environmentId: 'production',
    activeVersionId: '1.0.0',
    checksum: release.checksum,
    revision: 1,
    ...pointerPatch,
  }];
  const activations: any[] = [];
  const audits: any[] = [];
  const matches = (document: any, query: any) =>
    Object.entries(query)
      .filter(([key]) => key !== '$or')
      .every(([key, value]) => document[key] === value);

  const db: any = {
    collection(name: string) {
      if (name === COLLECTION_BUSINESS_PACK_RELEASES) {
        return {
          findOne: async (query: any) => releases.find((document) => {
            if (!matches(document, query)) return false;
            if (!query.$or) return true;
            return query.$or.some((candidate: any) =>
              candidate.version === document.version ||
              candidate['manifest.version'] === document.manifest?.version
            );
          }) ?? null,
        };
      }
      if (name === COLLECTION_BUSINESS_PACK_POINTERS) {
        return { findOne: async (query: any) => pointers.find((p) => matches(p, query)) ?? null };
      }
      if (name === COLLECTION_TENANT_CUTOVERS) {
        return {
          findOne: async (query: any) => activations.find((a) => matches(a, query)) ?? null,
          insertOne: async (document: any) => {
            activations.push(document);
            return { acknowledged: true };
          },
          updateOne: async (query: any, update: any) => {
            const current = activations.find((a) => matches(a, query));
            if (!current) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(current, update.$set ?? {});
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }
      if (name === COLLECTION_CUTOVER_AUDIT_LOGS) {
        return {
          insertOne: async (document: any) => {
            audits.push(document);
            return { acknowledged: true };
          },
        };
      }
      throw new Error(`Unexpected collection '${name}'`);
    },
  };
  const client: any = {
    startSession: () => ({
      withTransaction: async (operation: () => Promise<void>) => operation(),
      endSession: async () => undefined,
    }),
  };
  const repository = new ReleaseActivationRepository(async () => ({ db, client }));
  return { repository, activations, audits, pointers };
}

const promotion = (checksum: string) => ({
  status: 'migrated' as const,
  approvedReleaseVersion: '1.0.0',
  approvedReleaseChecksum: checksum,
  expectedRevision: 0,
  approvedBy: 'offline-test',
});

async function main() {
  console.log('🔐 Running release-activation integrity tests...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, operation: () => Promise<void>) {
    try {
      await operation();
      passed++;
      console.log(`  ✅ PASS: ${name}`);
    } catch (error: any) {
      failed++;
      console.error(`  ❌ FAIL: ${name}: ${error.message}`);
    }
  }

  await test('verified release and pointer promote atomically with audit', async () => {
    const release = canonicalRelease();
    const harness = createHarness(release.document);
    const record = await harness.repository.promoteReleaseActivation(
      'placemakers',
      'production',
      promotion(release.checksum)
    );
    assert.equal(record.revision, 1);
    assert.equal(record.approvedReleaseChecksum, release.checksum);
    assert.equal(harness.activations.length, 1);
    assert.equal(harness.audits.length, 1);
  });

  await test('tampered release retaining the original checksum is rejected before activation or audit', async () => {
    const release = canonicalRelease();
    const tampered = clone(release.document);
    tampered.profile.companyName = 'Tampered';
    const harness = createHarness(tampered);

    await assert.rejects(
      () => harness.repository.promoteReleaseActivation('placemakers', 'production', promotion(release.checksum)),
      (error: any) =>
        error instanceof ReleaseActivationValidationError &&
        error.code === 'RELEASE_INTEGRITY_CHECKSUM_MISMATCH'
    );
    assert.equal(harness.activations.length, 0);
    assert.equal(harness.audits.length, 0);
  });

  await test('missing and mismatched pointer checksums fail closed', async () => {
    const release = canonicalRelease();
    for (const [pointerPatch, expectedCode] of [
      [{ checksum: undefined }, 'POINTER_CHECKSUM_MISSING'],
      [{ checksum: 'f'.repeat(64) }, 'POINTER_CHECKSUM_MISMATCH'],
    ] as const) {
      const harness = createHarness(release.document, pointerPatch);
      await assert.rejects(
        () => harness.repository.promoteReleaseActivation('placemakers', 'production', promotion(release.checksum)),
        (error: any) => error instanceof ReleaseActivationValidationError && error.code === expectedCode
      );
      assert.equal(harness.activations.length, 0);
      assert.equal(harness.audits.length, 0);
    }
  });

  await test('caller checksum differing from the verified release is rejected', async () => {
    const release = canonicalRelease();
    const harness = createHarness(release.document);
    await assert.rejects(
      () => harness.repository.promoteReleaseActivation('placemakers', 'production', promotion('a'.repeat(64))),
      (error: any) => error instanceof ReleaseActivationValidationError && error.code === 'CHECKSUM_MISMATCH'
    );
    assert.equal(harness.activations.length, 0);
    assert.equal(harness.audits.length, 0);
  });

  console.log(`\nRelease Activation Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
