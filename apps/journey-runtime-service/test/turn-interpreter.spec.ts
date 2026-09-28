import assert from 'node:assert/strict';
import { TurnInterpreter } from '../src/turn/interpret-event';
import { ModelGateway, ModelGatewayError } from '../src/kernel/model.gateway';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState, TurnCommand } from '@journeyax/journey-core';

// Test Business Pack fixture
const testRelease: BusinessPackRelease = {
  manifest: {
    packId: 'test-pack',
    tenantId: 'test-tenant',
    environmentId: 'test',
    version: '1.0.0',
    name: 'Test Pack',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'test-checksum',
  },
  profile: {
    companyName: 'Test Corp',
    primaryCurrency: 'NZD',
    supportedCurrencies: ['NZD'],
    primaryLocale: 'en-NZ',
    supportedLocales: ['en-NZ'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [],
    acronyms: {},
    slotSynonyms: {
      tradeCategory: ['decking', 'plumbing', 'framing'],
      timber_treatment: ['H3.2', 'H4', 'H5'],
    },
    slotQuestions: {
      tradeCategory: {
        text: 'What trade category are you working on?',
        options: ['decking', 'plumbing', 'framing'],
      },
      deck_dimensions: {
        text: 'What are the deck dimensions?',
      },
      timber_treatment: {
        text: 'What timber treatment is required?',
        options: ['H3.2', 'H4', 'H5'],
      },
    },
  },
  entities: {
    version: '1.0.0',
    entities: [
      {
        entityName: 'tradeCategory',
        allowedValues: ['decking', 'plumbing', 'framing'],
      },
      {
        entityName: 'timber_treatment',
        allowedValues: ['H3.2', 'H4', 'H5'],
      },
    ],
  },
  conversationPolicy: {
    fencingRules: [],
    prohibitedTopics: [],
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  },
  journeys: {
    journeys: [
      {
        journeyId: 'deck_builder',
        title: 'Deck Builder',
        goals: ['Build a deck'],
        requiredFacts: [
          'tradeCategory',
          { factKey: 'bom_confirmed', source: 'capability', isConfirmation: true },
          { factKey: 'quote_generated', source: 'capability' },
        ],
        stages: [
          {
            stageId: 'stage_scope',
            displayName: 'Scoping',
            requiredFacts: ['tradeCategory'],
            optionalFacts: ['timber_treatment'],
            allowedCapabilities: ['catalog.search'],
          },
          {
            stageId: 'stage_quote',
            displayName: 'Quote Generation',
            requiredFacts: [{ factKey: 'quote_generated', source: 'capability' }],
            allowedCapabilities: ['trade.quote_create'],
          },
        ],
      },
    ],
  },
} as unknown as BusinessPackRelease;

const mockWorkspace: WorkspaceState = {
  workspaceId: 'ws_test_123',
  tenantId: 'test-tenant',
  environmentId: 'test',
  customerId: 'cust_123',
  conversationId: 'conv_123',
  journeyId: 'deck_builder',
  currentStage: 'stage_scope',
  facts: {},
  history: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function runTests() {
  console.log('=== Running TurnInterpreter Security & Fact Hardening Tests (Agent 1 Item 3) ===\n');

  // Test 1: Model returning capability-sourced fact (bom_confirmed) is dropped
  console.log('Test 1: Model returning capability-sourced fact (bom_confirmed) is dropped');
  const mockModelGatewayBOM: Partial<ModelGateway> = {
    execute: async () => ({
      content: JSON.stringify({
        intent: 'confirm_bom',
        candidateFacts: {
          tradeCategory: { value: 'decking', confidence: 0.99 },
          bom_confirmed: { value: true, confidence: 0.99 },
          quote_generated: { value: true, confidence: 0.99 },
        },
      }),
      provider: 'test-provider',
      model: 'test-model',
      residencyProven: 'nz',
    }),
  };

  const interpreterBOM = new TurnInterpreter(mockModelGatewayBOM as ModelGateway);
  const resultBOM = await interpreterBOM.interpret(
    { message: 'Yes, please confirm the bill of materials' } as TurnCommand,
    testRelease,
    mockWorkspace
  );

  assert.equal(resultBOM.candidateFacts['tradeCategory']?.value, 'decking');
  assert.equal(
    resultBOM.candidateFacts['bom_confirmed'],
    undefined,
    'bom_confirmed must be dropped when asserted by customer free text'
  );
  assert.equal(
    resultBOM.candidateFacts['quote_generated'],
    undefined,
    'quote_generated must be dropped when asserted by customer free text'
  );
  console.log('✓ Capability-sourced & confirmation facts dropped from candidate facts\n');

  // Test 2: Unknown/undeclared keys are dropped
  console.log('Test 2: Unknown/undeclared keys returned by model are dropped');
  const mockModelGatewayUnknownKey: Partial<ModelGateway> = {
    execute: async () => ({
      content: JSON.stringify({
        intent: 'provide_info',
        candidateFacts: {
          tradeCategory: { value: 'decking', confidence: 0.95 },
          arbitrary_unscoped_key: { value: 'hacked_value', confidence: 0.99 },
          injected_admin_override: { value: true, confidence: 1.0 },
        },
      }),
      provider: 'test-provider',
      model: 'test-model',
      residencyProven: 'nz',
    }),
  };

  const interpreterUnknown = new TurnInterpreter(mockModelGatewayUnknownKey as ModelGateway);
  const resultUnknown = await interpreterUnknown.interpret(
    { message: 'I need decking supplies' } as TurnCommand,
    testRelease,
    mockWorkspace
  );

  assert.equal(resultUnknown.candidateFacts['tradeCategory']?.value, 'decking');
  assert.equal(
    resultUnknown.candidateFacts['arbitrary_unscoped_key'],
    undefined,
    'Undeclared key must be dropped'
  );
  assert.equal(
    resultUnknown.candidateFacts['injected_admin_override'],
    undefined,
    'Injected key must be dropped'
  );
  console.log('✓ Unknown/undeclared keys dropped\n');

  // Test 3: Gateway error surfaces in interpretation.failure without silent catch
  console.log('Test 3: Model gateway error is captured in interpretation.failure');
  const mockModelGatewayFailing: Partial<ModelGateway> = {
    execute: async () => {
      const err = new ModelGatewayError(
        'Failed to execute model request: connection reset',
        'ModelNetworkError',
        'openai',
        'gpt-4o'
      );
      throw err;
    },
  };

  const interpreterFailing = new TurnInterpreter(mockModelGatewayFailing as ModelGateway);
  const resultFailing = await interpreterFailing.interpret(
    { message: 'I need decking' } as TurnCommand,
    testRelease,
    mockWorkspace
  );

  assert.ok(resultFailing.failure, 'interpretation.failure must be populated');
  assert.equal(resultFailing.failure.type, 'ModelGatewayError');
  assert.equal(resultFailing.failure.provider, 'openai');
  assert.ok(resultFailing.failure.message.includes('connection reset'));
  // Even with failure, fallback vocabulary extraction works:
  assert.equal(resultFailing.candidateFacts['tradeCategory']?.value, 'decking');
  console.log('✓ Gateway error captured in failure object and logged loudly\n');

  // Test 4: List slots validate each element against enum, not the whole array
  console.log('Test 4: List slots validate each element against enum');
  const mockModelGatewayListSlot: Partial<ModelGateway> = {
    execute: async () => ({
      content: JSON.stringify({
        intent: 'provide_options',
        candidateFacts: {
          // Valid list
          timber_treatment: { value: ['H3.2', 'H4'], confidence: 0.95 },
        },
      }),
      provider: 'test-provider',
      model: 'test-model',
      residencyProven: 'nz',
    }),
  };

  const interpreterList = new TurnInterpreter(mockModelGatewayListSlot as ModelGateway);
  const resultValidList = await interpreterList.interpret(
    { message: 'We use H3.2 and H4 treatments' } as TurnCommand,
    testRelease,
    mockWorkspace
  );
  assert.deepEqual(resultValidList.candidateFacts['timber_treatment']?.value, ['H3.2', 'H4']);

  // Invalid list with an illegal element
  const mockModelGatewayInvalidList: Partial<ModelGateway> = {
    execute: async () => ({
      content: JSON.stringify({
        intent: 'provide_options',
        candidateFacts: {
          // One invalid element
          timber_treatment: { value: ['H3.2', 'INVALID_TREATMENT_99'], confidence: 0.95 },
        },
      }),
      provider: 'test-provider',
      model: 'test-model',
      residencyProven: 'nz',
    }),
  };

  const interpreterInvalidList = new TurnInterpreter(mockModelGatewayInvalidList as ModelGateway);
  const resultInvalidList = await interpreterInvalidList.interpret(
    { message: 'We use H3.2 and INVALID' } as TurnCommand,
    testRelease,
    mockWorkspace
  );
  assert.equal(
    resultInvalidList.candidateFacts['timber_treatment'],
    undefined,
    'List with invalid element must fail validation'
  );
  console.log('✓ Individual list slot elements validated against enum\n');

  console.log('====================================================');
  console.log('✓ All TurnInterpreter Security & Fact Hardening Tests PASSED!');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
