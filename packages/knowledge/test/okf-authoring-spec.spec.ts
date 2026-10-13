import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import {
  AuthoringSpecSchema, PROVENANCE_KEY, applyAuthoring, auditProvenance, buildCoverageReport, buildServerOwnedOkfContent, buildTaxonomyDraft,
  computeKnowledgeChecksum, renderWorklistMarkdown, renderCoverageMarkdown, resolveOkfGate, summarizeWorklist, validateOkfDraftContent,
} from '../src';

const suite = createSuite('knowledge: authoring layer');
const AT = '2026-10-13T00:00:00.000Z';

const ingestConfig = {
  tenantId: 'acme', modelId: 'acme-knowledge', minProductsForConcept: 1,
  navigation: { questionTemplate: 'Which type of {name}?', uiInputType: 'card_choice', maxOptions: 20, overviewGroups: 3, maxItemsPerGroup: 2 },
  commerce: { addToCart: 'allowed', checkout: 'allowed' },
  synonyms: { pluralise: 'english', headNouns: false, ignoreTerms: [] },
  documents: { kinds: [], maxCandidatesPerCategory: 8 },
  descriptions: { leaf: '{name}: {products} products ({date}).', parent: '{name}: {products} products in {children} areas ({date}).' },
};
const rows = [
  { path: ['Outdoor', 'Decking', 'Composite Decking'], productCount: 40 },
  { path: ['Outdoor', 'Decking', 'Hardwood Decking'], productCount: 20 },
  { path: ['Outdoor', 'Finishes', 'Woodcare'], productCount: 30 },
  { path: ['Fixings', 'Fastenings', 'Wood Screws'], productCount: 90 },
  { path: ['Fixings', 'Fastenings', 'Metal Screws'], productCount: 50 },
  { path: ['Fixings', 'Fastenings', 'Masonry Anchors'], productCount: 40 },
  { path: ['Bath', 'Fixtures', 'Vanities'], productCount: 70 },
  { path: ['Bath', 'Fixtures', 'Tapware'], productCount: 60 },
  { path: ['Bath', 'Fixtures', 'Accessories'], productCount: 10 },
  { path: ['Electrical', 'Fittings', 'Switchgear'], productCount: 25 },
  { path: ['Electrical', 'Fittings', 'Accessories'], productCount: 5 },
  { path: ['Tools', 'Power', 'Drills'], productCount: 35 },
  { path: ['Tools', 'Power', 'Drill Bits'], productCount: 45 },
];
const total = rows.reduce((sum, row) => sum + row.productCount, 0);
const docs = [
  { category: 'Vanities', path: ['Bath', 'Fixtures', 'Vanities'], sourceUrl: 'pdf://v1', title: 'Vanity install', kind: 'installation_guide', chunkCount: 4, sku: '1' },
  { category: 'Vanities', path: ['Bath', 'Fixtures', 'Vanities'], sourceUrl: 'pdf://v2', title: 'Vanity warranty', kind: 'warranty', chunkCount: 2 },
  { category: 'Tapware', path: ['Bath', 'Fixtures', 'Tapware'], sourceUrl: 'pdf://t1', title: 'Tap brochure', kind: 'brochure', chunkCount: 1 },
  { category: 'Composite Decking', path: ['Outdoor', 'Decking', 'Composite Decking'], sourceUrl: 'pdf://d1', title: 'Deck care', kind: 'care_guide', chunkCount: 3 },
];
const baseSpec = () => ({
  tenantId: 'acme', version: 't1', author: { model: 'test-model', role: 'test' },
  journeyTargets: [{ journeyId: 'plan_space' }],
  evidence: { kinds: { installation_step: ['installation_guide'], warranty: ['warranty'], care_safety: ['care_guide'] } },
  facts: [
    { factKey: 'substrate', question: 'What is it going into?', options: [{ value: 'timber', label: 'Timber' }, { value: 'metal', label: 'Metal' }, { value: 'masonry', label: 'Masonry' }] },
    { factKey: 'deck_size', question: 'How big?', uiInputType: 'text', type: 'string', role: 'measurement' },
    { factKey: 'where', question: 'Where is the water?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  ],
  families: [{
    id: 'screws', name: 'Screws', description: 'Screws', synonyms: ['screw'], phrases: ['fixing screws'],
    members: ['Wood Screws', 'Metal Screws', 'Masonry Anchors'],
    discriminator: { fact: 'substrate', valueMap: { timber: 'Wood Screws', metal: 'Metal Screws', masonry: 'Masonry Anchors' } },
    compatibilitySensitive: true,
  }],
  projects: [
    { id: 'deck_build', name: 'Deck build', description: 'Build a deck', phrases: ['build a deck'], facts: [{ fact: 'deck_size', importance: 'high' }], categories: ['Composite Decking', 'Hardwood Decking'] },
    { id: 'bath_reno', name: 'Bathroom renovation', description: 'Renovate a bathroom', phrases: ['renovate my bathroom'], journey: { journeyId: 'plan_space' }, facts: [], categories: ['Vanities', 'Tapware'] },
  ],
  problems: [{ id: 'bath_leak', name: 'Bathroom leak', description: 'Water leaking', phrases: ['bathroom is leaking'], facts: ['where'] }],
  care: [{ id: 'deck_care', name: 'Deck care', description: 'Care for a deck', phrases: ['clean my deck'], appliesTo: ['Composite Decking'] }],
  overlays: [
    { id: 'pro', reason: 'confirm first', match: { categories: ['Switchgear'] }, set: { checkout: 'requires_professional_confirmation' } },
    { id: 'compat', reason: 'depends on substrate', match: { departments: ['Fixings'] }, set: { riskClass: 'compatibility', compatibilitySensitive: true } },
  ],
  suggestions: [
    { id: 'deck_extras', from: 'project:deck_build', to: ['Woodcare', 'Wood Screws'], rationale: 'finish and fixings' },
    { id: 'vanity_extras', from: 'Vanities', to: ['Tapware'], rationale: 'needs taps', label: 'Often bought together' },
    { id: 'drill_extras', from: 'Drills', to: ['Drill Bits', 'Vanities', 'Tapware', 'Woodcare'], rationale: 'bits' },
  ],
});
const derived = (over: Record<string, unknown> = {}) => buildTaxonomyDraft({ tenantId: 'acme', snapshotAt: AT, source: 'fixture', totalProducts: total, rows, documentCandidates: docs, ...over }, ingestConfig);
const author = (spec: Record<string, any> = baseSpec(), over: Record<string, unknown> = {}) => applyAuthoring(derived(over), spec);
const find = (authored: ReturnType<typeof author>, name: string) => authored.draft.concepts.find((entry: any) => entry.name === name) as any;
const gate = (authored: ReturnType<typeof author>, message: string, knownFacts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  resolveOkfGate(authored.draft as any, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', message, knownFacts, ...extra } as any) as any;

async function main() {
  await suite.test('the spec schema has no field with which to author a claim', () => {
    const spec: any = baseSpec();
    assert.equal(AuthoringSpecSchema.safeParse(spec).success, true);
    const reject = (mutate: (copy: any) => void, why: string) => {
      const copy = structuredClone(spec); mutate(copy);
      assert.equal(AuthoringSpecSchema.safeParse(copy).success, false, why);
    };
    reject((c) => { c.problems[0].safetySteps = ['turn off water']; }, 'a problem cannot carry its own safety steps');
    reject((c) => { c.problems[0].stepRefs = ['x']; }, 'nor step references');
    reject((c) => { c.care[0].instructions = 'use soap'; }, 'a care topic cannot carry instructions');
    reject((c) => { c.suggestions[0].type = 'compatible_with'; }, 'a relationship type cannot be chosen');
    reject((c) => { c.suggestions[0].claimClasses = ['compatibility']; }, 'a suggestion cannot carry claim classes');
    reject((c) => { c.overlays[1].set.riskClass = 'safety_critical'; }, 'an overlay cannot mark a product category safety-critical');
    reject((c) => { c.overlays[0].set.checkout = 'allowed'; }, 'an overlay cannot loosen checkout');
    reject((c) => { c.overlays[0].set.addToCart = 'allowed'; }, 'an overlay cannot loosen add-to-cart');
    reject((c) => { c.facts[0].extra = 1; }, 'unknown keys are rejected');
    reject((c) => { c.families[0].members = ['Wood Screws']; }, 'a family needs two members');
  });

  await suite.test('the authored draft is valid, passes the publication evaluation and keeps every authored item unverified', () => {
    const authored = author();
    assert.deepEqual(authored.errors, []);
    assert.equal(validateOkfDraftContent(authored.draft, 'acme').valid, true);
    const built = buildServerOwnedOkfContent(authored.draft, { tenantId: 'acme', environmentId: 'test', releaseId: 'r', evaluatedAt: AT });
    assert.equal(built.evaluation.passed, true);
    const audit = auditProvenance(authored.draft, authored.config);
    assert.deepEqual(audit.violations, []);
    assert.equal(audit.counts.authored_proposal > 0, true);
    assert.equal(authored.draft.verifications.length, 0);
    assert.equal(authored.draft.evidenceChunks.length, 0);
    for (const concept of authored.draft.concepts.filter((entry: any) => entry.conceptId.match(/\/(families|projects|problems|care)\//)) as any[]) {
      assert.equal(concept.extensions[PROVENANCE_KEY].structure.kind, 'authored_proposal');
      assert.equal(concept.extensions[PROVENANCE_KEY].structure.verified, false);
    }
    const source = authored.draft.sources.find((entry: any) => entry.sourceId === 'src-authoring-proposal') as any;
    assert.equal(source.kind, 'llm_draft');
    assert.match(source.title, /awaiting merchant review/);
  });

  await suite.test('references resolve exactly: ambiguous ones list their candidates, unknown ones fail loudly', () => {
    const spec: any = baseSpec();
    spec.suggestions = [
      { id: 'amb', from: 'Accessories', to: ['Vanities'], rationale: 'x' },
      { id: 'missing', from: 'Vanities', to: ['Teleporters'], rationale: 'x' },
      { id: 'qualified', from: 'Fittings > Accessories', to: ['Vanities'], rationale: 'x' },
    ];
    const authored = author(spec);
    const codes = authored.errors.map((error) => `${error.code}:${error.where}`);
    assert.ok(codes.includes('ambiguous_ref:suggestions.amb.from'));
    assert.ok(codes.includes('unresolved_ref:suggestions.missing.to[0]'));
    assert.ok(!codes.some((code) => code.includes('qualified')), 'a qualified reference resolves');
    assert.match(authored.errors.find((error) => error.code === 'ambiguous_ref')!.message, /Bath > Fixtures > Accessories.*Electrical > Fittings > Accessories/);
  });

  await suite.test('unknown facts, undeclared journeys, duplicate facts and self-suggestions are errors', () => {
    const spec: any = baseSpec();
    spec.projects[0].facts = [{ fact: 'no_such_fact' }];
    spec.projects[1].journey = { journeyId: 'not_in_the_pack' };
    spec.facts.push({ factKey: 'where', question: 'again', options: [{ value: 'x', label: 'X' }] });
    spec.suggestions = [{ id: 'self', from: 'Vanities', to: ['Vanities'], rationale: 'x' }];
    const codes = author(spec).errors.map((error) => error.code);
    for (const expected of ['unknown_fact', 'unknown_journey', 'duplicate_fact', 'self_suggestion']) assert.ok(codes.includes(expected), expected);
    const noOptions: any = baseSpec(); noOptions.facts[0].options = undefined;
    assert.ok(author(noOptions).errors.some((error) => error.code === 'fact_options_required'));
  });

  await suite.test('a family asks its authored question and routes each answer to a member; without one it lists its members', () => {
    const authored = author();
    const family = find(authored, 'Screws');
    assert.equal(family.type, 'product_family');
    assert.equal(family.compatibilitySensitive, true);
    assert.deepEqual(Object.keys(family.discriminators[0].valueMap).sort(), ['masonry', 'metal', 'timber']);
    const broad = gate(authored, 'fixing screws');
    assert.equal(broad.mode, 'overview_then_ask');
    assert.equal(broad.clarification.factKey, 'substrate');
    assert.equal(broad.retrieval.groups.length, 3);
    assert.equal(gate(authored, 'fixing screws', { substrate: 'metal' }).conceptId, find(authored, 'Metal Screws').conceptId);
    const withoutDiscriminator: any = baseSpec(); delete withoutDiscriminator.families[0].discriminator;
    withoutDiscriminator.families[0].question = 'Which kind?';
    const navigating = gate(author(withoutDiscriminator), 'fixing screws');
    assert.equal(navigating.clarification.question, 'Which kind?');
    assert.deepEqual(navigating.clarification.options.map((option: any) => option.label), ['Wood Screws', 'Metal Screws', 'Masonry Anchors']);
  });

  await suite.test('authored phrases beat derived ones; two authored concepts cannot share a phrase', () => {
    assert.ok(find(author(), 'Drills').synonyms.includes('drill'), 'precondition: the derived concept owns "drill"');
    const handover: any = baseSpec();
    handover.families.push({ id: 'power_drilling', name: 'Drilling', description: 'Drilling', synonyms: ['drill'], members: ['Drills', 'Drill Bits'] });
    const authored = author(handover);
    assert.deepEqual(authored.errors, []);
    assert.equal(find(authored, 'Drills').synonyms.includes('drill'), false, 'the derived concept gave the phrase up');
    assert.equal(find(authored, 'Drilling').synonyms.includes('drill'), true);
    assert.ok(authored.authored.removedDerivedPhrases >= 1);
    assert.equal(gate(authored, 'i need a drill').conceptId, find(authored, 'Drilling').conceptId);
    const clash: any = baseSpec();
    clash.projects[0].phrases = ['fixing screws'];
    assert.ok(author(clash).errors.some((error) => error.code === 'ambiguous_phrase'));
    const shadow: any = baseSpec();
    shadow.projects[0].phrases = ['vanities'];
    assert.ok(author(shadow).errors.some((error) => error.code === 'phrase_collides_with_name'));
  });

  await suite.test('a project asks its questions one at a time, then previews its categories; a journey owns the flow when one is named', () => {
    const authored = author();
    const first = gate(authored, 'i want to build a deck');
    assert.equal(first.mode, 'overview_then_ask');
    assert.equal(first.clarification.factKey, 'deck_size');
    assert.ok(first.trace.reasonCodes.includes('project_served_by_gate'));
    const known = gate(authored, 'i want to build a deck', { deck_size: '4x3 m' });
    assert.equal(known.clarification, undefined);
    assert.equal(known.retrieval.permission, 'allowed');
    assert.deepEqual(known.retrieval.groups.map((group: any) => group.label), ['Composite Decking', 'Hardwood Decking']);
    const journey = gate(authored, 'renovate my bathroom');
    assert.equal(journey.mode, 'project_journey');
    assert.deepEqual(journey.journeyRef, { journeyId: 'plan_space' });
    assert.equal(journey.retrieval.permission, 'blocked');
  });

  await suite.test('a problem blocks products and invents no guidance: it refers to a professional until a person verifies steps', () => {
    const authored = author();
    const leak = find(authored, 'Bathroom leak');
    assert.equal(leak.lens, 'problem'); assert.equal(leak.riskClass, 'safety_critical');
    assert.deepEqual(leak.safety, { blocksProducts: true, stepRefs: [] });
    assert.deepEqual(leak.commercePolicy, { addToCart: 'blocked', checkout: 'blocked' });
    const decision = gate(authored, 'my bathroom is leaking');
    assert.equal(decision.mode, 'safety_then_diagnose');
    assert.equal(decision.safety.guidanceUnavailable, true);
    assert.deepEqual(decision.safety.guidance, []);
    assert.equal(decision.retrieval.permission, 'blocked');
    assert.equal(decision.commerce.addToCart, 'blocked');
  });

  await suite.test('care and installation questions fail safely: no evidence, no instructions, no claim', () => {
    const authored = author();
    for (const message of ['clean my deck', 'how do i install a vanity', 'what is the warranty on this vanity']) {
      const decision = gate(authored, message);
      assert.equal(decision.mode, 'evidence_answer', message);
      assert.equal(decision.retrieval.permission, 'blocked', message);
      assert.deepEqual(decision.evidence.sourceRefs, [], message);
      assert.ok(decision.trace.reasonCodes.includes('verified_evidence_unavailable'), message);
      assert.deepEqual(decision.claims.allowedClasses.filter((claim: string) => claim !== 'suggestion'), [], message);
    }
    const careRelationships = authored.draft.relationships.filter((relationship: any) => relationship.type === 'care_for') as any[];
    assert.ok(careRelationships.length > 0 && careRelationships.every((relationship) => relationship.verificationRef === undefined && relationship.claimClasses.includes('care_safety')));
    assert.ok(auditProvenance(authored.draft).counts.pending_claim_relationships > 0, 'pending claims are counted, not hidden');
  });

  await suite.test('overlays only tighten: strictest wins, nothing is loosened, and the reviewer sees why', () => {
    const authored = author();
    assert.equal(find(authored, 'Switchgear').commercePolicy.checkout, 'requires_professional_confirmation');
    assert.equal(find(authored, 'Switchgear').commercePolicy.addToCart, 'allowed');
    const wood = find(authored, 'Wood Screws');
    assert.equal(wood.riskClass, 'compatibility'); assert.equal(wood.compatibilitySensitive, true);
    assert.match(JSON.stringify(wood.extensions[PROVENANCE_KEY]), /depends on substrate/);
    const stacked: any = baseSpec();
    stacked.overlays = [
      { id: 'a', reason: 'a', match: { categories: ['Vanities'] }, set: { checkout: 'requires_professional_confirmation' } },
      { id: 'b', reason: 'b', match: { categories: ['Vanities'] }, set: { checkout: 'requires_compatibility_resolution' } },
    ];
    assert.equal(find(author(stacked), 'Vanities').commercePolicy.checkout, 'requires_professional_confirmation', 'a later, weaker overlay cannot undo a stronger one');
    const strictBase = author(baseSpec(), {});
    assert.equal(auditProvenance(strictBase.draft, strictBase.config).violations.some((violation) => violation.code === 'derived_more_permissive'), false);
  });

  await suite.test('"Have you considered?" suggestions are unverified cross-sell: labelled, capped, shown only with products, never a claim', () => {
    const authored = author();
    const vanities = gate(authored, 'vanities');
    assert.deepEqual(vanities.suggestions.map((entry: any) => [entry.label, entry.status]), [['Often bought together', 'unverified_cross_sell']]);
    assert.match(vanities.suggestions[0].note, /not confirmed to be compatible with, or required for/);
    assert.deepEqual(vanities.claims.allowedClasses.filter((claim: string) => claim !== 'suggestion'), [], 'a suggestion adds no claim class');
    assert.equal(gate(authored, 'drills').suggestions.length, 3, 'capped at the policy maximum');
    assert.equal(gate(authored, 'drills').suggestions[0].label, 'Have you considered?', 'default wording from the policy messages');
    const blocked = gate(authored, 'clean my deck');
    assert.equal(blocked.suggestions, undefined, 'no suggestions while retrieval is blocked');
    assert.equal(gate(authored, 'my bathroom is leaking').suggestions, undefined);
    const relationship = authored.draft.relationships.find((entry: any) => entry.type === 'cross_sell') as any;
    assert.deepEqual(relationship.claimClasses, []);
    assert.equal(relationship.confidence, 'low');
    const off = structuredClone(authored.draft) as any; off.policy = { suggestions: { max: 0 } };
    assert.equal(gate({ ...authored, draft: off } as any, 'vanities').suggestions, undefined, 'a tenant can switch suggestions off');
  });

  await suite.test('suggestions never target another tenant, a retired concept, or the concept itself', () => {
    const authored = author();
    const retired = structuredClone(authored.draft) as any;
    retired.concepts.find((entry: any) => entry.name === 'Tapware').lifecycle.status = 'retired';
    assert.equal(gate({ ...authored, draft: retired } as any, 'vanities').suggestions, undefined);
  });

  await suite.test('the verification worklist maps candidate documents to the claims they could support, and nothing is verified', () => {
    const authored = author();
    const entries = authored.worklist.entries;
    const vanity = entries.filter((entry) => entry.conceptName === 'Vanities');
    assert.deepEqual(vanity.map((entry) => entry.claimClass).sort(), ['installation_step', 'warranty']);
    assert.ok(vanity.every((entry) => entry.status === 'unverified' && entry.needs === 'applicable_manufacturer_document_or_qualified_human'));
    assert.equal(entries.some((entry) => entry.conceptName === 'Tapware'), false, 'a brochure supports no configured claim class');
    assert.equal(vanity.find((entry) => entry.claimClass === 'installation_step')!.blocks, 'installation answers');
    assert.ok(authored.worklist.gaps.some((gap) => gap.claimClass === 'safety_instruction' && /qualified person/.test(gap.reason)));
    assert.ok(authored.worklist.gaps.some((gap) => gap.claimClass === 'care_safety'));
    const summary = summarizeWorklist(authored);
    assert.equal(summary.verified, 0);
    assert.equal(summary.byClaimClass.installation_step.entries, 1);
    const markdown = renderWorklistMarkdown(authored);
    assert.match(markdown, /Verified claims: 0/);
    assert.match(markdown, /\[Vanity install\]\(pdf:\/\/v1\)/);
  });

  await suite.test('coverage reports the authored layer and its gaps, and still reconciles', () => {
    const authored = author();
    const report = buildCoverageReport(authored);
    assert.equal(report.reconciliation.ok, true);
    assert.equal(report.authoring!.authored.projects, 2);
    assert.deepEqual(report.authoring!.projectsWithoutJourney, ['deck_build']);
    assert.equal(report.authoring!.sources.verifiedSources, 0);
    assert.equal(report.claims.verifiedClaims, 0);
    assert.match(renderCoverageMarkdown(report), /Authored layer \(proposal awaiting merchant review\)/);
  });

  await suite.test('authoring is deterministic and does not mutate the generated draft', () => {
    const generated = derived();
    const before = computeKnowledgeChecksum(generated.draft);
    const a = applyAuthoring(generated, baseSpec());
    const b = applyAuthoring(derived(), baseSpec());
    assert.equal(computeKnowledgeChecksum(a.draft), computeKnowledgeChecksum(b.draft));
    assert.equal(computeKnowledgeChecksum(generated.draft), before, 'the input draft is untouched');
    assert.throws(() => applyAuthoring(generated, { ...baseSpec(), tenantId: 'other' }), /does not match/);
  });

  await suite.test('a project concept with no journey and no preview policy keeps the original hand-off', () => {
    const authored = author();
    const legacy = structuredClone(authored.draft) as any;
    const project = legacy.concepts.find((entry: any) => entry.name === 'Deck build');
    delete project.broadQueryPolicy;
    assert.equal(gate({ ...authored, draft: legacy } as any, 'i want to build a deck').mode, 'project_journey');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
