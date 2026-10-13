import assert from 'node:assert/strict';
import { resolveOkfGate, resolveOkfBasketCommerce, validateOkfReleaseContent, type OkfGateInput } from '../src';
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

console.log('🧪 Running 70 deterministic OKF gate scenarios...');

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
const clarifyFirstContent = structuredClone(content);
clarifyFirstContent.concepts.find((entry) => entry.conceptId === conceptId('bathrooms/replacement-toilet'))!.broadQueryPolicy = {
  groupConceptIds: [conceptId('bathrooms/toilet-suites')], maxItemsPerGroup: 2, productRetrievalAllowed: true,
};
assert.equal(resolveOkfGate(clarifyFirstContent, { ...base, message: 'replacement toilet', matchedConcepts: matched(conceptId('bathrooms/replacement-toilet')) }).mode,
  'clarify_then_search', 'merchant-authored clarifyFirst must override grouped overview for compatibility-sensitive products');
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
scenario('mixed operational + safety message cannot bypass safety', { ...base, message: 'Where is my order? My appliance is sparking', matchedConcepts: matched(conceptId('problems/bathroom-leak')) }, (d) => {
  assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.safety?.blocksProducts, true);
});
scenario('purely operational message still routes to the operational journey', { ...base, message: 'Where is my order?', matchedConcepts: matched(conceptId('problems/bathroom-leak')) }, (d) => assert.equal(d.mode, 'operational_journey'));
scenario('mixed message with no matched safety concept still escalates (safety outranks operational)', { ...base, message: 'Where is my order? My appliance is sparking' }, (d) => {
  assert.equal(d.mode, 'safety_then_diagnose'); assert.ok(d.trace.reasonCodes.includes('uncovered_problem'));
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
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.recommendation, 'category_examples'); assert.equal(d.clarification, undefined);
});
scenario('screwdriver is not matched to screws by substring', { ...base, message: 'screwdriver' }, (d) => {
  assert.equal(d.conceptId, undefined); assert.equal(d.mode, 'no_match');
});
scenario('negative problem wording does not trigger safety flow', { ...base, message: 'bathroom no problem' }, (d) => {
  assert.equal(d.mode, 'project_journey');
});
scenario('broken glass cleaner is a shopping request, not a diagnosis', { ...base, message: 'broken glass cleaner' }, (d) => {
  assert.equal(d.mode, 'overview_then_ask');
});
for (const message of ['mould resistant paint', 'smoke alarm', 'leak sealant for roof']) {
  const decision = resolveOkfGate(content, { ...base, message });
  assert.notEqual(decision.mode, 'safety_then_diagnose', `${message} must not be classified as a fault`);
}
scenario('my toilet is leaking remains a problem statement', { ...base, message: 'my toilet is leaking' }, (d) => {
  assert.equal(d.mode, 'safety_then_diagnose');
});
scenario('revoked matched parent cannot be bypassed by discriminator narrowing', { ...base, message: 'screws', knownFacts: { substrate: 'timber' }, activeRevocations: [{ eventId: 'e-parent', revocationId: 'r-parent', eventType: 'created', tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-1.0.0', conceptIds: [conceptId('fastenings/screws')], cascade: 'none', effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'correction', createdBy: 'owner', createdAt: new Date('2026-10-09T00:00:00.000Z'), expiresAt: new Date('2026-10-20T00:00:00.000Z') }] }, (d) => {
  assert.equal(d.trace.reasonCodes.includes('concept_revoked'), true); assert.equal(d.retrieval.permission, 'blocked');
});
scenario('retrieval-only revocation preserves claims but blocks retrieval and commerce', { ...base, message: 'screws', activeRevocations: [{ eventId: 'e-retrieval', revocationId: 'r-retrieval', eventType: 'created', tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-1.0.0', conceptIds: [conceptId('fastenings/screws')], cascade: 'none', effect: { suppressClaims: false, suppressRetrieval: true }, reason: 'catalog correction', createdBy: 'owner', createdAt: new Date('2026-10-09T00:00:00.000Z'), expiresAt: new Date('2026-10-20T00:00:00.000Z') }] }, (d) => {
  assert.equal(d.retrieval.permission, 'blocked'); assert.equal(d.commerce.addToCart, 'blocked');
});
scenario('gate decisions never mutate immutable concept commerce policy', { ...base, message: 'SKU POA', matchedConcepts: matched(conceptId('fastenings/screws')), exactSku: 'POA', commerceContext: { productStatus: 'poa' } }, () => {
  const concept = content.concepts.find((entry) => entry.conceptId === conceptId('fastenings/screws'))!;
  assert.equal(concept.commercePolicy.addToCart, 'allowed_with_warning');
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
  assert.equal(d.mode, 'knowledge_unavailable'); assert.equal(d.claims.allowedClasses.length, 0);
});
scenario('optional enrichment failure permits legacy catalog facts only', { ...base, message: 'screws', knowledgeAvailability: { available: false, required: false, failurePolicy: 'enrichment_only' } }, (d) => {
  assert.equal(d.mode, 'legacy_search'); assert.deepEqual(d.claims.allowedClasses, ['catalog_fact']);
});
scenario('pinned release ID remains the decision release', { ...base, message: 'screws' }, (d) => assert.equal(d.trace.releaseId, 'okf-placemakers-1.0.0'));

const blockedCriticalContent = structuredClone(content);
const blockedCriticalScrews = blockedCriticalContent.concepts.find((entry) => entry.conceptId === conceptId('fastenings/screws'))!;
blockedCriticalScrews.riskClass = 'safety_critical';
blockedCriticalScrews.commercePolicy.checkout = 'blocked';
for (const input of [
  { ...base, message: 'screws' },
  { ...base, message: 'SKU 123', matchedConcepts: matched(conceptId('fastenings/screws')), exactSku: '123' },
]) {
  assert.equal(
    resolveOkfGate(blockedCriticalContent, input).commerce.checkout,
    'blocked',
    'a safety-critical gate must never loosen an existing checkout block',
  );
}

const basketContent = structuredClone(content);
const governedWoodSku = basketContent.concepts.find((entry) => entry.conceptId === conceptId('fastenings/wood-screws'))!;
governedWoodSku.riskClass = 'safety_critical';
governedWoodSku.commercePolicy.checkout = 'blocked';
const basketInput = {
  availability: { excludeFlagPaths: ['discontinued', 'delisted'], statusPaths: ['status', 'lifecycle.status'], unavailableStatuses: ['discontinued', 'retired', 'poa'] },
  tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-1.0.0',
  items: [{ sku: 'WOOD-001' }, { sku: 'CLEAN-001' }],
  products: [
    { projectId: 'placemakers', sku: 'WOOD-001', categoryId: 'fastenings.wood-screws' },
    { projectId: 'placemakers', sku: 'CLEAN-001', categoryId: 'cleaning' },
  ],
};
assert.equal(resolveOkfBasketCommerce(basketContent, basketInput).commerce.checkout, 'blocked', 'basket safety policy must survive a later unrelated turn');
assert.equal(resolveOkfBasketCommerce(content, { ...basketInput, items: [{ sku: 'SCREW-001' }], products: [{ projectId: 'placemakers', sku: 'SCREW-001', categoryId: 'fastenings.screws' }] }).commerce.addToCart, 'allowed_with_warning');
assert.equal(resolveOkfBasketCommerce(content, { ...basketInput, products: [{ projectId: 'other', sku: 'WOOD-001', categoryId: 'fastenings.wood-screws' }] }).commerce.checkout, 'blocked');
assert.equal(resolveOkfBasketCommerce(content, { ...basketInput, products: [{ projectId: 'other', tenantId: 'placemakers', sku: 'WOOD-001', categoryId: 'fastenings.wood-screws' }] }).commerce.checkout, 'blocked');

{
  const unavailable = (product: Record<string, unknown>, availability = basketInput.availability) => resolveOkfBasketCommerce(content, {
    ...basketInput, availability, items: [{ sku: 'SCREW-001' }],
    products: [{ projectId: 'placemakers', sku: 'SCREW-001', categoryId: 'fastenings.screws', ...product }],
  });
  assert.deepEqual(unavailable({ status: 'Retired' }).reasonCodes, ['unavailable_catalog_sku']);
  assert.deepEqual(unavailable({ lifecycle: { status: 'POA' } }).reasonCodes, ['unavailable_catalog_sku']);
  assert.deepEqual(unavailable({ discontinued: true }).reasonCodes, ['unavailable_catalog_sku']);
  assert.notDeepEqual(unavailable({ status: 'Retired' }, { ...basketInput.availability, unavailableStatuses: [] }).reasonCodes, ['unavailable_catalog_sku'], 'vocabulary is data, not code');
  passed++;
  console.log(`  ✓ ${passed}. basket lifecycle vocabulary is caller-supplied data`);
}


// ── Uncovered requests: classify first; never a blanket allow ─────────────────────────────────────────────────
function covered(coverage: any) { const c: any = structuredClone(content); c.policy = coverage ? { coverage } : undefined; return c; }
const OPEN_BROWSE = { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } };
function uncovered(name: string, message: string, extra: Partial<OkfGateInput>, coverage: any, verify: (d: ReturnType<typeof resolveOkfGate>) => void) {
  const decision = resolveOkfGate(covered(coverage), { ...base, message, ...extra });
  try { verify(decision); passed++; console.log(`  ✓ ${passed}. ${name}`); }
  catch (error) { console.error(`  ✗ ${passed + 1}. ${name}`); throw error; }
}
const noProductsNoCheckout = (d: ReturnType<typeof resolveOkfGate>) => {
  assert.equal(d.retrieval.permission, 'blocked'); assert.equal(d.commerce.addToCart, 'blocked'); assert.equal(d.commerce.checkout, 'blocked');
  assert.deepEqual(d.claims.allowedClasses, []);
};
const escalates = (d: ReturnType<typeof resolveOkfGate>) => {
  assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.safety?.guidanceUnavailable, true); assert.equal(d.safety?.blocksProducts, true);
  assert.equal(d.safety?.guidance?.length, 0, 'no guidance is invented'); noProductsNoCheckout(d); assert.ok(d.trace.reasonCodes.includes('uncovered_problem'));
};
for (const [name, message] of [
  ['"my appliance is sparking" escalates even when shopping is open', 'my appliance is sparking'],
  ['water near the power points escalates', 'there is water near the power points in my laundry'],
  ['a gas smell escalates', 'i can smell gas in the kitchen'],
  ['smoke from a heater escalates', 'my heater is smoking'],
  ['a safety problem inside a purchase request still escalates', 'i want to buy a new plug my socket is sparking'],
]) uncovered(name, message, {}, OPEN_BROWSE, escalates);

uncovered('an unknown technical requirement gets no claims, no products and no checkout', 'is this timber suitable for a load bearing deck', {}, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'no_match'); noProductsNoCheckout(d); assert.ok(d.trace.reasonCodes.includes('uncovered_technical'));
  assert.match(d.claims.disclaimers[0], /can't confirm technical/);
});
uncovered('"does this comply with the building code" is technical, not shopping', 'do you sell something that complies with the building code', {}, OPEN_BROWSE, (d) => {
  assert.ok(d.trace.reasonCodes.includes('uncovered_technical')); noProductsNoCheckout(d);
});
uncovered('ordinary broad shopping is blocked unless the release opts in', 'i need some paint brushes', {}, undefined, (d) => {
  assert.equal(d.mode, 'no_match'); noProductsNoCheckout(d); assert.ok(d.trace.reasonCodes.includes('uncovered_shopping_blocked'));
});
uncovered('opted-in shopping shows only catalogue facts with the configured, restricted commerce policy', 'i need some paint brushes', {}, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'legacy_search'); assert.equal(d.retrieval.permission, 'allowed');
  assert.deepEqual(d.claims.allowedClasses, ['catalog_fact']);
  assert.deepEqual(d.commerce, { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' });
  assert.equal(d.catalogHandling.requiresLiveValidation, true); assert.deepEqual(d.retrieval.categoryIds, []);
  assert.match(d.claims.disclaimers[0], /can't confirm compatibility/);
});
uncovered('an exact SKU is shopping; blocked by default, catalogue-only when opted in', 'sku 4400123', { exactSku: '4400123' }, undefined, (d) => noProductsNoCheckout(d));
uncovered('an exact SKU with the opt-in shows catalogue facts only', 'sku 4400123', { exactSku: '4400123' }, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'legacy_search'); assert.deepEqual(d.claims.allowedClasses, ['catalog_fact']);
});
uncovered('a bare noun is unknown without live catalogue evidence', 'paint brushes', {}, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'no_match'); noProductsNoCheckout(d); assert.ok(d.trace.reasonCodes.includes('uncovered_unknown'));
});
uncovered('a bare noun the live catalogue recognises becomes catalogue-only shopping', 'paint brushes', { catalogueMatch: true }, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'legacy_search'); assert.ok(d.trace.reasonCodes.includes('uncovered_shopping_catalogue_only'));
});
uncovered('catalogue evidence cannot override a hazard', 'my heater is smoking', { catalogueMatch: true }, OPEN_BROWSE, escalates);
uncovered('small talk is unknown and retrieves nothing', 'hello there', {}, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'no_match'); noProductsNoCheckout(d);
});
uncovered('an uncovered order question still reaches the operational journey', 'where is my order', {}, OPEN_BROWSE, (d) => assert.equal(d.mode, 'operational_journey'));
uncovered('governed concepts are unaffected by the coverage setting', 'screw', { matchedConcepts: matched(conceptId('fastenings/screws')) }, OPEN_BROWSE, (d) => {
  assert.equal(d.mode, 'overview_then_ask'); assert.equal(d.commerce.checkout, 'requires_compatibility_resolution');
});

// ── Basket: uncovered categories follow the explicit opt-in and still pass product checks ──────────────────────
{
  const basketBase = { ...basketInput, items: [{ sku: 'ODD-001' }], products: [{ projectId: 'placemakers', sku: 'ODD-001', categoryId: 'brushes.paint' }] };
  const run = (coverage: any, over: Record<string, unknown> = {}) => resolveOkfBasketCommerce(covered(coverage), { ...basketBase, ...over } as any);
  const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${passed}. ${name}`); };
  check('basket: an uncovered category is blocked by default', () => {
    const d = run(undefined); assert.equal(d.commerce.addToCart, 'blocked'); assert.ok(d.reasonCodes.includes('unmapped_catalog_category'));
  });
  check('basket: an opted-in uncovered category gets only the configured restricted policy plus a warning', () => {
    const d = run(OPEN_BROWSE);
    assert.deepEqual(d.commerce, { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' });
    assert.ok(d.reasonCodes.includes('uncovered_catalog_category')); assert.match(d.warnings[0], /can't confirm compatibility/);
  });
  check('basket: the opt-in never rescues an unavailable, unknown or ambiguous SKU', () => {
    const avail = { ...basketInput.availability };
    assert.equal(run(OPEN_BROWSE, { products: [{ projectId: 'placemakers', sku: 'ODD-001', categoryId: 'brushes.paint', status: 'retired' }], availability: avail }).commerce.addToCart, 'blocked');
    assert.equal(run(OPEN_BROWSE, { items: [{ sku: 'NOPE' }] }).commerce.addToCart, 'blocked');
    assert.equal(run(OPEN_BROWSE, { products: [{ projectId: 'other', sku: 'ODD-001', categoryId: 'brushes.paint' }] }).commerce.addToCart, 'blocked');
  });
  check('basket: the strictest of governed and opted-in uncovered policy wins', () => {
    const strict = { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_professional_confirmation' } } };
    const d = run(strict, { items: [{ sku: 'ODD-001' }, { sku: 'SCREW-001' }], products: [
      { projectId: 'placemakers', sku: 'ODD-001', categoryId: 'brushes.paint' },
      { projectId: 'placemakers', sku: 'SCREW-001', categoryId: 'fastenings.screws' }] });
    assert.equal(d.commerce.checkout, 'requires_professional_confirmation');
    const alone = run(OPEN_BROWSE, { items: [{ sku: 'SCREW-001' }], products: [{ projectId: 'placemakers', sku: 'SCREW-001', categoryId: 'fastenings.screws' }] });
    assert.equal(alone.commerce.checkout, 'requires_compatibility_resolution', 'governed products keep their own policy');
  });
}

// ── A product concept never answers a problem or hazard message ───────────────────────────────────────────────
{
  const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${passed}. ${name}`); };
  const product = (message: string, extra: Partial<OkfGateInput> = {}) => resolveOkfGate(content, { ...base, message, matchedConcepts: matched(conceptId('fastenings/screws')), ...extra }) as any;
  check('a matched product concept with a hazard message escalates instead of listing products', () => {
    const d = product('my screws are sparking');
    assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.safety.guidanceUnavailable, true);
    assert.equal(d.retrieval.permission, 'blocked'); assert.equal(d.commerce.addToCart, 'blocked'); assert.deepEqual(d.claims.allowedClasses, []);
    assert.ok(d.trace.reasonCodes.includes('problem_without_problem_concept'));
  });
  check('"leaky" and "leak" wording is a problem too, so a product shelf never answers it', () => {
    for (const message of ['leaky screws', 'screws leak', 'my screws are leaking']) {
      const d = product(message);
      assert.equal(d.mode, 'safety_then_diagnose', message); assert.equal(d.retrieval.permission, 'blocked', message);
      assert.ok(d.trace.reasonCodes.includes('problem_without_problem_concept'), message);
    }
    assert.equal(product('leak proof screws').mode, 'overview_then_ask', 'a leak-proof product is still shopping');
  });
  check('the same concept without a problem intent is unaffected', () => {
    assert.equal(product('i need screws').mode, 'overview_then_ask');
  });
  check('a problem-lens concept still handles its own problem', () => {
    const d = resolveOkfGate(content, { ...base, message: 'my bathroom is leaking', matchedConcepts: matched(conceptId('problems/bathroom-leak')) }) as any;
    assert.equal(d.mode, 'safety_then_diagnose'); assert.ok(!d.trace.reasonCodes.includes('problem_without_problem_concept'));
    assert.equal(d.conceptId, conceptId('problems/bathroom-leak'));
  });
  check('an exact SKU cannot smuggle a hazard past the gate', () => {
    const d = product('sku 4400123 is sparking', { exactSku: '4400123' });
    assert.equal(d.mode, 'safety_then_diagnose'); assert.equal(d.retrieval.permission, 'blocked');
  });
}

assert.equal(passed, 45 + 17 + 4 + 5);
console.log(`✅ OKF gate suite: ${passed} passed, 0 failed`);
