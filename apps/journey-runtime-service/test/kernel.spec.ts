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

// Test domain: Fleet logistics & drone routing (completely disjoint from workwear or sanitaryware)
const mockLogisticsPack: BusinessPackRelease = {
  manifest: {
    packId: 'fleet-logistics',
    name: 'Autonomous Drone Fleet Logistics',
    version: '1.0.0',
    description: 'Autonomous dispatch and routing',
    tenantId: 'tenant-fleet-99',
    environmentId: 'test',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'mock-checksum-sha256',
  },
  profile: {
    companyName: 'Fleet Logistics',
    industry: 'Aviation Logistics',
    brandTone: 'direct',
    primaryCurrency: 'EUR',
    supportedCurrencies: ['EUR'],
    primaryLocale: 'de-DE',
    supportedLocales: ['de-DE'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [
      {
        term: 'quadcopter',
        canonical: 'drone_quad',
        category: 'vehicle_type',
        synonyms: ['quad', '4-rotor', 'scout drone'],
      },
      {
        term: 'hexacopter',
        canonical: 'drone_heavy',
        category: 'vehicle_type',
        synonyms: ['heavy lift', '6-rotor'],
      },
      {
        term: 'priority express',
        canonical: 'urgent',
        category: 'dispatch_speed',
        synonyms: ['asap', 'rush', 'same-hour'],
      },
    ],
    acronyms: {},
    slotSynonyms: {
      delivery_zone: ['berlin central', 'potsdam', 'spandau', 'brandenburg'],
      payload_weight: ['under 5kg', 'under 10kg', 'light parcel', 'heavy crate'],
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
      journeyId: 'drone_flight_booking',
      version: '1.0.0',
      displayName: 'Drone Flight Dispatch Booking',
      goals: ['Confirm flight coordinates and calculate optimal energy path'],
      initialStage: 'stage_intake',
      stages: {
        stage_intake: {
          stageId: 'stage_intake',
          displayName: 'Flight Intake',
          requiredFacts: ['delivery_zone', 'vehicle_type'],
          allowedCapabilities: ['logistics.calculate_flight_path'],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [
            {
              allFactsPresent: ['delivery_zone', 'vehicle_type'],
              nextStage: 'stage_review',
            },
          ],
        },
        stage_review: {
          stageId: 'stage_review',
          displayName: 'Flight Review',
          requiredFacts: ['delivery_zone', 'vehicle_type'],
          allowedCapabilities: ['logistics.commit_flight'],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [
            {
              allFactsPresent: ['flight_path_confirmed'],
              nextStage: 'stage_complete',
            },
          ],
        },
        stage_complete: {
          stageId: 'stage_complete',
          displayName: 'Flight Dispatched',
          requiredFacts: [],
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
        toolId: 'logistics.calculate_flight_path',
        displayName: 'Calculate Flight Path',
        description: 'Calculates airway route and battery reserve',
        version: '1.0.0',
        inputSchema: {
          delivery_zone: { type: 'string' },
          vehicle_type: { type: 'string' },
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
        toolId: 'logistics.commit_flight',
        displayName: 'Commit Flight',
        description: 'Dispatches drone along airway',
        version: '1.0.0',
        inputSchema: {},
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
        toolId: 'logistics.calculate_flight_path',
        tenantId: 'tenant-fleet-99',
        environmentId: 'test',
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability',
          nativeHandler: 'logistics.calculate_flight_path',
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
        toolId: 'logistics.commit_flight',
        tenantId: 'tenant-fleet-99',
        environmentId: 'test',
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability',
          nativeHandler: 'logistics.commit_flight',
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
  agents: [
    {
      agentId: 'dispatcher-agent',
      name: 'Flight Dispatcher',
      purpose: 'Coordinates autonomous drone airway bookings and flight safety',
      modelPolicyRef: 'fast-local',
      allowedTools: ['logistics.calculate_flight_path'],
      maxTurns: 3,
      handoffConditions: [],
      inputSchema: {},
      outputSchema: {},
    },
  ],
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'fast-local',
    policies: [
      {
        policyId: 'fast-local',
        candidates: [{ provider: 'open-model', model: 'mock-model', priority: 1 }],
        dataResidency: 'eu',
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

async function runKernelTests() {
  console.log('🧪 Running Domain-Neutral Kernel Verification Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // Set up in-memory workspace store & test environment
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

  const mockPackRepo = {
    loadActivePack: async (tenantId: string) => mockLogisticsPack,
    hasActivePack: async (tenantId: string) => true,
    invalidate: () => {},
  } as unknown as PackRepository;

  const workspaceStore = new WorkspaceStore();
  const workspaceRepo = new WorkspaceRepository(workspaceStore);
  const outboxRepo = new OutboxRepository();
  const executionRepo = new ExecutionRepository();
  const capabilityGateway = new CapabilityGateway();

  // Register domain capability adapter dynamically via gateway
  let pathCalculatorCalled = false;
  capabilityGateway.registerCustomAdapter('logistics.calculate_flight_path', {
    execute: async (input: any) => {
      pathCalculatorCalled = true;
      return {
        airwayId: 'AW-BER-902',
        waypoints: 4,
        batteryConsumptionPct: 18,
        facts: {
          flight_path_confirmed: {
            value: true,
            source: 'system',
            confidence: 1.0,
            extractedAt: new Date().toISOString(),
          },
        },
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

  await test('Step 1: Missing required facts triggers ask_fact with zero industry hardcoding', async () => {
    const cmd: TurnCommand = {
      tenantId: 'tenant-fleet-99',
      environmentId: 'test',
      workspaceId: 'ws-logistics-001',
      sessionId: 'sess-001',
      correlationId: 'corr-001',
      message: 'Hello, I want to book a delivery flight',
    };

    const res = await appService.executeTurn(cmd);

    assert.equal(res.decision.type, 'ask_fact');
    assert.deepEqual(res.decision.payload.missingFacts, ['delivery_zone', 'vehicle_type']);
    assert(res.assistantMessage?.includes('delivery zone') || res.assistantMessage?.includes('vehicle type'));
    assert.equal(res.workspace.currentStage, 'stage_intake');
  });

  await test('Step 2: Partial facts extract dynamically from vocabulary terms without domain leakage', async () => {
    const cmd: TurnCommand = {
      tenantId: 'tenant-fleet-99',
      environmentId: 'test',
      workspaceId: 'ws-logistics-001',
      sessionId: 'sess-001',
      correlationId: 'corr-002',
      message: 'I need a quadcopter for this flight',
    };

    const res = await appService.executeTurn(cmd);

    assert.equal(res.decision.type, 'ask_fact');
    assert.deepEqual(res.decision.payload.missingFacts, ['delivery_zone']);
    assert.equal(res.workspace.facts['vehicle_type']?.value, 'drone_quad');
  });

  await test('Step 3: All required facts satisfied triggers stage transition to stage_review', async () => {
    const cmd: TurnCommand = {
      tenantId: 'tenant-fleet-99',
      environmentId: 'test',
      workspaceId: 'ws-logistics-001',
      sessionId: 'sess-001',
      correlationId: 'corr-003',
      message: 'The delivery is to Potsdam please',
    };

    const res = await appService.executeTurn(cmd);

    // Both delivery_zone and vehicle_type are now satisfied.
    // Exit condition triggers transition to stage_review.
    assert.equal(res.workspace.currentStage, 'stage_review');
    assert.equal(res.workspace.facts['delivery_zone']?.value, 'potsdam');
  });

  await test('Step 4: Dynamic custom capability execution reduces outcome facts', async () => {
    // In stage_review, allowedCapabilities has 'logistics.commit_flight'.
    // Register the review adapter
    capabilityGateway.registerCustomAdapter('logistics.commit_flight', {
      execute: async (input: any) => {
        return {
          flightId: 'FL-99021',
          facts: {
            flight_path_confirmed: {
              value: true,
              source: 'system',
              confidence: 1.0,
              extractedAt: new Date().toISOString(),
            },
          },
        };
      },
    });

    const cmd: TurnCommand = {
      tenantId: 'tenant-fleet-99',
      environmentId: 'test',
      workspaceId: 'ws-logistics-001',
      sessionId: 'sess-001',
      correlationId: 'corr-004',
      message: 'Confirm and dispatch flight',
    };

    const res = await appService.executeTurn(cmd);

    assert.equal(res.executedCapabilities.length, 1);
    assert.equal(res.executedCapabilities[0].toolId, 'logistics.commit_flight');
    assert.equal(res.executedCapabilities[0].status, 'success');
    assert.equal(res.workspace.facts['flight_path_confirmed']?.value, true);
  });

  await test('Step 5: Next turn evaluates exit condition with updated facts and transitions to stage_complete', async () => {
    const cmd: TurnCommand = {
      tenantId: 'tenant-fleet-99',
      environmentId: 'test',
      workspaceId: 'ws-logistics-001',
      sessionId: 'sess-001',
      correlationId: 'corr-005',
      message: 'Status update please',
    };

    const res = await appService.executeTurn(cmd);

    assert.equal(res.workspace.currentStage, 'stage_complete');
    assert.equal(res.decision.type, 'complete_goal');
  });

  await test('Step 6: Outbox events enqueued on turn completion', async () => {
    const events = outboxRepo.getEvents();
    assert(events.length >= 5, `Expected at least 5 outbox events, got ${events.length}`);
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.eventType, 'journey.turn_completed');
    assert.equal(lastEvent.tenantId, 'tenant-fleet-99');
  });

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runKernelTests().catch((e) => {
  console.error('Unhandled test failure:', e);
  process.exit(1);
});
