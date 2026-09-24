import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { CapabilityDispatcher } from '@journeyax/capability-sdk';
import { RuntimeModule } from '../src/runtime.module';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';

async function runOutboxRealConsumersSuite() {
  console.log('\n📦 Running Outbox Real Durable Consumers Test Suite (Workstream A)...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  }

  // ── Test 1: notification.dispatch success calls real dispatcher and persists delivery ──
  await test('1. notification.dispatch succeeds, calls dispatcher, records delivery, and marks published', async () => {
    const repo = new OutboxRepository();
    const deliveriesRecorded: any[] = [];

    const mockNotifDispatcher = {
      dispatch: async (tenantId: string, eventId: string, payload: any, channelsConfig: any, options: any) => {
        deliveriesRecorded.push({
          tenantId,
          eventId,
          payload,
          channelsConfig,
          environmentId: options.environmentId,
          providerDeliveryId: 'prov_sg_123',
          status: 'delivered',
        });
        return {
          success: true,
          deliveries: [
            {
              deliveryId: 'del_001',
              channel: 'email' as const,
              provider: 'sendgrid',
              providerDeliveryId: 'prov_sg_123',
              recipient: 'buyer@example.com',
              status: 'delivered' as const,
            },
          ],
        };
      },
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      notificationDispatcher: mockNotifDispatcher,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'notification.dispatch',
      {
        payload: { message: 'Order confirmation' },
        recipients: ['buyer@example.com'],
        channelsConfig: { email: { enabled: true, provider: 'sendgrid' } },
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_notif_test',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.processed, 1);
    assert.equal(batchRes.succeeded, 1);
    assert.equal(batchRes.failed, 0);

    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'published', 'Event must be acknowledged/published on success');
    assert.equal(deliveriesRecorded.length, 1);
    assert.equal(deliveriesRecorded[0].tenantId, 'tenant_caroma');
    assert.equal(deliveriesRecorded[0].providerDeliveryId, 'prov_sg_123');

    service.stopWorker();
  });

  // ── Test 2: notification.dispatch failure throws and remains retryable (never log-and-ack) ──
  await test('2. notification.dispatch throws on delivery failure and remains pending/retryable', async () => {
    const repo = new OutboxRepository();

    const failingNotifDispatcher = {
      dispatch: async () => ({
        success: false,
        deliveries: [
          {
            deliveryId: 'del_002',
            channel: 'email' as const,
            provider: 'sendgrid',
            recipient: 'bad@example.com',
            status: 'failed' as const,
            error: 'Upstream SMTP connection dropped by provider',
          },
        ],
      }),
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      notificationDispatcher: failingNotifDispatcher,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'notification.dispatch',
      {
        payload: { message: 'Order alert' },
        recipients: ['bad@example.com'],
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_notif_fail',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
      maxAttempts: 3,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.processed, 1);
    assert.equal(batchRes.succeeded, 0);
    assert.equal(batchRes.failed, 1);

    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published', 'Failed notification must NEVER be marked published');
    assert.equal(event.status, 'pending', 'Must remain pending for retry');
    assert.equal(event.attempts, 1);
    assert.match(event.error || '', /Upstream SMTP connection dropped/);

    service.stopWorker();
  });

  // ── Test 3: activepieces.dispatch success invokes capability dispatcher & persists execution idempotently ──
  await test('3. activepieces.dispatch invokes CapabilityDispatcher and upserts execution idempotently', async () => {
    const repo = new OutboxRepository();
    const executionsRecorded: any[] = [];
    const mockDb = {
      collection: (name: string) => ({
        updateOne: async (filter: any, update: any, options: any) => {
          if (name === 'activepieces_executions') {
            assert.ok(filter.eventId, 'Upsert must filter by eventId');
            assert.equal(options?.upsert, true, 'Upsert option must be true');
            executionsRecorded.push({ filter, update });
          }
          return { matchedCount: 1, upsertedCount: 1 };
        },
      }),
    };

    let capDispatched = false;
    const mockCapDispatcher = {
      dispatch: async (toolDef: any, toolBinding: any, req: any, ctx: any) => {
        capDispatched = true;
        assert.equal(toolBinding.executor.type, 'activepieces_flow');
        assert.equal(toolBinding.executor.flowId, 'flow_ct_sync_01');
        assert.equal(toolBinding.executor.connectionRef, 'conn_ct_caroma_secret');
        assert.equal(ctx.tenantId, 'tenant_caroma');
        assert.equal(ctx.environmentId, 'production');
        assert.equal(req.idempotencyKey, ctx.correlationId);
        return { status: 'success' as const, output: { syncCount: 42 } };
      },
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      db: mockDb,
      capabilityDispatcher: mockCapDispatcher,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        flowId: 'flow_ct_sync_01',
        connectionRef: 'conn_ct_caroma_secret',
        input: { fullSync: true },
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_ap_test',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.processed, 1);
    assert.equal(batchRes.succeeded, 1);
    assert.ok(capDispatched, 'CapabilityDispatcher must have been invoked');

    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'published');
    assert.equal(executionsRecorded.length, 1);
    assert.equal(executionsRecorded[0].filter.eventId, eventId);
    assert.deepEqual(executionsRecorded[0].update.$set.output, { syncCount: 42 });

    service.stopWorker();
  });

  // ── Test 4: activepieces.dispatch failure remains retryable and not published ──
  await test('4. activepieces.dispatch throws when external flow fails and remains pending', async () => {
    const repo = new OutboxRepository();

    const failingCapDispatcher = {
      dispatch: async () => ({
        status: 'failure' as const,
        error: 'Activepieces HTTP 504 Gateway Timeout',
      }),
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      capabilityDispatcher: failingCapDispatcher,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        flowId: 'flow_ct_sync_01',
        connectionRef: 'conn_ct_caroma_secret',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_ap_fail',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
      maxAttempts: 3,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.processed, 1);
    assert.equal(batchRes.succeeded, 0);
    assert.equal(batchRes.failed, 1);

    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published');
    assert.equal(event.status, 'pending');
    assert.equal(event.attempts, 1);
    assert.match(event.error || '', /Activepieces HTTP 504 Gateway Timeout/);

    service.stopWorker();
  });

  // ── Test 5: activepieces.dispatch rejects missing flowId or connectionRef ───────
  await test('5. activepieces.dispatch fails closed on missing flowId or connectionRef', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    service.configureHandlers({});

    const missingConnId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      { flowId: 'flow_ct_sync_01' } // Missing connectionRef
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_ap_missing_ref',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1);

    const event = repo.getEvents().find((e) => e.eventId === missingConnId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /Missing mandatory 'connectionRef'/);

    service.stopWorker();
  });

  // ── Test 6: business_pack.published persists audit log idempotently and throws on DB failure ─
  await test('6. business_pack.published persists audit log via idempotent upsert; DB failure leaves event pending', async () => {
    const repo = new OutboxRepository();
    const auditLogs: any[] = [];

    // 6a. Success case: idempotent upsert
    const healthyDb = {
      collection: (name: string) => ({
        updateOne: async (filter: any, update: any, options: any) => {
          if (name === 'audit_logs') {
            assert.ok(filter.eventId);
            assert.equal(options?.upsert, true);
            auditLogs.push({ filter, update });
          }
          return { matchedCount: 1, upsertedCount: 1 };
        },
      }),
    };

    const healthyService = new OutboxWorkerService();
    healthyService.configureHandlers({ db: healthyDb });
    const successEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'business_pack.published',
      { packId: 'pack_c1', version: '2.0.0' }
    );

    const worker1 = healthyService.startWithRepository(repo, undefined, {
      workerId: 'worker_bp_success',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    await worker1.processNextBatch();
    const successEvent = repo.getEvents().find((e) => e.eventId === successEventId)!;
    assert.equal(successEvent.status, 'published');
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].update.$setOnInsert.payload.version, '2.0.0');
    assert.equal(auditLogs[0].filter.eventId, successEventId);
    healthyService.stopWorker();

    // 6b. Failure case: DB throws error
    const failingDb = {
      collection: () => ({
        updateOne: async () => {
          throw new Error('MongoNetworkError: connection timed out');
        },
      }),
    };

    const failingService = new OutboxWorkerService();
    failingService.configureHandlers({ db: failingDb });
    const failEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'business_pack.published',
      { packId: 'pack_c1', version: '2.0.1' }
    );

    const worker2 = failingService.startWithRepository(repo, undefined, {
      workerId: 'worker_bp_fail',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    await worker2.processNextBatch();
    const failEvent = repo.getEvents().find((e) => e.eventId === failEventId)!;
    assert.notEqual(failEvent.status, 'published', 'Event must NOT be published if audit persistence fails');
    assert.equal(failEvent.status, 'pending');
    assert.match(failEvent.error || '', /MongoNetworkError/);
    failingService.stopWorker();
  });

  // ── Test 7: Unregistered event types throw and are never acknowledged ──────────
  await test('7. Unregistered event types throw and remain pending (no log-and-ack)', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService(); // Empty production handlers; no webhook consumer injected

    const webhookEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'webhook.dispatch',
      { url: 'https://example.com/webhook', data: { test: true } }
    );

    const randomEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'custom.arbitrary.unhandled',
      { data: 123 }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_unhandled',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.processed, 2);
    assert.equal(batchRes.failed, 2);
    assert.equal(batchRes.succeeded, 0);

    const webhookEvent = repo.getEvents().find((e) => e.eventId === webhookEventId)!;
    const randomEvent = repo.getEvents().find((e) => e.eventId === randomEventId)!;

    assert.equal(webhookEvent.status, 'pending');
    assert.match(webhookEvent.error || '', /No handler registered for event type 'webhook.dispatch'/);

    assert.equal(randomEvent.status, 'pending');
    assert.match(randomEvent.error || '', /No handler registered for event type 'custom.arbitrary.unhandled'/);

    service.stopWorker();
  });

  // ── Test 8: Dead-letter queue transition after max retry attempts ──────────────
  await test('8. Exhausted retry attempts transition outbox event to dead_letter', async () => {
    const repo = new OutboxRepository();
    const failingService = new OutboxWorkerService();
    failingService.configureHandlers({
      notificationDispatcher: {
        dispatch: async () => {
          throw new Error('Fatal persistent failure');
        },
      } as any,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'notification.dispatch',
      { message: 'Fatal' }
    );

    const worker = failingService.startWithRepository(repo, undefined, {
      workerId: 'worker_dlq',
      batchSize: 5,
      pollIntervalMs: 10,
      leaseDurationMs: 1000,
      maxAttempts: 3,
      backoffBaseMs: 1,
    });

    // Attempt 1
    await worker.processNextBatch();
    let event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.attempts, 1);
    assert.equal(event.status, 'pending');

    // Attempt 2
    event.nextAttemptAt = new Date(Date.now() - 1000);
    await worker.processNextBatch();
    event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.attempts, 2);
    assert.equal(event.status, 'pending');

    // Attempt 3: Reaches maxAttempts (3) -> moves to dead_letter
    event.nextAttemptAt = new Date(Date.now() - 1000);
    await worker.processNextBatch();
    event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.attempts, 3);
    assert.equal(event.status, 'dead_letter', 'Must transition to dead_letter upon exhausting maxAttempts');

    failingService.stopWorker();
  });

  // ── Test 9: Nest module boot test verifies dependency injection without Object tokens ──
  await test('9. Nest module boot succeeds without DI errors or Object token failures', async () => {
    const app = await NestFactory.createApplicationContext(RuntimeModule, { logger: false });
    const outboxService = app.get(OutboxWorkerService);
    assert.ok(outboxService instanceof OutboxWorkerService, 'OutboxWorkerService must be resolvable from Nest DI');
    await app.close();
  });

  // ── Test 10: Real CapabilityDispatcher policy gate integration ────────────────
  await test('10. Real CapabilityDispatcher policy gate enforces confirmation and throws when denied/requires_approval', async () => {
    const repo = new OutboxRepository();
    const executionsRecorded: any[] = [];
    const mockDb = {
      collection: (name: string) => ({
        updateOne: async (filter: any, update: any, options: any) => {
          if (name === 'activepieces_executions') {
            executionsRecorded.push({ filter, update, options });
          }
          return { matchedCount: 1, upsertedCount: 1 };
        },
      }),
    };

    // Real CapabilityDispatcher with verified connection ownership and explicit credentials
    const realCapDispatcher = new CapabilityDispatcher({
      activepiecesApiUrl: 'http://localhost:3010',
      activepiecesApiKey: 'test_ap_key_123',
      activepiecesWebhookSecret: 'test_ap_secret_456',
      validateConnectionOwnership: async (t, e, c) => {
        return t === 'tenant_caroma' && e === 'production' && c === 'conn_ct_caroma_secret';
      },
    });

    // 10a: When userConfirmationConfirmed is false, PolicyGate returns requires_approval.
    // Real CapabilityDispatcher returns status: 'requires_approval'.
    // The handler must throw and the outbox event must NOT be published.
    const service = new OutboxWorkerService();
    service.configureHandlers({
      db: mockDb,
      capabilityDispatcher: realCapDispatcher,
    });

    const unconfirmedEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        flowId: 'flow_ct_sync_01',
        connectionRef: 'conn_ct_caroma_secret',
        risk: 'high',
        userConfirmationConfirmed: false, // Explicitly unconfirmed
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_policy_gate_test',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const unconfirmedBatchRes = await worker.processNextBatch();
    assert.equal(unconfirmedBatchRes.failed, 1, 'Policy gate requires_approval must cause batch failure');
    const unconfirmedEvent = repo.getEvents().find((e) => e.eventId === unconfirmedEventId)!;
    assert.notEqual(unconfirmedEvent.status, 'published', 'Unapproved event must NOT be marked published');
    assert.equal(unconfirmedEvent.status, 'pending');
    assert.match(unconfirmedEvent.error || '', /requires_approval/);

    // 10b: When confirmed and ownership is valid, real CapabilityDispatcher calls the provider.
    // Intercept globalThis.fetch to simulate Activepieces responding 200 OK.
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string, init: any) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', syncedProducts: 100 }),
        };
      };

      const confirmedEventId = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        {
          flowId: 'flow_ct_sync_01',
          connectionRef: 'conn_ct_caroma_secret',
          risk: 'medium',
          userConfirmationConfirmed: true,
          input: { force: true },
        }
      );

      const confirmedBatchRes = await worker.processNextBatch();
      assert.equal(confirmedBatchRes.succeeded, 1, 'Approved policy execution must succeed');
      const confirmedEvent = repo.getEvents().find((e) => e.eventId === confirmedEventId)!;
      assert.equal(confirmedEvent.status, 'published', 'Approved event must be published');
      assert.equal(executionsRecorded.length, 1);
      assert.equal(executionsRecorded[0].filter.eventId, confirmedEventId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    service.stopWorker();
  });

  console.log(`\nOutbox Real Consumers Test Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runOutboxRealConsumersSuite().catch((err) => {
  console.error('Fatal test error in Outbox Real Consumers suite:', err);
  process.exit(1);
});
