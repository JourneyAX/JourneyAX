import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { applyAuthoring, buildTaxonomyDraft, computeKnowledgeEntityHash } from '../../../packages/knowledge/src';
import { ProjectService } from '../src/project.service';
import { OkfAuthoringService } from '../src/okf-authoring.service';
import { KnowledgeInsightService } from '../src/knowledge-insight.service';
import { ProjectController } from '../src/project.controller';
import { PERMISSION_KEY } from '../src/permission.guard';

const suite = createSuite('project-service: knowledge insight (coverage, lifecycle, mapping check, live preview)');
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const authored = applyAuthoring(buildTaxonomyDraft(snapshot, read('scripts/okf/tenants/placemakers.ingest.json')), read('scripts/okf/tenants/placemakers.authoring.json'));
const catalogMapping = read('docs/migrations/placemakers-catalog-mapping.json').catalogMapping;
const TENANT = 'placemakers';
const ENV = 'test';

const pathOf = (category: string): string[] => snapshot.rows.find((row: any) => row.path.length > 0 && row.path[row.path.length - 1] === category).path;
const item = (sku: string, name: string, category: string, price: number, extra: Record<string, unknown> = {}) => ({
  projectId: TENANT, sku, name, category, categoryPath: pathOf(category), priceUSD: { min: price }, currency: 'NZD', inStock: true, ...extra,
});

function projectDoc() {
  const trigger = (id: string, label: string) => ({ id: `t-${id}`, data: { kind: 'trigger.intent', stageId: `${id}_start`, label } });
  return {
    projectId: TENANT, name: 'PlaceMakers', companyName: 'PlaceMakers', ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 }, catalogMapping,
    routingPolicy: { defaultJourneyId: 'placemakers_shop' },
    persona: { systemName: 'Agent', systemPromptOverrides: 'Help.', journeyGraph: {
      nodes: [trigger('shop', 'Shop'), { id: 'n-cat', data: { kind: 'tool.search', stageId: 'catalogue', label: 'Catalogue', capabilityId: 'catalog.search' } }, trigger('plan', 'Plan your space')],
      edges: [{ id: 'e1', source: 't-shop', target: 'n-cat' }],
    } },
  };
}

async function setup() {
  const db = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }], ['config_versions', { projectId: 1, version: 1 }]] as const) {
    await db.collection(name).createIndex(spec as any, { unique: true });
  }
  await db.collection('tenant_configs').insertOne(projectDoc());
  await db.collection('products').insertMany([
    item('1000101', 'Vanity unit 750mm', 'Vanities', 499), item('1000102', 'Wall hung vanity', 'Vanities', 399), item('1000103', 'Basin mixer', 'Tapware & Showering', 89),
    item('1000104', 'LED mirror', 'Mirrors', 129), item('1000105', 'Wood screw', 'Wood Screws', 12), item('1000106', 'Claw hammer', 'Hammers & Mallets', 25),
    item('1000107', 'Old vanity', 'Vanities', 100, { status: 'Discontinued' }),
    { projectId: TENANT, sku: '1000108', name: 'Loose tap set', category: 'Laundry Tapware & Plumbing', priceUSD: { min: 55 }, currency: 'NZD' },
    { projectId: TENANT, sku: '1000109', name: 'Mystery item', priceUSD: { min: 5 }, currency: 'NZD' },
    { projectId: 'someone-else', sku: '9000001', name: 'Foreign vanity', category: 'Vanities', categoryPath: pathOf('Vanities'), priceUSD: { min: 1 }, currency: 'NZD' },
  ]);
  const projects = new ProjectService();
  Object.assign(projects as any, {
    db, projectsCol: db.collection('tenant_configs'), membersCol: db.collection('project_members'), rulesCol: db.collection('business_rules'),
    versionsCol: db.collection('config_versions'), isConnected: true,
  });
  const authoring = new OkfAuthoringService(async () => db as any, (pid, update) => projects.updateProject(pid, update as any));
  const insight = new KnowledgeInsightService(() => db, (pid) => projects.getProject(pid), authoring);
  return { db, projects, authoring, insight };
}

async function main() {
  await suite.test('coverage: reads the live catalogue through the tenant mapping and reports department figures, never another tenant\'s', async () => {
    const { insight, authoring } = await setup();
    await authoring.saveDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: 0, content: authored.draft, updatedBy: 'process:test' });
    const coverage = await insight.coverage(TENANT, ENV);
    assert.equal(coverage.catalogue!.products, 8, 'products the shop lists: the discontinued one (hidden by the mapping) and the other tenant\'s are not counted');
    assert.equal(coverage.catalogue!.uncovered, 1, 'the product with neither a path nor a category');
    const bathrooms = coverage.departments.find((entry) => entry.name === 'Bathrooms & Plumbing')!;
    assert.equal(bathrooms.products, 4);
    assert.equal(bathrooms.productsCovered, 4);
    assert.equal(coverage.layers.authored, 18);
    assert.equal(coverage.pack, null, 'nothing is published yet, so the journeys are reported as unknown');
    assert.ok(coverage.journeys.every((entry) => entry.existsInPack === null));
    assert.equal(coverage.verification.verifiedClaims, 0);
  });

  await suite.test('coverage: journeys are checked against the pack that is actually active', async () => {
    const { insight, authoring, projects } = await setup();
    await authoring.saveDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: 0, content: authored.draft, updatedBy: 'process:test' });
    const released: any = await authoring.publishDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: 1, version: '1.0.0', publishedBy: 'human:reviewer' });
    const published: any = await projects.publishConfig(TENANT, { environmentId: ENV, publishedBy: 'human:reviewer' });
    assert.equal(published.success, true, published.message);
    const coverage = await insight.coverage(TENANT, ENV);
    assert.deepEqual(coverage.pack!.journeyIds.sort(), ['placemakers_plan_your_space', 'placemakers_shop']);
    assert.equal(coverage.journeys[0].journeyId, 'placemakers_plan_your_space');
    assert.equal(coverage.journeys[0].existsInPack, true);
    assert.ok(released.release.releaseId);
  });

  await suite.test('lifecycle: draft → released → staged → active, with the exact difference at each step and the next step to take', async () => {
    const { insight, authoring, projects } = await setup();
    assert.equal((await insight.lifecycle(TENANT, ENV)).nextStep, 'write_draft');

    const saved: any = await authoring.saveDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: 0, content: authored.draft, updatedBy: 'process:test' });
    let state = await insight.lifecycle(TENANT, ENV);
    assert.equal(state.draft!.revision, 1);
    assert.equal(state.staged, null);
    assert.equal(state.nextStep, 'publish_release');

    await authoring.publishDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
    state = await insight.lifecycle(TENANT, ENV);
    assert.equal(state.releases.length, 1);
    assert.equal(state.staged!.version, '1.0.0');
    assert.equal(state.state.draftHasChanges, false, 'the draft is exactly what was released');
    assert.equal(state.state.stagedIsLatestRelease, true);
    assert.equal(state.state.activeIsStaged, false, 'no pack carries it yet');
    assert.equal(state.changes.stagedVsActive!.concepts.total, authored.draft.concepts.length, 'activating adds every concept');
    assert.equal(state.nextStep, 'publish_pack');

    const published: any = await projects.publishConfig(TENANT, { environmentId: ENV, publishedBy: 'human:reviewer' });
    assert.equal(published.success, true, published.message);
    state = await insight.lifecycle(TENANT, ENV);
    assert.equal(state.active!.knowledge!.checksum, state.staged!.checksum);
    assert.equal(state.state.activeIsStaged, true);
    assert.equal(state.changes.stagedVsActive!.identical, true);
    assert.equal(state.active!.currency, 'NZD');
    assert.equal(state.nextStep, 'none');

    // An edit makes the draft differ from what customers are served, and names what changed.
    const edited: any = structuredClone((await authoring.getDraft(TENANT, ENV)).content);
    const target = edited.concepts.find((concept: any) => concept.name === 'Vanities');
    target.description = `${target.description} Reviewed by the merchant.`;
    target.contentHash = computeKnowledgeEntityHash({ ...target, contentHash: undefined });
    await authoring.saveDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: state.draft!.revision, content: edited, updatedBy: 'human:author' });
    state = await insight.lifecycle(TENANT, ENV);
    assert.equal(state.state.draftHasChanges, true);
    assert.deepEqual(state.changes.draftVsStaged!.concepts.changed.map((entry) => entry.name), ['Vanities']);
    assert.equal(state.changes.draftVsStaged!.concepts.total, 1);
    assert.equal(state.nextStep, 'publish_release');
    assert.equal(state.state.activeIsStaged, true, 'customers still get the released knowledge until a new one is activated');
  });

  await suite.test('mapping check: the saved mapping reads this catalogue; the platform default does not; both without writing anything', async () => {
    const { insight, db } = await setup();
    const before = JSON.stringify(db.dump('tenant_configs'));
    const saved = await insight.checkCatalogMapping(TENANT, undefined);
    assert.equal(saved.ok, true, JSON.stringify(saved.issues));
    assert.equal(saved.catalogueProducts, 9);
    assert.equal(saved.sampleSize, 9);
    assert.deepEqual(saved.currencies, { NZD: 8 }, 'the discontinued product is not quoted');
    assert.ok(saved.issues.some((entry) => entry.code === 'hierarchy_partial'));
    const standard = await insight.checkCatalogMapping(TENANT, {});
    assert.equal(standard.ok, false);
    assert.ok(standard.issues.some((entry) => entry.code === 'price_unreadable'));
    const invalid = await insight.checkCatalogMapping(TENANT, { searchPaths: ['$where'] });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.mappingErrors.length > 0);
    assert.equal(JSON.stringify(db.dump('tenant_configs')), before, 'the check writes nothing');
  });

  await suite.test('mapping check: the sample is spread across the catalogue, so a bad tail is seen, and is bounded', async () => {
    const { insight, db } = await setup();
    await db.collection('products').deleteMany({});
    const rows = [...Array(300)].map((_, index) => index < 270
      ? item(`2${String(index).padStart(6, '0')}`, `Item ${index}`, 'Vanities', 10)
      : { projectId: TENANT, sku: `2${String(index).padStart(6, '0')}`, name: `Tail ${index}`, category: 'Vanities', categoryPath: pathOf('Vanities'), currency: 'NZD' });
    await db.collection('products').insertMany(rows);
    const result = await insight.checkCatalogMapping(TENANT, undefined, { sample: 50 });
    assert.equal(result.catalogueProducts, 300);
    assert.ok(result.sampleSize <= 50);
    assert.ok(result.issues.some((entry) => entry.code === 'price_missing'), 'the unpriced tail appears in an evenly spread sample');
  });

  await suite.test('live preview: the decision plus the live products each scope selects, and nothing for a problem', async () => {
    const { insight, authoring } = await setup();
    await authoring.saveDraft({ projectId: TENANT, environmentId: ENV, expectedRevision: 0, content: authored.draft, updatedBy: 'process:test' });
    const vanities: any = await insight.previewWithCatalogue(TENANT, { message: 'vanities' }, ENV);
    assert.equal(vanities.decision.mode, 'direct_results');
    assert.equal(vanities.conceptName, 'Vanities');
    assert.equal(vanities.live.scope.products, 2, 'two sellable vanities; the discontinued and another tenant\'s are not counted');
    assert.deepEqual(vanities.live.scope.sample.map((entry: any) => entry.sku).sort(), ['1000101', '1000102']);
    assert.equal(vanities.live.scope.sample[0].currency, 'NZD');
    assert.deepEqual(vanities.live.suggestions.map((entry: any) => [entry.name, entry.products]), [['Tapware & Showering', 1], ['Mirrors', 1]]);

    const overview: any = await insight.previewWithCatalogue(TENANT, { message: 'screws' }, ENV);
    assert.equal(overview.decision.mode, 'overview_then_ask');
    assert.deepEqual(overview.live.groups.map((entry: any) => [entry.label, entry.products]), [['Wood Screws', 1], ['Metal Screws', 0], ['Masonry  Anchors', 0]]);

    const leak: any = await insight.previewWithCatalogue(TENANT, { message: 'my bathroom is leaking' }, ENV);
    assert.equal(leak.decision.mode, 'safety_then_diagnose');
    assert.equal(leak.live.scope, null);
    assert.deepEqual(leak.live.groups, []);
    assert.deepEqual(leak.live.suggestions, []);
  });

  await suite.test('the new routes are permissioned', () => {
    const proto = ProjectController.prototype as any;
    for (const [handler, permission] of [['knowledgeCoverage', 'knowledge.read'], ['knowledgeLifecycle', 'knowledge.read'], ['checkCatalogMapping', 'config.edit'], ['previewKnowledgeDraft', 'knowledge.read']] as const) {
      assert.equal(Reflect.getMetadata(PERMISSION_KEY, proto[handler]), permission, handler);
    }
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
