import {
  computeKnowledgeEntityHash,
  computeKnowledgeChecksum,
  type OkfReleaseContent,
} from '../src';

const TENANT = 'placemakers';
const id = (path: string) => `concept://${TENANT}/${path}`;

function concept(overrides: Record<string, any>): any {
  const value = {
    conceptId: id('misc/unknown'),
    tenantId: TENANT,
    type: 'product_category',
    name: 'Unknown',
    description: 'Test concept',
    synonyms: [],
    customerPhrases: [],
    lens: 'product',
    riskClass: 'standard',
    compatibilitySensitive: false,
    requiredFacts: [],
    discriminators: [],
    searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    commercePolicy: { addToCart: 'allowed', checkout: 'allowed' },
    safety: { blocksProducts: false, stepRefs: [] },
    evidenceRefs: [],
    lifecycle: { status: 'active_draft' },
    version: 1,
    ...overrides,
  };
  value.contentHash = computeKnowledgeEntityHash(value);
  return value;
}

function relationship(overrides: Record<string, any>): any {
  const value = {
    relationshipId: 'rel-unknown',
    from: id('misc/unknown'),
    to: id('misc/unknown-2'),
    type: 'relevant_to',
    strength: 'optional',
    scope: 'general',
    confidence: 'medium',
    sourceRefs: [],
    claimClasses: [],
    ...overrides,
  };
  value.contentHash = computeKnowledgeEntityHash(value);
  return value;
}

export function buildOkfContent(): OkfReleaseContent {
  const source = {
    sourceId: 'src-trade-guide',
    kind: 'manufacturer_document' as const,
    title: 'Verified trade guide',
    documentId: 'doc-trade-guide',
    uri: 'https://merchant.invalid/trade-guide.pdf',
    checksum: '1'.repeat(64),
    scope: 'family' as const,
  };

  const concepts = [
    concept({
      conceptId: id('fastenings/screws'),
      name: 'Screws',
      description: 'Threaded fixings grouped by substrate and environment.',
      synonyms: ['screw', 'fixings'],
      customerPhrases: ['i need screws'],
      compatibilitySensitive: true,
      riskClass: 'compatibility',
      requiredFacts: [{ factKey: 'substrate', importance: 'high' }],
      discriminators: [{
        factKey: 'substrate',
        questionRef: 'q.substrate',
        valueMap: { timber: id('fastenings/wood-screws'), metal: id('fastenings/metal-screws') },
        clarifyFirst: false,
      }],
      searchScope: { catalogCategoryIds: ['fastenings.screws'], enrichmentFacets: ['gauge', 'length'], excludeCategoryIds: ['tools.screwdrivers'] },
      broadQueryPolicy: {
        groupConceptIds: [id('fastenings/wood-screws'), id('fastenings/decking-screws'), id('fastenings/metal-screws')],
        maxItemsPerGroup: 2,
        questionRef: 'q.substrate',
        productRetrievalAllowed: true,
      },
      commercePolicy: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' },
    }),
    concept({
      conceptId: id('fastenings/wood-screws'),
      name: 'Wood screws',
      description: 'Fixings for timber.',
      synonyms: ['timber screws'],
      searchScope: { catalogCategoryIds: ['fastenings.wood-screws'], enrichmentFacets: [], excludeCategoryIds: [] },
    }),
    concept({
      conceptId: id('fastenings/metal-screws'),
      name: 'Metal screws',
      description: 'Fixings for metal.',
      searchScope: { catalogCategoryIds: ['fastenings.metal-screws'], enrichmentFacets: [], excludeCategoryIds: [] },
    }),
    concept({
      conceptId: id('fastenings/decking-screws'),
      name: 'Decking screws',
      description: 'Fixings used in deck projects.',
      customerPhrases: ['screws for my deck', 'deck screws'],
      compatibilitySensitive: true,
      riskClass: 'compatibility',
      requiredFacts: [{ factKey: 'deck_material', importance: 'high' }],
      discriminators: [{ factKey: 'deck_material', questionRef: 'q.deck_material', valueMap: {}, clarifyFirst: false }],
      searchScope: { catalogCategoryIds: ['fastenings.decking-screws'], enrichmentFacets: ['treatment', 'length'], excludeCategoryIds: [] },
      broadQueryPolicy: {
        groupConceptIds: [id('fastenings/decking-screws')],
        maxItemsPerGroup: 2,
        questionRef: 'q.deck_material',
        productRetrievalAllowed: true,
      },
      commercePolicy: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' },
    }),
    concept({
      conceptId: id('bathrooms/toilet'),
      name: 'Toilet',
      description: 'Toilet suites, seats, cisterns, and parts.',
      synonyms: ['toilets'],
      compatibilitySensitive: true,
      riskClass: 'compatibility',
      requiredFacts: [{ factKey: 'toilet_intent', importance: 'high' }],
      discriminators: [{
        factKey: 'toilet_intent',
        questionRef: 'q.toilet_intent',
        valueMap: { seat: id('bathrooms/toilet-seat'), fault: id('problems/toilet-fault'), replacement: id('bathrooms/replacement-toilet') },
        clarifyFirst: false,
      }],
      searchScope: { catalogCategoryIds: ['bathrooms.toilets'], enrichmentFacets: [], excludeCategoryIds: ['bathrooms.accessories'] },
      broadQueryPolicy: {
        groupConceptIds: [id('bathrooms/toilet-suites'), id('bathrooms/toilet-seat'), id('bathrooms/cistern-parts')],
        maxItemsPerGroup: 2,
        questionRef: 'q.toilet_intent',
        productRetrievalAllowed: true,
      },
      commercePolicy: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' },
    }),
    concept({ conceptId: id('bathrooms/toilet-suites'), name: 'Toilet suites', description: 'Complete toilet suites.', searchScope: { catalogCategoryIds: ['bathrooms.toilet-suites'], enrichmentFacets: [], excludeCategoryIds: ['bathrooms.toilet-seats'] } }),
    concept({ conceptId: id('bathrooms/toilet-seat'), name: 'Toilet seat', description: 'Replacement toilet seats.', synonyms: ['toilet seats'], searchScope: { catalogCategoryIds: ['bathrooms.toilet-seats'], enrichmentFacets: [], excludeCategoryIds: ['bathrooms.toilet-suites'] } }),
    concept({ conceptId: id('bathrooms/cistern-parts'), name: 'Cistern parts', description: 'Cistern components.', searchScope: { catalogCategoryIds: ['bathrooms.cistern-parts'], enrichmentFacets: [], excludeCategoryIds: [] } }),
    concept({
      conceptId: id('bathrooms/replacement-toilet'),
      name: 'Replacement toilet',
      description: 'Replacement toilet scoped by outlet type.',
      synonyms: ['replace toilet'],
      compatibilitySensitive: true,
      riskClass: 'compatibility',
      requiredFacts: [{ factKey: 'outlet_type', importance: 'high' }],
      discriminators: [{ factKey: 'outlet_type', questionRef: 'q.outlet_type', valueMap: {}, clarifyFirst: true }],
      searchScope: { catalogCategoryIds: ['bathrooms.toilet-suites'], enrichmentFacets: ['outlet_type'], excludeCategoryIds: ['bathrooms.toilet-seats'] },
      commercePolicy: { addToCart: 'blocked', checkout: 'requires_compatibility_resolution' },
    }),
    concept({
      conceptId: id('projects/bathroom'),
      name: 'Bathroom',
      description: 'Bathroom project planning.',
      synonyms: ['bathroom remodel', 'bathroom renovation'],
      type: 'room',
      lens: 'project',
      requiredFacts: [{ factKey: 'project_scope', importance: 'high' }],
      discriminators: [{ factKey: 'project_scope', questionRef: 'q.project_scope', valueMap: {}, clarifyFirst: false }],
    }),
    concept({
      conceptId: id('problems/toilet-fault'),
      name: 'Toilet fault',
      description: 'Troubleshooting a toilet fault.',
      synonyms: ['toilet leaking'],
      type: 'symptom',
      lens: 'problem',
      riskClass: 'safety_critical',
      safety: { blocksProducts: true, stepRefs: [id('safety/isolate-water')] },
      commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
    }),
    concept({
      conceptId: id('problems/bathroom-leak'),
      name: 'Bathroom leak',
      description: 'Water leak in a bathroom or under a vanity.',
      customerPhrases: ['my bathroom is leaking', 'water under my vanity'],
      type: 'symptom',
      lens: 'problem',
      riskClass: 'safety_critical',
      safety: { blocksProducts: true, stepRefs: [id('safety/isolate-water')] },
      commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
    }),
    concept({ conceptId: id('safety/isolate-water'), name: 'Isolate the water safely', description: 'Turn off the water supply at the nearest safe isolation point. If water is near electrical equipment or you cannot isolate it safely, stop and contact a qualified professional.', type: 'safety_step', lens: 'problem', riskClass: 'safety_critical', safety: { blocksProducts: true, stepRefs: [] }, commercePolicy: { addToCart: 'blocked', checkout: 'blocked' } }),
    concept({
      conceptId: id('cleaning/cleaners'),
      name: 'Cleaner',
      description: 'Cleaning products grouped by task and surface.',
      synonyms: ['cleaning products'],
      requiredFacts: [{ factKey: 'surface', importance: 'high' }],
      discriminators: [{ factKey: 'surface', questionRef: 'q.surface', valueMap: {}, clarifyFirst: false }],
      broadQueryPolicy: {
        groupConceptIds: [id('cleaning/indoor'), id('cleaning/outdoor'), id('cleaning/wipes')],
        maxItemsPerGroup: 2,
        questionRef: 'q.surface',
        productRetrievalAllowed: true,
      },
      searchScope: { catalogCategoryIds: ['cleaning'], enrichmentFacets: ['surface'], excludeCategoryIds: [] },
    }),
    concept({ conceptId: id('cleaning/indoor'), name: 'Indoor cleaners', description: 'Indoor cleaning products.' }),
    concept({ conceptId: id('cleaning/outdoor'), name: 'Outdoor cleaners', description: 'Outdoor cleaning products.' }),
    concept({ conceptId: id('cleaning/wipes'), name: 'Cleaning wipes', description: 'Cleaning wipes.' }),
    concept({
      conceptId: id('care/matte-black-tapware'),
      name: 'Matte black tapware care',
      description: 'Care guidance for matte black finishes.',
      customerPhrases: ['cleaner for matte black tapware'],
      type: 'care',
      lens: 'care',
      compatibilitySensitive: true,
      riskClass: 'compatibility',
      requiredFacts: [{ factKey: 'surface', importance: 'high' }],
      discriminators: [{ factKey: 'surface', questionRef: 'q.surface', valueMap: {}, clarifyFirst: true }],
      searchScope: { catalogCategoryIds: ['cleaning.indoor'], enrichmentFacets: ['surface'], excludeCategoryIds: [] },
      commercePolicy: { addToCart: 'blocked', checkout: 'requires_compatibility_resolution' },
    }),
    concept({ conceptId: id('services/garage-door'), name: 'Garage door service', description: 'Garage door measure and quote service.', synonyms: ['garage door'], type: 'service', lens: 'service', commercePolicy: { addToCart: 'blocked', checkout: 'blocked' } }),
    concept({
      conceptId: id('insulation'),
      name: 'Insulation',
      description: 'Insulation grouped by application.',
      requiredFacts: [{ factKey: 'application', importance: 'high' }],
      discriminators: [{ factKey: 'application', questionRef: 'q.application', valueMap: {}, clarifyFirst: false }],
      broadQueryPolicy: {
        groupConceptIds: [id('insulation/wall'), id('insulation/ceiling'), id('insulation/floor')],
        maxItemsPerGroup: 2,
        questionRef: 'q.application',
        productRetrievalAllowed: true,
      },
    }),
    concept({ conceptId: id('insulation/wall'), name: 'Wall insulation', description: 'Wall insulation.' }),
    concept({ conceptId: id('insulation/ceiling'), name: 'Ceiling insulation', description: 'Ceiling insulation.' }),
    concept({ conceptId: id('insulation/floor'), name: 'Floor insulation', description: 'Floor insulation.' }),
  ];

  const relationships = [
    relationship({ relationshipId: 'rel-wood-screws-parent', from: id('fastenings/wood-screws'), to: id('fastenings/screws'), type: 'child_of' }),
    relationship({ relationshipId: 'rel-metal-screws-parent', from: id('fastenings/metal-screws'), to: id('fastenings/screws'), type: 'child_of' }),
    relationship({ relationshipId: 'rel-decking-screws-parent', from: id('fastenings/decking-screws'), to: id('fastenings/screws'), type: 'child_of' }),
    relationship({
      relationshipId: 'rel-leak-safety',
      from: id('problems/bathroom-leak'),
      to: id('safety/isolate-water'),
      type: 'requires',
      strength: 'required',
      confidence: 'high',
      sourceRefs: ['src-trade-guide'],
      claimClasses: ['safety_instruction'],
      verificationRef: 'verify-leak-safety',
    }),
    relationship({
      relationshipId: 'rel-tapware-care',
      from: id('care/matte-black-tapware'),
      to: id('cleaning/indoor'),
      type: 'care_for',
      strength: 'recommended',
      confidence: 'high',
      sourceRefs: ['src-trade-guide'],
      claimClasses: ['care_safety'],
      verificationRef: 'verify-tapware-care',
    }),
  ];

  const verifications = [
    {
      recordId: 'verify-leak-safety',
      targetType: 'relationship' as const,
      targetId: 'rel-leak-safety',
      status: 'verified' as const,
      sourceRefs: ['src-trade-guide'],
      verifiedBy: 'trade-expert-1',
      verifierRole: 'trade_expert',
      verifiedAt: '2026-10-01T00:00:00.000Z',
      contentHash: relationships.find((entry) => entry.relationshipId === 'rel-leak-safety')!.contentHash,
      staleAfter: '2027-10-01T00:00:00.000Z',
    },
    {
      recordId: 'verify-tapware-care',
      targetType: 'relationship' as const,
      targetId: 'rel-tapware-care',
      status: 'verified' as const,
      sourceRefs: ['src-trade-guide'],
      verifiedBy: 'product-expert-1',
      verifierRole: 'product_manager',
      verifiedAt: '2026-10-01T00:00:00.000Z',
      contentHash: relationships.find((entry) => entry.relationshipId === 'rel-tapware-care')!.contentHash,
      staleAfter: '2027-10-01T00:00:00.000Z',
    },
  ];

  const content: any = {
    schemaVersion: '1.0.0',
    modelId: 'placemakers-trade-knowledge',
    factRegistry: [
      { factKey: 'substrate', type: 'enum', questionRef: 'q.substrate', question: 'What are you fixing, and into which material?', uiInputType: 'card_choice', options: [{ value: 'timber', label: 'Timber' }, { value: 'metal', label: 'Metal' }, { value: 'concrete', label: 'Concrete or masonry' }] },
      { factKey: 'deck_material', type: 'string', questionRef: 'q.deck_material', question: 'What deck material are you fixing?', uiInputType: 'text' },
      { factKey: 'toilet_intent', type: 'enum', questionRef: 'q.toilet_intent', question: 'Is this for a new toilet, replacement, accessory, or a fault?', uiInputType: 'card_choice', allowedValues: ['new', 'replacement', 'seat', 'fault'] },
      { factKey: 'outlet_type', type: 'enum', questionRef: 'q.outlet_type', question: 'Which outlet type do you need?', uiInputType: 'card_choice', allowedValues: ['s-trap', 'p-trap', 'unknown'] },
      { factKey: 'project_scope', type: 'enum', questionRef: 'q.project_scope', question: 'Are you renovating, building new, or fixing a problem?', uiInputType: 'card_choice', allowedValues: ['renovation', 'new', 'problem'] },
      { factKey: 'surface', type: 'string', questionRef: 'q.surface', question: 'Which surface or finish are you cleaning?', uiInputType: 'text' },
      { factKey: 'application', type: 'enum', questionRef: 'q.application', question: 'Is the insulation for a wall, ceiling, or floor?', uiInputType: 'card_choice', allowedValues: ['wall', 'ceiling', 'floor'] },
    ],
    concepts,
    relationships,
    sources: [source],
    evidenceChunks: [
      (() => {
        const chunk: any = {
          chunkId: 'chunk-trade-guide-care',
          sourceRef: 'src-trade-guide',
          conceptIds: [id('care/matte-black-tapware'), id('problems/bathroom-leak')],
          claimClasses: ['care_safety', 'safety_instruction'],
          title: 'Verified trade guide',
          content: 'Follow the verified care instructions for the selected finish. Isolate the water supply before inspecting an active leak.',
          applicability: { scope: 'family', refs: ['tapware', 'wet-area'] },
          ordinal: 0,
          uri: 'https://merchant.invalid/trade-guide.pdf',
        };
        chunk.contentHash = computeKnowledgeEntityHash(chunk);
        return chunk;
      })(),
    ],
    verifications,
    index: {
      embeddingModel: 'text-embedding-test',
      embeddingModelVersion: '1',
      chunkingVersion: '1',
      indexChecksum: '2'.repeat(64),
      builtAt: '2026-10-01T00:00:00.000Z',
      sourceChecksum: '3'.repeat(64),
    },
    evaluation: {
      reportId: 'eval-okf-1',
      passed: true,
      evaluatedAt: '2026-10-01T00:00:00.000Z',
      scenarioCount: 34,
      failedScenarioCount: 0,
    },
  };
  return content as OkfReleaseContent;
}

export function buildStoredOkfRelease(content = buildOkfContent()): any {
  return {
    releaseId: 'okf-placemakers-1.0.0',
    tenantId: TENANT,
    environmentId: 'production',
    version: '1.0.0',
    checksum: computeKnowledgeChecksum(content),
    status: 'ready',
    content,
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    publishedBy: 'test',
  };
}

export const conceptId = id;
