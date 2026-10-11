import assert from 'node:assert/strict';
import { computePackChecksum } from '@journeyax/business-pack';
import { createSuite } from '@journeyax/test-support';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { RuntimeService } from '../src/runtime.service';
import { idleRepinHours, isIdleBeyond, packHostsWorkspace } from '../src/kernel/pin-lifecycle';
import { buildCanonicalPackContent } from './fixtures/canonical-release.fixture';

const suite = createSuite('runtime: workspace pin lifecycle');
const capabilities = { toolDefinitions: [], toolBindings: [], stageBindings: [] };
const HOUR = 3_600_000;

const pack = (version: string, extensions?: Record<string, unknown>, stageIds?: string[]) => {
  const content = buildCanonicalPackContent({ tenantId: 'placemakers', environmentId: 'production', version, capabilities, ...(stageIds ? { stageIds } : {}) });
  if (extensions) content.extensions = { ...(content.extensions || {}), ...extensions };
  return content;
};

function gate(workspace: any, pinned: any, active: any) {
  const service = new RuntimeService({
    workspaceRepo: { load: async () => workspace },
    packRepo: { loadPinnedPack: async () => pinned, loadActivePack: async () => active },
  } as any);
  service.setReleaseActivationRepositoryForTest({
    getReleaseActivation: async () => ({
      tenantId: 'placemakers', environmentId: 'production', status: 'migrated',
      approvedReleaseVersion: active.manifest.version, approvedReleaseChecksum: computePackChecksum(active), revision: 1,
    }),
  } as any);
  return service.assertReleaseActivationApproved('placemakers', 'production', 'ws', 'ws');
}

const workspaceIdleFor = (hours: number, overrides: Record<string, unknown> = {}) => ({
  tenantId: 'placemakers', environmentId: 'production', workspaceId: 'ws', packVersionId: '1.0.0',
  journeyId: 'journey_outbox_fixture', currentStage: 'stage_sync', status: 'active',
  pins: { packChecksum: 'old', pinnedAt: new Date().toISOString() },
  updatedAt: new Date(Date.now() - hours * HOUR).toISOString(), ...overrides,
});

async function main() {
  await suite.test('idle policy is opt-in and read from the pinned pack', () => {
    assert.equal(idleRepinHours(pack('1.0.0')), undefined);
    assert.equal(idleRepinHours(pack('1.0.0', { workspacePinPolicy: { idleRepinAfterHours: 24 } })), 24);
    assert.equal(idleRepinHours(pack('1.0.0', { workspacePinPolicy: { idleRepinAfterHours: -1 } })), undefined);
    assert.equal(isIdleBeyond({ updatedAt: new Date(Date.now() - 25 * HOUR) }, 24), true);
    assert.equal(isIdleBeyond({ updatedAt: new Date(Date.now() - 1 * HOUR) }, 24), false);
  });

  await suite.test('a pack hosts a workspace only if it still has the journey and current stage', () => {
    const host = pack('2.0.0');
    assert.equal(packHostsWorkspace(host, { journeyId: 'journey_outbox_fixture', currentStage: 'stage_test' }), true);
    assert.equal(packHostsWorkspace(host, { journeyId: 'journey_outbox_fixture', currentStage: 'stage_gone' }), false);
    assert.equal(packHostsWorkspace(host, { journeyId: 'other', currentStage: 'stage_sync' }), false);
  });

  await suite.test('without a policy the pinned release is kept however long the workspace idles', async () => {
    const loaded = await gate(workspaceIdleFor(500), pack('1.0.0'), pack('2.0.0'));
    assert.equal(loaded.manifest.version, '1.0.0');
  });

  await suite.test('a recently active workspace stays on its pinned release', async () => {
    const policy = { workspacePinPolicy: { idleRepinAfterHours: 24 } };
    const loaded = await gate(workspaceIdleFor(1), pack('1.0.0', policy), pack('2.0.0'));
    assert.equal(loaded.manifest.version, '1.0.0');
  });

  await suite.test('an idle workspace moves to the active release when it can host the conversation', async () => {
    const policy = { workspacePinPolicy: { idleRepinAfterHours: 24 } };
    const loaded = await gate(workspaceIdleFor(48), pack('1.0.0', policy), pack('2.0.0'));
    assert.equal(loaded.manifest.version, '2.0.0');
  });

  await suite.test('an idle workspace stays pinned when the active release lacks its stage', async () => {
    const policy = { workspacePinPolicy: { idleRepinAfterHours: 24 } };
    const loaded = await gate(workspaceIdleFor(48), pack('1.0.0', policy), pack('2.0.0', undefined, ['stage_other']));
    assert.equal(loaded.manifest.version, '1.0.0');
  });

  await suite.test('completed workspaces are never re-pinned', async () => {
    const policy = { workspacePinPolicy: { idleRepinAfterHours: 24 } };
    const loaded = await gate(workspaceIdleFor(48, { status: 'completed' }), pack('1.0.0', policy), pack('2.0.0'));
    assert.equal(loaded.manifest.version, '1.0.0');
  });

  await suite.test('the store updates knowledgeEvaluatedAt but keeps every other pin write-once', async () => {
    const store = new WorkspaceStore({ forceInMemory: true });
    const initial = store.createInitial({
      tenantId: 'placemakers', environmentId: 'production', workspaceId: 'ws-e', packVersionId: '1.0.0',
      pins: { packChecksum: 'c1', okfReleaseId: 'r1', pinnedAt: '2026-10-01T00:00:00.000Z', knowledgeEvaluatedAt: '2026-10-01T00:00:00.000Z' },
      journeyId: 'j', initialStage: 's', goal: 'g',
    });
    await store.commit(initial);
    const next = (await store.load('placemakers', 'production', 'ws-e'))!;
    next.pins = { ...next.pins!, packChecksum: 'tampered', knowledgeEvaluatedAt: '2026-10-11T00:00:00.000Z' };
    await store.commit(next);
    const persisted = (await store.load('placemakers', 'production', 'ws-e'))!;
    assert.equal(persisted.pins?.packChecksum, 'c1');
    assert.equal(persisted.pins?.knowledgeEvaluatedAt, '2026-10-11T00:00:00.000Z');
  });

  await suite.test('an explicit rebound persists new pins once and the flag is not stored', async () => {
    const store = new WorkspaceStore({ forceInMemory: true });
    const initial = store.createInitial({
      tenantId: 'placemakers', environmentId: 'production', workspaceId: 'ws-r', packVersionId: '1.0.0',
      pins: { packChecksum: 'c1', pinnedAt: '2026-10-01T00:00:00.000Z' }, journeyId: 'j', initialStage: 's', goal: 'g',
    });
    await store.commit(initial);
    const loaded = (await store.load('placemakers', 'production', 'ws-r'))!;
    loaded.pins = { packChecksum: 'c2', pinnedAt: '2026-10-11T00:00:00.000Z', repinnedAt: '2026-10-11T00:00:00.000Z' };
    loaded.packVersionId = '2.0.0';
    loaded.pinsRebound = true;
    await store.commit(loaded);
    const persisted = (await store.load('placemakers', 'production', 'ws-r'))!;
    assert.equal(persisted.pins?.packChecksum, 'c2');
    assert.equal(persisted.packVersionId, '2.0.0');
    assert.equal(persisted.pinsRebound, undefined);
  });
}

main().then(() => { suite.finish(); }).catch((e) => { console.error(e); process.exitCode = 1; });
