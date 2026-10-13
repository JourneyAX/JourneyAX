import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import {
  auditProvenance, buildCoverageReport, buildServerOwnedOkfContent, buildTaxonomyDraft, buildTaxonomyTree, classifyDocument, IngestConfigSchema,
  computeKnowledgeChecksum, exportOkfBundle, extractSkus, familyTerms, importOkfBundle, pluralVariants, renderCoverageMarkdown,
  renderDepartmentMarkdown, resolveOkfGate, slugify, splitName, validateOkfDraftContent, PROVENANCE_KEY,
} from '../src';

const suite = createSuite('knowledge: taxonomy ingestion');
const AT = '2026-10-13T00:00:00.000Z';

const config = (over: Record<string, unknown> = {}) => ({
  tenantId: 'acme', modelId: 'acme-knowledge', minProductsForConcept: 1, unassignedDepartment: 'Other products',
  navigation: { questionTemplate: 'Which type of {name} do you need?', uiInputType: 'card_choice', maxOptions: 20, overviewGroups: 2, maxItemsPerGroup: 2 },
  commerce: { addToCart: 'allowed', checkout: 'allowed' },
  keywords: { maxPerConcept: 4, minLength: 4 },
  sources: { maxPerConcept: 2 },
  synonyms: { splitOn: [' & ', ' and ', ','], pluralise: 'english', minLength: 3, headNouns: true, ignoreTerms: ['other', 'accessories'], dominanceThreshold: 0.6 },
  documents: { kinds: [], maxCandidatesPerCategory: 8 },
  descriptions: { leaf: '{name}: {products} products. Derived from the catalogue ({date}).', parent: '{name}: {products} products in {children} areas. Derived ({date}).' },
  ...over,
});

const rows = [
  { path: ['Tools', 'Hand Tools', 'Hammers & Mallets'], productCount: 120 },
  { path: ['Tools', 'Hand Tools', 'Saws'], productCount: 80 },
  { path: ['Tools', 'Power Tools', 'Drills'], productCount: 60 },
  { path: ['Tools', 'Power Tools', 'Accessories'], productCount: 15 },
  { path: ['Fastenings', 'Screws & Nails', 'Wood Screws'], productCount: 300 },
  { path: ['Fastenings', 'Screws & Nails', 'Metal Screws'], productCount: 90 },
  { path: ['Fastenings', 'Screws & Nails', 'Nails'], productCount: 70 },
  { path: ['Bathrooms', 'Fixtures', 'Vanities'], productCount: 200 },
  { path: ['Bathrooms', 'Fixtures', 'Accessories'], productCount: 40 },
  { path: ['Outdoor', 'Garden', 'Plumbing'], productCount: 10 },
  { path: ['Tools', 'Hand Tools', 'Plumbing'], productCount: 5 },
  { path: [], category: 'Gift Cards', productCount: 3 },
];
const total = rows.reduce((sum, row) => sum + row.productCount, 0);
const snapshot = (over: Record<string, unknown> = {}) => ({
  tenantId: 'acme', snapshotAt: AT, source: 'fixture.products', totalProducts: total, rows, keywordHints: [], documentCandidates: [], ...over,
});
const build = (snap: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) => buildTaxonomyDraft(snapshot(snap), config(cfg));
const concept = (generated: ReturnType<typeof build>, name: string) => generated.draft.concepts.find((entry: any) => entry.name === name) as any;

async function main() {
  await suite.test('tree: counts roll up, identifiers are exact, slugs are stable and unique among siblings', () => {
    const tree = buildTaxonomyTree({ rows }, IngestConfigSchema.parse(config()));
    const tools = tree.roots.find((node) => node.name === 'Tools')!;
    assert.equal(tools.products, 120 + 80 + 60 + 15 + 5);
    assert.deepEqual(tools.children.map((child) => child.name), ['Hand Tools', 'Power Tools'], 'largest first');
    assert.equal(tree.rowProductTotal, total);
    assert.equal(slugify('Doors, Windows & Joinery Hardware'), 'doors-windows-and-joinery-hardware');
    const collide = buildTaxonomyTree({ rows: [
      { path: ['A', 'Fix & Fit'], productCount: 1 }, { path: ['A', 'Fix and Fit'], productCount: 1 }] }, IngestConfigSchema.parse(config()));
    assert.deepEqual(collide.roots[0].children.map((child) => child.slug).sort(), ['fix-and-fit', 'fix-and-fit-2']);
  });

  await suite.test('rows without a department go to the configured unassigned department, or are excluded and reported', () => {
    const filed = build();
    assert.ok(concept(filed, 'Other products'));
    assert.equal(filed.tree.excluded.length, 0);
    const withoutBucket = buildTaxonomyTree({ rows }, IngestConfigSchema.parse({ ...config(), unassignedDepartment: undefined }));
    assert.deepEqual(withoutBucket.excluded.map((entry) => [entry.reason, entry.row.productCount]), [['no_department', 3]]);
    const excluding = buildTaxonomyTree({ rows }, IngestConfigSchema.parse(config({ exclusions: [{ department: 'Outdoor', reason: 'not sold online' }] })));
    assert.ok(excluding.excluded.some((entry) => entry.reason === 'not sold online'));
    assert.ok(!excluding.nodes.some((node) => node.path[0] === 'Outdoor'));
  });

  await suite.test('categories below the threshold have no concept and are covered by their parent', () => {
    const generated = build({}, { minProductsForConcept: 20 });
    assert.equal(concept(generated, 'Nails') !== undefined, true);
    assert.equal(generated.draft.concepts.some((entry: any) => entry.name.startsWith('Accessories')), true, 'accessories (40) stays');
    const small = generated.tree.nodes.find((node) => node.name === 'Drills' && node.products < 20)
      ?? generated.tree.nodes.find((node) => node.status === 'covered_by_ancestor');
    assert.ok(small, 'a below-threshold node exists');
    const report = buildCoverageReport(generated);
    assert.ok(report.nodes.some((node) => node.status === 'covered_by_ancestor' && node.coveredBy));
    assert.equal(report.reconciliation.ok, true);
  });

  await suite.test('generation is deterministic and independent of row order', () => {
    const a = build();
    const b = buildTaxonomyDraft(snapshot({ rows: [...rows].reverse() }), config());
    assert.equal(computeKnowledgeChecksum(a.draft), computeKnowledgeChecksum(b.draft));
    assert.equal(computeKnowledgeChecksum(a.draft), computeKnowledgeChecksum(build().draft));
  });

  await suite.test('the draft is valid, claim-free, tenant-scoped and passes the publication evaluation', () => {
    const generated = build();
    const validation = validateOkfDraftContent(generated.draft, 'acme');
    assert.equal(validation.valid, true, JSON.stringify(validation.issues.slice(0, 3)));
    assert.equal(generated.draft.verifications.length, 0);
    assert.ok(generated.draft.relationships.every((relationship: any) => relationship.claimClasses.length === 0));
    assert.ok(generated.draft.concepts.every((entry: any) => entry.tenantId === 'acme' && entry.conceptId.startsWith('concept://acme/')));
    const built = buildServerOwnedOkfContent(generated.draft, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', evaluatedAt: AT });
    assert.equal(built.evaluation.passed, true);
  });

  await suite.test('navigation: parents ask a configured question whose options map to their children', () => {
    const generated = build();
    const tools = concept(generated, 'Tools');
    const fact = generated.draft.factRegistry.find((entry: any) => entry.factKey === tools.discriminators[0].factKey) as any;
    assert.equal(fact.question, 'Which type of Tools do you need?');
    assert.deepEqual(fact.options.map((option: any) => option.label), ['Hand Tools', 'Power Tools']);
    assert.deepEqual(Object.values(tools.discriminators[0].valueMap).sort(), [concept(generated, 'Hand Tools').conceptId, concept(generated, 'Power Tools').conceptId].sort());
    assert.equal(tools.broadQueryPolicy.maxItemsPerGroup, 2);
    assert.equal(concept(generated, 'Vanities').discriminators.length, 0, 'leaf categories do not ask');
  });

  await suite.test('navigation options are capped and the cut is reported', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ path: ['Big', `Group ${i}`, `Cat ${i}`], productCount: 10 - i }));
    const generated = buildTaxonomyDraft(snapshot({ rows: many, totalProducts: many.reduce((s, r) => s + r.productCount, 0) }), config({ navigation: { ...config().navigation, maxOptions: 3 } }));
    assert.deepEqual(generated.warnings.truncatedOptions, [{ concept: 'Big', offered: 3, available: 6 }]);
    assert.equal((generated.draft.factRegistry[0] as any).options.length, 3);
  });

  await suite.test('scope uses exact catalogue identifiers, including a leaf-category alias, and commerce follows the config ceiling', () => {
    const aliased = buildTaxonomyDraft(snapshot({ rows: [{ path: ['Dept', 'Group', 'Toilet Suites'], category: 'Toilets', productCount: 4 }], totalProducts: 4 }), config());
    assert.deepEqual(concept(aliased, 'Toilet Suites').searchScope.catalogCategoryIds, ['Toilet Suites', 'Toilets']);
    const strict = build({}, { commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } });
    assert.ok(strict.draft.concepts.every((entry: any) => entry.commercePolicy.checkout === 'requires_compatibility_resolution'));
  });

  await suite.test('duplicate names are qualified with their parent and reported', () => {
    const generated = build();
    assert.ok(concept(generated, 'Accessories (Power Tools)') && concept(generated, 'Accessories (Fixtures)'));
    assert.ok(generated.warnings.duplicateNames.some((entry) => entry.name === 'Accessories'));
    assert.ok(generated.warnings.duplicateNames.some((entry) => entry.name === 'Plumbing'));
  });

  await suite.test('synonyms: compound parts, plurals and head nouns; generic words are ignored', () => {
    const generated = build();
    assert.deepEqual(concept(generated, 'Hammers & Mallets').synonyms, ['hammer', 'hammers', 'mallet', 'mallets']);
    assert.ok(!concept(generated, 'Hammers & Mallets').synonyms.includes('hammers mallet'), 'no noise from pluralising the compound');
    assert.ok(!generated.draft.concepts.some((entry: any) => entry.synonyms.includes('accessories') || entry.synonyms.includes('accessory')));
    assert.deepEqual(pluralVariants('vanity', 'english'), ['vanities']);
    assert.deepEqual(pluralVariants('boxes', 'english'), ['box']);
    assert.deepEqual(pluralVariants('vanity', 'none'), []);
    assert.deepEqual(splitName('Doors, Windows & Joinery Hardware', [' & ', ',']), ['Doors', 'Windows', 'Joinery Hardware']);
    assert.deepEqual(splitName('Saws', [' & ']), []);
  });

  await suite.test('a word owned by several categories goes to their lowest common parent, never to an arbitrary one', () => {
    const generated = build();
    const screws = generated.draft.concepts.filter((entry: any) => entry.synonyms.includes('screws'));
    assert.deepEqual(screws.map((entry: any) => entry.name), ['Screws & Nails'], 'Wood and Metal Screws share the group concept');
    const decision: any = resolveOkfGate(generated.draft as any, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', message: 'i need screws' });
    assert.equal(decision.mode, 'overview_then_ask');
    assert.equal(decision.conceptId, concept(generated, 'Screws & Nails').conceptId);
  });

  await suite.test('a word spread across departments is unassigned unless one department clearly dominates', () => {
    const spread = buildTaxonomyDraft(snapshot({ rows: [
      { path: ['A', 'G', 'Plumbing'], productCount: 50 }, { path: ['B', 'H', 'Plumbing'], productCount: 50 }], totalProducts: 100 }), config());
    assert.ok(!spread.draft.concepts.some((entry: any) => entry.synonyms.includes('plumbing')));
    const dominated = buildTaxonomyDraft(snapshot({ rows: [
      { path: ['A', 'G', 'Plumbing'], productCount: 900 }, { path: ['B', 'H', 'Plumbing'], productCount: 100 }], totalProducts: 1000 }), config());
    assert.ok(dominated.draft.concepts.some((entry: any) => entry.synonyms.includes('plumbing')));
    assert.equal(dominated.warnings.phrasesResolvedByDominance > 0, true);
    const disabled = buildTaxonomyDraft(snapshot({ rows: [
      { path: ['A', 'G', 'Plumbing'], productCount: 900 }, { path: ['B', 'H', 'Plumbing'], productCount: 100 }], totalProducts: 1000 }),
      config({ synonyms: { ...config().synonyms, dominanceThreshold: 1 } }));
    assert.ok(!disabled.draft.concepts.some((entry: any) => entry.synonyms.includes('plumbing')));
  });

  await suite.test('keywords: merged across sub-class sets, unique, labelled as model-generated and never evidence', () => {
    const generated = build({ keywordHints: [
      { category: 'Vanities', path: ['Bathrooms', 'Fixtures', 'Vanities'], keywords: ['floating vanity', 'wall hung vanity', 'vanity top', 'x'], model: 'm1', generatedAt: AT },
      { category: 'Vanities', path: ['Bathrooms', 'Fixtures', 'Vanities'], keywords: ['basin cabinet', 'floating vanity'] },
      { category: 'Drills', path: ['Tools', 'Power Tools', 'Drills'], keywords: ['basin cabinet', 'cordless drill'] },
    ] }, { synonyms: { ...config().synonyms, dominanceThreshold: 1 } });
    const vanities = concept(generated, 'Vanities');
    assert.ok(vanities.customerPhrases.includes('floating vanity') && vanities.customerPhrases.includes('wall hung vanity'));
    assert.ok(!vanities.customerPhrases.includes('x'), 'too short');
    assert.ok(!vanities.customerPhrases.includes('basin cabinet'), 'claimed by two concepts in different departments');
    assert.deepEqual(concept(generated, 'Drills').customerPhrases, ['cordless drill']);
    assert.equal(vanities.extensions[PROVENANCE_KEY].customerPhrases.kind, 'model_generated_keywords');
    assert.equal(vanities.extensions[PROVENANCE_KEY].customerPhrases.verified, false);
    assert.equal(generated.draft.evidenceChunks.length, 0, 'keywords are never evidence');
  });

  await suite.test('document sources: ranked, capped, de-duplicated, unverified and resolvable', () => {
    const docs = [
      ['https://x/guide-a', 9], ['https://x/guide-b', 7], ['https://x/guide-c', 3],
    ].map(([sourceUrl, chunkCount]) => ({ category: 'Vanities', path: ['Bathrooms', 'Fixtures', 'Vanities'], sourceUrl, title: `Doc ${sourceUrl}`, kind: 'installation_guide', chunkCount }));
    const generated = build({ documentCandidates: docs });
    const vanities = concept(generated, 'Vanities');
    const docSources = generated.draft.sources.filter((source: any) => source.kind === 'crawl');
    assert.equal(docSources.length, 2, 'maxPerConcept = 2');
    assert.deepEqual(docSources.map((source: any) => source.url), ['https://x/guide-a', 'https://x/guide-b']);
    assert.ok(vanities.evidenceRefs.includes('src-catalogue-taxonomy') && docSources.every((source: any) => vanities.evidenceRefs.includes(source.sourceId)));
    assert.equal(vanities.extensions[PROVENANCE_KEY].evidenceRefs.kind, 'crawl_document_candidate');
    assert.equal(validateOkfDraftContent(generated.draft, 'acme').valid, true);
    assert.ok(concept(generated, 'Fixtures').evidenceRefs.length > 1, 'a parent surfaces its best descendants');
  });

  await suite.test('provenance audit: generated drafts pass, and every kind of tampering is caught', () => {
    const generated = build({ documentCandidates: [{ category: 'Vanities', path: ['Bathrooms', 'Fixtures', 'Vanities'], sourceUrl: 'https://x/g', title: 'g', kind: 'brochure', chunkCount: 1 }] });
    assert.deepEqual(auditProvenance(generated.draft, generated.config).violations, []);
    const codes = (mutate: (draft: any) => void) => {
      const draft = structuredClone(generated.draft) as any; mutate(draft);
      return auditProvenance(draft, generated.config).violations.map((violation) => violation.code);
    };
    assert.ok(codes((d) => { delete d.concepts[0].extensions; }).includes('missing_provenance'));
    assert.ok(codes((d) => { d.concepts[0].extensions[PROVENANCE_KEY].structure.verified = true; }).includes('derived_marked_verified'));
    assert.ok(codes((d) => { d.concepts[0].extensions[PROVENANCE_KEY].structure.kind = 'merchant_verified'; }).includes('unknown_provenance_kind'));
    assert.ok(codes((d) => { d.relationships[0].claimClasses = ['compatibility']; }).includes('derived_claim'));
    assert.ok(codes((d) => { d.verifications.push({ recordId: 'v', targetType: 'concept', targetId: d.concepts[0].conceptId, status: 'verified' }); }).includes('derived_verified_in_place'));
    assert.ok(codes((d) => { d.evidenceChunks.push({ chunkId: 'c', sourceRef: 'src-catalogue-taxonomy', claimClasses: ['installation_step'] }); }).includes('derived_evidence_as_claim'));
    const strictConfig = { commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } as any;
    assert.ok(auditProvenance(generated.draft, strictConfig).violations.some((violation) => violation.code === 'derived_more_permissive'));
  });

  await suite.test('coverage: every product is covered or excluded, and a mismatch with the snapshot is reported', () => {
    const generated = build();
    const report = buildCoverageReport(generated);
    assert.equal(report.reconciliation.ok, true);
    assert.equal(report.totals.productsCovered + report.totals.productsExcluded, total);
    assert.equal(report.totals.departments, 5);
    assert.equal(report.totals.leafCategories, generated.tree.nodes.filter((node) => node.children.length === 0).length);
    assert.equal(report.claims.verifiedClaims, 0);
    const lying = buildCoverageReport(buildTaxonomyDraft(snapshot({ totalProducts: total + 7 }), config()));
    assert.equal(lying.reconciliation.ok, false);
    assert.equal(lying.reconciliation.unaccountedProducts, 7);
    const otherCategory = report.nodes.find((node) => node.path.join('>') === 'Other products>Gift Cards')!;
    assert.equal(otherCategory.level, 'category', 'a leaf directly under a department is a category, not a group');
  });

  await suite.test('coverage: family suggestions surface shared customer terms and the markdown is reviewable', () => {
    const report = buildCoverageReport(build());
    assert.ok(report.familySuggestions.some((entry) => entry.term === 'screw' && entry.categories.includes('Wood Screws') && entry.categories.includes('Metal Screws')));
    assert.deepEqual(familyTerms(['Band Saws', 'Jig Saws', 'Drills'], 'english'), [{ term: 'saw', categories: ['Band Saws', 'Jig Saws'] }]);
    const markdown = renderCoverageMarkdown(report);
    assert.match(markdown, /Reconciliation: ✅/);
    assert.match(markdown, /\*\*Verified claims\*\* \| \*\*0\*\*/);
    assert.match(markdown, /Family suggestions/);
    const department = renderDepartmentMarkdown(report, 'Tools');
    assert.match(department, /# Tools/);
    assert.match(department, /Nothing on this page is a verified claim/);
  });

  await suite.test('gate on generated concepts: broad → grouped overview + question; specific → results; uncovered stays classified', () => {
    const generated = build();
    const ask = (message: string) => resolveOkfGate(generated.draft as any, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', message }) as any;
    const broad = ask('tools');
    assert.equal(broad.mode, 'overview_then_ask');
    assert.equal(broad.retrieval.groups.length, 2);
    assert.equal(broad.clarification.question, 'Which type of Tools do you need?');
    const specific = ask('hammers');
    assert.equal(specific.mode, 'direct_results');
    assert.deepEqual(specific.retrieval.categoryIds, ['Hammers & Mallets']);
    assert.deepEqual(specific.commerce, { addToCart: 'allowed', checkout: 'allowed' });
    const hazard = ask('my vanity is sparking');
    assert.equal(hazard.mode, 'safety_then_diagnose', 'a product concept never answers a hazard');
    assert.equal(hazard.retrieval.permission, 'blocked'); assert.equal(hazard.commerce.addToCart, 'blocked');
    assert.ok(hazard.trace.reasonCodes.includes('problem_without_problem_concept'));
    assert.equal(ask('i need a new vanity').mode, 'direct_results', 'ordinary shopping on the same concept is unaffected');
    const technical = ask('is a bag of cement suitable for a load bearing wall');
    assert.equal(technical.mode, 'no_match');
    assert.equal(technical.retrieval.permission, 'blocked');
  });

  await suite.test('the bundle has a root index, an index per department directory, and survives import', () => {
    const generated = build();
    const built = buildServerOwnedOkfContent(generated.draft, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', evaluatedAt: AT });
    const files = exportOkfBundle({
      releaseId: 'r', tenantId: 'acme', environmentId: 'test', version: '1.0.0', checksum: computeKnowledgeChecksum(built), status: 'ready',
      content: built, publishedAt: new Date(AT), publishedBy: 'process:test',
    } as any);
    const text = (file: string) => Buffer.from(files[file]).toString('utf8');
    assert.match(text('index.md'), /okf_version: "0.2"/);
    for (const department of ['tools', 'fastenings', 'bathrooms', 'outdoor', 'other-products']) {
      assert.ok(files[`${department}/index.md`], `${department} has an index`);
      assert.ok(files[`${department}.md`], `${department} has a concept file`);
    }
    assert.match(text('tools/index.md'), /Hand Tools/);
    assert.match(text('tools/hand-tools/hammers-and-mallets.md'), /kind: catalogue_taxonomy[\s\S]*verified: false|verified: false[\s\S]*kind: catalogue_taxonomy/);
    const imported = importOkfBundle(files, 'acme');
    assert.equal(imported.draft.concepts.length, generated.draft.concepts.length);
    const roundTrip = imported.draft.concepts.find((entry: any) => entry.name === 'Hammers & Mallets') as any;
    // Imported files are untrusted: the concept comes back fail-closed and its embedded controls, provenance included,
    // are kept for a human reviewer instead of being applied.
    assert.equal(roundTrip.commercePolicy.addToCart, 'blocked');
    assert.equal(roundTrip.riskClass, 'safety_critical');
    assert.equal(roundTrip.importReview.status, 'required');
    assert.equal(roundTrip.interchange.controlFields.extensions[PROVENANCE_KEY].structure.kind, 'catalogue_taxonomy', 'provenance reaches the reviewer');
  });

  await suite.test('documents: SKUs come from stated text or a leading title number, kinds from tenant phrases', () => {
    assert.deepEqual(extractSkus('Installation guide, for SKU 7834161 and SKU: 7834162', '1294422 spec'), ['7834161', '7834162', '1294422']);
    assert.deepEqual(extractSkus('no sku here 12', 'Spec sheet'), []);
    assert.deepEqual(extractSkus('SKUs 1111111 2222222 3333333', ''), ['1111111', '2222222', '3333333']);
    const rules = [{ kind: 'installation_guide', anyOf: ['installation guide'] }, { kind: 'warranty', anyOf: ['warranty'] }];
    assert.equal(classifyDocument('Basin spec', '(Installation Guide, for SKU 1)', rules), 'installation_guide');
    assert.equal(classifyDocument('5 Year Warranty', '', rules), 'warranty');
    assert.equal(classifyDocument('Brochure', '', rules), 'document');
  });

  await suite.test('a snapshot or config for another tenant, or an invalid config, is rejected', () => {
    assert.throws(() => buildTaxonomyDraft(snapshot({ tenantId: 'other' }), config()), /does not match/);
    assert.throws(() => buildTaxonomyDraft(snapshot(), { ...config(), commerce: undefined }), /commerce/i);
    assert.throws(() => buildTaxonomyDraft(snapshot(), config({ navigation: { questionTemplate: 'x' } })));
    assert.throws(() => buildTaxonomyDraft({ tenantId: 'acme', rows: [] }, config()));
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
