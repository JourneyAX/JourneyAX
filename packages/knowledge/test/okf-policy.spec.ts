import assert from 'node:assert/strict';
import {
  OKF_PLATFORM_POLICY,
  compilePhrase,
  detectIntents,
  evaluateOkfDraft,
  foldText,
  tokenizeText,
  exportOkfBundle,
  extractSkuCandidate,
  importOkfBundle,
  renderOkfMessage,
  resolveOkfGate,
  resolveOkfPolicy,
  validateOkfDraftContent,
  validateOkfReleaseContent,
  validateOkfTenantPolicy,
  type OkfReleaseContent,
  type OkfTenantPolicy,
} from '../src';
import { buildOkfContent, conceptId } from './fixtures';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${passed}. ${name}`);
  } catch (error) {
    console.error(`  ✗ ${passed + 1}. ${name}`);
    throw error;
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const base = {
  tenantId: 'placemakers',
  environmentId: 'production',
  releaseId: 'r-policy',
  now: new Date('2026-10-10T00:00:00.000Z'),
};
const withPolicy = (policy: OkfTenantPolicy, mutate?: (content: OkfReleaseContent) => void): OkfReleaseContent => {
  const content = clone(buildOkfContent());
  content.policy = policy;
  mutate?.(content);
  return content;
};
const intentsOf = (message: string, policy?: OkfTenantPolicy) =>
  detectIntents(message, resolveOkfPolicy(policy)).intents;

console.log('🧪 OKF data-driven policy suite');

// ── platform defaults ────────────────────────────────────────────────────────
test('platform defaults detect the core intents without any tenant policy', () => {
  assert.deepEqual(intentsOf('where is my order'), ['order_status']);
  assert.ok(intentsOf('what is the warranty on this tap').includes('warranty'));
  assert.ok(intentsOf('how do I install this').includes('installation'));
  assert.ok(intentsOf('my kitchen sink tap is leaking').includes('problem'));
  assert.ok(intentsOf('there is a leak under the vanity').includes('problem'));
  assert.ok(intentsOf('just show me the options').includes('force_show'));
});

test('negations and product phrases do not become problems', () => {
  assert.ok(!intentsOf('no problem, I need screws').includes('problem'));
  assert.ok(!intentsOf('not a problem at all').includes('problem'));
  assert.ok(!intentsOf('damage-free fixings please').includes('problem'));
  assert.ok(!intentsOf('screwdriver set').includes('problem'));
});

test('platform policy file is the single source for messages, roles and thresholds', () => {
  assert.equal(OKF_PLATFORM_POLICY.matching.minimum, 0.75);
  assert.ok(OKF_PLATFORM_POLICY.messages.safety_heading);
  assert.ok(OKF_PLATFORM_POLICY.verifierRoles.some((role) => role.roleId === 'trade_expert'));
  assert.deepEqual(OKF_PLATFORM_POLICY.claimEvidence.legal_requirement, ['regulation']);
});

// ── phrase grammar ───────────────────────────────────────────────────────────
test('phrase grammar supports alternation, prefix, optional and wildcard tokens', () => {
  const words = ['i', 'want', 'to', 'return', 'my', 'big', 'blue', 'order'];
  const matches = (phrase: string) => {
    const compiled = compilePhrase(phrase);
    return detectIntents(words.join(' '), { ...resolveOkfPolicy(), intents: [{ intent: 'x', phrases: [compiled], suppressedBy: [] }] }).intents.includes('x');
  };
  assert.equal(matches('return|refund my'), true);
  assert.equal(matches('retur* my'), true);
  assert.equal(matches('return the? my'), true);
  assert.equal(matches('return my * order'), true);
  assert.equal(matches('return my order'), false, 'a wildcard needs at least one token and exact tokens must be adjacent');
  assert.equal(matches('refund my'), false);
});

test('invalid phrases are rejected at compile time', () => {
  assert.throws(() => compilePhrase('   '), /1-12 tokens|Empty/);
  assert.throws(() => compilePhrase('a b c d e f g h i j k l m'), /1-12 tokens/);
  assert.throws(() => compilePhrase('* a?'), /required literal/);
  assert.throws(() => compilePhrase('?'), /Empty phrase alternative/);
  assert.throws(() => compilePhrase('x'.repeat(200)), /too long/);
});

// ── tenant overrides: no code change needed for a different language or vocabulary ──
const spanish: OkfTenantPolicy = {
  locale: 'es',
  intents: [
    { intent: 'problem', phrases: ['mi * tiene|esta fuga|roto|averiado'], suppressedBy: ['no hay problema'] },
    { intent: 'force_show', phrases: ['solo muestrame', 'sin preguntas'] },
    { intent: 'order_status', phrases: ['donde esta mi pedido'] },
  ],
  messages: {
    guidance_temporarily_unavailable: 'La orientacion no esta disponible por ahora. Contacte a un profesional.',
    safety_guidance_unavailable: 'No hay orientacion de seguridad verificada. Contacte a un profesional.',
  },
};

test('a tenant lexicon replaces platform phrases for that intent and adds new ones', () => {
  assert.ok(intentsOf('mi lavabo esta roto', spanish).includes('problem'));
  assert.ok(!intentsOf('my sink is leaking', spanish).includes('problem'), 'replaced phrases no longer match');
  assert.ok(intentsOf('no hay problema, solo muestrame', spanish).includes('force_show'));
  assert.deepEqual(intentsOf('donde esta mi pedido', spanish).filter((i) => i === 'order_status'), ['order_status']);
});

test('extend mode appends to the platform phrases instead of replacing them', () => {
  const policy: OkfTenantPolicy = { intents: [{ intent: 'problem', extend: true, phrases: ['kaputt'] }] };
  assert.ok(intentsOf('my sink is leaking', policy).includes('problem'));
  assert.ok(intentsOf('kaputt', policy).includes('problem'));
});

test('tenant messages reach the gate decision and runtime message rendering', () => {
  const content = withPolicy(spanish);
  const decision = resolveOkfGate(content, {
    ...base, message: 'mi cocina tiene fuga', matchedConcepts: [{ id: conceptId('problems/toilet-fault'), score: 1 }],
  });
  assert.equal(decision.mode, 'safety_then_diagnose');
  assert.ok(decision.claims.disclaimers.some((text) => text.includes('seguridad verificada')));
  assert.equal(decision.messages.guidance_temporarily_unavailable, spanish.messages!.guidance_temporarily_unavailable);
  assert.equal(renderOkfMessage(decision.messages, 'safety_heading'), 'Safety first', 'untouched keys fall back to platform text');
});

test('message templates interpolate named variables and leave unknown ones intact', () => {
  assert.equal(renderOkfMessage({}, 'relationship_unverified', { relationshipId: 'rel-1', status: 'expired' }),
    "Relationship 'rel-1' is expired; compatibility, requirement, safety, and equivalence claims are not permitted.");
  assert.equal(renderOkfMessage({ x: 'Hello {name} {other}' }, 'x', { name: 'A' }), 'Hello A {other}');
});

test('matching thresholds are tenant data', () => {
  const strict = withPolicy({ matching: { minimum: 0.95 } });
  const decision = resolveOkfGate(strict, { ...base, message: 'i need some screws please' });
  assert.equal(decision.mode, 'no_match');
  assert.equal(decision.trace.reasonCodes[0], 'concept_not_found');
  const normal = resolveOkfGate(buildOkfContent(), { ...base, message: 'i need some screws please' });
  assert.notEqual(normal.mode, 'no_match');
});

test('"just show me" is detected from the message through the lexicon', () => {
  const decision = resolveOkfGate(buildOkfContent(), { ...base, message: 'screws, just show me' });
  assert.ok(decision.trace.reasonCodes.includes('customer_declined_questions'));
  assert.equal(decision.recommendation, 'category_examples');
});

// ── role registry ────────────────────────────────────────────────────────────
function withVerifiedRole(role: string, content = clone(buildOkfContent())): OkfReleaseContent {
  for (const record of content.verifications) if (record.status === 'verified') record.verifierRole = role;
  return content;
}

test('an unregistered verifier role cannot support a governed claim', () => {
  const result = validateOkfReleaseContent(withVerifiedRole('licensed plumber'), 'placemakers');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unqualified_verification'));
});

test('a tenant registers its own role and claim classes without code changes', () => {
  const content = withVerifiedRole('licensed_plumber');
  content.policy = { verifierRoles: [{ roleId: 'licensed_plumber', label: 'Licensed plumber', claimClasses: ['safety_instruction', 'care_safety', 'installation_step', 'compatibility', 'requirement'] }] };
  const result = validateOkfReleaseContent(content, 'placemakers');
  assert.equal(result.issues.filter((issue) => issue.code === 'unqualified_verification').length, 0,
    result.issues.map((issue) => `${issue.code}:${issue.message}`).join('\n'));
});

test('a role outside the claim class it signs is rejected', () => {
  const content = withVerifiedRole('merchant_policy_owner');
  const result = validateOkfReleaseContent(content, 'placemakers');
  assert.ok(result.issues.some((issue) => issue.code === 'unqualified_verification'));
});

// ── policy validation ────────────────────────────────────────────────────────
test('policy validation reports bad phrases, unknown message keys and unknown placeholders', () => {
  const problems = validateOkfTenantPolicy({
    intents: [{ intent: 'problem', phrases: ['a b c d e f g h i j k l m'] }],
    messages: { not_a_real_key: 'x', safety_heading: 'Hi {unknownVar}' },
  });
  assert.ok(problems.some((text) => text.includes('policy.intents[0]')));
  assert.ok(problems.some((text) => text.includes('unknown message key')));
  assert.ok(problems.some((text) => text.includes('unknown placeholder')));
});

test('the content validator surfaces invalid policy as a publication issue', () => {
  const content = withPolicy({ messages: { not_a_real_key: 'x' } });
  const result = validateOkfReleaseContent(content, 'placemakers');
  assert.ok(result.issues.some((issue) => issue.code === 'policy_invalid'));
});

test('tenants cannot override platform claim-evidence rules or unknown fields', () => {
  assert.equal(validateOkfTenantPolicy({ claimEvidence: { legal_requirement: ['crawl'] } }).length > 0, true);
});

test('releases without a policy keep their checksum shape (no injected keys)', () => {
  const parsed = validateOkfReleaseContent(buildOkfContent(), 'placemakers').content as any;
  assert.equal('policy' in parsed, false);
  assert.equal('acceptanceScenarios' in parsed, false);
});

// ── tenant acceptance scenarios ──────────────────────────────────────────────
function withScenarios(scenarios: NonNullable<OkfReleaseContent['acceptanceScenarios']>) {
  const content = clone(buildOkfContent());
  content.acceptanceScenarios = scenarios;
  const { index: _i, evaluation: _e, ...draft } = content;
  return { content, draft };
}

test('tenant acceptance scenarios run at publication and pass when the behaviour matches', () => {
  const { draft } = withScenarios([
    { scenarioId: 'broad-screws', message: 'screws', expect: { mode: 'overview_then_ask', recommendation: 'category_examples', clarificationFactKey: 'substrate' } },
    { scenarioId: 'known-substrate', message: 'screws', knownFacts: { substrate: 'timber' }, expect: { noClarification: true, retrievalPermission: 'allowed' } },
  ]);
  const results = evaluateOkfDraft(draft as any, 'placemakers', 'production', 'r-eval', '2026-10-10T00:00:00.000Z');
  const tenant = results.filter((entry) => entry.id.startsWith('tenant_scenario:'));
  assert.equal(tenant.length, 2);
  assert.ok(tenant.every((entry) => entry.passed), JSON.stringify(tenant));
});

test('a failing tenant scenario blocks the release with a readable reason', () => {
  const { draft } = withScenarios([
    { scenarioId: 'expects-wrong-mode', message: 'screws', expect: { mode: 'direct_results' } },
  ]);
  const results = evaluateOkfDraft(draft as any, 'placemakers', 'production', 'r-eval', '2026-10-10T00:00:00.000Z');
  const failed = results.find((entry) => entry.id === 'tenant_scenario:expects-wrong-mode');
  assert.equal(failed?.passed, false);
  assert.match(failed?.reason || '', /mode expected 'direct_results'/);
});

test('scenario references are validated (unknown concept, unknown fact, duplicate id)', () => {
  const { draft } = withScenarios([
    { scenarioId: 'dup', message: 'screws', expect: { conceptId: 'concept://placemakers/does/not-exist' } },
    { scenarioId: 'dup', message: 'screws', knownFacts: { nonexistent_fact: 'x' }, expect: {} },
  ]);
  const result = validateOkfDraftContent(draft, 'placemakers');
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes('unresolved_concept'));
  assert.ok(codes.includes('unknown_fact'));
  assert.ok(codes.includes('duplicate_id'));
});

// ── SKU shape policy ─────────────────────────────────────────────────────────
test('SKU detection is parameterised by the policy', () => {
  const sku = resolveOkfPolicy().sku;
  assert.equal(extractSkuCandidate('show me 1002486', sku), '1002486');
  assert.equal(extractSkuCandidate('sku AB-1234', sku), 'AB-1234');
  assert.equal(extractSkuCandidate('treated pine 90x45mm', sku), undefined);
  assert.equal(extractSkuCandidate('the 10-year warranty', sku), undefined);
  const tenant = resolveOkfPolicy({ sku: { numericMinLength: 8, explicitPrefixes: ['item', 'part number'] } }).sku;
  assert.equal(extractSkuCandidate('show me 1002486', tenant), undefined, 'a longer numeric minimum rejects 7 digits');
  assert.equal(extractSkuCandidate('part number XJ-9981', tenant), 'XJ-9981');
  const feet = resolveOkfPolicy({ sku: { measurementUnits: ['ft'] } }).sku;
  assert.equal(extractSkuCandidate('a 12ft ladder', feet), undefined);
});

// ── bundle round trip keeps tenant policy and scenarios ──────────────────────
test('policy and acceptance scenarios survive export then import', () => {
  const content = withPolicy(spanish);
  content.acceptanceScenarios = [{ scenarioId: 'es-1', message: 'solo muestrame', expect: { noClarification: true } }];
  const bundle = exportOkfBundle({
    releaseId: 'r-rt', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0',
    checksum: 'a'.repeat(64), status: 'ready', content, publishedAt: new Date('2026-10-10'), publishedBy: 'tester',
  } as any);
  const imported = importOkfBundle(bundle, 'placemakers');
  assert.equal(imported.draft.policy?.locale, 'es');
  assert.deepEqual(imported.draft.acceptanceScenarios?.map((s) => s.scenarioId), ['es-1']);
  assert.equal(imported.diagnostics.some((text) => text.includes('policy')), false);
});


const localized: OkfTenantPolicy = {
  locales: {
    fr: {
      intents: [
        { intent: 'order_status', phrases: ['où|ou est|sont ma|mon commande|colis'] },
        { intent: 'problem', phrases: ['mon|ma|mes * étincelle|etincelle|fuit|fuite'] },
      ],
      messages: { safety_heading: 'Sécurité d’abord' },
    },
    'fr-CA': { messages: { safety_heading: 'Sécurité avant tout' } },
    mi: { intents: [{ intent: 'returns', phrases: ['whakahoki*'] }] },
  },
};

test('tokenizer keeps letters of any script and folds diacritics', () => {
  assert.deepEqual(tokenizeText('Où est ma commande ?'), ['ou', 'est', 'ma', 'commande']);
  assert.deepEqual(tokenizeText('Whakahokia te tāpiri'), ['whakahokia', 'te', 'tapiri']);
  assert.deepEqual(tokenizeText('订单 在哪里 123'), ['订单', '在哪里', '123']);
  assert.equal(foldText('ĀÉÎ'), 'aei');
});

test('locale lexicon only applies for that language, with exact-then-language lookup', () => {
  const fr = resolveOkfPolicy(localized, 'fr-FR');
  assert.ok(detectIntents('où est ma commande', fr).intents.includes('order_status'));
  const en = resolveOkfPolicy(localized, 'en');
  assert.equal(detectIntents('où est ma commande', en).intents.includes('order_status'), false);
  assert.equal(resolveOkfPolicy(localized).locale, 'en');
  assert.equal(resolveOkfPolicy(localized, 'fr').locale, 'fr');
});

test('locale messages layer over the tenant default and prefer the exact region', () => {
  assert.equal(resolveOkfPolicy(localized, 'fr').messages.safety_heading, 'Sécurité d’abord');
  assert.equal(resolveOkfPolicy(localized, 'fr-CA').messages.safety_heading, 'Sécurité avant tout');
  assert.equal(resolveOkfPolicy(localized, 'de').messages.safety_heading, OKF_PLATFORM_POLICY.messages.safety_heading);
});

test('te reo Māori phrases match with macrons folded', () => {
  assert.ok(detectIntents('Whakahokia mai tēnei', resolveOkfPolicy(localized, 'mi')).intents.includes('returns'));
});

test('locale overlays are validated like the base policy', () => {
  assert.deepEqual(validateOkfTenantPolicy(localized), []);
  assert.ok(validateOkfTenantPolicy({ locales: { fr: { intents: [{ intent: 'returns', phrases: ['* a?'] }] } } }).some((p) => p.includes('policy.locales.fr')));
  assert.ok(validateOkfTenantPolicy({ locales: { fr: { messages: { nope: 'x' } } } }).some((p) => p.includes('policy.locales.fr.messages.nope')));
  assert.ok(validateOkfTenantPolicy({ locales: { 'not a locale': {} } }).length > 0);
});

test('the gate uses the request locale: a French safety problem beats a French order question', () => {
  const content: any = structuredClone(buildOkfContent());
  content.policy = localized;
  const base = { tenantId: 'placemakers', environmentId: 'production', releaseId: 'r', matchedConcepts: [{ id: conceptId('problems/bathroom-leak'), score: 1, matchedBy: 'test' }] };
  const mixed = resolveOkfGate(content, { ...base, locale: 'fr', message: 'Où est ma commande ? Mon appareil étincelle' });
  assert.equal(mixed.mode, 'safety_then_diagnose');
  const orderOnly = resolveOkfGate(content, { ...base, locale: 'fr', message: 'Où est ma commande ?' });
  assert.equal(orderOnly.mode, 'operational_journey');
  const wrongLocale = resolveOkfGate(content, { ...base, locale: 'en', message: 'Où est ma commande ?' });
  assert.notEqual(wrongLocale.mode, 'operational_journey');
});

test('locale policy survives bundle export and import', () => {
  const content: any = structuredClone(buildOkfContent());
  content.policy = localized;
  const bundle = exportOkfBundle({
    releaseId: 'r-loc', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0',
    checksum: 'a'.repeat(64), status: 'ready', content, publishedAt: new Date('2026-10-10'), publishedBy: 'tester',
  } as any);
  const imported = importOkfBundle(bundle, 'placemakers');
  assert.deepEqual(imported.draft.policy?.locales, localized.locales);
});


test('coverage defaults to fail-closed and only shopping can be opened', () => {
  const resolved = resolveOkfPolicy();
  assert.equal(resolved.coverage.uncoveredShopping.mode, 'blocked');
  assert.deepEqual(resolved.coverage.uncoveredShopping.commerce, { addToCart: 'blocked', checkout: 'blocked' });
  const open = { coverage: { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } } };
  assert.deepEqual(validateOkfTenantPolicy(open), []);
  assert.equal(resolveOkfPolicy(open as any).coverage.uncoveredShopping.mode, 'catalogue_only');
});

test('coverage rejects unwarned add-to-cart, unknown modes and any attempt to open problems or technical requests', () => {
  const bad = (coverage: unknown) => validateOkfTenantPolicy({ coverage }).length > 0;
  assert.equal(bad({ uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed', checkout: 'allowed' } } }), true);
  assert.equal(bad({ uncoveredShopping: { mode: 'open', commerce: { addToCart: 'blocked', checkout: 'blocked' } } }), true);
  assert.equal(bad({ uncoveredProblem: { mode: 'catalogue_only' } }), true);
  assert.equal(bad({ uncoveredTechnical: { mode: 'catalogue_only' } }), true);
});

test('the platform lexicon recognises hazards, technical questions and shopping requests', () => {
  const policy = resolveOkfPolicy();
  const intents = (text: string) => detectIntents(text, policy).intents;
  for (const text of ['my appliance is sparking', 'there is water near the power points', 'i can smell gas', 'gas leak in the garage', 'my heater is smoking']) {
    assert.ok(intents(text).includes('problem'), text);
  }
  for (const text of ['is it suitable for outdoor use', 'does this comply with the building code', 'is it load bearing']) {
    assert.ok(intents(text).includes('technical_requirement'), text);
  }
  for (const text of ['i need some paint brushes', 'looking for a cordless drill', 'do you sell hinges', 'how much is a sheet of ply']) {
    assert.ok(intents(text).includes('shopping'), text);
  }
  for (const text of ['complete laundry makeover', 'standard hinges', 'the cat sat on the mat']) {
    assert.equal(intents(text).includes('technical_requirement'), false, `${text} must not read as technical`);
  }
  assert.equal(intents('water the garden').includes('problem'), false, 'ordinary water is not a hazard');
});

console.log(`✅ OKF policy suite: ${passed} passed, 0 failed`);
