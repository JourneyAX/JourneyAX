import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { CapabilityDispatcher } from '@journeyax/capability-sdk';
import { computePackChecksum } from '@journeyax/business-pack';
import { RuntimeModule } from '../src/runtime.module';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';
import { ApprovalService } from '../src/kernel/approval.service';

process.env.ACTIVEPIECES_API_URL = process.env.ACTIVEPIECES_API_URL || 'http://localhost:3010';
process.env.ALLOW_IN_MEMORY_OUTBOX = 'true';

function createMockOutboxDb(overrides: {
  workspaces?: any;
  sessions?: any;
  businessPackPointers?: any;
  businessPackReleases?: any;
  tenantConnections?: any;
  tenantSecrets?: any[];
  approvalRequests?: any[];
  stageId?: string;
  principalRole?: string;
  releaseChecksum?: string;
  capabilities?: any;
} = {}) {
  const approvals = new Map<string, any>();
  if (overrides.approvalRequests) {
    for (const app of overrides.approvalRequests) {
      const id = app.approvalId || app.approvalRequestId || app._id;
      approvals.set(id, {
        ...app,
        _id: id,
        approvalId: id,
        approvalRequestId: id,
      });
    }
  }

  const executions: any[] = [];
  const auditLogs: any[] = [];

  const defaultTools = [
    {
      toolId: 'activepieces.flow_ct_sync_01',
      sideEffect: 'read',
      risk: 'low',
    },
    {
      toolId: 'activepieces.flow_ct_write_01',
      sideEffect: 'write',
      risk: 'high',
    },
  ];

  const defaultToolBindings = [
    {
      toolId: 'activepieces.flow_ct_sync_01',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_ct_sync_01',
        connectionRef: 'conn_ct_caroma_secret',
      },
    },
    {
      toolId: 'activepieces.flow_ct_write_01',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_ct_write_01',
        connectionRef: 'conn_ct_caroma_secret',
      },
    },
  ];

  const capabilities = {
    toolDefinitions: overrides.capabilities?.toolDefinitions || defaultTools,
    toolBindings: overrides.capabilities?.toolBindings || defaultToolBindings,
    stageBindings:
      overrides.capabilities?.stageBindings !== undefined
        ? overrides.capabilities.stageBindings
        : [
            {
              stageId: 'stage_sync',
              tools: [
                { toolId: 'activepieces.flow_ct_sync_01' },
                { toolId: 'activepieces.flow_ct_write_01' },
                ...(overrides.capabilities?.toolDefinitions || []).map((t: any) => ({ toolId: t.toolId })),
              ],
            },
            {
              stageId: 'stage_test',
              tools: [
                { toolId: 'activepieces.flow_ct_sync_01' },
                { toolId: 'activepieces.flow_ct_write_01' },
                ...(overrides.capabilities?.toolDefinitions || []).map((t: any) => ({ toolId: t.toolId })),
              ],
            },
            {
              stageId: 'stage_restricted',
              tools: [],
            },
          ],
  };

  const packPayloadToHash = { capabilities };
  const canonicalChecksum = computePackChecksum(packPayloadToHash as any);

  const defaultRelease = {
    tenantId: 'tenant_caroma',
    environmentId: 'production',
    versionId: '1.0.0',
    version: '1.0.0',
    status: 'published',
    checksum: overrides.releaseChecksum !== undefined ? overrides.releaseChecksum : canonicalChecksum,
    capabilities,
  };

  const defaultSecrets = overrides.tenantSecrets || [
    {
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      secretRef: 'activepieces_api_key',
      value: 'test_ap_key_123',
    },
    {
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      secretRef: 'activepieces_webhook_secret',
      value: 'test_ap_secret_456',
    },
  ];

  return {
    approvals,
    executions,
    auditLogs,
    collection: (name: string) => ({
      findOne: async (query: any) => {
        if (name === 'workspaces') {
          if (overrides.workspaces === null) return null;
          if (query.workspaceId === 'ws_forged_unauthorized') return null;
          return {
            tenantId: query.tenantId || 'tenant_caroma',
            environmentId: query.environmentId || 'production',
            workspaceId: query.workspaceId || 'ws_caroma',
            currentStage: overrides.stageId || 'stage_sync',
            packVersionId: '1.0.0',
            ...(overrides.workspaces || {}),
          };
        }
        if (name === 'sessions') {
          if (overrides.sessions === null) return null;
          return {
            tenantId: query.tenantId || 'tenant_caroma',
            environmentId: query.environmentId || 'production',
            workspaceId: query.workspaceId || 'ws_caroma',
            sessionId: query.sessionId || 'session_caroma_01',
            principalRole: overrides.principalRole || 'customer',
            principalId: 'user_caroma_01',
            ...(overrides.sessions || {}),
          };
        }
        if (name === 'business_pack_pointers') {
          if (overrides.businessPackPointers === null) return null;
          return {
            tenantId: query.tenantId || 'tenant_caroma',
            environmentId: query.environmentId || 'production',
            activeVersionId: '1.0.0',
            checksum: overrides.releaseChecksum !== undefined ? overrides.releaseChecksum : canonicalChecksum,
            ...(overrides.businessPackPointers || {}),
          };
        }
        if (name === 'business_pack_releases') {
          if (overrides.businessPackReleases === null) return null;
          if (overrides.businessPackReleases) {
            if (
              query.environmentId &&
              overrides.businessPackReleases.environmentId &&
              overrides.businessPackReleases.environmentId !== query.environmentId
            ) {
              return null;
            }
            return overrides.businessPackReleases;
          }
          if (query.environmentId && defaultRelease.environmentId !== query.environmentId) {
            return null;
          }
          return defaultRelease;
        }
        if (name === 'tenant_connections') {
          if (overrides.tenantConnections === null) return null;
          return {
            tenantId: query.tenantId || 'tenant_caroma',
            environmentId: query.environmentId || 'production',
            connectionRef: query.connectionRef || 'conn_ct_caroma_secret',
            status: 'active',
            pieceId: '@activepieces/piece-commercetools',
            allowedFlows: ['flow_ct_sync_01', 'flow_ct_write_01'],
            ...(overrides.tenantConnections || {}),
          };
        }
        if (name === 'tenant_secrets') {
          const matched = defaultSecrets.find((s: any) => {
            if (s.tenantId !== query.tenantId) return false;
            if (s.secretRef !== query.secretRef) return false;
            if (query.$or) {
              const envMatch = query.$or.some(
                (c: any) => c.environmentId === s.environmentId || s.environmentId === 'all'
              );
              if (!envMatch) return false;
            } else if (
              query.environmentId &&
              s.environmentId !== query.environmentId &&
              s.environmentId !== 'all'
            ) {
              return false;
            }
            return true;
          });
          return matched || null;
        }
        if (name === 'approval_requests') {
          const searchId = query.approvalId || query.approvalRequestId;
          let app = searchId ? approvals.get(searchId) : null;
          if (!app && query.$or) {
            for (const [_, item] of approvals.entries()) {
              const match = query.$or.some((c: any) => {
                if (c.approvalId && (item.approvalId === c.approvalId || item.approvalRequestId === c.approvalId)) return true;
                if (c.approvalRequestId && (item.approvalRequestId === c.approvalRequestId || item.approvalId === c.approvalRequestId)) return true;
                return false;
              });
              if (match) {
                app = item;
                break;
              }
            }
          }
          if (!app) return null;
          if (query.tenantId && app.tenantId !== query.tenantId) return null;
          if (query.environmentId && app.environmentId !== query.environmentId) return null;
          if (query.workspaceId && app.workspaceId !== query.workspaceId) return null;
          if (query.toolId && app.toolId !== query.toolId) return null;
          if (query.status && app.status !== query.status) return null;
          if (query.$or) {
            const matchesOr = query.$or.some((c: any) => {
              if (app.executionKey === 'ALLOW_CURRENT') return true;
              if (c.executionKey && app.executionKey === c.executionKey) return true;
              if (c.idempotencyKey && app.idempotencyKey === c.idempotencyKey) return true;
              if (c.eventId && (app.eventId === c.eventId || app.executionKey === c.eventId)) return true;
              return false;
            });
            if (!matchesOr) return null;
          }
          return app;
        }
        return null;
      },
      insertOne: async (doc: any) => {
        if (name === 'approval_requests') {
          const id = doc.approvalId || doc.approvalRequestId || doc._id;
          approvals.set(id, { ...doc, _id: id, approvalId: id, approvalRequestId: id });
          return { insertedId: id };
        }
        return { insertedId: 'mock_id' };
      },
      findOneAndUpdate: async (filter: any, update: any, options: any) => {
        if (name === 'approval_requests') {
          for (const [id, app] of approvals.entries()) {
            if (
              app._id === filter._id ||
              id === filter.approvalId ||
              app.approvalId === filter.approvalId ||
              id === filter.approvalRequestId ||
              app.approvalRequestId === filter.approvalRequestId
            ) {
              if (
                app.consumedByEventId &&
                app.consumedByEventId !== update.$set?.consumedByEventId
              ) {
                return { value: null };
              }
              const updated = { ...app, ...update.$set };
              approvals.set(id, updated);
              return { value: updated };
            }
          }
          return { value: null };
        }
        return { value: null };
      },
      updateOne: async (filter: any, update: any, options: any) => {
        if (name === 'approval_requests') {
          for (const [id, app] of approvals.entries()) {
            if (
              app._id === filter._id ||
              id === filter.approvalId ||
              app.approvalId === filter.approvalId ||
              id === filter.approvalRequestId ||
              app.approvalRequestId === filter.approvalRequestId
            ) {
              const updated = { ...app, ...update.$set };
              approvals.set(id, updated);
              return { matchedCount: 1, modifiedCount: 1 };
            }
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (name === 'activepieces_executions') {
          executions.push({ filter, update, options });
        }
        if (name === 'audit_logs') {
          auditLogs.push({ filter, update, options });
        }
        return { matchedCount: 1, upsertedCount: 1 };
      },
    }),
  };
}

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
    const mockDb = createMockOutboxDb();

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
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
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
    assert.equal(mockDb.executions.length, 1);
    assert.equal(mockDb.executions[0].filter.eventId, eventId);
    assert.deepEqual(mockDb.executions[0].update.$set.output, { syncCount: 42 });

    service.stopWorker();
  });

  // ── Test 4: activepieces.dispatch failure remains retryable and not published ──
  await test('4. activepieces.dispatch throws when external flow fails and remains pending', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();

    const failingCapDispatcher = {
      dispatch: async () => ({
        status: 'failure' as const,
        error: 'Activepieces HTTP 504 Gateway Timeout',
      }),
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      db: mockDb,
      capabilityDispatcher: failingCapDispatcher,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        flowId: 'flow_ct_sync_01',
        connectionRef: 'conn_ct_caroma_secret',
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_02',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
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

  // ── Test 5: activepieces.dispatch fails closed on missing tool binding flowId or connectionRef in release ──
  await test('5. activepieces.dispatch fails closed on missing tool binding flowId or connectionRef in release', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({
      capabilities: {
        toolDefinitions: [{ toolId: 'activepieces.flow_missing_ref', sideEffect: 'read', risk: 'low' }],
        toolBindings: [
          {
            toolId: 'activepieces.flow_missing_ref',
            environmentId: 'production',
            executor: {
              type: 'activepieces_flow',
              flowId: 'flow_ct_sync_01',
              // missing connectionRef
            },
          },
        ],
      },
    });

    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const missingConnId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_missing_ref',
        packVersionId: '1.0.0',
      }
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
    assert.match(event.error || '', /lacks mandatory flowId or connectionRef/);

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
    const mockDb = createMockOutboxDb();

    // 10a: When approvalId is missing for side-effecting write tool, the handler throws and the outbox event remains pending
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const unconfirmedEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      { input: { force: true } },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_10a',
        toolId: 'activepieces.flow_ct_write_01', // sideEffect: write
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_policy_gate_test',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const unconfirmedBatchRes = await worker.processNextBatch();
    assert.equal(unconfirmedBatchRes.failed, 1, 'Missing approval record must cause batch failure');
    const unconfirmedEvent = repo.getEvents().find((e) => e.eventId === unconfirmedEventId)!;
    assert.notEqual(unconfirmedEvent.status, 'published', 'Unapproved event must NOT be marked published');
    assert.equal(unconfirmedEvent.status, 'pending');
    assert.match(unconfirmedEvent.error || '', /requires an authoritative top-level 'approvalId' in outbox envelope/);

    // 10b: When durable approved record exists and ownership is valid, real CapabilityDispatcher calls the provider.
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string, init: any) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', syncedProducts: 100 }),
        };
      };

      mockDb.approvals.set('apr_valid_10b', {
        _id: 'apr_valid_10b',
        approvalId: 'apr_valid_10b',
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        workspaceId: 'ws_caroma',
        status: 'approved',
        toolId: 'activepieces.flow_ct_write_01',
        executionKey: 'ALLOW_CURRENT',
        expiresAt: new Date(Date.now() + 60000),
      });

      const confirmedEventId = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        { input: { force: true } },
        undefined,
        undefined,
        {
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_10b',
          toolId: 'activepieces.flow_ct_write_01',
          packVersionId: '1.0.0',
          approvalId: 'apr_valid_10b',
        }
      );

      const confirmedBatchRes = await worker.processNextBatch();
      assert.equal(confirmedBatchRes.succeeded, 1, 'Approved policy execution must succeed');
      const confirmedEvent = repo.getEvents().find((e) => e.eventId === confirmedEventId)!;
      assert.equal(confirmedEvent.status, 'published', 'Approved event must be published');
      assert.equal(mockDb.executions.length, 1);
      assert.equal(mockDb.executions[0].filter.eventId, confirmedEventId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    service.stopWorker();
  });

  // ── Test 11: Missing durable execution context fails closed and remains pending ──
  await test('11. Negative: missing durable execution context remains retryable and is not published', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockEmptyDb = {
      collection: () => ({
        findOne: async () => null,
      }),
    };
    service.configureHandlers({
      db: mockEmptyDb as any,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        input: { sync: true },
      },
      undefined,
      undefined,
      {
        // missing workspaceId
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_ctx_fail',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1, 'Missing durable context must fail batch');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published', 'Must NOT be marked published');
    assert.equal(event.status, 'pending', 'Must remain pending for retry');
    assert.match(
      event.error || '',
      /Missing mandatory top-level 'workspaceId' in outbox envelope \(payload fallback prohibited\)/
    );

    service.stopWorker();
  });

  // ── Test 12: Missing approval record fails closed and remains pending ──
  await test('12. Negative: side-effecting dispatch without approval record remains retryable', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockDb = createMockOutboxDb();

    service.configureHandlers({
      db: mockDb,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_12',
        toolId: 'activepieces.flow_ct_write_01',
        packVersionId: '1.0.0',
        approvalId: 'apr_non_existent',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_approval_fail',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1, 'Missing approval must fail batch');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published', 'Unapproved event must NOT be published');
    assert.equal(event.status, 'pending', 'Must remain pending for retry');
    assert.match(event.error || '', /Authoritative approval record 'apr_non_existent' not found/);

    service.stopWorker();
  });

  // ── Test 13: Forged payload principalRole cannot bypass durable session role ──
  await test('13. Negative: forged payload principalRole (admin) cannot override durable session role (guest) and remains retryable', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockDb = createMockOutboxDb({
      principalRole: 'guest',
      capabilities: {
        toolDefinitions: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            sideEffect: 'read',
            risk: 'low',
            allowedRoles: ['customer', 'admin'],
          },
        ],
        toolBindings: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            environmentId: 'production',
            policy: {
              requiredRole: 'customer',
            },
            executor: {
              type: 'activepieces_flow',
              flowId: 'flow_ct_sync_01',
              connectionRef: 'conn_ct_caroma_secret',
            },
          },
        ],
      },
    });

    service.configureHandlers({
      db: mockDb,
    });

    // Attacker attempts to forge principalRole: 'admin' in payload
    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        principalRole: 'admin', // Forged payload role!
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_guest',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_role',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1, 'Forged role must fail against authoritative session role');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published');
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /insufficient permissions|denied|requires_approval|Role 'guest' is not authorized/i);

    service.stopWorker();
  });

  // ── Test 14: Forged payload context not matching durable records fails closed ──
  await test('14. Negative: forged payload context (workspaceId not in DB) fails closed and remains retryable', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockDb = createMockOutboxDb();

    service.configureHandlers({
      db: mockDb,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_forged_unauthorized', // Forged workspace!
        sessionId: 'session_1',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_context',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published');
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /Durable workspace record not found/);

    service.stopWorker();
  });

  // ── Test 15: Forged payload userConfirmationConfirmed boolean cannot bypass approval ──
  await test('15. Negative: forged payload userConfirmationConfirmed=true cannot bypass missing durable approval row', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockDb = createMockOutboxDb();

    service.configureHandlers({
      db: mockDb,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        userConfirmationConfirmed: true, // Forged confirmation bypass attempt in payload!
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_15',
        toolId: 'activepieces.flow_ct_write_01', // sideEffect: write
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_confirmation',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1, 'Forged confirmation must be ignored when approval row is missing');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published');
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /requires an authoritative top-level 'approvalId' in outbox envelope/);

    service.stopWorker();
  });

  // ── Test 16: Forged embedded approvalRecord cannot bypass durable DB row requirement ──
  await test('16. Negative: forged embedded approvalRecord cannot bypass missing durable approval row in approval_requests', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();
    const mockDb = createMockOutboxDb();

    service.configureHandlers({
      db: mockDb,
    });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        approvalRecord: { status: 'approved', approvedBy: 'attacker@evil.com' }, // Forged embedded record in payload!
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_16',
        toolId: 'activepieces.flow_ct_write_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_approval_record',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const batchRes = await worker.processNextBatch();
    assert.equal(batchRes.failed, 1, 'Forged embedded approvalRecord must be ignored');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.notEqual(event.status, 'published');
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /requires an authoritative top-level 'approvalId' in outbox envelope/);

    service.stopWorker();
  });

  // ── Test 17: Approval replay prevention across different events (Item C) ───────
  await test('17. Negative: same-tool different-event approval reuse is rejected (atomic consumption prevents replay)', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success' }),
      });

      mockDb.approvals.set('apr_reuse_single_shot', {
        _id: 'apr_reuse_single_shot',
        approvalId: 'apr_reuse_single_shot',
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        workspaceId: 'ws_caroma',
        status: 'approved',
        toolId: 'activepieces.flow_ct_write_01',
        executionKey: 'ALLOW_CURRENT',
        expiresAt: new Date(Date.now() + 60000),
      });

      const service = new OutboxWorkerService();
      service.configureHandlers({ db: mockDb });

      // First legitimate event consumes approval
      const event1Id = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        { input: { batch: 1 } },
        undefined,
        undefined,
        {
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_01',
          toolId: 'activepieces.flow_ct_write_01',
          packVersionId: '1.0.0',
          approvalId: 'apr_reuse_single_shot',
        }
      );

      const worker1 = service.startWithRepository(repo, undefined, {
        workerId: 'worker_reuse_1',
        batchSize: 1,
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
      });

      const res1 = await worker1.processNextBatch();
      assert.equal(res1.succeeded, 1, 'First event must consume approval successfully');
      const event1 = repo.getEvents().find((e) => e.eventId === event1Id)!;
      assert.equal(event1.status, 'published');
      service.stopWorker();

      // Second DIFFERENT event attempts to reuse the same approvalId
      const event2Id = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        { input: { batch: 2 } },
        undefined,
        undefined,
        {
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_01',
          toolId: 'activepieces.flow_ct_write_01',
          packVersionId: '1.0.0',
          approvalId: 'apr_reuse_single_shot',
        }
      );

      const worker2 = service.startWithRepository(repo, undefined, {
        workerId: 'worker_reuse_2',
        batchSize: 1,
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
      });

      const res2 = await worker2.processNextBatch();
      assert.equal(res2.failed, 1, 'Reusing approval on different event must fail');
      const event2 = repo.getEvents().find((e) => e.eventId === event2Id)!;
      assert.notEqual(event2.status, 'published');
      assert.equal(event2.status, 'pending');
      assert.match(
        event2.error || '',
        /has already been consumed by another execution; replay rejected|Authoritative approval record/
      );
      service.stopWorker();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Test 18: Forged payload sideEffect / risk cannot bypass Business-Pack definition (Item A) ──
  await test('18. Negative: forged payload sideEffect=read and risk=low cannot bypass Business-Pack write definition', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    // Attacker crafts payload claiming sideEffect: 'read', risk: 'low'
    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        sideEffect: 'read', // Forged in payload!
        risk: 'low',         // Forged in payload!
        policy: { requiresConfirmation: false },
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_write_01', // Pack defines this as sideEffect: 'write', risk: 'high'
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_risk',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1, 'Pack-defined sideEffect must override payload claims');
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /requires an authoritative top-level 'approvalId' in outbox envelope/);

    service.stopWorker();
  });

  // ── Test 19: Forged payload flowId / connectionRef cannot override ToolBinding (Item A) ──
  await test('19. Negative: forged payload flowId or connectionRef cannot override Business-Pack ToolBinding', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    // Attacker attempts to redirect execution to malicious flow
    const forgedFlowEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        flowId: 'malicious_flow_drain_funds',
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    // Attacker attempts to hijack connectionRef to another tenant's secret
    const forgedConnEventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {
        connectionRef: 'victim_tenant_secret_ref',
      },
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_forged_bindings',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 2);

    const flowEvent = repo.getEvents().find((e) => e.eventId === forgedFlowEventId)!;
    assert.equal(flowEvent.status, 'pending');
    assert.match(flowEvent.error || '', /Forged flowId in payload 'malicious_flow_drain_funds' does not match pack binding/);

    const connEvent = repo.getEvents().find((e) => e.eventId === forgedConnEventId)!;
    assert.equal(connEvent.status, 'pending');
    assert.match(connEvent.error || '', /Forged connectionRef in payload 'victim_tenant_secret_ref' does not match pack binding/);

    service.stopWorker();
  });

  // ── Test 20: Stage allowance enforcement (Item A) ──────────────────────────────
  await test('20. Negative: tool invocation not allowed by stageBindings in published release fails closed', async () => {
    const repo = new OutboxRepository();
    // Workspace is at 'stage_restricted' where no tools are allowed
    const mockDb = createMockOutboxDb({ stageId: 'stage_restricted' });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_stage_disallowed',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /is not allowed in stage 'stage_restricted' by published business pack release '1.0.0'/);

    service.stopWorker();
  });

  // ── Test 21: Cross-environment secret isolation (Item D) ───────────────────────
  await test('21. Negative: cross-environment secret isolation prevents production event from using staging secret', async () => {
    const repo = new OutboxRepository();
    // Configure secrets only for staging
    const mockDb = createMockOutboxDb({
      tenantSecrets: [
        {
          tenantId: 'tenant_caroma',
          environmentId: 'staging',
          secretRef: 'activepieces_api_key',
          value: 'staging_only_key',
        },
        {
          tenantId: 'tenant_caroma',
          environmentId: 'staging',
          secretRef: 'activepieces_webhook_secret',
          value: 'staging_only_secret',
        },
      ],
    });

    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    // Event is enqueued for PRODUCTION
    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_cross_env_secrets',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(
      event.error || '',
      /Activepieces tenant secrets \(activepieces_api_key \/ activepieces_webhook_secret\) not configured for tenant 'tenant_caroma' \(production\); failing closed/
    );

    service.stopWorker();
  });

  // ── Test 22: Negative: missing active business pack pointer fails closed ───────
  await test('22. Negative: missing active business pack pointer fails closed without fallback to workspace packVersionId', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({ businessPackPointers: null });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_missing_pointer',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(
      event.error || '',
      /Active business pack pointer not found for tenant 'tenant_caroma' \(production\); failing closed/
    );

    service.stopWorker();
  });

  // ── Test 23: Negative: Canonical checksum mismatch fails closed ─────────────────
  await test('23. Negative: Business Pack checksum mismatch between release and pointer fails closed', async () => {
    const repo = new OutboxRepository();
    // Pointer has a different checksum from the computed/release checksum
    const mockDb = createMockOutboxDb({
      businessPackPointers: {
        checksum: 'different_pointer_checksum',
      },
    });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_checksum_mismatch',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /Business Pack checksum mismatch between release/);

    service.stopWorker();
  });

  // ── Test 24: Negative: Release with environmentId='all' is rejected ────────────
  await test("24. Negative: Business pack release with environmentId='all' is rejected", async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({
      businessPackReleases: {
        tenantId: 'tenant_caroma',
        environmentId: 'all', // Non-exact environment
        versionId: '1.0.0',
        version: '1.0.0',
        status: 'published',
        checksum: 'sha256_mock_checksum',
      },
    });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_env_all_release',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(
      event.error || '',
      /Published business pack release '1.0.0' not found for tenant 'tenant_caroma' (with|in) exact environment 'production'/
    );

    service.stopWorker();
  });

  // ── Test 25: Negative: Absent stage binding or empty stageBindings fails closed ──
  await test('25. Negative: Absent stage binding or empty stageBindings fails closed', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({
      capabilities: {
        stageBindings: [], // Empty stage bindings!
      },
    });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_absent_stage_binding',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /lacks mandatory 'stageBindings'; failing closed/);

    service.stopWorker();
  });

  // ── Test 26: Negative: Tool binding with environmentId='all' is rejected ────────
  await test("26. Negative: Tool binding configured with environmentId='all' is rejected", async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({
      capabilities: {
        toolDefinitions: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            sideEffect: 'read',
            risk: 'low',
          },
        ],
        toolBindings: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            environmentId: 'all', // Not exact environment 'production'
            executor: {
              type: 'activepieces_flow',
              flowId: 'flow_ct_sync_01',
              connectionRef: 'conn_ct_caroma_secret',
            },
          },
        ],
      },
    });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_tool_binding_env_all',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(
      event.error || '',
      /ToolBinding for 'activepieces.flow_ct_sync_01' with exact environment 'production' not found/
    );

    service.stopWorker();
  });

  // ── Test 27: Negative: Connection does not permit configured flow fails closed ──
  await test('27. Negative: Connection does not permit configured flow or piece fails closed', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb({
      tenantConnections: {
        allowedFlows: ['some_other_flow_only'], // Does not allow flow_ct_sync_01
      },
    });
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    const eventId = await repo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      {},
      undefined,
      undefined,
      {
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        toolId: 'activepieces.flow_ct_sync_01',
        packVersionId: '1.0.0',
      }
    );

    const worker = service.startWithRepository(repo, undefined, {
      workerId: 'worker_disallowed_flow',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 1000,
    });

    const res = await worker.processNextBatch();
    assert.equal(res.failed, 1);
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.match(event.error || '', /does not permit flow 'flow_ct_sync_01'/);

    service.stopWorker();
  });

  // ── Test 28: Negative: OutboxRepository.enqueueEvent fails closed in production when durable storage unavailable ──
  await test('28. Negative: OutboxRepository.enqueueEvent throws in production/staging when Mongo is unavailable', async () => {
    const originalUri = process.env.MONGODB_URI;
    const originalEnv = process.env.NODE_ENV;
    const originalAllow = process.env.ALLOW_IN_MEMORY_OUTBOX;
    try {
      delete process.env.MONGODB_URI;
      delete process.env.ALLOW_IN_MEMORY_OUTBOX;
      process.env.NODE_ENV = 'production';
      const repo = new OutboxRepository();

      // In production environment
      await assert.rejects(
        async () => {
          await repo.enqueueEvent('tenant_caroma', 'production', 'activepieces.dispatch', { test: true });
        },
        /Durable MongoDB storage unavailable for environment 'production'; failing closed in production\/staging/
      );

      // In staging environment
      await assert.rejects(
        async () => {
          await repo.enqueueEvent('tenant_caroma', 'staging', 'activepieces.dispatch', { test: true });
        },
        /Durable MongoDB storage unavailable for environment 'staging'; failing closed in production\/staging/
      );

      // Verify health state reports healthy when 0 items or degraded when items exist
      const health = repo.getHealthState();
      assert.equal(health.status, 'healthy');
      assert.equal(health.inMemoryCount, 0);
    } finally {
      process.env.MONGODB_URI = originalUri;
      process.env.NODE_ENV = originalEnv;
      if (originalAllow !== undefined) {
        process.env.ALLOW_IN_MEMORY_OUTBOX = originalAllow;
      }
    }
  });

  // ── Test 29: End-to-end: Approved capability execution path transactionally enqueues activepieces.dispatch ──
  await test('29. End-to-end: Approved capability execution path transactionally enqueues activepieces.dispatch and is consumed by outbox worker', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();

    // Create approval service wired to the outbox repository
    const approvalService = new ApprovalService(undefined, repo);

    // Turn/capability creates a pending approval request for a high-risk write tool
    const ctx = {
      tenantId: 'tenant_caroma',
      environmentId: 'production' as const,
      workspaceId: 'ws_caroma',
      sessionId: 'session_caroma_01',
      principalId: 'user_caroma_01',
      principalRole: 'customer',
      stageId: 'stage_sync',
      packVersionId: '1.0.0',
    };
    const input = { orderId: 'ord_12345', action: 'write_sync' };
    const pending = await approvalService.createPending(
      'activepieces.flow_ct_write_01',
      input,
      ctx
    );

    assert.ok(pending.approvalRequestId);
    assert.equal(pending.status, 'pending');

    // Also populate in mockDb's approval_requests collection so worker can find and consume it
    mockDb.approvals.set(pending.approvalRequestId, {
      ...pending,
      approvalId: pending.approvalRequestId,
      executionKey: 'ALLOW_CURRENT',
    });

    // Approver approves the request
    const approved = await approvalService.decide(
      'tenant_caroma',
      'production',
      'ws_caroma',
      pending.approvalRequestId,
      'approved',
      'manager_caroma_01'
    );
    assert.equal(approved, true);

    // Synchronize approved status in mockDb collection for outbox worker consumption
    const mockAppRecord = mockDb.approvals.get(pending.approvalRequestId);
    if (mockAppRecord) {
      mockAppRecord.status = 'approved';
      mockAppRecord.reviewedBy = 'manager_caroma_01';
      mockAppRecord.reviewedAt = new Date();
    }

    // Verify activepieces.dispatch was enqueued to OutboxRepository with immutable envelope refs
    const queuedEvents = repo.getEvents();
    const dispatchEvent = queuedEvents.find((e) => e.eventType === 'activepieces.dispatch');
    assert.ok(dispatchEvent, 'activepieces.dispatch event must be enqueued upon approval');
    assert.equal(dispatchEvent.tenantId, 'tenant_caroma');
    assert.equal(dispatchEvent.environmentId, 'production');
    assert.equal(dispatchEvent.workspaceId, 'ws_caroma');
    assert.equal(dispatchEvent.sessionId, 'session_caroma_01');
    assert.equal(dispatchEvent.toolId, 'activepieces.flow_ct_write_01');
    assert.equal(dispatchEvent.packVersionId, '1.0.0');
    assert.equal(dispatchEvent.approvalId, pending.approvalRequestId);
    assert.equal(dispatchEvent.status, 'pending');

    // Configure and start OutboxWorkerService
    const service = new OutboxWorkerService();
    service.configureHandlers({ db: mockDb });

    // Mock Activepieces API response for execution
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ap_run_999', status: 'PAUSED', result: { sync: 'complete' } }),
      } as any;
    };

    try {
      const worker = service.startWithRepository(repo, undefined, {
        workerId: 'worker_e2e_approval',
        batchSize: 5,
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
      });

      const res = await worker.processNextBatch();
      assert.equal(res.processed, 1, 'Event must be processed by outbox worker');
      assert.equal(res.failed, 0, 'Event execution must succeed without failure');

      assert.equal(dispatchEvent.status, 'published', 'Event must transition to published');
      assert.ok(dispatchEvent.publishedAt, 'Event must have publishedAt set');
      assert.equal(fetchCalled, true, 'Activepieces dispatcher must have been called');

      // Verify health info accurately reports live status
      const health = await service.getHealthInfo();
      assert.equal(health.features?.activepiecesDispatch?.status, 'handler_live_producer_wired');
      assert.equal(health.features?.activepiecesDispatch?.cutoverReady, false);

      service.stopWorker();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\nOutbox Real Consumers Test Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runOutboxRealConsumersSuite().catch((err) => {
  console.error('Fatal test error in Outbox Real Consumers suite:', err);
  process.exit(1);
});
