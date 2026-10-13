import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { ProjectService } from '../src/project.service';
import {
  buildServerOwnedOkfContent,
  publishOkfRelease,
  withKnowledgeEntityHash,
  type OkfReleaseContent,
} from '../../../packages/knowledge/src';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';

const suite = createSuite('project-service: environment-aware publication');

const TENANT = 'placemakers';

function projectDoc(extra: Record<string, unknown> = {}) {
  return {
    projectId: TENANT,
    name: 'Env Tenant',
    companyName: 'Env Tenant Ltd',
    pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
    ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    persona: {
      systemName: 'Env Agent',
      systemPromptOverrides: 'Guide customers.',
      journeyGraph: {
        nodes: [
          { id: 'n1', data: { kind: 'trigger.intent', stageId: 'intake', label: 'Intake' } },
          { id: 'n2', data: { kind: 'stage.scoping', stageId: 'recommend', label: 'Recommend', allowedCapabilities: ['catalog_search'] } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    },
    ...extra,
  };
}

async function createService(extra: Record<string, unknown> = {}) {
  const db = new MemoryDb();
  for (const [name, spec] of [
    ['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }],
    ['config_versions', { projectId: 1, version: 1 }],
  ] as const) await db.collection(name).createIndex(spec as any, { unique: true });
  await db.collection('tenant_configs').insertOne(projectDoc(extra));
  const service = new ProjectService();
  (service as any).db = db;
  (service as any).projectsCol = db.collection('tenant_configs');
  (service as any).membersCol = db.collection('project_members');
  (service as any).rulesCol = db.collection('business_rules');
  (service as any).versionsCol = db.collection('config_versions');
  (service as any).isConnected = true;
  return { service, db };
}

/** OKF release without journey references, so it validates against the minimal pack above. */
function okfContent(): OkfReleaseContent {
  const content = structuredClone(buildOkfContent());
  const { index: _index, evaluation: _evaluation, ...draft } = content;
  draft.concepts = draft.concepts.map((concept: any) => {
    const { journeyRef: _journeyRef, contentHash: _hash, ...rest } = concept;
    return withKnowledgeEntityHash(rest) as any;
  });
  // Hashes of concepts changed, so re-bind the verification records that point at them.
  const hashById = new Map(draft.concepts.map((concept: any) => [concept.conceptId, concept.contentHash]));
  draft.verifications = draft.verifications.map((record: any) =>
    record.targetType === 'concept' && hashById.has(record.targetId) ? { ...record, contentHash: hashById.get(record.targetId) } : record);
  return buildServerOwnedOkfContent(draft as any, {
    tenantId: TENANT, environmentId: 'staging', releaseId: 'r', evaluatedAt: '2026-10-10T00:00:00.000Z',
  });
}

async function main() {
  await suite.test('publishing to staging writes the staging release and pointer, never production', async () => {
    const { service, db } = await createService();
    const result: any = await service.publishConfig(TENANT, { environmentId: 'staging', publishedBy: 'tester' });
    assert.equal(result.success, true, result.message);
    assert.equal(result.environmentId, 'staging');
    const releases = db.dump('business_pack_releases');
    assert.equal(releases.length, 1);
    assert.equal(releases[0].environmentId, 'staging');
    assert.equal(releases[0].manifest.environmentId, 'staging');
    assert.ok(releases[0].capabilities.toolBindings.every((binding: any) => binding.environmentId === 'staging'));
    const pointers = db.dump('business_pack_pointers');
    assert.deepEqual(pointers.map((pointer) => pointer.environmentId), ['staging']);
  });

  await suite.test('a non-production publish never disturbs the Studio production state', async () => {
    const { service, db } = await createService({ activeVersion: 7, packVersion: '1.0.7' });
    await service.publishConfig(TENANT, { environmentId: 'staging' });
    const project = db.dump('tenant_configs')[0];
    assert.equal(project.activeVersion, 7);
    assert.equal(project.packVersion, '1.0.7');
    assert.equal(project.environmentVersions.staging.version >= 1, true);
    const snapshot = db.dump('config_versions').at(-1)!;
    assert.equal(snapshot.environmentId, 'staging');
  });

  await suite.test('production and staging keep independent pointers and versions', async () => {
    const { service, db } = await createService();
    await service.publishConfig(TENANT, { environmentId: 'staging' });
    await service.publishConfig(TENANT, { environmentId: 'production' });
    const pointers = db.dump('business_pack_pointers');
    assert.deepEqual(pointers.map((pointer) => pointer.environmentId).sort(), ['production', 'staging']);
    const project = db.dump('tenant_configs')[0];
    assert.equal(project.activeVersion, 2, 'production owns the Studio active version');
    assert.equal(project.environmentVersions.staging.version, 1);
    assert.equal(db.dump('config_versions').find((v) => v.version === 2)?.environmentId, undefined, 'production snapshots stay unlabelled');
  });

  await suite.test('an unknown environment is rejected before anything is written', async () => {
    const { service, db } = await createService();
    const result = await service.publishConfig(TENANT, { environmentId: 'qa' });
    assert.equal(result.success, false);
    assert.match(result.message || '', /Invalid environmentId/);
    assert.equal(db.dump('business_pack_releases').length, 0);
  });

  await suite.test('version history marks the active snapshot per environment', async () => {
    const { service } = await createService();
    await service.publishConfig(TENANT, { environmentId: 'staging' });
    await service.publishConfig(TENANT, { environmentId: 'production' });
    const history = await service.listVersions(TENANT);
    const byVersion = new Map(history.map((entry: any) => [entry.version, entry]));
    assert.deepEqual([byVersion.get(1)?.environmentId, byVersion.get(1)?.active], ['staging', true]);
    assert.deepEqual([byVersion.get(2)?.environmentId, byVersion.get(2)?.active], ['production', true]);
  });

  await suite.test('rollback is scoped to the environment the snapshot was published to', async () => {
    const { service, db } = await createService();
    await service.publishConfig(TENANT, { environmentId: 'staging' });
    await service.publishConfig(TENANT, { environmentId: 'staging' });
    await service.publishConfig(TENANT, { environmentId: 'production' });
    const wrongEnvironment = await service.rollbackConfig(TENANT, 3, 'tester', 'staging');
    assert.equal(wrongEnvironment.success, false);
    assert.match(wrongEnvironment.message || '', /published to 'production', not 'staging'/);
    const ok = await service.rollbackConfig(TENANT, 1, 'tester', 'staging');
    assert.equal(ok.success, true, ok.message);
    const staging = db.dump('business_pack_pointers').find((pointer) => pointer.environmentId === 'staging')!;
    const production = db.dump('business_pack_pointers').find((pointer) => pointer.environmentId === 'production')!;
    assert.equal(staging.activeVersion, db.dump('config_versions').find((v) => v.version === 1)!.packVersion);
    assert.notEqual(production.activeVersion, staging.activeVersion);
  });

  await suite.test('the OKF reference is verified in the target environment only', async () => {
    const { service, db } = await createService();
    const content = okfContent();
    const release = await publishOkfRelease(db as any, {
      releaseId: 'okf-staging-1', tenantId: TENANT, environmentId: 'staging', version: '1.0.0', content, publishedBy: 'tester',
    });
    const knowledgeModel = {
      type: 'okf_release', modelId: content.modelId, releaseId: release.releaseId, version: release.version,
      checksum: release.checksum, required: true, failurePolicy: 'fail_closed',
    };
    await db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { knowledgeModel } });

    const production = await service.publishConfig(TENANT, { environmentId: 'production' });
    assert.equal(production.success, false, 'a staging release must not satisfy a production publication');
    assert.match(production.message || '', /OKF reference integrity/);

    const staging = await service.publishConfig(TENANT, { environmentId: 'staging' });
    assert.equal(staging.success, true, staging.message);
    const stored = db.dump('business_pack_releases').find((doc) => doc.environmentId === 'staging')!;
    assert.equal(stored.knowledgeModel.releaseId, 'okf-staging-1');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
