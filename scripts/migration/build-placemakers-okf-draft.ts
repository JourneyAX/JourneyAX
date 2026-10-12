/**
 * Builds the PlaceMakers OKF *draft* (docs/migrations/placemakers-okf-draft.json).
 *
 * This is authoring input, not a release: hashes are computed here, but the file is meant to be loaded into the
 * OKF Studio (Advanced typed release editor, or bundle import), reviewed by PlaceMakers, verified and attested by
 * assigned humans, then published. Nothing here talks to a database.
 *
 *   npx tsx scripts/migration/build-placemakers-okf-draft.ts
 *
 * Safety guidance is deliberately shipped as an UNVERIFIED model-drafted source: the platform will not present it
 * as verified. Until a PlaceMakers trade expert supplies a `trade_expert` (or `manufacturer_document`) source and
 * verifies the relationship, a bathroom leak yields "contact a qualified professional" with products paused.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  computeKnowledgeEntityHash,
  evaluateOkfDraft,
  validateOkfDraftContent,
  validateOkfTenantPolicy,
} from '../../packages/knowledge/src';

const TENANT = 'placemakers';
const id = (p: string) => `concept://${TENANT}/${p}`;

function concept(overrides: Record<string, any>): any {
  const value: any = {
    tenantId: TENANT, type: 'product_category', synonyms: [], customerPhrases: [], lens: 'product', riskClass: 'standard',
    compatibilitySensitive: false, requiredFacts: [], discriminators: [],
    searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    commercePolicy: { addToCart: 'allowed', checkout: 'allowed' }, safety: { blocksProducts: false, stepRefs: [] },
    evidenceRefs: [], lifecycle: { status: 'active_draft' }, version: 1, ...overrides,
  };
  value.contentHash = computeKnowledgeEntityHash(value);
  return value;
}

function withHash<T extends Record<string, any>>(value: T): T & { contentHash: string } {
  return { ...value, contentHash: computeKnowledgeEntityHash(value) };
}

const GENERATED_AT = '2026-10-12T00:00:00.000Z';

const concepts = [
  concept({
    conceptId: id('fastenings/screws'), type: 'product_family', name: 'Screws',
    description: 'Screws and fixings, grouped by what they are fixed into.',
    synonyms: ['screw', 'screws', 'fixings'], customerPhrases: ['i need screws', 'screws', 'what screws do i need'],
    compatibilitySensitive: true, riskClass: 'compatibility',
    requiredFacts: [{ factKey: 'fastener_substrate', importance: 'high' }],
    discriminators: [{
      factKey: 'fastener_substrate', questionRef: 'q.fastener_substrate', clarifyFirst: false,
      valueMap: { timber: id('fastenings/wood-screws'), metal: id('fastenings/metal-screws'), masonry: id('fastenings/masonry-anchors') },
    }],
    searchScope: { catalogCategoryIds: ['Wood Screws', 'Metal Screws', 'Masonry  Anchors'], enrichmentFacets: ['length', 'gauge'], excludeCategoryIds: ['Screwdrivers', 'Screwdriver Bits', 'Drill Bits'] },
    broadQueryPolicy: {
      groupConceptIds: [id('fastenings/wood-screws'), id('fastenings/metal-screws'), id('fastenings/masonry-anchors')],
      maxItemsPerGroup: 2, questionRef: 'q.fastener_substrate', productRetrievalAllowed: true,
    },
    commercePolicy: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' },
  }),
  concept({
    conceptId: id('fastenings/wood-screws'), name: 'Wood screws', description: 'Screws for fixing into timber.',
    synonyms: ['timber screws'], customerPhrases: ['screws for timber', 'wood screws'],
    searchScope: { catalogCategoryIds: ['Wood Screws'], enrichmentFacets: ['length', 'gauge'], excludeCategoryIds: [] },
  }),
  concept({
    conceptId: id('fastenings/metal-screws'), name: 'Metal screws', description: 'Screws for fixing into steel or other metal.',
    synonyms: ['self drilling screws'], customerPhrases: ['screws for metal', 'metal screws'],
    searchScope: { catalogCategoryIds: ['Metal Screws'], enrichmentFacets: ['length', 'gauge'], excludeCategoryIds: [] },
  }),
  concept({
    conceptId: id('fastenings/masonry-anchors'), name: 'Masonry anchors', description: 'Anchors and screws for concrete, brick and block.',
    synonyms: ['concrete screws', 'wall anchors'], customerPhrases: ['screws for concrete', 'masonry screws'],
    searchScope: { catalogCategoryIds: ['Masonry  Anchors'], enrichmentFacets: ['length'], excludeCategoryIds: [] },
  }),
  concept({
    conceptId: id('problems/bathroom-leak'), type: 'symptom', lens: 'problem', name: 'Bathroom leak',
    description: 'Water leaking from a shower, toilet, vanity, wall or floor in a bathroom.',
    synonyms: ['leak', 'leaking', 'water damage'], customerPhrases: ['bathroom is leaking', 'my bathroom is leaking', 'water under my vanity', 'shower is leaking', 'toilet is leaking'],
    riskClass: 'safety_critical', safety: { blocksProducts: true, stepRefs: [id('safety/isolate-water')] },
    requiredFacts: [{ factKey: 'leak_location', importance: 'high' }],
    discriminators: [{ factKey: 'leak_location', questionRef: 'q.leak_location', valueMap: {}, clarifyFirst: false }],
    commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
  }),
  concept({
    conceptId: id('safety/isolate-water'), type: 'safety_step', lens: 'problem', name: 'Isolate the water and stay clear of electrics',
    description: 'If water is running or dripping, turn off the water supply at the nearest safe isolation point and stop using the fixture. If water is near power points or lights, keep clear and contact a licensed tradesperson.',
    riskClass: 'safety_critical', safety: { blocksProducts: true, stepRefs: [] }, commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
    evidenceRefs: ['src-leak-safety-draft'],
  }),
];

const sources = [{
  sourceId: 'src-leak-safety-draft', kind: 'llm_draft', title: 'Model-drafted leak safety wording — NOT verified',
  model: 'claude-sonnet-5-5', promptHash: 'a'.repeat(64), generatedAt: GENERATED_AT,
}];

const relationships = [withHash({
  relationshipId: 'rel-leak-isolate-water', from: id('problems/bathroom-leak'), to: id('safety/isolate-water'),
  type: 'requires', strength: 'required', scope: 'general', confidence: 'low',
  sourceRefs: ['src-leak-safety-draft'], claimClasses: ['safety_instruction'],
})];

const evidenceChunks = [withHash({
  chunkId: 'chunk-leak-safety-draft', sourceRef: 'src-leak-safety-draft', conceptIds: [id('problems/bathroom-leak'), id('safety/isolate-water')],
  claimClasses: ['safety_instruction'], title: 'Leak first response (draft — needs PlaceMakers trade review)',
  content: 'If water is actively running or dripping, turn off the water supply at the nearest safe isolation point and stop using the fixture. If there is water near power points or lights, keep clear and contact a licensed tradesperson.',
  applicability: { scope: 'general', refs: [] }, ordinal: 0,
})];

const draft: any = {
  schemaVersion: '1.0.0',
  modelId: 'placemakers-trade-knowledge',
  factRegistry: [
    { factKey: 'fastener_substrate', type: 'enum', questionRef: 'q.fastener_substrate', question: 'What are you screwing into?', uiInputType: 'card_choice',
      options: [{ value: 'timber', label: 'Timber' }, { value: 'metal', label: 'Metal' }, { value: 'masonry', label: 'Concrete, brick or block' }] },
    { factKey: 'leak_location', type: 'enum', questionRef: 'q.leak_location', question: 'Where is the water showing up?', uiInputType: 'card_choice',
      options: [{ value: 'shower', label: 'Shower or bath' }, { value: 'toilet', label: 'Around the toilet' }, { value: 'vanity', label: 'Vanity or basin' }, { value: 'wall_ceiling', label: 'Wall or ceiling' }, { value: 'unknown', label: 'Not sure' }] },
  ],
  concepts, relationships, sources, evidenceChunks,
  // Unverified on purpose: the model-drafted source cannot back a verified safety claim.
  verifications: [],
  acceptanceScenarios: [
    { scenarioId: 'screws-broad', description: 'Broad "screw" shows grouped examples and asks what it is going into', message: 'screw',
      expect: { mode: 'overview_then_ask', clarificationFactKey: 'fastener_substrate', retrievalPermission: 'allowed' } },
    { scenarioId: 'screws-for-timber', description: 'A stated substrate narrows directly to wood screws', message: 'screws for timber',
      knownFacts: { fastener_substrate: 'timber' }, expect: { conceptId: id('fastenings/wood-screws') } },
    { scenarioId: 'leak-safety-first', description: 'A bathroom leak is safety first and pauses products', message: 'bathroom is leaking',
      expect: { mode: 'safety_then_diagnose', retrievalPermission: 'blocked', commerce: { addToCart: 'blocked', checkout: 'blocked' } } },
    { scenarioId: 'leak-beats-order-question', description: 'Safety outranks an order question in the same message', message: 'Where is my order? My bathroom is leaking',
      expect: { mode: 'safety_then_diagnose', retrievalPermission: 'blocked' } },
  ],
};

const problems = [
  ...validateOkfDraftContent(draft, TENANT).issues.map((issue) => `${issue.code}: ${issue.message}`),
  ...validateOkfTenantPolicy(draft.policy ?? {}),
];
const results = evaluateOkfDraft(draft, TENANT, 'production', 'draft:placemakers', GENERATED_AT);
const failed = results.filter((result) => !result.passed);

const out = path.resolve(__dirname, '../../docs/migrations/placemakers-okf-draft.json');
writeFileSync(out, `${JSON.stringify(draft, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
console.log(`draft validation: ${problems.length === 0 ? 'valid' : `${problems.length} issue(s)`}`);
for (const problem of problems) console.log(`  - ${problem}`);
console.log(`publication evaluation: ${results.length - failed.length}/${results.length} scenarios passed`);
for (const result of failed) console.log(`  ✗ ${result.id}: ${result.reason}`);
process.exitCode = problems.length || failed.length ? 1 : 0;
