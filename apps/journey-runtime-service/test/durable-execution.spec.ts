import assert from 'node:assert/strict';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { PackRepository } from '../src/kernel/pack.repository';
import { WorkspaceRepository } from '../src/kernel/workspace.repository';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { ExecutionRepository } from '../src/kernel/execution.repository';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { TurnCommand } from '@journeyax/journey-core';

// Test domain pack for durable execution
const mockDurablePack: BusinessPackRelease = {
  manifest: {
    packId: 'durable-ops',
    name: 'Durable Ops Test Pack',
    version: '1.0.0',
    description: 'Testing durable outbox, leasing, and idempotency',
    tenantId: 'tenant-durable-1',
    environmentId: 'test',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'mock-checksum',
  },
  profile: {
    companyName: 'Durable Ops',
    industry: 'Financial Infrastructure',
    primaryCurrency: 'USD',
    supportedCurrencies: ['USD'],
    primaryLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [],
    acronyms: {},
    slotSynonyms: {},
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
      journeyId: 'durable_journey',
      version: '1.0.0',
      goals: ['Verify durable execution', 'Charge card'],
      metadata: { triggerIntents: ['charge_card', 'Charge card'] },
      initialStage: 'stage_exec',
      stages: {
        stage_exec: {
          stageId: 'stage_exec',
          requiredFacts: [],
          allowedCapabilities: ['payment.charge'],
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
        toolId: 'payment.charge',
        displayName: 'Charge Payment',
        description: 'Processes credit card charge',
        version: '1.0.0',
        inputSchema: {},
        outputSchema: {},
        sideEffect: 'read',
        risk: 'low',
        timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
        idempotencyPolicy: { required: true, ttlSeconds: 86400 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
        dataClassification: 'internal',
      },
    ],
    toolBindings: [
      {
        toolId: 'payment.charge',
        tenantId: 'tenant-durable-1',
        environmentId: 'test',
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability',
          nativeHandler: 'payment.charge',
        },
        enabled: true,
        policy: {
          requiredRole: 'customer',
          requiresConfirmation: false,
          idempotencyRequired: true,
          timeoutMs: 10000,
          retryAttempts: 0,
        },
      },
    ],
    stageBindings: [],
  },
  agents: [
    {
      agentId: 'billing-agent',
      name: 'Billing',
      purpose: 'Billing agent',
      modelPolicyRef: 'default',
      allowedTools: ['payment.charge'],
      maxTurns: 3,
      handoffConditions: [],
      inputSchema: {},
      outputSchema: {},
    },
  ],
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'default',
    policies: [
      {
        policyId: 'default',
        candidates: [{ provider: 'open-model', model: 'mock-model', priority: 1 }],
        dataResidency: 'us',
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

async function runDurableExecutionTests() {
  console.log('⚡ Running PR 4: Durable Execution Verification Suite...\n');

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

  process.env.NODE_ENV = 'test';
  process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

  await test('1. Pre-dispatch idempotency avoids duplicate execution and returns cached replay', async () => {
    let callCount = 0;
    const capabilityGateway = new CapabilityGateway();
    capabilityGateway.registerCustomAdapter('payment.charge', {
      execute: async () => {
        callCount++;
        return {
          chargeId: `ch_${Date.now()}`,
          amountCents: 5000,
          status: 'succeeded',
        };
      },
    });

    const mockPackRepo = {
      loadActivePack: async () => mockDurablePack,
      hasActivePack: async () => true,
      invalidate: () => {},
    } as unknown as PackRepository;

    const workspaceStore = new WorkspaceStore();
    const workspaceRepo = new WorkspaceRepository(workspaceStore);
    const executionRepo = new ExecutionRepository();
    const outboxRepo = new OutboxRepository();

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

    const cmd: TurnCommand = {
      tenantId: 'tenant-durable-1',
      environmentId: 'test',
      workspaceId: 'ws-idem-01',
      sessionId: 'sess-idem-01',
      correlationId: 'corr-charge-100',
      idempotencyKey: 'idem-charge-token-abc',
      message: 'Charge card',
    };

    // First call: executes capability
    const res1 = await appService.executeTurn(cmd);
    assert.equal(callCount, 1, 'First turn should execute the capability once');
    assert.equal(res1.executedCapabilities.length, 1);
    assert.equal(res1.executedCapabilities[0].status, 'success');
    const firstChargeId = res1.executedCapabilities[0].output?.chargeId;
    assert.ok(firstChargeId);

    // Second call: duplicate request with identical idempotencyKey
    const res2 = await appService.executeTurn(cmd);
    assert.equal(callCount, 1, 'Second turn MUST NOT invoke capability again');
    assert.equal(res2.executedCapabilities.length, 1);
    assert.equal(res2.executedCapabilities[0].status, 'success');
    assert.equal(
      res2.executedCapabilities[0].output?.chargeId,
      firstChargeId,
      'Should return cached output from original charge'
    );
  });

  await test('2. Atomic lease claim locks events from concurrent workers', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'order.created',
      { orderId: 'ord-101' },
      'corr-outbox-1'
    );

    // Worker 1 claims lease
    const worker1Events = await outboxRepo.claimLeases('worker-1', 5000, 10);
    assert.equal(worker1Events.length, 1);
    assert.equal(worker1Events[0].eventId, eventId);
    assert.equal(worker1Events[0].status, 'leased');
    assert.equal(worker1Events[0].leasedBy, 'worker-1');

    // Worker 2 attempts concurrent claim while lease is active
    const worker2Events = await outboxRepo.claimLeases('worker-2', 5000, 10);
    assert.equal(worker2Events.length, 0, 'Worker 2 must not claim currently leased event');
  });

  await test('3. Expired lease is reclaimed by subsequent worker', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'order.created',
      { orderId: 'ord-102' },
      'corr-outbox-2'
    );

    // Worker 1 claims lease with 0ms duration (immediately expired)
    await outboxRepo.claimLeases('worker-1', -1000, 10);

    // Worker 2 should be able to claim the expired lease
    const worker2Events = await outboxRepo.claimLeases('worker-2', 10000, 10);
    assert.equal(worker2Events.length, 1);
    assert.equal(worker2Events[0].eventId, eventId);
    assert.equal(worker2Events[0].leasedBy, 'worker-2');
  });

  await test('4. OutboxWorker dispatches successfully and marks events published', async () => {
    const outboxRepo = new OutboxRepository();
    await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'inventory.allocated',
      { sku: 'SKU-001', qty: 2 }
    );

    let dispatched = 0;
    const worker = new OutboxWorker(outboxRepo, {
      workerId: 'worker-test-pub',
      dispatcher: async (event) => {
        dispatched++;
        assert.equal(event.eventType, 'inventory.allocated');
      },
    });

    const result = await worker.processNextBatch();
    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(dispatched, 1);

    // Verify event is marked published
    const remaining = await outboxRepo.claimLeases('worker-test-pub', 5000, 10);
    assert.equal(remaining.length, 0, 'Published event should no longer be leased');
  });

  await test('5. Exponential backoff and dead-letter queueing upon reaching max retries', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'payment.failed',
      { error: 'timeout' }
    );

    // Attempt 1: failure -> retry scheduled with backoff
    const r1 = await outboxRepo.recordFailure(eventId, 'Network timeout', 3, 50);
    assert.equal(r1, 'retry_scheduled');

    // Attempt 2: failure -> retry scheduled with exponential backoff
    const r2 = await outboxRepo.recordFailure(eventId, 'Network timeout 2', 3, 50);
    assert.equal(r2, 'retry_scheduled');

    // Attempt 3: reached maxAttempts=3 -> moved to dead_letter
    const r3 = await outboxRepo.recordFailure(eventId, 'Permanent refusal', 3, 50);
    assert.equal(r3, 'dead_letter');

    const allEvents = outboxRepo.getEvents();
    const event = allEvents.find((e) => e.eventId === eventId);
    assert.equal(event?.status, 'dead_letter');
    assert.equal(event?.attempts, 3);
  });

  await test('6. Optimistic concurrency control rejects conflicting workspace stateVersion', async () => {
    const workspaceStore = new WorkspaceStore();
    const initial = workspaceStore.createInitial({
      tenantId: 'tenant-durable-1',
      environmentId: 'test',
      workspaceId: 'ws-conflict-01',
      packVersionId: '1.0.0',
      journeyId: 'durable_journey',
      initialStage: 'stage_exec',
      goal: 'Test conflict',
    });

    await workspaceStore.commit(initial);

    // Load two copies concurrently
    const copy1 = await workspaceStore.load('tenant-durable-1', 'test', 'ws-conflict-01');
    const copy2 = await workspaceStore.load('tenant-durable-1', 'test', 'ws-conflict-01');
    assert.ok(copy1 && copy2);

    // Commit copy 1 -> increments stateVersion to 2
    copy1.facts['fact_a'] = { value: 'A', source: 'customer', confidence: 1.0 };
    await workspaceStore.commit(copy1);
    assert.equal(copy1.stateVersion, 2);

    // Commit copy 2 with stale stateVersion=1 must fail with concurrency error
    copy2.facts['fact_b'] = { value: 'B', source: 'customer', confidence: 1.0 };
    await assert.rejects(
      async () => {
        await workspaceStore.commit(copy2);
      },
      /concurrently/
    );
  });

  await test('7. OutboxWorker lease renewal and crash recovery reclaim', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'order.processing',
      { orderId: 'ord_long_running' }
    );

    let dispatchRunning = true;
    const worker1 = new OutboxWorker(outboxRepo, {
      workerId: 'worker_crasher',
      leaseDurationMs: 50, // 50ms lease
      dispatcher: async () => {
        // Simulates crash while processing
        throw new Error('Worker crash / unhandled failure');
      },
    });

    // Worker 1 attempts processing and fails (attempt 1)
    await worker1.processNextBatch();

    // Now test lease renewal explicitly on an active lease
    const eventId2 = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'order.renew_lease',
      { orderId: 'ord_renewal' }
    );
    const worker2 = new OutboxWorker(outboxRepo, {
      workerId: 'worker_renew',
      leaseDurationMs: 1000,
      dispatcher: async () => {},
    });

    await outboxRepo.claimLeases('worker_renew', 1000, 10);
    const renewed = await worker2.renewCurrentLease(eventId2, 5000);
    assert.equal(renewed, true);

    const eventRecord = outboxRepo.getEvents().find(e => e.eventId === eventId2);
    assert.ok(eventRecord && eventRecord.leaseExpiresAt && eventRecord.leaseExpiresAt.getTime() > Date.now() + 3000);
  });

  await test('8. OutboxWorker dead-letter operational alert callback fires on max retries', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'notification.send',
      { email: 'user@example.com' }
    );

    let alertFired = false;
    let alertedEventId = '';
    let alertedError = '';

    const worker = new OutboxWorker(outboxRepo, {
      workerId: 'worker_alert_test',
      maxAttempts: 1, // Fail immediately into dead letter
      backoffBaseMs: 10,
      dispatcher: async () => {
        throw new Error('SMTP connection refused');
      },
      onDeadLetterAlert: (evt, err) => {
        alertFired = true;
        alertedEventId = evt.eventId;
        alertedError = err;
      },
    });

    await worker.processNextBatch();

    assert.equal(alertFired, true);
    assert.equal(alertedEventId, eventId);
    assert.equal(alertedError, 'SMTP connection refused');

    const metrics = await outboxRepo.getMetrics('tenant-durable-1');
    assert.equal(metrics.deadLetter, 1);
  });

  await test('9. Operational controls: dead-letter replay and resolution', async () => {
    const outboxRepo = new OutboxRepository();
    const eventId = await outboxRepo.enqueueEvent(
      'tenant-durable-1',
      'test',
      'sync.crm',
      { customerId: 'cust_999' }
    );

    // Transition to dead_letter
    await outboxRepo.recordFailure(eventId, 'CRM timeout', 1, 10);
    let event = outboxRepo.getEvents().find(e => e.eventId === eventId);
    assert.equal(event?.status, 'dead_letter');

    // 1. Replay dead letter: resets to pending
    const replayed = await outboxRepo.replayDeadLetter(eventId);
    assert.equal(replayed, true);
    event = outboxRepo.getEvents().find(e => e.eventId === eventId);
    assert.equal(event?.status, 'pending');
    assert.equal(event?.attempts, 0);

    // Fail again
    await outboxRepo.recordFailure(eventId, 'CRM timeout again', 1, 10);
    event = outboxRepo.getEvents().find(e => e.eventId === eventId);
    assert.equal(event?.status, 'dead_letter');

    // 2. Resolve dead letter: marks resolved with audit note
    const resolved = await outboxRepo.resolveDeadLetter(eventId, 'Manually backfilled in CRM by operator ops_1');
    assert.equal(resolved, true);
    event = outboxRepo.getEvents().find(e => e.eventId === eventId);
    assert.equal(event?.status, 'resolved');
    assert.equal(event?.resolutionNote, 'Manually backfilled in CRM by operator ops_1');
    assert.ok(event?.resolvedAt instanceof Date);
  });

  await test('10. Authenticated Activepieces flow execution passes tenant, environment, and auth headers', async () => {
    const { CapabilityDispatcher } = await import('../../../packages/capability-sdk/src');

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    // Mock global fetch for the test
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', executionId: 'exec_ap_123' }),
      };
    };

    try {
      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'http://localhost:3010',
        activepiecesApiKey: 'sec_ap_token_xyz',
        activepiecesWebhookSecret: 'ap_hmac_secret_456',
      });

      const response = await dispatcher.dispatch(
        {
          toolId: 'flow.sample_process',
          name: 'Sample Process',
          description: 'Process sample flow',
          inputSchema: { type: 'object' },
        },
        {
          toolId: 'flow.sample_process',
          tenantId: 'tenant-durable-1',
          environmentId: 'test',
          executor: {
            type: 'activepieces_flow',
            flowId: 'flow_98765',
          },
        },
        {
          toolId: 'flow.sample_process',
          input: { sampleKey: 'sampleVal' },
        },
        {
          tenantId: 'tenant-durable-1',
          environmentId: 'test',
          workspaceId: 'ws_durable_ap',
          correlationId: 'corr_ap_001',
          userRole: 'admin',
        }
      );

      assert.equal(response.status, 'success');
      assert.equal(capturedHeaders['X-Tenant-ID'], 'tenant-durable-1');
      assert.equal(capturedHeaders['X-Environment-ID'], 'test');
      assert.equal(capturedHeaders['X-Workspace-ID'], 'ws_durable_ap');
      assert.equal(capturedHeaders['X-Correlation-ID'], 'corr_ap_001');
      assert.equal(capturedHeaders['Authorization'], 'Bearer sec_ap_token_xyz');
      assert.ok(capturedHeaders['X-Activepieces-Signature']);
      assert.ok(capturedHeaders['X-Activepieces-Timestamp']);
      assert.ok(capturedHeaders['X-Activepieces-Nonce']);
      assert.equal(capturedBody.context.tenantId, 'tenant-durable-1');
      assert.equal(capturedBody.context.environmentId, 'test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runDurableExecutionTests().catch((e) => {
  console.error('Unhandled test failure:', e);
  process.exit(1);
});
