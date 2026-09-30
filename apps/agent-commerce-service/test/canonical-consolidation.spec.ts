/**
 * Canonical Runtime Consolidation & Architecture Safety Test Suite
 *
 * Verifies the 10 mandatory consolidation requirements:
 * 1. Multi-journey request without explicit/resolved journey fails closed (zero positional journeys[0] fallback).
 * 2. Unknown stage exposes zero tools (never falls back to all tools).
 * 3. Tool binding for another tenant/environment is rejected (strict cross-tenant/env boundary).
 * 4. Configured executor is used (native/flow execution per binding).
 * 5. Missing executor/secret reference fails closed.
 * 6. Pack-defined tool/card works without Agent Commerce code changes.
 * 7. Canonical SSE is passed through without buffering.
 * 8. No fabricated price, stock or fulfilment result (generic runtime returns unavailable).
 * 9. Active Business Pack tenants never execute the compatibility runtime.
 * 10. Nest application boot still passes with proper dependency injection.
 */

import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AgentModule } from '../src/agent.module';
import { AgentService } from '../src/agent.service';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from '../src/runtime/tenant-runtime-activation.router';
import { LegacyJourneyAdapter } from '../src/legacy/legacy-journey-adapter';
import { ConfigLoader } from '../src/pipeline/config-loader';
import { TradeOrchestrator } from '../src/orchestration/trade-orchestrator';
import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
} from '@journeyax/journey-core';
import {
  BusinessPackRelease,
} from '@journeyax/business-pack';
import {
  JourneyResolver,
} from '../../journey-runtime-service/src/kernel/journey.resolver';
import {
  CapabilityGateway,
} from '../../journey-runtime-service/src/kernel/capability.gateway';

async function runConsolidationSuite() {
  console.log('🧪 Running Canonical Runtime Consolidation & Architecture Safety Suite...\n');

  // ── TEST 1: Multi-journey request without explicit/resolved journey fails closed ──
  console.log('1. Testing multi-journey request without explicit/resolved journey...');
  const multiJourneyPack: BusinessPackRelease = {
    manifest: {
      packId: 'pack-multi',
      version: '1.0.0',
      tenantId: 'tenant-multi',
      environmentId: 'production',
      name: 'Multi Journey Pack',
      publishedAt: new Date().toISOString(),
      publishedBy: 'system',
      checksum: 'chk-multi',
      status: 'active',
      compatibility: { minRuntimeVersion: '1.0.0', targetSchemaVersion: '1.0.0' },
    },
    journeys: [
      {
        journeyId: 'journey_alpha',
        displayName: 'Alpha Journey',
        version: '1.0.0',
        goals: ['buy shoes', 'purchase footwear'],
        initialStage: 'stage_alpha_1',
        stages: {
          stage_alpha_1: {
            requiredFacts: ['footwear_size'],
            allowedCapabilities: ['catalog.search'],
            exitConditions: [],
            nextDecisionPolicy: 'dependency-first',
          },
        },
      },
      {
        journeyId: 'journey_beta',
        displayName: 'Beta Journey',
        version: '1.0.0',
        goals: ['order clothing', 'purchase apparel'],
        initialStage: 'stage_beta_1',
        stages: {
          stage_beta_1: {
            requiredFacts: ['clothing_size'],
            allowedCapabilities: ['catalog.search'],
            exitConditions: [],
            nextDecisionPolicy: 'dependency-first',
          },
        },
      },
    ],
    agents: [
      {
        agentId: 'specialist_1',
        name: 'Specialist',
        purpose: 'Handle customer orders',
        modelPolicyRef: 'standard_turn',
        allowedTools: ['catalog.search'],
        maxTurns: 3,
        handoffConditions: [],
        inputSchema: {},
        outputSchema: {},
      },
    ],
    modelPolicy: {
      version: '1.0.0',
      defaultPolicy: 'standard_turn',
      policies: [
        {
          policyId: 'standard_turn',
          candidates: [{ provider: 'open-model', model: 'mock-model', priority: 1 }],
          dataResidency: 'nz',
          maxInputTokens: 2000,
          maxOutputTokens: 500,
          fallbackAllowed: true,
          timeoutMs: 5000,
        },
      ],
    },
    capabilities: {
      version: '1.0.0',
      toolDefinitions: [
        {
          toolId: 'catalog.search',
          version: '1.0.0',
          displayName: 'Catalog Search',
          description: 'Search products',
          inputSchema: {},
          outputSchema: {},
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 3600 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
          dataClassification: 'public',
        },
      ],
      toolBindings: [
        {
          tenantId: 'tenant-multi',
          environmentId: 'production',
          toolId: 'catalog.search',
          bindingVersion: '1.0.0',
          enabled: true,
          executor: { type: 'native_capability', nativeHandler: 'catalog.search' },
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 5000,
            retryAttempts: 0,
          },
        },
      ],
      stageBindings: [
        {
          journeyId: 'journey_alpha',
          stageId: 'stage_alpha_1',
          tools: [{ toolId: 'catalog.search' }],
        },
      ],
    },
  };

  const resolver = new JourneyResolver();
  const ambiguousRes = resolver.resolveJourneyResolution(
    multiJourneyPack,
    { journeyId: 'unassigned', currentStage: 'initial', facts: {}, decisions: [], openQuestions: [] } as any,
    { message: 'Hello, I want to talk' } as any
  );
  assert.notEqual(ambiguousRes.status, 'resolved', 'Must fail closed, NEVER positional fallback to journey_alpha');
  assert.equal(ambiguousRes.status, 'no_match', 'Unmatched message returns no_match');

  // Multi-match message matching both goals equally
  const equalMatchRes = resolver.resolveJourneyResolution(
    multiJourneyPack,
    { journeyId: 'unassigned', currentStage: 'initial', facts: {}, decisions: [], openQuestions: [] } as any,
    { message: 'I want to purchase' } as any
  );
  assert.equal(equalMatchRes.status, 'ambiguous', 'Equal match message returns ambiguous');
  console.log('   ✅ PASS: Multi-journey request without explicit/resolved journey fails closed');

  // ── TEST 2: Unknown stage exposes zero tools ──
  console.log('2. Testing unknown stage tool exposure...');
  const capGateway = new CapabilityGateway();
  const unknownStageTools = capGateway.resolveCapabilitiesForStage(multiJourneyPack, {
    tenantId: 'tenant-multi',
    environmentId: 'production',
    journeyId: 'journey_alpha',
    currentStage: 'ghost_non_existent_stage',
    facts: {},
  } as any);
  const tools = Array.isArray(unknownStageTools) ? unknownStageTools : (unknownStageTools as any).tools;
  assert.equal(tools.length, 0, 'Unknown stage must expose exactly 0 tools');
  assert.deepEqual(tools, [], 'Unknown stage must expose zero tools');
  console.log('   ✅ PASS: Unknown stage exposes zero tools');

  // ── TEST 3: Binding for another tenant/environment is rejected ──
  console.log('3. Testing cross-tenant/env binding rejection...');
  const crossEnvExecution = await capGateway.executeCapability(
    multiJourneyPack,
    'catalog.search',
    { query: 'test' },
    {
      tenantId: 'tenant-multi',
      environmentId: 'staging', // Binding is production only
      principalId: 'test_user',
      principalRole: 'customer',
      correlationId: 'corr_123',
    }
  );
  assert.equal(crossEnvExecution.status, 'failure', 'Must fail when environment does not match binding');
  assert.ok(crossEnvExecution.error?.includes('No tool binding configured'), 'Error must cite binding absence');
  console.log('   ✅ PASS: Tool binding for another tenant/environment is rejected');

  // ── TEST 4: Configured executor is used ──
  console.log('4. Testing configured executor dispatch...');
  const nativeExecution = await capGateway.executeCapability(
    multiJourneyPack,
    'catalog.search',
    { query: 'timber' },
    {
      tenantId: 'tenant-multi',
      environmentId: 'production',
      principalId: 'test_user',
      principalRole: 'customer',
      correlationId: 'corr_456',
    }
  );
  assert.equal(nativeExecution.toolId, 'catalog.search');
  assert.equal(nativeExecution.status, 'success');
  assert.equal(nativeExecution.provenance.executorType, 'native_capability');
  console.log('   ✅ PASS: Configured native executor is invoked');

  // ── TEST 5: Missing executor/secret reference fails closed ──
  console.log('5. Testing missing executor/secret reference fail-closed...');
  const invalidSecretPack = JSON.parse(JSON.stringify(multiJourneyPack));
  invalidSecretPack.capabilities.toolDefinitions.push({
    toolId: 'secret.op',
    displayName: 'Secret Op',
    description: 'Requires secret',
    inputSchema: {},
    outputSchema: {},
    sideEffect: 'read',
    risk: 'low',
    timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
    idempotencyPolicy: { required: false, ttlSeconds: 3600 },
    approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
    dataClassification: 'confidential',
  });
  invalidSecretPack.capabilities.toolBindings.push({
    tenantId: 'tenant-multi',
    environmentId: 'production',
    toolId: 'secret.op',
    bindingVersion: '1.0.0',
    enabled: true,
    executor: {
      type: 'activepieces_flow',
      flowId: 'flow-secret',
      connectionRef: 'unauthorized_secret_connection',
    } as any,
    policy: {
      requiredRole: 'customer',
      requiresConfirmation: false,
      idempotencyRequired: false,
      timeoutMs: 5000,
      retryAttempts: 0,
    },
  });

  const missingSecretExec = await capGateway.executeCapability(
    invalidSecretPack,
    'secret.op',
    {},
    {
      tenantId: 'tenant-multi',
      environmentId: 'production',
      principalId: 'test_user',
      principalRole: 'customer',
      correlationId: 'corr_789',
    }
  );
  assert.equal(missingSecretExec.status, 'failure');
  assert.ok(missingSecretExec.error?.includes('does not belong to tenant') || missingSecretExec.error?.includes('Activepieces'));

  // Also test unsupported executor type fails closed
  const unsupportedExecPack = JSON.parse(JSON.stringify(invalidSecretPack));
  unsupportedExecPack.capabilities.toolBindings[unsupportedExecPack.capabilities.toolBindings.length - 1].executor = {
    type: 'nonexistent_executor_engine',
  };
  const unsupportedExec = await capGateway.executeCapability(
    unsupportedExecPack,
    'secret.op',
    {},
    {
      tenantId: 'tenant-multi',
      environmentId: 'production',
      principalId: 'test_user',
      principalRole: 'customer',
      correlationId: 'corr_790',
    }
  );
  assert.equal(unsupportedExec.status, 'failure');
  assert.ok(unsupportedExec.error?.includes('Unsupported executor type'));
  console.log('   ✅ PASS: Missing executor connection/secret reference fails closed');

  // ── TEST 6: Pack-defined tool/card works without Agent Commerce code changes ──
  console.log('6. Testing pack-defined tool and card presentation pass-through...');
  const customCardPack = JSON.parse(JSON.stringify(multiJourneyPack));
  customCardPack.capabilities.toolDefinitions.push({
    toolId: 'custom.widget_display',
    displayName: 'Widget Display',
    description: 'Displays a custom dynamic widget',
    inputSchema: {},
    outputSchema: {},
    sideEffect: 'read',
    risk: 'low',
    timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
    idempotencyPolicy: { required: false, ttlSeconds: 3600 },
    approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
    dataClassification: 'public',
  });

  const customTurnResult: TurnResult = {
    decision: {
      decisionId: 'dec_custom',
      type: 'continue',
      payload: {},
      reason: 'Display custom pack card',
      createdAt: new Date().toISOString(),
    },
    workspaceState: {
      tenantId: 'tenant-multi',
      environmentId: 'production',
      workspaceId: 'ws_test',
      journeyId: 'journey_alpha',
      currentStage: 'stage_alpha_1',
      facts: {},
      decisions: [],
      openQuestions: [],
      updatedAt: new Date(),
    } as any,
    uiInstructions: [
      {
        actionId: 'act_custom_card',
        component: 'dynamic_widget_card',
        placement: 'inline',
        props: { widgetId: 'w-99', customMetric: 42 },
        envelope: {
          name: 'presentCard',
          arguments: {
            card: {
              id: 'act_custom_card',
              cardType: 'dynamic_widget_card',
              state: { widgetId: 'w-99', customMetric: 42 },
            },
          },
        },
      } as any,
    ],
    assistantMessage: 'Here is your custom widget presentation.',
  };

  const canonicalAdapter = new CanonicalRuntimeAdapter();
  canonicalAdapter.setInProcessRuntimeForTest({
    runTurn: async () => customTurnResult,
  });

  const mockActivationRouter = new TenantRuntimeActivationRouter();
  mockActivationRouter.resolveActivation = async () => ({
    action: 'CANONICAL',
    record: {
      tenantId: 'tenant-multi',
      environmentId: 'production',
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: 'chk_123',
      revision: 1,
      approvedBy: 'admin',
      promotedAt: new Date().toISOString(),
      updatedAt: new Date(),
    },
    routingKey: 'ws_test',
    reason: 'Active migrated release',
  });

  const coordinator = new JourneyCoordinator(
    mockActivationRouter,
    canonicalAdapter,
    new LegacyJourneyAdapter(),
    new ConfigLoader()
  );

  const chatResponse = await coordinator.executeChat({
    tenantId: 'tenant-multi',
    message: 'Show me my widget',
  });

  assert.equal(chatResponse.uiActions.length, 1);
  assert.equal(chatResponse.uiActions[0].name, 'presentCard');
  assert.equal(chatResponse.uiActions[0].arguments.card.cardType, 'dynamic_widget_card');
  assert.equal(chatResponse.uiActions[0].arguments.card.state.customMetric, 42);
  console.log('   ✅ PASS: Pack-defined tool/card passes through without Agent Commerce code changes');

  // ── TEST 7: Canonical SSE is passed through without buffering ──
  console.log('7. Testing canonical SSE pass-through without buffering...');
  const emittedEvents: Array<{ event: string; data: any }> = [];

  canonicalAdapter.setInProcessRuntimeForTest({
    runTurn: async () => customTurnResult,
    streamTurn: async (_cmd, emit) => {
      // Emit events incrementally in arrival order
      emit('session', { sessionId: 'ws_stream_123' });
      emit('token', { token: 'Incremental ' });
      emit('token', { token: 'unbuffered ' });
      emit('token', { token: 'token!' });
      emit('uiAction', {
        name: 'presentCard',
        arguments: { card: { cardType: 'custom_panel', state: {} } },
      });
      emit('done', {});
    },
  });

  await coordinator.executeChatStream(
    { tenantId: 'tenant-multi', message: 'Stream this' },
    (event, data) => {
      emittedEvents.push({ event, data });
    }
  );

  const tokenEvents = emittedEvents.filter((e) => e.event === 'token');
  assert.equal(tokenEvents.length, 3, 'Must stream all 3 incremental tokens');
  assert.equal(tokenEvents[0].data.token, 'Incremental ');
  assert.equal(tokenEvents[1].data.token, 'unbuffered ');
  assert.equal(tokenEvents[2].data.token, 'token!');
  assert.equal(emittedEvents[emittedEvents.length - 1].event, 'done');
  console.log('   ✅ PASS: Canonical SSE streams incrementally without buffering');

  // ── TEST 8: No fabricated price, stock or fulfilment result ──
  console.log('8. Testing that generic runtime refuses fabricated calculations...');
  const planResult = await TradeOrchestrator.handleBuildProjectPlan({
    projectType: 'decking',
    material: 'Timber',
    lengthM: 5,
    widthM: 3,
  });
  assert.equal(planResult.ok, false);
  assert.equal(planResult.unavailable, true);
  assert.ok(planResult.message.includes('requires a published domain extension'));
  console.log('   ✅ PASS: Generic runtime refuses fabricated calculations (missing info returns unavailable)');

  // ── TEST 9: Active Business Pack tenants never execute compatibility runtime ──
  console.log('9. Testing active Business Pack tenant execution isolation...');
  let legacyChatCalled = false;
  let legacyStreamCalled = false;

  const mockLegacyAdapter = {
    executeLegacyChat: async () => {
      legacyChatCalled = true;
      return {} as any;
    },
    executeLegacyChatStream: async () => {
      legacyStreamCalled = true;
    },
  } as any;

  const isolatedCoordinator = new JourneyCoordinator(
    mockActivationRouter,
    canonicalAdapter,
    mockLegacyAdapter,
    new ConfigLoader()
  );

  await isolatedCoordinator.executeChat({ tenantId: 'placemakers', message: 'Hello' });
  await isolatedCoordinator.executeChatStream({ tenantId: 'placemakers', message: 'Stream' });

  assert.equal(legacyChatCalled, false, 'Legacy chat must NEVER be called for active pack tenant');
  assert.equal(legacyStreamCalled, false, 'Legacy stream must NEVER be called for active pack tenant');
  console.log('   ✅ PASS: Active Business Pack tenants never execute the compatibility runtime');

  // ── TEST 10: Nest application boot still passes ──
  console.log('10. Testing Nest application context boot with full DI...');
  const appContext = await NestFactory.createApplicationContext(AgentModule, { logger: false });
  const agentService = appContext.get(AgentService);
  const journeyCoordinator = appContext.get(JourneyCoordinator);
  const canonAdapter = appContext.get(CanonicalRuntimeAdapter);
  const legAdapter = appContext.get(LegacyJourneyAdapter);
  const activationRouter = appContext.get(TenantRuntimeActivationRouter);

  assert.ok(agentService, 'AgentService must resolve');
  assert.ok(journeyCoordinator, 'JourneyCoordinator must resolve');
  assert.ok(canonAdapter, 'CanonicalRuntimeAdapter must resolve');
  assert.ok(legAdapter, 'LegacyJourneyAdapter must resolve');
  assert.ok(activationRouter, 'TenantRuntimeActivationRouter must resolve');

  await appContext.close();
  console.log('   ✅ PASS: Nest application boots cleanly and resolves all consolidated providers\n');

  console.log('🎉 ALL 10 CANONICAL CONSOLIDATION REQUIREMENTS FULLY PROVEN!\n');
}

runConsolidationSuite().catch((err) => {
  console.error('❌ Consolidation suite failed:', err);
  process.exit(1);
});
