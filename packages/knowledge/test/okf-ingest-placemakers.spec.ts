import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import {
  OKF_LIMITS, auditProvenance, buildCoverageReport, buildServerOwnedOkfContent, buildTaxonomyDraft, computeKnowledgeChecksum,
  exportOkfBundle, hydrateOkfReleaseEnvelope, importOkfBundle, loadPinnedOkfRelease, publishOkfRelease, resolveOkfGate,
  validateOkfDraftContent, TaxonomySnapshotSchema,
} from '../src';

/**
 * Real-data proof. The inputs are committed evidence, not fixtures written for the test:
 *   docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json  (read-only capture of the live catalogue)
 *   docs/inventory/placemakers-inventory-2026-10-13.json          (independent inventory of the same snapshot day)
 *   scripts/okf/tenants/placemakers.ingest.json                              (tenant-authored ingest configuration)
 */
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const inventory = read('docs/inventory/placemakers-inventory-2026-10-13.json');
const config = read('scripts/okf/tenants/placemakers.ingest.json');

const suite = createSuite('knowledge: PlaceMakers taxonomy coverage (real snapshot)');
const generated = buildTaxonomyDraft(snapshot, config);
const report = buildCoverageReport(generated);
const AT = snapshot.snapshotAt;
const built = buildServerOwnedOkfContent(generated.draft, { tenantId: 'placemakers', environmentId: 'production', releaseId: 'cov', evaluatedAt: AT });

const gate = (message: string, extra: Record<string, unknown> = {}) => resolveOkfGate(built, {
  tenantId: 'placemakers', environmentId: 'production', releaseId: 'cov', message, ...extra,
} as any) as any;
const nameOf = (decision: any) => built.concepts.find((entry) => entry.conceptId === decision.conceptId)?.name;

async function main() {
  await suite.test('the snapshot reconciles with the independent inventory of the same day', () => {
    assert.equal(snapshot.totalProducts, inventory.catalogue.tenantTotal, 'product total');
    const parsed = TaxonomySnapshotSchema.parse(snapshot);
    assert.equal(parsed.rows.reduce((sum, row) => sum + row.productCount, 0), snapshot.totalProducts, 'rows sum to the total');
    assert.equal(new Set(parsed.rows.map((row) => row.path[0] ?? '(none)')).size, 18, 'departments incl. products without a path');
    assert.equal(snapshot.snapshotAt.slice(0, 10), '2026-10-13');
  });

  await suite.test('every department, group and category is accounted for; no product is unaccounted', () => {
    assert.equal(report.reconciliation.ok, true, report.reconciliation.note);
    assert.equal(report.totals.productsCovered + report.totals.productsExcluded, snapshot.totalProducts);
    assert.equal(report.totals.departments, 18);
    assert.equal(report.totals.leafCategories, report.totals.leafCategoriesWithOwnConcept + report.totals.leafCategoriesCoveredByAncestor);
    assert.equal(report.totals.leafCategoriesCoveredByAncestor, 0, 'nothing is left uncovered at the default threshold');
    for (const row of snapshot.rows) {
      const path = row.path.length ? row.path : row.category ? [config.unassignedDepartment, row.category] : [config.unassignedDepartment];
      const node = generated.tree.nodes.find((entry) => entry.path.join('\u0000') === path.join('\u0000'));
      assert.ok(node, `row ${JSON.stringify(path)} has a node`);
      assert.ok(generated.conceptIdByNode.get(node!), `row ${JSON.stringify(path)} has a concept`);
    }
  });

  await suite.test('the draft is internally consistent: unique ids, resolvable relationships and navigation, exact scopes', () => {
    const ids = new Set(generated.draft.concepts.map((entry: any) => entry.conceptId));
    assert.equal(ids.size, generated.draft.concepts.length);
    for (const relationship of generated.draft.relationships as any[]) assert.ok(ids.has(relationship.from) && ids.has(relationship.to), relationship.relationshipId);
    const factKeys = new Set(generated.draft.factRegistry.map((fact: any) => fact.factKey));
    for (const entry of generated.draft.concepts as any[]) {
      for (const discriminator of entry.discriminators) {
        assert.ok(factKeys.has(discriminator.factKey));
        for (const target of Object.values(discriminator.valueMap) as string[]) assert.ok(ids.has(target));
      }
      const scope = entry.searchScope;
      assert.ok(scope.catalogCategoryIds.length + (scope.catalogCategoryPaths ?? []).length >= 1, `${entry.conceptId} has an exact catalogue scope`);
    }
    // Every real catalogue path is selected by exactly its own concept and the ancestors above it.
    const scopedPaths = new Set(generated.draft.concepts.flatMap((entry: any) => (entry.searchScope.catalogCategoryPaths ?? []).map((path: string[]) => path.join('\u0000'))));
    for (const row of snapshot.rows.filter((entry: any) => entry.path.length > 0)) assert.ok(scopedPaths.has(row.path.join('\u0000')), `${row.path.join(' > ')} is selected by path`);
    // Path-less products stay reachable by their category name.
    const scopedNames = new Set(generated.draft.concepts.flatMap((entry: any) => entry.searchScope.catalogCategoryIds));
    for (const row of snapshot.rows.filter((entry: any) => entry.path.length === 0 && entry.category)) assert.ok(scopedNames.has(row.category), `${row.category} is selected by name`);
  });

  await suite.test('the draft validates, passes the server publication evaluation and fits the draft ceiling with room to spare', () => {
    assert.equal(validateOkfDraftContent(generated.draft, 'placemakers').valid, true);
    assert.equal(built.evaluation.passed, true);
    assert.ok(built.evaluation.scenarioCount > 1000, 'a scenario set proportional to the model, not a handful');
    const bytes = Buffer.byteLength(JSON.stringify(generated.draft));
    assert.ok(bytes < OKF_LIMITS.draftMaxBytes / 4, `draft is ${bytes} bytes`);
  });

  await suite.test('derived material is never presented as verified: no claims, no verifications, no evidence chunks', () => {
    const audit = auditProvenance(generated.draft, generated.config);
    assert.deepEqual(audit.violations, []);
    assert.equal(report.claims.verifiedClaims, 0);
    assert.equal(generated.draft.verifications.length, 0);
    assert.equal(generated.draft.evidenceChunks.length, 0);
    assert.ok((generated.draft.relationships as any[]).every((relationship) => relationship.claimClasses.length === 0));
    assert.ok((generated.draft.sources as any[]).every((source) => source.kind === 'crawl' || source.kind === 'catalog_feed'));
    assert.ok(Object.keys(audit.counts).every((kind) => ['catalogue_taxonomy', 'model_generated_keywords', 'crawl_document_candidate'].includes(kind)));
  });

  await suite.test('document candidates are linked from real stated SKUs, ranked, capped and flagged unverified', () => {
    assert.equal(snapshot.documentTotals.documents, 10274);
    assert.ok(snapshot.documentTotals.mappedToProduct / snapshot.documentTotals.documents > 0.95, 'nearly every PDF names a SKU that maps to a product');
    assert.ok(report.totals.documentSources > 400);
    const concepts = generated.draft.concepts as any[];
    assert.ok(concepts.every((entry) => entry.evidenceRefs.filter((ref: string) => ref.startsWith('src-doc-')).length <= config.sources.maxPerConcept));
    assert.ok(concepts.filter((entry) => entry.evidenceRefs.some((ref: string) => ref.startsWith('src-doc-'))).length > 150);
    for (const entry of concepts.filter((item) => item.extensions['x-journeyax-provenance'].evidenceRefs)) {
      assert.equal(entry.extensions['x-journeyax-provenance'].evidenceRefs.verified, false);
    }
  });

  await suite.test('generation is deterministic', () => {
    assert.equal(computeKnowledgeChecksum(buildTaxonomyDraft(snapshot, config).draft), computeKnowledgeChecksum(generated.draft));
  });

  await suite.test('customer language reaches the right part of the business', () => {
    const expectations: Array<[string, string, string]> = [
      ['tools', 'Tools', 'overview_then_ask'],
      ['power tools', 'Power Tools', 'overview_then_ask'],
      ['hammers', 'Hammers & Mallets', 'direct_results'],
      ['cordless drill', 'Drills', 'direct_results'],
      ['wood screws', 'Wood Screws', 'direct_results'],
      ['screws', 'Fastenings', 'overview_then_ask'],
      ['vanities', 'Vanities', 'direct_results'],
      ['toilet suites', 'Toilets', 'direct_results'],
      ['paint brushes', 'Brushes & Rollers', 'direct_results'],
      ['timber', 'Timber & Plywood', 'overview_then_ask'],
      ['decking', 'Decking', 'overview_then_ask'],
      ['insulation', 'Insulation', 'overview_then_ask'],
    ];
    for (const [message, concept, mode] of expectations) {
      const decision = gate(message);
      assert.equal(nameOf(decision), concept, `"${message}" → ${nameOf(decision)}`);
      assert.equal(decision.mode, mode, `"${message}" mode`);
      assert.equal(decision.retrieval.permission, 'allowed');
    }
  });

  await suite.test('broad requests ask the configured question and preview a few groups; specific ones go straight to results', () => {
    const broad = gate('tools');
    assert.equal(broad.clarification.question, 'Which type of Tools are you looking for?');
    assert.ok(broad.retrieval.groups.length > 1 && broad.retrieval.groups.length <= config.navigation.overviewGroups);
    assert.ok(broad.retrieval.groups.every((group: any) => group.maxItems === config.navigation.maxItemsPerGroup));
    assert.equal(gate('hammers').clarification, undefined);
  });

  await suite.test('hazards escalate on the real release: no products, no cart, no invented guidance', () => {
    for (const message of [
      'my heater is smoking', 'my vanity is sparking', 'there is water near the power points in my laundry',
      'i can smell gas in the kitchen', 'my hot water cylinder is leaking', 'the extension cord is sparking',
    ]) {
      const decision = gate(message);
      assert.equal(decision.mode, 'safety_then_diagnose', message);
      assert.equal(decision.retrieval.permission, 'blocked', message);
      assert.equal(decision.safety.guidanceUnavailable, true, message);
      assert.equal(decision.commerce.addToCart, 'blocked', message);
      assert.deepEqual(decision.claims.allowedClasses, [], message);
    }
  });

  await suite.test('derived concepts assert no technical, compatibility, installation, care or warranty claim', () => {
    const governed = ['compatibility', 'requirement', 'substitution', 'installation_step', 'care_safety', 'warranty', 'safety_instruction', 'legal_requirement'];
    for (const message of ['hammers', 'vanities', 'decking', 'is the decking suitable for a load bearing deck', 'how do i install a vanity']) {
      const decision = gate(message);
      assert.ok(!decision.claims.allowedClasses.some((claim: string) => governed.includes(claim)), `${message}: ${decision.claims.allowedClasses}`);
    }
  });

  await suite.test('commerce on derived concepts is exactly the merchant-configured ceiling', () => {
    assert.ok((generated.draft.concepts as any[]).every((entry) => entry.commercePolicy.addToCart === config.commerce.addToCart && entry.commercePolicy.checkout === config.commerce.checkout));
  });

  await suite.test('the bundle has a root index and an index for every department; concepts carry provenance for the reviewer', () => {
    const files = exportOkfBundle({
      releaseId: 'cov', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', checksum: computeKnowledgeChecksum(built), status: 'ready',
      content: built, publishedAt: new Date(AT), publishedBy: 'process:test',
    } as any);
    const text = (file: string) => Buffer.from(files[file]).toString('utf8');
    assert.match(text('index.md'), /okf_version: "0.2"/);
    for (const department of report.departments) {
      const slug = generated.tree.roots.find((root) => root.name === department.name)!.slug;
      assert.ok(files[`${slug}/index.md`] || files[`${slug}.md`], `${department.name} is reachable from the bundle`);
    }
    assert.ok(Object.keys(files).filter((file) => file.endsWith('/index.md')).length >= 18);
    assert.equal(importOkfBundle(files, 'placemakers').draft.concepts.length, generated.draft.concepts.length);
  });

  await suite.test('the release publishes checksum-bound and loads back verified, with tampering rejected', async () => {
    const db = new MemoryDb();
    const release = await publishOkfRelease(db as any, {
      releaseId: 'okf-placemakers-coverage-1', tenantId: 'placemakers', environmentId: 'test', version: '1.0.0', content: built, publishedBy: 'human:test',
    });
    const ref = { tenantId: 'placemakers', environmentId: 'test', releaseId: release.releaseId, version: release.version, checksum: release.checksum };
    const loaded = await loadPinnedOkfRelease(db as any, ref);
    assert.equal(loaded.release.content.concepts.length, built.concepts.length);
    assert.equal(computeKnowledgeChecksum(loaded.release.content), release.checksum.replace(/^sha256:/, ''));
    const stored = await db.collection('okf_releases').findOne({ releaseId: release.releaseId });
    assert.equal(stored.contentStorage, 'release_scoped_v1', 'metadata-only release row; no 16 MB document risk');
    assert.ok(!('content' in stored));
    const row: any = db.collection('okf_concepts').docs[0];
    row.name = 'Tampered';
    await assert.rejects(() => hydrateOkfReleaseEnvelope(db as any, stored), /integrity|checksum/i);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
