import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { applyAuthoring, buildTaxonomyDraft, computeKnowledgeEntityHash, hydrateOkfReleaseEnvelope } from '../../../packages/knowledge/src';
import { FactRegistrySchema } from '@journeyax/business-pack';
import { OkfAuthoringService } from '../src/okf-authoring.service';

const suite = createSuite('project-service: generated PlaceMakers coverage draft');
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const generated = buildTaxonomyDraft(read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json'), read('scripts/okf/tenants/placemakers.ingest.json'));
const authored = applyAuthoring(generated, read('scripts/okf/tenants/placemakers.authoring.json'));

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

  await suite.test('the list for a person is what they can act on, and outstanding checks never make a release "not ready"', async () => {
    const { service } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: authored.draft, updatedBy: 'process:okf-authoring' });
    assert.equal(saved.validation.valid, true);
    const before = await service.analyzeDraft('placemakers', 'test');
    const relationships = new Map(saved.content.relationships.map((entry: any) => [entry.relationshipId, entry]));
    const listed = before.staleness.filter((entry) => entry.targetType === 'relationship').map((entry) => relationships.get(entry.targetId) as any);
    assert.ok(listed.length > 0 && listed.every((entry) => entry.claimClasses.length > 0), 'a relationship is listed only if it carries a claim');
    assert.ok(before.staleness.length < (saved.content.concepts.length + saved.content.relationships.length) / 2, `${before.staleness.length} listed`);
    assert.ok(before.staleness.some((entry) => entry.targetId.includes('/problems/')), 'a problem needs a person');
    const check = before.checks.find((entry) => entry.id === 'verifications_current')!;
    assert.equal(check.ok, false);
    assert.equal(check.advisory, true);
    assert.equal(before.ready, false, 'not ready yet: nothing is published');
    await service.publishDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
    const after = await service.analyzeDraft('placemakers', 'test');
    assert.equal(after.checks.find((entry) => entry.id === 'verifications_current')?.ok, false, 'the advice is still waiting for a person');
    assert.equal(after.ready, true, 'but the release is ready: its unconfirmed advice is withheld');
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
  await suite.test('the authored layer saves and publishes through the same path and carries fact semantics to the pack', async () => {
    assert.deepEqual(authored.errors, []);
    const { service, db, attached } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: authored.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues.slice(0, 3)));
    assert.equal(saved.content.verifications.length, 0);
    for (const entry of saved.content.concepts) assert.equal(entry.contentHash, computeKnowledgeEntityHash(entry), `${entry.conceptId} keeps its hash`);
    const result: any = await service.publishDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
    assert.equal(result.release.status, 'ready');
    const release = await hydrateOkfReleaseEnvelope(db as any, await db.collection('okf_releases').findOne({ releaseId: result.release.releaseId }));
    assert.equal(release.content.evaluation.passed, true);
    assert.equal(attached[0].knowledgeModel.checksum, result.release.checksum);
    // Regression: the attached registry must be a valid Business Pack fact registry (each fact carries its own key),
    // otherwise no pack that references an OKF release could ever be published.
    const parsed = FactRegistrySchema.parse(attached[0].factRegistry);
    for (const [factKey, fact] of Object.entries(parsed.facts ?? {})) assert.equal(fact.key, factKey);
    const facts = attached[0].factRegistry.facts;
    for (const key of ['room_dimensions', 'deck_size', 'fence_length']) assert.equal(facts[key].role, 'measurement', `${key} is a measurement`);
    for (const key of ['bathroom_features', 'laundry_features', 'kitchen_features']) assert.equal(facts[key].multiple, true, `${key} holds several values`);
    assert.equal(facts.deck_material.role, undefined, 'a plain choice fact carries no role');
  });

  await suite.test('editing an authored concept afterwards is a visible edit and the rest keeps its hashes', async () => {
    const { service } = setup();
    const saved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: 0, content: authored.draft, updatedBy: 'process:okf-taxonomy-ingest' });
    const index = saved.content.concepts.findIndex((entry: any) => entry.name === 'Deck build');
    assert.ok(index >= 0);
    const edited = structuredClone(saved.content);
    edited.concepts[index].description = `${edited.concepts[index].description} Reviewed.`;
    const resaved = await service.saveDraft({ projectId: 'placemakers', environmentId: 'test', expectedRevision: saved.revision, content: edited, updatedBy: 'human:author' });
    assert.notEqual(resaved.content.concepts[index].contentHash, saved.content.concepts[index].contentHash);
    assert.equal(resaved.content.concepts[(index + 1) % saved.content.concepts.length].contentHash, saved.content.concepts[(index + 1) % saved.content.concepts.length].contentHash);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
