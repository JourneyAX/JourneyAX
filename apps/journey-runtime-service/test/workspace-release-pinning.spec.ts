import assert from 'node:assert/strict';
import { computePackChecksum } from '@journeyax/business-pack';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { RuntimeService } from '../src/runtime.service';
import { buildCanonicalPackContent } from './fixtures/canonical-release.fixture';

const capabilities = { toolDefinitions: [], toolBindings: [], stageBindings: [] };

async function main() {
  console.log('📌 Running workspace release-pinning tests...\n');
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

  await test('workspace store writes release pins once and refuses later repinning', async () => {
    const store = new WorkspaceStore({ forceInMemory: true });
    const workspace = store.createInitial({
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId: 'ws-pinned',
      packVersionId: '1.0.0',
      pins: {
        packChecksum: 'checksum-v1',
        okfReleaseId: 'okf-v1',
        okfChecksum: 'okf-checksum-v1',
        pinnedAt: '2026-10-10T00:00:00.000Z',
      },
      journeyId: 'journey-1',
      initialStage: 'stage-1',
      goal: 'test',
    });
    await store.commit(workspace);

    const attemptedRepin = (await store.load('placemakers', 'production', 'ws-pinned'))!;
    attemptedRepin.packVersionId = '2.0.0';
    attemptedRepin.pins = {
      packChecksum: 'checksum-v2',
      okfReleaseId: 'okf-v2',
      okfChecksum: 'okf-checksum-v2',
      pinnedAt: '2026-10-11T00:00:00.000Z',
    };
    await store.commit(attemptedRepin);

    const persisted = (await store.load('placemakers', 'production', 'ws-pinned'))!;
    assert.equal(persisted.packVersionId, '1.0.0');
    assert.equal(persisted.pins?.packChecksum, 'checksum-v1');
    assert.equal(persisted.pins?.okfReleaseId, 'okf-v1');
  });

  await test('existing pinned workspace loads its release without consulting the active pack', async () => {
    const pinnedPack = buildCanonicalPackContent({
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      capabilities,
    });
    let pinnedLoads = 0;
    let activeLoads = 0;
    const appService: any = {
      workspaceRepo: {
        load: async () => ({
          tenantId: 'placemakers',
          environmentId: 'production',
          workspaceId: 'ws-existing',
          packVersionId: '1.0.0',
          pins: { packChecksum: 'checksum-v1', pinnedAt: new Date().toISOString() },
        }),
      },
      packRepo: {
        loadPinnedPack: async (_tenant: string, _env: string, version: string, checksum: string) => {
          pinnedLoads++;
          assert.equal(version, '1.0.0');
          assert.equal(checksum, 'checksum-v1');
          return pinnedPack;
        },
        loadActivePack: async () => {
          activeLoads++;
          throw new Error('active pointer must not be consulted');
        },
      },
    };
    const service = new RuntimeService(appService);
    service.setReleaseActivationRepositoryForTest({
      getReleaseActivation: async () => ({
        tenantId: 'placemakers',
        environmentId: 'production',
        status: 'migrated',
        approvedReleaseVersion: '2.0.0',
        approvedReleaseChecksum: 'checksum-v2',
        revision: 2,
      }),
    } as any);

    const loaded = await service.assertReleaseActivationApproved(
      'placemakers',
      'production',
      'ws-existing',
      'ws-existing'
    );
    assert.equal(loaded.manifest.version, '1.0.0');
    assert.equal(pinnedLoads, 1);
    assert.equal(activeLoads, 0);
  });

  await test('new workspace loads only the activation-approved active release', async () => {
    const activePack = buildCanonicalPackContent({
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '2.0.0',
      capabilities,
    });
    const checksum = computePackChecksum(activePack);
    let activeLoads = 0;
    const appService: any = {
      workspaceRepo: { load: async () => null },
      packRepo: {
        loadActivePack: async () => {
          activeLoads++;
          return activePack;
        },
        loadPinnedPack: async () => assert.fail('new workspace must not use a pinned release'),
      },
    };
    const service = new RuntimeService(appService);
    service.setReleaseActivationRepositoryForTest({
      getReleaseActivation: async () => ({
        tenantId: 'placemakers',
        environmentId: 'production',
        status: 'migrated',
        approvedReleaseVersion: '2.0.0',
        approvedReleaseChecksum: checksum,
        revision: 2,
      }),
    } as any);

    const loaded = await service.assertReleaseActivationApproved(
      'placemakers',
      'production',
      'ws-new',
      'ws-new'
    );
    assert.equal(loaded.manifest.version, '2.0.0');
    assert.equal(activeLoads, 1);
  });

  await test('a pinned release load failure fails closed and never falls back to active', async () => {
    let activeLoads = 0;
    const appService: any = {
      workspaceRepo: {
        load: async () => ({
          packVersionId: '1.0.0',
          pins: { packChecksum: 'withdrawn-checksum', pinnedAt: new Date().toISOString() },
        }),
      },
      packRepo: {
        loadPinnedPack: async () => { throw new Error('release is withdrawn'); },
        loadActivePack: async () => { activeLoads++; return {}; },
      },
    };
    const service = new RuntimeService(appService);
    service.setReleaseActivationRepositoryForTest({
      getReleaseActivation: async () => ({
        tenantId: 'placemakers',
        environmentId: 'production',
        status: 'migrated',
        approvedReleaseVersion: '2.0.0',
        approvedReleaseChecksum: 'checksum-v2',
        revision: 2,
      }),
    } as any);

    await assert.rejects(
      () => service.assertReleaseActivationApproved('placemakers', 'production', 'ws', 'ws'),
      /Pinned Business Pack unavailable.*withdrawn/
    );
    assert.equal(activeLoads, 0);
  });

  console.log(`\nWorkspace Pinning Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
