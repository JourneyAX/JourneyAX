/**
 * Deterministic legacy Business Pack fixture (checksumSchemaVersion absent, no routingPolicy,
 * no factRegistry/knowledgeModel). Shared by the golden-checksum test and by the offline
 * cross-check against the pre-change (HEAD) checksum algorithm. Do NOT edit casually: any change
 * invalidates the fixed golden checksum asserted in pack-canonical-content.spec.ts.
 */
export const rawLegacyFixture = {
  manifest: {
    packId: 'pack_canonical_test',
    tenantId: 'placemakers',
    name: 'PlaceMakers Trade Supplies',
    version: '1.0.0',
    description: 'Building Materials & Trade Supplies Business Pack',
    schemaVersion: '1.0.0',
    environmentId: 'production',
    author: 'studio',
  },
  profile: {
    companyName: 'PlaceMakers',
    industry: 'building_supplies',
    primaryGoals: ['materials_consultation', 'quote_generation'],
    locales: ['en-NZ', 'en-AU'],
  },
  vocabulary: {
    version: '1.0.0',
    dimensions: [
      {
        name: 'room_type',
        type: 'string',
        allowedValues: ['laundry', 'bathroom', 'kitchen'],
        promptOnMissing: 'Which room are you renovating?',
        required: true,
      },
    ],
    terms: [{ term: 'linings', canonical: 'linings', description: 'Interior wall linings' }],
    acronyms: { WANZ: 'Window Association of New Zealand' },
    slotSynonyms: { room_type: ['room', 'space', 'area'] },
    slotQuestions: {
      room_type: {
        text: 'What room are you working on?',
        options: ['laundry', 'bathroom'],
      },
    },
    slotMappings: {},
    prohibitedTerms: ['unlicensed_work'],
  },
  entities: {
    version: '1.0.0',
    entities: [
      {
        entityId: 'project_spec',
        displayName: 'Project Specification',
        description: 'Dimensions and materials required',
        attributes: [
          { name: 'length_mm', type: 'number', required: false },
          { name: 'material', type: 'string', required: true },
        ],
      },
    ],
  },
  conversationPolicy: {
    fencingRules: ['Stay within building codes and trade supplies'],
    prohibitedTopics: ['electrical_wiring'],
    maxClarificationQuestionsPerTurn: 3,
    allowJourneySwitch: true,
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  },
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'p_standard',
    policies: [
      {
        policyId: 'p_standard',
        candidates: [{ provider: 'openai', model: 'gpt-4o', priority: 1 }],
        dataResidency: 'au',
        fallbackAllowed: false,
        maxInputTokens: 8000,
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
    ],
  },
  agents: [
    {
      agentId: 'consultant_agent',
      name: 'Trade Consultant',
      purpose: 'Advise on materials and products',
      modelPolicyRef: 'p_standard',
      allowedTools: ['catalog.search'],
      inputSchema: {},
      outputSchema: {},
      maxTurns: 5,
      handoffConditions: [],
    },
  ],
  journeys: [
    {
      journeyId: 'journey_laundry_renovation',
      version: '1.0.0',
      displayName: 'Laundry Renovation',
      goals: ['Size and quote laundry materials'],
      initialStage: 'stage_intake',
      stages: {
        stage_intake: {
          stageId: 'stage_intake',
          displayName: 'Intake',
          requiredFacts: [{ key: 'room_type', source: 'customer' }],
          allowedCapabilities: ['catalog.search'],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [],
        },
      },
    },
  ],
  rules: [],
  capabilities: {
    version: '1.0.0',
    toolDefinitions: [
      {
        toolId: 'catalog.search',
        name: 'Search Catalog',
        displayName: 'Catalog Search Tool',
        description: 'Search trade catalog',
        risk: 'low',
        sideEffect: 'read',
        parameters: { query: { type: 'string' } },
      },
    ],
    toolBindings: [
      {
        toolId: 'catalog.search',
        tenantId: 'placemakers',
        environmentId: 'production',
        executor: {
          type: 'native_capability',
          capabilityId: 'catalog_search',
        },
      },
    ],
    stageBindings: [
      {
        journeyId: 'journey_laundry_renovation',
        stageId: 'stage_intake',
        tools: [{ toolId: 'catalog.search' }],
      },
    ],
  },
  experience: {
    version: '1.0.0',
    theme: {
      primaryColor: '#0F172A',
      accentColor: '#3B82F6',
      fontFamily: 'Inter, sans-serif',
      borderRadius: '8px',
      customCssVars: {},
    },
    cards: {
      allowedCardTypes: ['bundle', 'products', 'quote'],
      defaultCardRenderer: '@journeyax/ui-cards',
    },
  },
  evaluations: [],
  extensions: {},
};
