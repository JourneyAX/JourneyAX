import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { buildTaxonomyDraft, computeKnowledgeEntityHash, hydrateOkfReleaseEnvelope } from '../../../packages/knowledge/src';
import { OkfAuthoringService } from '../src/okf-authoring.service';

const suite = createSuite('project-service: generated PlaceMakers coverage draft');
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const generated = buildTaxonomyDraft(read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json'), read('scripts/okf/tenants/placemakers.ingest.json'));

function setup() {
  const db = new MemoryDb();
  const attached: any[] = [];
  const service = new OkfAuthoringService(async () => db as any, async (_projectId, update) => { attached.push(update); return { success: true }; });
  return { db, attached, service };
}

async function main() {
  await suite.test('the full generated draft saves through the authoring service and stays valid', async () => {
    const { service } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: generated.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues.slice(0, 3)));
    assert.equal(saved.content.concepts.length, generated.draft.concepts.length);
    assert.equal(saved.content.verifications.length, 0);
  });

  await suite.test('server-side hashing agrees with the generator, so nothing looks edited after a save', async () => {
    const { service } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: generated.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    for (const entry of saved.content.concepts) assert.equal(entry.contentHash, computeKnowledgeEntityHash(entry));
    const analysis = await service.analyzeDraft('placemakers', 'test');
    assert.ok(!analysis.staleness.some((item) => item.reason === 'edited_since_verification'));
    assert.equal(analysis.checks.find((check) => check.id === 'draft_valid')?.ok, true);
  });

  await suite.test('it publishes as an immutable release and attaches all navigation facts to the project', async () => {
    const { service, db, attached } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: generated.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    const result: any = await service.publishDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
    assert.equal(result.release.status, 'ready');
    const stored = await db.collection('okf_releases').findOne({ releaseId: result.release.releaseId });
    const release = await hydrateOkfReleaseEnvelope(db as any, stored);
    assert.equal(release.content.evaluation.passed, true);
    assert.equal(Object.keys(attached[0].factRegistry.facts).length, generated.draft.factRegistry.length);
    assert.equal(attached[0].knowledgeModel.checksum, result.release.checksum);
  });

  await suite.test('a hand edit to one concept is visible as an edit, not silently accepted', async () => {
    const { service } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: generated.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    const edited = structuredClone(saved.content);
    edited.concepts[0].name = `${edited.concepts[0].name} (edited)`;
    const resaved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: saved.revision, content: edited, updatedBy: 'human:author' });
    assert.notEqual(resaved.content.concepts[0].contentHash, saved.content.concepts[0].contentHash);
    assert.equal(resaved.content.concepts[1].contentHash, saved.content.concepts[1].contentHash, 'other concepts are untouched');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
