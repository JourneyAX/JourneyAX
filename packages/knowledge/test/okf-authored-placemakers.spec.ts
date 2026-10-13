import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import {
  OKF_LIMITS, PROVENANCE_KEY, applyAuthoring, auditProvenance, buildCoverageReport, buildServerOwnedOkfContent, buildTaxonomyDraft,
  computeKnowledgeChecksum, exportOkfBundle, loadPinnedOkfRelease, publishOkfRelease, resolveOkfBasketCommerce, resolveOkfGate,
  renderOkfMessage, summarizeWorklist, validateOkfDraftContent,
} from '../src';

/**
 * Real-data proof of the authored PlaceMakers layer. Inputs are committed evidence:
 *   the 2026-10-13 catalogue snapshot, the inventory of the active pack (declared journeys), the tenant ingest config,
 *   and the authoring proposal (scripts/okf/tenants/placemakers.authoring.json).
 */
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const inventory = read('docs/inventory/placemakers-inventory-2026-10-13.json');
const ingest = read('scripts/okf/tenants/placemakers.ingest.json');
const spec = read('scripts/okf/tenants/placemakers.authoring.json');

const suite = createSuite('knowledge: PlaceMakers authored layer (real snapshot)');
const authored = applyAuthoring(buildTaxonomyDraft(snapshot, ingest), spec);
const built = buildServerOwnedOkfContent(authored.draft, { tenantId: 'placemakers', environmentId: 'production', releaseId: 'authored', evaluatedAt: snapshot.snapshotAt });
const name = (conceptId?: string) => built.concepts.find((entry) => entry.conceptId === conceptId)?.name;
const gate = (message: string, knownFacts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  resolveOkfGate(built, { tenantId: 'placemakers', environmentId: 'production', releaseId: 'authored', message, knownFacts, ...extra } as any) as any;
const suggestionNames = (decision: any) => (decision.suggestions ?? []).map((entry: any) => name(entry.conceptId));

async function main() {
  await suite.test('the proposal resolves completely against the real taxonomy and the active pack', () => {
    assert.deepEqual(authored.errors, []);
    const packJourneys: string[] = inventory.activePack.journeys;
    for (const target of spec.journeyTargets) assert.ok(packJourneys.includes(target.journeyId), `${target.journeyId} is a journey of the active pack`);
    for (const project of spec.projects) if (project.journey) assert.ok(packJourneys.includes(project.journey.journeyId));
    assert.deepEqual(
      { families: authored.authored.families, projects: authored.authored.projects, problems: authored.authored.problems, care: authored.authored.care },
      { families: 2, projects: 8, problems: 6, care: 2 });
    assert.deepEqual(authored.projectsWithoutJourney.sort(), ['deck_build', 'fence_build', 'insulate_home', 'paint_a_room', 'wet_area_lining']);
  });

  await suite.test('the authored release is valid, evaluated, small, deterministic and still reconciles to every product', () => {
    assert.equal(validateOkfDraftContent(authored.draft, 'placemakers').valid, true);
    assert.equal(built.evaluation.passed, true);
    assert.ok(Buffer.byteLength(JSON.stringify(authored.draft)) < OKF_LIMITS.draftMaxBytes / 4);
    assert.equal(computeKnowledgeChecksum(applyAuthoring(buildTaxonomyDraft(snapshot, ingest), spec).draft), computeKnowledgeChecksum(authored.draft));
    const report = buildCoverageReport(authored);
    assert.equal(report.reconciliation.ok, true);
    assert.equal(report.totals.productsCovered, snapshot.totalProducts);
    assert.equal(report.claims.verifiedClaims, 0);
  });

  await suite.test('authored material is a proposal: unverified, claim-free, using only non-claim relationship types', () => {
    const audit = auditProvenance(authored.draft, authored.config);
    assert.deepEqual(audit.violations, []);
    assert.equal(authored.draft.verifications.length, 0);
    assert.equal(authored.draft.evidenceChunks.length, 0);
    const types = new Set((authored.draft.relationships as any[]).map((relationship) => relationship.type));
    for (const forbidden of ['requires', 'compatible_with', 'incompatible_with', 'alternative_to', 'installed_with', 'solves', 'diagnoses', 'document_for']) {
      assert.ok(!types.has(forbidden), `no ${forbidden} relationship is authored`);
    }
    assert.ok(types.has('cross_sell') && types.has('care_for') && types.has('child_of'));
    for (const relationship of (authored.draft.relationships as any[]).filter((entry) => entry.type === 'cross_sell')) {
      assert.deepEqual(relationship.claimClasses, []);
      assert.equal(relationship.customerLabel ?? 'Have you considered?', relationship.customerLabel ?? 'Have you considered?');
    }
    assert.ok((authored.draft.relationships as any[]).filter((entry) => entry.type === 'care_for').every((entry) => entry.claimClasses.join() === 'care_safety' && !entry.verificationRef));
    const proposal = (authored.draft.sources as any[]).find((source) => source.sourceId === 'src-authoring-proposal');
    assert.match(proposal.title, /awaiting merchant review/);
  });

  await suite.test('customer scenarios reach the right authored concept, question and next step', () => {
    const table: Array<[string, Record<string, unknown>, { mode: string; concept: string; ask?: string }]> = [
      ['screws', {}, { mode: 'overview_then_ask', concept: 'Screws', ask: 'fastener_substrate' }],
      ['screws', { fastener_substrate: 'masonry' }, { mode: 'direct_results', concept: 'Masonry  Anchors' }],
      ['nails', {}, { mode: 'overview_then_ask', concept: 'Nails', ask: 'nav_family_nails' }],
      ['i want to build a deck', {}, { mode: 'overview_then_ask', concept: 'Deck build', ask: 'deck_material' }],
      ['i want to build a deck', { deck_material: 'composite' }, { mode: 'overview_then_ask', concept: 'Deck build', ask: 'deck_size' }],
      ['i want to build a deck', { deck_material: 'composite', deck_size: '4x3 m' }, { mode: 'overview_then_ask', concept: 'Deck build' }],
      ['renovate my bathroom', {}, { mode: 'project_journey', concept: 'Bathroom renovation', ask: 'project_scope' }],
      ['renovate my bathroom', { project_scope: 'renovation' }, { mode: 'project_journey', concept: 'Bathroom renovation', ask: 'room_dimensions' }],
      ['laundry makeover', {}, { mode: 'project_journey', concept: 'Laundry makeover', ask: 'project_scope' }],
      ['painting a room', {}, { mode: 'overview_then_ask', concept: 'Painting project', ask: 'paint_surface' }],
      ['wet area lining', {}, { mode: 'overview_then_ask', concept: 'Wet area lining', ask: 'wet_area_room' }],
      ['build a fence', {}, { mode: 'overview_then_ask', concept: 'Fence build', ask: 'fence_type' }],
      ['insulate my house', { insulation_area: 'walls' }, { mode: 'overview_then_ask', concept: 'Insulating a home' }],
      ['vanities', {}, { mode: 'direct_results', concept: 'Vanities' }],
      ['hammers', {}, { mode: 'direct_results', concept: 'Hammers & Mallets' }],
    ];
    for (const [message, facts, expected] of table) {
      const decision = gate(message, facts);
      const label = `${message} ${JSON.stringify(facts)}`;
      assert.equal(decision.mode, expected.mode, label);
      assert.equal(name(decision.conceptId), expected.concept, label);
      assert.equal(decision.clarification?.factKey, expected.ask, label);
    }
  });

  await suite.test('a customer\'s own words reach the right concept: a project beats a category that shares one word, and naming two of a project\'s categories describes the project', () => {
    const route = (message: string) => { const decision: any = gate(message); return { concept: name(decision.conceptId), mode: decision.mode, matchedBy: decision.trace.matchedBy }; };
    // The wording that was sent to the live shop: two categories of the wet-area project in one question.
    assert.deepEqual(route('What moisture-resistant linings and waterproofing do I need for my wet area?'), { concept: 'Wet area lining', mode: 'overview_then_ask', matchedBy: 'project_categories' });
    assert.equal(route('I need wet wall linings and waterproofing').concept, 'Wet area lining', 'two of its categories named');
    // One shared word must not decide it: "wet" belongs to a timber grade and "walls" to retaining walls.
    assert.equal(route('what do I need to line a wet area').concept, 'Wet area lining');
    assert.equal(route('I want to waterproof my bathroom').concept, 'Wet area lining');
    assert.equal(route('how do I waterproof my bathroom walls').concept, 'Wet area lining', 'the project\'s own phrasing, not "walls"');
    // Nothing is taken from a customer who names exactly one category, or exactly one concept.
    assert.deepEqual(route('waterproofing'), { concept: 'Waterproofing', mode: 'direct_results', matchedBy: 'exact_phrase' });
    assert.equal(route('wood screws').concept, 'Wood Screws');
    assert.equal(route('wet area lining').matchedBy, 'exact_phrase');
  });

  await suite.test('problem-first requests escalate: products paused, no invented guidance, a professional is named', () => {
    for (const [message, concept] of [
      ['my bathroom is leaking', 'Bathroom leak'], ['there is a gas leak', 'Gas hazard'], ['dripping tap', 'Leaking tap or pipe'],
      ['blocked drain', 'Blocked drain'], ['mouldy walls', 'Mould and damp'], ['water near power points', 'Electrical hazard'],
    ]) {
      const decision = gate(message);
      assert.equal(decision.mode, 'safety_then_diagnose', message);
      assert.equal(name(decision.conceptId), concept, message);
      assert.equal(decision.safety.guidanceUnavailable, true, message);
      assert.deepEqual(decision.safety.guidance, [], message);
      assert.equal(decision.retrieval.permission, 'blocked', message);
      assert.deepEqual([decision.commerce.addToCart, decision.commerce.checkout], ['blocked', 'blocked'], message);
    }
    for (const message of ['my heater is smoking', 'the extension cord is sparking', 'i can smell gas']) {
      assert.equal(gate(message).mode, 'safety_then_diagnose', message);
    }
  });

  await suite.test('installation, warranty and care questions fail safely until a person verifies a source', () => {
    for (const message of ['how do i install a vanity', 'what is the warranty on this vanity', 'clean my deck', 'how to install a toilet']) {
      const decision = gate(message);
      assert.equal(decision.mode, 'evidence_answer', message);
      assert.equal(decision.retrieval.permission, 'blocked', message);
      assert.deepEqual(decision.evidence.sourceRefs, [], message);
      assert.deepEqual(decision.claims.allowedClasses.filter((claim: string) => claim !== 'suggestion'), [], message);
    }
  });

  await suite.test('"Have you considered?" appears with products, is unverified, and never reaches a claim', () => {
    assert.deepEqual(suggestionNames(gate('vanities')), ['Tapware & Showering', 'Mirrors']);
    assert.deepEqual(suggestionNames(gate('i want to build a deck', { deck_material: 'composite', deck_size: '4x3 m' })), ['Wood Screws', 'Woodcare', 'Outdoor Cleaners']);
    assert.deepEqual(suggestionNames(gate('drills')), ['Drill Bits', 'Screwdriver Bits', 'Battery & Charger']);
    assert.deepEqual(suggestionNames(gate('wood screws')), ['Drill Bits', 'Screwdriver Bits']);
    for (const message of ['vanities', 'drills', 'wood screws']) {
      const decision = gate(message);
      assert.ok(decision.suggestions.every((entry: any) => entry.status === 'unverified_cross_sell' && /not confirmed/.test(entry.note)));
      assert.ok(!decision.claims.allowedClasses.some((claim: string) => ['compatibility', 'requirement', 'substitution'].includes(claim)));
    }
    assert.equal(gate('my bathroom is leaking').suggestions, undefined);
    assert.equal(gate('clean my deck').suggestions, undefined);
  });

  await suite.test('risk policy: professional confirmation for installed-by-trade categories, compatibility for fixings, the rest unchanged', () => {
    for (const category of ['Switchgear', 'Gas Heating', 'Heat Pumps', 'Hot Water']) {
      const decision = gate(category.toLowerCase());
      assert.equal(name(decision.conceptId), category);
      assert.equal(decision.commerce.checkout, 'requires_professional_confirmation', category);
      assert.equal(decision.commerce.addToCart, 'allowed', category);
    }
    const screws = built.concepts.find((entry) => entry.name === 'Wood Screws')!;
    assert.deepEqual([screws.riskClass, screws.compatibilitySensitive], ['compatibility', true]);
    const screwDecision = gate('wood screws');
    const compatibilityNotice = renderOkfMessage(screwDecision.messages, 'compatibility_unverified');
    assert.ok(screwDecision.claims.disclaimers.includes(compatibilityNotice) && screwDecision.claims.notices.includes(compatibilityNotice));
    assert.deepEqual(gate('hammers').commerce, { addToCart: 'allowed', checkout: 'allowed' });
  });

  await suite.test('the basket honours the same policy per product and still blocks what is unavailable or unknown', () => {
    const availability = { excludeFlagPaths: ['discontinued'], statusPaths: ['status'], unavailableStatuses: ['discontinued'] };
    const base = { tenantId: 'placemakers', environmentId: 'production', releaseId: 'authored', availability };
    const product = (sku: string, categoryPath: string[], extra: Record<string, unknown> = {}) => ({ projectId: 'placemakers', sku, categoryPath, ...extra });
    const run = (items: string[], products: any[]) => resolveOkfBasketCommerce(built, { ...base, items: items.map((sku) => ({ sku })), products });
    const switchgear = run(['S1'], [product('S1', ['Electrical & Heating/Cooling', 'Electrical', 'Switchgear'])]);
    assert.equal(switchgear.commerce.checkout, 'requires_professional_confirmation');
    assert.ok(switchgear.warnings.includes(renderOkfMessage({}, 'basket_warning_professional', { conceptName: 'Switchgear' })), 'the warning is the policy message, naming the concept');
    const hammer = run(['H1'], [product('H1', ['Tools', 'Hand Tools', 'Hammers & Mallets'])]);
    assert.deepEqual(hammer.commerce, { addToCart: 'allowed', checkout: 'allowed' });
    const mixed = run(['H1', 'S1'], [product('H1', ['Tools', 'Hand Tools', 'Hammers & Mallets']), product('S1', ['Electrical & Heating/Cooling', 'Electrical', 'Switchgear'])]);
    assert.equal(mixed.commerce.checkout, 'requires_professional_confirmation', 'the strictest item decides');
    assert.equal(run(['D1'], [product('D1', ['Tools', 'Hand Tools', 'Hammers & Mallets'], { discontinued: true })]).commerce.addToCart, 'blocked');
    assert.equal(run(['NOPE'], []).commerce.addToCart, 'blocked');
  });

  await suite.test('the verification worklist is the honest register: many candidates, zero verified, gaps named', () => {
    const summary = summarizeWorklist(authored);
    assert.equal(summary.verified, 0);
    assert.ok(summary.byClaimClass.installation_step.entries > 100, `installation: ${summary.byClaimClass.installation_step.entries}`);
    assert.ok(summary.byClaimClass.warranty.entries > 50);
    assert.ok(summary.byClaimClass.installation_step.candidateDocuments >= summary.byClaimClass.installation_step.entries);
    assert.equal(summary.gaps, 8, '6 problems + 2 care topics need a person to author and verify guidance');
    assert.ok(authored.worklist.entries.every((entry) => entry.status === 'unverified' && entry.candidates.length > 0 && entry.candidates.length <= 5));
    assert.ok(authored.worklist.entries.some((entry) => entry.conceptName === 'Vanities' && entry.claimClass === 'installation_step'));
  });

  await suite.test('the bundle groups the authored layer in its own directories with indexes, for human review', () => {
    const files = exportOkfBundle({
      releaseId: 'authored', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', checksum: computeKnowledgeChecksum(built), status: 'ready',
      content: built, publishedAt: new Date(snapshot.snapshotAt), publishedBy: 'process:test',
    } as any);
    const text = (file: string) => Buffer.from(files[file]).toString('utf8');
    for (const directory of ['families', 'projects', 'problems', 'care']) assert.ok(files[`${directory}/index.md`], `${directory}/ is indexed`);
    assert.match(text('projects/index.md'), /Deck build/);
    assert.match(text('problems/bathroom-leak.md'), /authored_proposal/);
    assert.match(text('families/screws.md'), /Screws/);
    assert.equal(JSON.stringify(Object.keys(files).filter((file) => file.startsWith('projects/') && file !== 'projects/index.md').length), String(spec.projects.length));
  });

  await suite.test('it publishes checksum-bound and the authored concepts keep their provenance through storage', async () => {
    const db = new MemoryDb();
    const release = await publishOkfRelease(db as any, {
      releaseId: 'okf-placemakers-authored-1', tenantId: 'placemakers', environmentId: 'test', version: '1.0.0', content: built, publishedBy: 'human:test',
    });
    const loaded = await loadPinnedOkfRelease(db as any, { tenantId: 'placemakers', environmentId: 'test', releaseId: release.releaseId, version: release.version, checksum: release.checksum });
    const family = loaded.release.content.concepts.find((entry) => entry.name === 'Screws') as any;
    assert.equal(family.extensions[PROVENANCE_KEY].structure.kind, 'authored_proposal');
    assert.equal(family.extensions[PROVENANCE_KEY].structure.verified, false);
    assert.equal(loaded.release.content.concepts.length, built.concepts.length);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
