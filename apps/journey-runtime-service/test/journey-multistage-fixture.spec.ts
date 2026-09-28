import assert from 'node:assert/strict';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { PackRepository } from '../src/kernel/pack.repository';
import { WorkspaceRepository } from '../src/kernel/workspace.repository';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { ExecutionRepository } from '../src/kernel/execution.repository';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { TurnCommand } from '@journeyax/journey-core';

// Multi-stage fixture shaped like PlaceMakers 3-stage journey without domain literals in core
const multistageFixturePack: BusinessPackRelease = {
  manifest: {
    packId: 'fixture-multistage-pack',
    name: 'Multi-Stage Fixture Pack',
    version: '1.0.0',
    description: 'PlaceMakers-shaped 3-stage journey verification',
    tenantId: 'tenant-multistage-fixture',
    environmentId: 'test',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'checksum-multistage-fixture',
  },
  profile: {
    companyName: 'Fixture Supply Co',
    industry: 'Materials Distribution',
    brandTone: 'professional',
    primaryCurrency: 'NZD',
    supportedCurrencies: ['NZD'],
    primaryLocale: 'en-NZ',
    supportedLocales: ['en-NZ'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [
      {
        term: 'standard category',
        canonical: 'cat_standard',
        category: 'project_category',
        synonyms: ['standard', 'std', 'regular'],
      },
    ],
    acronyms: {},
    slotSynonyms: {
      project_category: ['standard', 'premium', 'economy'],
      project_dimensions: ['5x3', '4x4', '6x2'],
    },
    slotQuestions: {
      project_category: {
        text: 'What project category would you like to build?',
        options: ['standard', 'premium', 'economy'],
      },
      project_dimensions: {
        text: 'What are the dimensions of your project (e.g. 5x3)?',
      },
    },
    slotMappings: {},
    prohibitedTerms: [],
  },
  entities: {
    version: '1.0.0',
    entities: [],
  },
  conversationPolicy: {
    fencingRules: [],
    prohibitedTopics: [],
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  },
  journeys: [
    {
      journeyId: 'project_estimator_journey',
      version: '1.0.0',
      displayName: 'Project Material Estimator',
      goals: ['Estimate required materials and generate supply quote'],
      metadata: {
        triggerIntents: ['estimate_materials', 'build_project', 'project_quote'],
      },
      initialStage: 'stage_intake',
      stages: {
        stage_intake: {
          stageId: 'stage_intake',
          displayName: 'Project Requirements Intake',
          requiredFacts: ['project_dimensions', 'project_category'],
          allowedCapabilities: [],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [
            {
              allFactsPresent: ['project_dimensions', 'project_category'],
              nextStage: 'stage_assembly',
            },
          ],
        },
        stage_assembly: {
          stageId: 'stage_assembly',
          displayName: 'BOM Assembly & Quote Creation',
          requiredFacts: ['project_dimensions', 'project_category'],
          allowedCapabilities: ['catalog.search', 'trade.quote_create'],
          capabilityPlan: [
            {
              toolId: 'catalog.search',
              when: { factsMissing: ['catalog_items'] },
              producesFacts: ['catalog_items'],
            },
            {
              toolId: 'trade.quote_create',
              when: { factsPresent: ['catalog_items'], factsMissing: ['quote_generated'] },
              producesFacts: ['quote_generated', 'bom_confirmed'],
            },
          ],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [
            {
              allFactsPresent: ['quote_generated', 'bom_confirmed'],
              nextStage: 'stage_complete',
            },
          ],
        },
        stage_complete: {
          stageId: 'stage_complete',
          displayName: 'Estimation Complete',
          requiredFacts: ['quote_generated'],
          allowedCapabilities: [],
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
        displayName: 'Catalog Search',
        description: 'Searches catalog items matching project specs',
        version: '1.0.0',
        inputSchema: {
          properties: {
            dimensions: { type: 'string' },
            category: { type: 'string' },
          },
        },
        outputSchema: {},
        sideEffect: 'read',
        risk: 'low',
        timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
        idempotencyPolicy: { required: false, ttlSeconds: 86400 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
        dataClassification: 'internal',
      },
      {
        toolId: 'trade.quote_create',
        displayName: 'Create Trade Quote',
        description: 'Generates official quote from BOM items',
        version: '1.0.0',
        inputSchema: {
          properties: {
            itemsCount: { type: 'number' },
          },
        },
        outputSchema: {},
        sideEffect: 'read',
        risk: 'low',
        timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
        idempotencyPolicy: { required: false, ttlSeconds: 86400 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
        dataClassification: 'internal',
      },
    ],
    toolBindings: [
      {
        toolId: 'catalog.search',
        tenantId: 'tenant-multistage-fixture',
        environmentId: 'test',
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability',
          nativeHandler: 'catalog.search',
        },
        outputFactMapping: {
          catalog_items: 'items',
        },
        enabled: true,
        policy: {
          requiredRole: 'customer',
          requiresConfirmation: false,
          idempotencyRequired: false,
          timeoutMs: 10000,
          retryAttempts: 0,
        },
      },
      {
        toolId: 'trade.quote_create',
        tenantId: 'tenant-multistage-fixture',
        environmentId: 'test',
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability',
          nativeHandler: 'trade.quote_create',
        },
        outputFactMapping: {
          quote_generated: 'quoteId',
          bom_confirmed: 'confirmed',
        },
        enabled: true,
        policy: {
          requiredRole: 'customer',
          requiresConfirmation: false,
          idempotencyRequired: false,
          timeoutMs: 10000,
          retryAttempts: 0,
        },
      },
    ],
    stageBindings: [],
  },
  agents: [],
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'default',
    policies: [
      {
        policyId: 'default',
        candidates: [{ provider: 'open-model', model: 'mock-model', priority: 1 }],
        dataResidency: 'nz',
        acceptedResidencies: ['nz', 'au'],
        maxInputTokens: 4000,
        maxOutputTokens: 1000,
        fallbackAllowed: true,
        timeoutMs: 5000,
      },
    ],
  },
  experience: {
    version: '1.0.0',
    theme: {
      primaryColor: '#0055ff',
      accentColor: '#3B82F6',
      fontFamily: 'sans-serif',
      borderRadius: '8px',
      customCssVars: {},
    },
    cards: {
      allowedCardTypes: ['bundle'],
      defaultCardRenderer: '@journeyax/ui-cards',
    },
  },
  evaluations: [],
};

async function runMultistageFixtureTests() {
  console.log('🧪 Running PlaceMakers-Shaped 3-Stage Journey Fixture Test Suite...\n');

  process.env.NODE_ENV = 'test';
  process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

  const mockPackRepo = {
    loadActivePack: async () => multistageFixturePack,
    hasActivePack: async () => true,
    invalidate: () => {},
  } as unknown as PackRepository;

  const workspaceStore = new WorkspaceStore();
  const workspaceRepo = new WorkspaceRepository(workspaceStore);
  const executionRepo = new ExecutionRepository();
  const outboxRepo = new OutboxRepository();
  const capabilityGateway = new CapabilityGateway();

  let catalogExecuted = false;
  let quoteExecuted = false;

  capabilityGateway.registerCustomAdapter('catalog.search', {
    execute: async () => {
      catalogExecuted = true;
      return {
        items: [
          { sku: 'SKU-001', name: 'Material Post 100mm', quantity: 12 },
          { sku: 'SKU-002', name: 'Fastener Box 500', quantity: 2 },
        ],
        total: 2,
      };
    },
  });

  capabilityGateway.registerCustomAdapter('trade.quote_create', {
    execute: async () => {
      quoteExecuted = true;
      return {
        quoteId: 'QUO-NZ-982341',
        totalPrice: 4250.0,
        currency: 'NZD',
        confirmed: true,
      };
    },
  });

  const appService = new TurnApplicationService(
    mockPackRepo,
    workspaceRepo,
    undefined,
    undefined,
    undefined,
    capabilityGateway,
    undefined,
    executionRepo,
    outboxRepo
  );

  const sessionId = 'session-multistage-001';
  const workspaceId = 'ws-multistage-001';

  // ──────────────────────────────────────────────────────────────────────────
  // Turn 1: Customer initiates request with partial facts (project_dimensions only)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- Turn 1: Customer provides project_dimensions only ---');
  const turn1Cmd: TurnCommand = {
    tenantId: 'tenant-multistage-fixture',
    environmentId: 'test',
    workspaceId,
    sessionId,
    correlationId: 'corr-001',
    message: 'I want to estimate materials for dimensions 5x3',
  };

  const res1 = await appService.executeTurn(turn1Cmd);

  assert.equal(res1.workspace.currentStage, 'stage_intake', 'Stage must remain stage_intake');
  assert.equal(res1.decision.type, 'ask_fact', 'Should ask for missing project_category');
  assert.equal(res1.decision.payload?.targetFact, 'project_category');
  assert.ok(res1.workspace.facts['project_dimensions'], 'project_dimensions should be extracted');
  assert.equal(res1.workspace.facts['project_dimensions'].value, '5x3');
  console.log('  ✅ Turn 1 PASS: Asked for project_category; stored project_dimensions=5x3');

  // ──────────────────────────────────────────────────────────────────────────
  // Turn 2: Customer provides project_category. Stage 1 completes!
  // Stage transitions to stage_assembly -> executes catalog.search ->
  // produces catalog_items via outputFactMapping
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Turn 2: Customer provides project_category ---');
  const turn2Cmd: TurnCommand = {
    tenantId: 'tenant-multistage-fixture',
    environmentId: 'test',
    workspaceId,
    sessionId,
    correlationId: 'corr-002',
    message: 'The project category is standard',
  };

  const res2 = await appService.executeTurn(turn2Cmd);

  // Assert catalog search execution and stage 2 transition
  assert.ok(catalogExecuted, 'catalog.search capability should have executed');
  assert.equal(res2.workspace.currentStage, 'stage_assembly', 'Workspace should be in stage_assembly');
  assert.ok(res2.workspace.facts['catalog_items'], 'catalog_items fact must be present');
  assert.equal(res2.workspace.facts['catalog_items'].source, 'capability');
  console.log('  ✅ Turn 2 PASS: Transitioned to stage_assembly; executed catalog.search and mapped catalog_items');

  // ──────────────────────────────────────────────────────────────────────────
  // Turn 3: Customer requests quote generation.
  // Stage 2 executes capabilityPlan second tool: trade.quote_create ->
  // produces quote_generated and bom_confirmed ->
  // Exit condition satisfied -> Transition to stage_complete!
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Turn 3: Customer requests quote creation ---');
  const turn3Cmd: TurnCommand = {
    tenantId: 'tenant-multistage-fixture',
    environmentId: 'test',
    workspaceId,
    sessionId,
    correlationId: 'corr-003',
    message: 'Please generate the quote for these materials',
  };

  const res3 = await appService.executeTurn(turn3Cmd);

  assert.ok(quoteExecuted, 'trade.quote_create capability should have executed');
  assert.ok(res3.workspace.facts['quote_generated'], 'quote_generated fact must be present');
  assert.equal(res3.workspace.facts['quote_generated'].value, 'QUO-NZ-982341');
  assert.equal(res3.workspace.facts['quote_generated'].source, 'capability');
  assert.equal(res3.workspace.facts['quote_generated'].confidence, 1.0);

  assert.ok(res3.workspace.facts['bom_confirmed'], 'bom_confirmed fact must be present');
  assert.equal(res3.workspace.facts['bom_confirmed'].value, true);
  assert.equal(res3.workspace.facts['bom_confirmed'].source, 'capability');

  // Assert all 3 stages traversed and reached stage_complete
  assert.equal(res3.workspace.currentStage, 'stage_complete', 'Workspace must reach stage_complete');
  assert.equal(res3.decision.type, 'complete_goal', 'Decision must be complete_goal');

  // Assert transitions trace was populated
  assert.ok(res3.trace?.transitions && res3.trace.transitions.length >= 1, 'Trace transitions should record stage transition');
  console.log('  ✅ Turn 3 PASS: Executed trade.quote_create, mapped output facts, and reached stage_complete');

  console.log('\n==================================================');
  console.log('Summary: Multi-Stage PlaceMakers-Shaped Journey Passed All 3 Stages via Customer Messages Only!');
  console.log('==================================================');
}

runMultistageFixtureTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
