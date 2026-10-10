import assert from 'node:assert/strict';
import { resolveOkfGate, validateOkfReleaseContent, type OkfGateInput } from '../src';
import { buildOkfContent, conceptId } from './fixtures';

const content = buildOkfContent();
const valid = validateOkfReleaseContent(content, 'placemakers');
assert.equal(valid.valid, true, valid.issues.map((issue) => `${issue.code}:${issue.message}`).join('\n'));

const base: Omit<OkfGateInput, 'message'> = {
  tenantId: 'placemakers',
  environmentId: 'production',
  releaseId: 'okf-placemakers-1.0.0',
  now: new Date('2026-10-10T00:00:00.000Z'),
};

const matched = (id: string) => [{ id, score: 1, matchedBy: 'test' }];
let passed = 0;
function scenario(name: string, input: OkfGateInput, verify: (decision: ReturnType<typeof resolveOkfGate>) => void) {
  const decision = resolveOkfGate(content, input);
  try {
    verify(decision);
    passed++;
    console.log(`  ✓ ${passed}. ${name}`);
  } catch (error) {
    console.error(`  ✗ ${passed + 1}. ${name}`);
    throw error;
  }
}

console.log('🧪 Running 34 deterministic OKF gate scenarios...');

scenario('broad screws gives grouped overview and a non-blocking substrate card', { ...base, message: 'screws' }, (d) => {
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.retrieval.presentation, 'grouped_overview'); assert.equal(d.clarification?.factKey, 'substrate'); assert.equal(d.clarification?.blocking, false);
});
scenario('deck screws narrows to decking and asks deck material', { ...base, message: 'screws for my deck' }, (d) => {
  assert.equal(d.conceptId, conceptId('fastenings/decking-screws')); assert.equal(d.clarification?.factKey, 'deck_material');
});
scenario('fully specified decking screws goes direct', { ...base, message: '10g 75mm exterior decking screws for treated pine', matchedConcepts: matched(conceptId('fastenings/decking-screws')), knownFacts: { deck_material: 'treated pine' } }, (d) => {
  assert.equal(d.mode, 'direct_results'); assert.equal(d.claims.allowedClasses.includes('compatibility'), false);
});
scenario('exact SKU goes direct and requires live validation', { ...base, message: 'SKU 123', matchedConcepts: matched(conceptId('fastenings/screws')), exactSku: '123' }, (d) => {
  assert.equal(d.mode, 'direct_results'); assert.equal(d.catalogHandling.requiresLiveValidation, true);
});
scenario('discontinued SKU uses possible alternatives without equivalence proof', { ...base, message: 'SKU 123', matchedConcepts: matched(conceptId('fastenings/screws')), exactSku: '123', commerceContext: { productStatus: 'discontinued' } }, (d) => {
  assert.equal(d.catalogHandling.alternativeLanguage, 'possible_alternatives');
});
scenario('POA SKU blocks cart and routes to quote', { ...base, message: 'SKU POA', matchedConcepts: matched(conceptId('fastenings/screws')), exactSku: 'POA', commerceContext: { productStatus: 'poa' } }, (d) => {
  assert.equal(d.commerce.addToCart, 'blocked'); assert.equal(d.catalogHandling.nextAction, 'quote');
});
scenario('warranty request is an evidence answer', { ...base, message: 'What is the warranty on SKU 123?', matchedConcepts: matched(conceptId('bathrooms/toilet')) }, (d) => {
  assert.equal(d.mode, 'evidence_answer'); assert.equal(d.claims.allowedClasses.includes('warranty'), false);
  assert.equal(d.retrieval.permission, 'blocked');
  assert.ok(d.trace.reasonCodes.includes('verified_evidence_unavailable'));
});
scenario('installation request is evidence answer', { ...base, message: 'How do I install this tap?', matchedConcepts: matched(conceptId('bathrooms/toilet')) }, (d) => assert.equal(d.mode, 'evidence_answer'));
scenario('broad toilet gives grouped overview', { ...base, message: 'toilet' }, (d) => {
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.clarification?.factKey, 'toilet_intent');
});
scenario('toilet fault routes to safety before products', { ...base, message: 'toilet', knownFacts: { toilet_intent: 'fault' } }, (d) => {
  assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.retrieval.permission, 'blocked');
});
scenario('replacement toilet without outlet clarifies first', { ...base, message: 'replacement toilet', matchedConcepts: matched(conceptId('bathrooms/replacement-toilet')) }, (d) => {
  assert.equal(d.mode, 'clarify_then_search'); assert.equal(d.clarification?.blocking, true);
});
scenario('replacement toilet with outlet goes direct', { ...base, message: 'replacement toilet', matchedConcepts: matched(conceptId('bathrooms/replacement-toilet')), knownFacts: { outlet_type: 's-trap' } }, (d) => assert.equal(d.mode, 'direct_results'));
scenario('toilet seat excludes suites', { ...base, message: 'toilet seat' }, (d) => {
  assert.equal(d.conceptId, conceptId('bathrooms/toilet-seat')); assert.equal(d.retrieval.excludeCategoryIds.includes('bathrooms.toilet-suites'), true);
});
scenario('bathroom starts a project journey', { ...base, message: 'bathroom' }, (d) => assert.equal(d.mode, 'project_journey'));
scenario('bathroom budget does not invent allocation', { ...base, message: 'bathroom remodel $5000' }, (d) => {
  assert.equal(d.mode, 'project_journey'); assert.equal(d.claims.allowedClasses.includes('catalog_fact'), false);
});
scenario('bathroom leak blocks products', { ...base, message: 'my bathroom is leaking' }, (d) => {
  assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.safety?.blocksProducts, true);
  assert.equal(d.safety?.guidanceUnavailable, false);
  assert.match(d.safety?.guidance?.[0]?.instruction || '', /turn off the water supply/i);
  assert.equal(d.safety?.guidance?.[0]?.sources[0]?.title, 'Verified trade guide');
});
scenario('unverified critical diagnosis yields unavailable guidance', { ...base, message: 'toilet leaking', matchedConcepts: matched(conceptId('problems/toilet-fault')) }, (d) => {
  assert.equal(d.safety?.guidanceUnavailable, true); assert.equal(d.commerce.addToCart, 'blocked');
});
scenario('electrical mould problem is safety first', { ...base, message: 'mould near an electrical outlet', matchedConcepts: matched(conceptId('problems/bathroom-leak')) }, (d) => assert.equal(d.mode, 'safety_then_diagnose'));
scenario('cleaner gives task-group overview', { ...base, message: 'cleaner' }, (d) => {
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.retrieval.scope.length, 3);
});
scenario('care query without usable verification would not make safe claim', { ...base, message: 'cleaner for matte black tapware', now: new Date('2028-01-01T00:00:00.000Z') }, (d) => {
  assert.equal(d.mode, 'evidence_answer'); assert.equal(d.claims.allowedClasses.includes('care_safety'), false);
});
scenario('verified care relationship permits sourced care claim', { ...base, message: 'cleaner for matte black tapware' }, (d) => {
  assert.equal(d.claims.allowedClasses.includes('care_safety'), true);
  assert.equal(d.retrieval.permission, 'allowed');
  assert.deepEqual(d.evidence?.sourceRefs, ['src-trade-guide']);
});
scenario('garage door is service intake', { ...base, message: 'garage door' }, (d) => {
  assert.equal(d.mode, 'service_intake'); assert.equal(d.commerce.addToCart, 'blocked');
});
scenario('order status bypasses OKF', { ...base, message: "where's my order" }, (d) => assert.equal(d.mode, 'operational_journey'));
scenario('insulation gives application groups', { ...base, message: 'insulation' }, (d) => {
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.retrieval.scope.length, 3);
});
scenario('expired relationship loses its claim class', { ...base, message: 'cleaner for matte black tapware', now: new Date('2028-01-01T00:00:00.000Z') }, (d) => assert.equal(d.claims.allowedClasses.includes('care_safety'), false));
scenario('known fact is not asked again', { ...base, message: 'screws', knownFacts: { substrate: 'timber' } }, (d) => {
  assert.equal(d.conceptId, conceptId('fastenings/wood-screws')); assert.equal(d.clarification, undefined);
});
scenario('customer declines a question and asks to see items', { ...base, message: 'screws just show me', matchedConcepts: matched(conceptId('fastenings/screws')), declinedQuestions: ['q.substrate'], forceShowResults: true }, (d) => {
  assert.equal(d.mode, 'direct_results'); assert.equal(d.clarification, undefined);
});
scenario('gibberish produces no match and no retrieval', { ...base, message: 'asdf' }, (d) => {
  assert.equal(d.mode, 'no_match'); assert.equal(d.retrieval.permission, 'blocked');
});
scenario('out-of-scope request produces no match', { ...base, message: 'book me an airline ticket' }, (d) => assert.equal(d.mode, 'no_match'));
scenario('cross-tenant concept is rejected', { ...base, tenantId: 'tenant-b', message: 'screws', matchedConcepts: matched(conceptId('fastenings/screws')) }, (d) => assert.equal(d.trace.reasonCodes.includes('cross_tenant_concept_rejected'), true));
scenario('active revocation suppresses pinned safety concept', { ...base, message: 'my bathroom is leaking', activeRevocations: [{ eventId: 'e1', revocationId: 'r1', eventType: 'created', tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-1.0.0', conceptIds: [conceptId('problems/bathroom-leak')], cascade: 'descendants', effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'safety correction', createdBy: 'safety-owner', createdAt: new Date('2026-10-09T00:00:00.000Z'), expiresAt: new Date('2026-10-20T00:00:00.000Z') }] }, (d) => {
  assert.deepEqual(d.trace.revocationsApplied, ['r1']); assert.equal(d.safety?.guidanceUnavailable, true);
});
scenario('required knowledge failure closes', { ...base, message: 'screws', knowledgeAvailability: { available: false, required: true, failurePolicy: 'fail_closed' } }, (d) => {
  assert.equal(d.mode, 'no_match'); assert.equal(d.claims.allowedClasses.length, 0);
});
scenario('optional enrichment failure permits legacy catalog facts only', { ...base, message: 'screws', knowledgeAvailability: { available: false, required: false, failurePolicy: 'enrichment_only' } }, (d) => {
  assert.equal(d.mode, 'legacy_search'); assert.deepEqual(d.claims.allowedClasses, ['catalog_fact']);
});
scenario('pinned release ID remains the decision release', { ...base, message: 'screws' }, (d) => assert.equal(d.trace.releaseId, 'okf-placemakers-1.0.0'));

assert.equal(passed, 34);
console.log(`✅ OKF gate suite: ${passed} passed, 0 failed`);
