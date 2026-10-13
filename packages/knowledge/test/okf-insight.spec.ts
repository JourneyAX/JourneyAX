import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { analyzeKnowledgeCoverage, applyAuthoring, buildTaxonomyDraft, computeKnowledgeEntityHash, diffKnowledge } from '../src';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const inventory = read('docs/inventory/placemakers-inventory-2026-10-13.json');
const authored = applyAuthoring(buildTaxonomyDraft(snapshot, read('scripts/okf/tenants/placemakers.ingest.json')), read('scripts/okf/tenants/placemakers.authoring.json'));
const content: any = authored.draft;
const catalogue = snapshot.rows.map((row: any) => ({ path: row.path, category: row.category, products: row.productCount }));

const suite = createSuite('knowledge: coverage and change insight (real PlaceMakers draft)');

async function main() {
  await suite.test('coverage reconciles with the catalogue: every product is covered except those no scope can select', () => {
    const coverage = analyzeKnowledgeCoverage(content, { journeyIds: inventory.activePack.journeys, catalogue });
    assert.equal(coverage.catalogue!.products, snapshot.totalProducts);
    assert.equal(coverage.catalogue!.covered + coverage.catalogue!.uncovered, snapshot.totalProducts);
    assert.equal(coverage.catalogue!.uncovered, 381, 'the products with neither a path nor a category');
    assert.deepEqual(coverage.catalogue!.uncoveredCategories.map((entry) => [entry.path, entry.products]), [[[], 381]]);
    assert.equal(coverage.totals.concepts, content.concepts.length);
  });

  await suite.test('departments come from the catalogue\'s own paths, with product counts and covered share', () => {
    const coverage = analyzeKnowledgeCoverage(content, { catalogue });
    const names = coverage.departments.map((entry) => entry.name);
    assert.ok(names.includes('Bathrooms & Plumbing') && names.includes('Tools'));
    const bathrooms = coverage.departments.find((entry) => entry.name === 'Bathrooms & Plumbing')!;
    assert.equal(bathrooms.products, 15256);
    assert.equal(bathrooms.productsCovered, 15256);
    assert.ok(bathrooms.concepts >= 17);
    assert.equal(coverage.departments.reduce((sum, entry) => sum + (entry.products ?? 0), 0) + 381, snapshot.totalProducts, 'department products + the unreachable 381 = the catalogue');
    assert.equal(coverage.departments[0].name, 'Bathrooms & Plumbing', 'largest department first');
  });

  await suite.test('derived and authored layers are counted apart, and the authored concepts are listed by kind', () => {
    const coverage = analyzeKnowledgeCoverage(content);
    assert.deepEqual(coverage.layers, { derived: content.concepts.length - 19, authored: 19, manual: 0 });
    assert.deepEqual(
      { families: coverage.authored.families.length, projects: coverage.authored.projects.length, problems: coverage.authored.problems.length, care: coverage.authored.care.length },
      { families: 3, projects: 8, problems: 6, care: 2 });
    assert.ok(coverage.authored.projects.some((entry) => entry.name === 'Deck build'));
  });

  await suite.test('journeys: which the knowledge hands off to, whether the pack has them, and the projects with none', () => {
    const known = analyzeKnowledgeCoverage(content, { journeyIds: inventory.activePack.journeys });
    assert.deepEqual(known.journeys.map((entry) => [entry.journeyId, entry.existsInPack, entry.concepts.map((concept) => concept.name).sort()]), [
      ['placemakers_plan_your_space', true, ['Bathroom renovation', 'Kitchen update', 'Laundry makeover']],
    ]);
    assert.deepEqual(known.projectsWithoutJourney.map((entry) => entry.name).sort(), ['Deck build', 'Fence build', 'Insulating a home', 'Painting project', 'Wet area lining']);
    assert.equal(analyzeKnowledgeCoverage(content, { journeyIds: [] }).journeys[0].existsInPack, false, 'a pack without it is flagged');
    assert.equal(analyzeKnowledgeCoverage(content).journeys[0].existsInPack, null, 'unknown when no pack was supplied');
  });

  await suite.test('verification: nothing is verified, unverified claims are counted by class, and every problem and care topic is a gap', () => {
    const { verification } = analyzeKnowledgeCoverage(content);
    assert.equal(verification.verifiedClaims, 0);
    assert.ok(verification.unverifiedClaims > 0);
    assert.equal(verification.byClaimClass.care_safety.verified, 0);
    assert.ok(verification.byClaimClass.care_safety.unverified > 0);
    assert.equal(verification.guidanceGaps.length, 8);
    assert.deepEqual([...new Set(verification.guidanceGaps.map((gap) => gap.kind))].sort(), ['care', 'problem']);
    assert.ok(verification.conceptsWithCandidateSources > 100 && verification.candidateSources > 100, 'candidate documents exist but none is verified');
  });

  await suite.test('a verified, current care claim removes that gap and counts as verified', () => {
    const edited: any = structuredClone(content);
    const care = edited.concepts.find((concept: any) => concept.lens === 'care');
    const edge = edited.relationships.find((relationship: any) => relationship.from === care.conceptId && relationship.claimClasses.includes('care_safety'));
    edited.verifications = [{
      recordId: 'v-1', targetType: 'relationship', targetId: edge.relationshipId, status: 'verified', sourceRefs: [], verifiedBy: 'human:expert',
      verifierRole: 'product_manager', verifiedAt: '2026-10-01T00:00:00.000Z', contentHash: edge.contentHash, staleAfter: '2099-01-01T00:00:00.000Z',
    }];
    const { verification } = analyzeKnowledgeCoverage(edited);
    assert.equal(verification.verifiedClaims, 1);
    assert.equal(verification.guidanceGaps.length, 7);
    assert.ok(!verification.guidanceGaps.some((gap) => gap.conceptId === care.conceptId));
    // Editing the claim afterwards makes the verification stale again.
    edge.description = 'changed'; edge.contentHash = computeKnowledgeEntityHash({ ...edge, contentHash: undefined });
    assert.equal(analyzeKnowledgeCoverage(edited).verification.verifiedClaims, 0);
  });

  await suite.test('diff: identical content is identical; edits, additions and removals are named', () => {
    assert.equal(diffKnowledge(content, content).identical, true);
    const next: any = structuredClone(content);
    const changed = next.concepts[3];
    changed.name = `${changed.name} (renamed)`; changed.contentHash = computeKnowledgeEntityHash({ ...changed, contentHash: undefined });
    const removed = next.concepts.pop();
    next.concepts.push({ ...next.concepts[0], conceptId: 'concept://placemakers/new/thing', name: 'Brand new', contentHash: 'f'.repeat(64) });
    const diff = diffKnowledge(content, next);
    assert.equal(diff.identical, false);
    assert.deepEqual(diff.concepts.changed.map((entry) => entry.conceptId), [changed.conceptId]);
    assert.deepEqual(diff.concepts.added.map((entry) => entry.name), ['Brand new']);
    assert.deepEqual(diff.concepts.removed.map((entry) => entry.conceptId), [removed.conceptId]);
    assert.equal(diff.concepts.total, 3);
    const fromNothing = diffKnowledge(null, content);
    assert.equal(fromNothing.concepts.total, content.concepts.length);
    assert.ok(fromNothing.concepts.added.length <= 20, 'lists are capped; totals are not');
  });

  await suite.test('retired concepts are not counted, and the analysis never mutates its input', () => {
    const copy: any = structuredClone(content);
    copy.concepts[0].lifecycle = { status: 'retired' };
    assert.equal(analyzeKnowledgeCoverage(copy).totals.concepts, content.concepts.length - 1);
    const before = JSON.stringify(content);
    analyzeKnowledgeCoverage(content, { catalogue, journeyIds: [] });
    diffKnowledge(content, copy);
    assert.equal(JSON.stringify(content), before);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
