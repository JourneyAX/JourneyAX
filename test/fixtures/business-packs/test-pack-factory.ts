import { BusinessPackRelease } from '@journeyax/business-pack';
import { computePackChecksum } from '@journeyax/business-pack';

export interface TestPackOptions {
  tenantId?: string;
  environmentId?: 'dev' | 'test' | 'staging' | 'production';
  version?: string;
  modelPolicy?: any;
  extensions?: Record<string, any>;
}

/**
 * Creates an in-memory, sanitized, domain-neutral Business Pack release for tests.
 * Never touches filesystem or customer production data.
 */
export function createSanitizedTestPack(options: TestPackOptions = {}): BusinessPackRelease {
  const tenantId = options.tenantId || 'placemakers';
  const environmentId = options.environmentId || 'production';
  const version = options.version || '1.0.0';

  const defaultModelPolicy = {
    version: '1.0.0',
    defaultPolicy: 'complex_reasoning',
    policies: [
      {
        policyId: 'fast_intent',
        description: 'Fast turn classification and intent extraction',
        dataResidency: 'au',
        acceptedResidencies: ['au', 'us', 'global'],
        candidates: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            priority: 1,
            temperature: 0.0,
          },
        ],
        fallbackAllowed: false,
        timeoutMs: 5000,
        maxInputTokens: 8000,
        maxOutputTokens: 1000,
      },
      {
        policyId: 'complex_reasoning',
        description: 'Complex multi-step journey reasoning',
        dataResidency: 'au',
        acceptedResidencies: ['au', 'us', 'global'],
        candidates: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            priority: 1,
            temperature: 0.4,
          },
        ],
        fallbackAllowed: false,
        timeoutMs: 15000,
        maxInputTokens: 20000,
        maxOutputTokens: 2500,
      },
      {
        policyId: 'tool_selection',
        description: 'Capability and tool parameter binding',
        dataResidency: 'au',
        acceptedResidencies: ['au', 'us', 'global'],
        candidates: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            priority: 1,
            temperature: 0.0,
          },
        ],
        fallbackAllowed: false,
        timeoutMs: 5000,
        maxInputTokens: 8000,
        maxOutputTokens: 1000,
      },
      {
        policyId: 'response_generation',
        description: 'Grounded customer response composition',
        dataResidency: 'au',
        acceptedResidencies: ['au', 'us', 'global'],
        candidates: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            priority: 1,
            temperature: 0.3,
          },
        ],
        fallbackAllowed: false,
        timeoutMs: 15000,
        maxInputTokens: 20000,
        maxOutputTokens: 2500,
      },
    ],
  };

  const pack: BusinessPackRelease = {
    manifest: {
      packId: `bp_${tenantId}_v1`,
      tenantId,
      environmentId,
      version,
      name: `${tenantId === 'placemakers' ? 'PlaceMakers' : tenantId} Unified Business Pack`,
      publishedAt: '2026-09-30T00:00:00.000Z',
      publishedBy: 'system:test-runner',
      schemaVersion: '1.0.0',
      status: 'active',
      description: `Sanitized domain-neutral test pack for ${tenantId}`,
    },
    profile: {
      companyName: tenantId === 'placemakers' ? 'PlaceMakers NZ' : `${tenantId} Corp`,
      industry: 'Building Materials & Trade Supplies',
      market: 'NZ',
    },
    vocabulary: {
      terms: [],
      acronyms: {},
      slotSynonyms: {},
      welcomeMessage: 'Kia ora! I am your materials and project consultant. How can I help you today?',
    },
    entities: {
      entities: [
        {
          entityId: 'tradeCategory',
          entityName: 'tradeCategory',
          displayName: 'Trade Category',
          allowedValues: ['wet_area', 'decking', 'framing', 'flooring'],
        },
      ],
    },
    conversationPolicy: {
      allowJourneySwitch: true,
    },
    modelPolicy: options.modelPolicy || defaultModelPolicy,
    agents: [
      {
        agentId: 'consultant',
        name: `${tenantId === 'placemakers' ? 'PlaceMakers' : tenantId} Consultant`,
        description: 'Primary trade consultant agent',
        initialJourneyId: 'technical_advisory',
        systemPrompt: 'You are an AI trade consultant providing verified building and materials guidance.',
      },
    ],
    journeys: [
      {
        journeyId: 'technical_advisory',
        version: '1.0.0',
        displayName: 'Technical & Building Materials Advisory',
        description: 'Advisory flow providing verified technical guidance, wet-area specifications, and compliance guidance.',
        initialStage: 'advisory_intake',
        goals: [
          'technical advisory',
          'moisture-resistant linings and waterproofing',
          'wet area requirements',
          'linings',
          'waterproofing',
          'gib aqualine',
        ],
        metadata: {
          triggerIntents: ['technical_advisory', 'wet_area', 'linings', 'waterproofing', 'moisture_resistant_linings'],
        },
        stages: {
          advisory_intake: {
            stageId: 'advisory_intake',
            displayName: 'Technical Advisory',
            description: 'Search technical compliance docs and provide grounded recommendations.',
            requiredFacts: [],
            allowedCapabilities: ['knowledge.search', 'catalog.search'],
            capabilityPlan: [
              {
                toolId: 'knowledge.search',
                producesFacts: ['knowledge_verified'],
              },
            ],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                allFactsPresent: ['quote_requested'],
                nextStage: 'trade_quote',
              },
            ],
          },
        },
      },
      {
        journeyId: 'trade_quote',
        version: '1.0.0',
        displayName: 'PlaceMakers Trade BOM & Estimation Flow',
        description: 'Guides trade customers from explicit project scope to a fully compliant bill of materials and quote.',
        initialStage: 'project_intake',
        goals: ['assemble_bom', 'deliver_quote', 'trade quote', 'request quote'],
        metadata: {
          triggerIntents: ['trade_quote', 'request_quote'],
        },
        stages: {
          project_intake: {
            stageId: 'project_intake',
            displayName: 'Project Intake & Sizing',
            description: 'Capture building trade category and dimensions.',
            requiredFacts: ['tradeCategory'],
            allowedCapabilities: ['catalog.search', 'knowledge.search'],
            capabilityPlan: [
              {
                toolId: 'knowledge.search',
                when: { factsPresent: ['tradeCategory'] },
                producesFacts: ['knowledge_verified'],
              },
            ],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                allFactsPresent: ['tradeCategory', 'quote_requested'],
                nextStage: 'bom_assembly',
              },
            ],
          },
          bom_assembly: {
            stageId: 'bom_assembly',
            displayName: 'Bill of Materials Assembly',
            description: 'Search catalogue, verify NZBC compliance, and assemble trade BOM.',
            requiredFacts: [],
            allowedCapabilities: ['catalog.search', 'knowledge.search', 'trade.quote_create'],
            capabilityPlan: [
              {
                toolId: 'trade.quote_create',
                when: { factsMissing: ['quote_generated'] },
                producesFacts: ['quote_generated'],
              },
            ],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                allFactsPresent: ['quote_generated'],
                nextStage: 'trade_approval',
              },
            ],
          },
          trade_approval: {
            stageId: 'trade_approval',
            displayName: 'Trade Account Approval & Sync',
            description: 'Sync quote to SAP ERP and place trade order.',
            requiredFacts: ['bom_confirmed'],
            allowedCapabilities: ['order.commit'],
            capabilityPlan: [],
            nextDecisionPolicy: 'rule-first',
            exitConditions: [],
          },
        },
      },
    ],
    rules: [],
    capabilities: {
      toolDefinitions: [
        {
          toolId: 'knowledge.search',
          version: '1.0.0',
          displayName: 'Technical Documentation & Compliance Search',
          description: 'Search BRANZ and NZBC installation guides.',
          inputSchema: {
            properties: {
              query: { type: 'string' },
            },
          },
          outputSchema: {
            properties: {
              documents: { type: 'array' },
              verified: { type: 'boolean' },
            },
          },
          sideEffect: 'read',
          risk: 'low',
        },
        {
          toolId: 'catalog.search',
          version: '1.0.0',
          displayName: 'PlaceMakers Catalog Search',
          description: 'Search trade building materials and hardware.',
          inputSchema: {
            properties: {
              query: { type: 'string' },
            },
          },
          outputSchema: {
            properties: {
              items: { type: 'array' },
            },
          },
          sideEffect: 'read',
          risk: 'low',
        },
        {
          toolId: 'trade.quote_create',
          version: '1.0.0',
          displayName: 'Create Trade BOM Quote',
          description: 'Generates structured trade quote with trade discount pricing.',
          inputSchema: {
            properties: {
              items: { type: 'array' },
            },
          },
          outputSchema: {
            properties: {
              quoteId: { type: 'string' },
            },
          },
          sideEffect: 'read',
          risk: 'low',
        },
      ],
      toolBindings: [
        {
          tenantId,
          environmentId: options.environmentId,
          toolId: 'knowledge.search',
          bindingVersion: '1.0.0',
          executor: {
            type: 'native_capability',
            nativeHandler: 'knowledge.search',
          },
          inputMapping: {
            query: 'tradeCategory',
          },
          outputFactMapping: {
            knowledge_verified: 'verified',
          },
          timeoutMs: 10000,
        },
        {
          tenantId,
          environmentId: options.environmentId,
          toolId: 'catalog.search',
          bindingVersion: '1.0.0',
          executor: {
            type: 'native_capability',
            nativeHandler: 'catalog.search',
          },
          inputMapping: {
            query: 'tradeCategory',
          },
          outputFactMapping: {
            catalog_results: 'items',
          },
          timeoutMs: 10000,
        },
        {
          tenantId,
          environmentId: options.environmentId,
          toolId: 'trade.quote_create',
          bindingVersion: '1.0.0',
          executor: {
            type: 'native_capability',
            nativeHandler: 'trade.quote_create',
          },
          inputMapping: {},
          outputFactMapping: {
            quote_generated: 'quoteId',
          },
          timeoutMs: 10000,
        },
      ],
      stageBindings: [
        {
          journeyId: 'technical_advisory',
          stageId: 'advisory_intake',
          tools: [
            {
              toolId: 'knowledge.search',
              inputMapping: {
                query: 'tradeCategory',
              },
              outputFactMapping: {
                knowledge_verified: 'verified',
              },
            },
          ],
        },
        {
          journeyId: 'trade_quote',
          stageId: 'project_intake',
          tools: [
            {
              toolId: 'knowledge.search',
              inputMapping: {
                query: 'tradeCategory',
              },
              outputFactMapping: {
                knowledge_verified: 'verified',
              },
            },
          ],
        },
      ],
    },
    experience: {
      welcomeMessage: 'Kia ora! I am your materials and project consultant. How can I help you today?',
    },
    evaluations: [],
    extensions: options.extensions || {},
    checksum: '',
  };

  pack.checksum = computePackChecksum(pack);
  return pack;
}

export function getPlaceMakersTestPack(options: TestPackOptions = {}): BusinessPackRelease {
  return createSanitizedTestPack({
    tenantId: 'placemakers',
    environmentId: options.environmentId || 'production',
    version: options.version || '1.0.0',
    modelPolicy: options.modelPolicy,
    extensions: options.extensions,
  });
}
