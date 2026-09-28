import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { CapabilityDispatcher } from '@journeyax/capability-sdk';
import { computePackChecksum, publishBusinessPack } from '@journeyax/business-pack';
import { RuntimeModule } from '../src/runtime.module';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';
import { ApprovalService } from '../src/kernel/approval.service';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { ApprovalStore } from '../src/approval/approval.store';
import { COLLECTION_TOOL_APPROVALS, setTestDatabase } from '@journeyax/database';

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
  const publishedReleases = new Map<string, any>();
  const publishedPointers = new Map<string, any>();
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
          const env =
            query.environmentId ||
            query.$or?.find((c: any) => c.environmentId || c.channel)?.environmentId ||
            query.$or?.find((c: any) => c.environmentId || c.channel)?.channel;
          const key = `${query.tenantId}:${env}`;
          if (publishedPointers.has(key)) return publishedPointers.get(key);
          if (overrides.businessPackPointers === null) return null;
          return {
            tenantId: query.tenantId || 'tenant_caroma',
            environmentId: query.environmentId || 'production',
            activeVersionId: '1.0.0',
            activeVersion: '1.0.0',
            status: 'active',
            checksum: overrides.releaseChecksum !== undefined ? overrides.releaseChecksum : canonicalChecksum,
            ...(overrides.businessPackPointers || {}),
          };
        }
        if (name === 'business_pack_releases') {
          for (const [_, rel] of publishedReleases.entries()) {
            if (rel.tenantId === query.tenantId && rel.environmentId === query.environmentId) {
              const targetVer = query.$or?.find((c: any) => c.versionId || c.version)?.versionId ||
                query.$or?.find((c: any) => c.versionId || c.version)?.version ||
                query.versionId ||
                query.version;
              if (!targetVer || rel.versionId === targetVer || rel.version === targetVer) {
                return rel;
              }
            }
          }
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
          const requestedVer =
            query.$or?.find((c: any) => c.versionId || c.version)?.versionId ||
            query.$or?.find((c: any) => c.versionId || c.version)?.version ||
            query.versionId ||
            query.version;
          if (
            requestedVer &&
            defaultRelease.version !== requestedVer &&
            (defaultRelease as any).versionId !== requestedVer
          ) {
            return null;
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
        if (name === 'approval_requests' || name === 'tool_approvals') {
          for (const [id, item] of approvals.entries()) {
            if (query.tenantId && item.tenantId !== query.tenantId) continue;
            if (query.environmentId && item.environmentId !== query.environmentId) continue;
            if (query.workspaceId && item.workspaceId !== query.workspaceId) continue;
            if (query.toolId && item.toolId !== query.toolId) continue;
            if (query.status && item.status !== query.status) continue;

            const targetId = query.approvalId || query.approvalRequestId;
            if (targetId && item.approvalId !== targetId && item.approvalRequestId !== targetId && id !== targetId) {
              continue;
            }

            if (query.$and) {
              let andMatch = true;
              for (const cond of query.$and) {
                if (cond.$or) {
                  const match = cond.$or.some((c: any) => {
                    if (c.approvalId && (item.approvalId === c.approvalId || item.approvalRequestId === c.approvalId)) return true;
                    if (c.approvalRequestId && (item.approvalRequestId === c.approvalRequestId || item.approvalId === c.approvalRequestId)) return true;
                    if (c.eventId && (item.eventId === c.eventId || item.executionKey === c.eventId || item.executionKey === 'ALLOW_CURRENT')) return true;
                    if (c.executionReference && (item.executionReference === c.executionReference || item.executionKey === 'ALLOW_CURRENT')) return true;
                    return false;
                  });
                  if (!match) { andMatch = false; break; }
                }
              }
              if (!andMatch) continue;
            }

            if (query.$or) {
              const match = query.$or.some((c: any) => {
                if (c.approvalId && (item.approvalId === c.approvalId || item.approvalRequestId === c.approvalId)) return true;
                if (c.approvalRequestId && (item.approvalRequestId === c.approvalRequestId || item.approvalId === c.approvalRequestId)) return true;
                if (c.eventId && (item.eventId === c.eventId || item.executionKey === c.eventId || item.executionKey === 'ALLOW_CURRENT')) return true;
                if (c.executionKey && (item.executionKey === c.executionKey || item.executionKey === 'ALLOW_CURRENT')) return true;
                if (c.idempotencyKey && (item.idempotencyKey === c.idempotencyKey || item.executionReference === c.idempotencyKey)) return true;
                return false;
              });
              if (!match) continue;
            }

            return item;
          }
          return null;
        }
        return null;
      },
      insertOne: async (doc: any) => {
        if (name === 'approval_requests' || name === 'tool_approvals') {
          const id = doc.approvalId || doc.approvalRequestId || doc._id;
          approvals.set(id, { ...doc, _id: id, approvalId: id, approvalRequestId: id });
          return { insertedId: id };
        }
        if (name === 'business_pack_releases') {
          const key = `${doc.tenantId}:${doc.environmentId}:${doc.version}`;
          publishedReleases.set(key, doc);
          return { acknowledged: true, insertedId: key };
        }
        if (name === 'business_pack_pointers') {
          const key = `${doc.tenantId}:${doc.environmentId}`;
          publishedPointers.set(key, doc);
          return { acknowledged: true, insertedId: key };
        }
        return { insertedId: 'mock_id' };
      },
      findOneAndUpdate: async (filter: any, update: any, options: any) => {
        if (name === 'approval_requests' || name === 'tool_approvals') {
          for (const [id, app] of approvals.entries()) {
            let matched = false;
            if (
              app._id === filter._id ||
              id === filter.approvalId ||
              app.approvalId === filter.approvalId ||
              id === filter.approvalRequestId ||
              app.approvalRequestId === filter.approvalRequestId
            ) {
              matched = true;
            } else if (filter.$or) {
              matched = filter.$or.some((c: any) =>
                (c.approvalId && (app.approvalId === c.approvalId || app.approvalRequestId === c.approvalId || id === c.approvalId)) ||
                (c.approvalRequestId && (app.approvalRequestId === c.approvalRequestId || app.approvalId === c.approvalRequestId || id === c.approvalRequestId))
              );
            }
            if (matched) {
              if (
                app.consumedByEventId &&
                update.$set?.consumedByEventId &&
                app.consumedByEventId !== update.$set?.consumedByEventId
              ) {
                return { value: null };
              }
              const updated = { ...app, ...update.$set };
              if (update.$unset) {
                for (const k of Object.keys(update.$unset)) {
                  delete updated[k];
                }
              }
              approvals.set(id, updated);
              return { value: updated };
            }
          }
          return { value: null };
        }
        return { value: null };
      },
      updateOne: async (filter: any, update: any, options: any) => {
        if (name === 'approval_requests' || name === 'tool_approvals') {
          for (const [id, app] of approvals.entries()) {
            let matched = false;
            if (
              app._id === filter._id ||
              id === filter.approvalId ||
              app.approvalId === filter.approvalId ||
              id === filter.approvalRequestId ||
              app.approvalRequestId === filter.approvalRequestId
            ) {
              matched = true;
            } else if (filter.$or) {
              matched = filter.$or.some((c: any) =>
                (c.approvalId && (app.approvalId === c.approvalId || app.approvalRequestId === c.approvalId || id === c.approvalId)) ||
                (c.approvalRequestId && (app.approvalRequestId === c.approvalRequestId || app.approvalId === c.approvalRequestId || id === c.approvalRequestId))
              );
            }
            if (matched) {
              const updated = { ...app, ...update.$set };
              if (update.$unset) {
                for (const k of Object.keys(update.$unset)) {
                  delete updated[k];
                }
              }
              approvals.set(id, updated);
              return { matchedCount: 1, modifiedCount: 1 };
            }
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }
        if (name === 'business_pack_pointers') {
          const key = `${filter.tenantId}:${filter.environmentId}`;
          const prev = publishedPointers.get(key) || {};
          const updated = { ...prev, ...update.$set };
          publishedPointers.set(key, updated);
          return { matchedCount: 1, modifiedCount: 1 };
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

      const approvalService10 = new ApprovalService(undefined, repo, mockDb);
      const pending10 = await approvalService10.createPending(
        'activepieces.flow_ct_write_01',
        { input: { force: true } },
        {
          tenantId: 'tenant_caroma',
          environmentId: 'production',
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_10b',
          stageId: 'stage_sync',
          packVersionId: '1.0.0',
          principalRole: 'customer',
          principalId: 'user_caroma_01',
          correlationId: 'corr_10b',
        }
      );

      await approvalService10.decide(
        'tenant_caroma',
        'production',
        'ws_caroma',
        pending10.approvalRequestId,
        'approved',
        'admin_10b'
      );

      const initialEvent = repo.getEvents().find((e) => e.approvalId === pending10.approvalRequestId)!;
      const confirmedEventId = initialEvent.eventId;

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

      const approvalService17 = new ApprovalService(undefined, repo, mockDb);
      const pending17 = await approvalService17.createPending(
        'activepieces.flow_ct_write_01',
        { input: { batch: 1 } },
        {
          tenantId: 'tenant_caroma',
          environmentId: 'production',
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_01',
          stageId: 'stage_sync',
          packVersionId: '1.0.0',
          principalRole: 'customer',
          principalId: 'user_caroma_01',
          correlationId: 'corr_17',
        }
      );

      await approvalService17.decide(
        'tenant_caroma',
        'production',
        'ws_caroma',
        pending17.approvalRequestId,
        'approved',
        'manager_17'
      );

      const service = new OutboxWorkerService();
      service.configureHandlers({ db: mockDb });

      const event1 = repo.getEvents().find((e) => e.approvalId === pending17.approvalRequestId)!;
      const event1Id = event1.eventId;

      const worker1 = service.startWithRepository(repo, undefined, {
        workerId: 'worker_reuse_1',
        batchSize: 1,
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
      });

      const res1 = await worker1.processNextBatch();
      assert.equal(res1.succeeded, 1, 'First event must consume approval successfully');
      assert.equal(event1.status, 'published');
      service.stopWorker();

      // Second DIFFERENT event attempts to reuse the same approvalId
      const event2Id = await repo.enqueueEvent(
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
          approvalId: pending17.approvalRequestId,
          executionReference: pending17.executionReference,
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

    // Create approval service wired to the outbox repository and mockDb
    const approvalService = new ApprovalService(undefined, repo, mockDb);

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

    // Approver approves the request through authentic ApprovalService path (not hand-inserted approval_requests)
    const approved = await approvalService.decide(
      'tenant_caroma',
      'production',
      'ws_caroma',
      pending.approvalRequestId,
      'approved',
      'manager_caroma_01'
    );
    assert.equal(approved, true);

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
      if (res.failed > 0) {
        console.error('TEST 29 FAILED EVENT ERROR:', dispatchEvent.error);
      }
      assert.equal(res.processed, 1, 'Event must be processed by outbox worker');
      assert.equal(res.failed, 0, 'Event execution must succeed without failure');

      assert.equal(dispatchEvent.status, 'published', 'Event must transition to published');
      assert.ok(dispatchEvent.publishedAt, 'Event must have publishedAt set');
      assert.equal(fetchCalled, true, 'Activepieces dispatcher must have been called');

      // Verify health info accurately reports live status
      const health = await service.getHealthInfo();
      assert.equal(health.features?.activepiecesDispatch?.status, 'handler_live_producer_wired');
      assert.equal(health.features?.activepiecesDispatch?.cutoverReady, false);

      // Verify approval record was marked consumed with consumedByEventId
      const storedApproval = await mockDb.collection('tool_approvals').findOne({
        approvalRequestId: pending.approvalRequestId,
      });
      assert.ok(storedApproval.consumedAt, 'Approval record must be marked as consumed');
      assert.equal(storedApproval.consumedByEventId, dispatchEvent.eventId, 'Approval must be bound to exact eventId');

      // Verify one-time consumption: replaying with a second event fails
      const replayEventId = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        input,
        undefined,
        undefined,
        {
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_01',
          toolId: 'activepieces.flow_ct_write_01',
          packVersionId: '1.0.0',
          approvalId: pending.approvalRequestId,
          executionReference: pending.executionReference,
        }
      );
      const replayRes = await worker.processNextBatch();
      assert.equal(replayRes.failed, 1, 'Replay of consumed approval must fail');
      const replayEvent = repo.getEvents().find((e) => e.eventId === replayEventId)!;
      assert.equal(replayEvent.status, 'pending');
      assert.match(replayEvent.error || '', /has already been consumed|replay rejected/);

      service.stopWorker();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Test 30: Canonical Business Pack publication and runtime consumer resolution ──
  await test('30. Canonical Business Pack publication via real publishBusinessPack resolves through OutboxWorker with verified checksum', async () => {
    const repo = new OutboxRepository();
    const mockDb = createMockOutboxDb();

    const canonicalPack = {
      manifest: {
        packId: 'pack_canonical_pub',
        tenantId: 'tenant_caroma',
        name: 'Canonical Caroma Pack',
        version: '3.0.0',
        description: 'Testing canonical publication contract',
        schemaVersion: '1.0.0',
        environmentId: 'production',
        author: 'system-test',
      },
      profile: {
        companyName: 'Caroma Canonical',
        industry: 'retail',
        primaryGoals: ['sales'],
        locales: ['en-AU'],
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
        escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 },
      },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'standard_turn',
        policies: [
          {
            policyId: 'standard_turn',
            candidates: [{ provider: 'google', model: 'gemini-1.5-pro', priority: 1 }],
            dataResidency: 'au',
            maxInputTokens: 20000,
            maxOutputTokens: 2000,
            fallbackAllowed: true,
            timeoutMs: 10000,
          },
        ],
      },
      agents: [
        {
          agentId: 'agent_canonical',
          name: 'Canonical Agent',
          purpose: 'Assist customers with catalog operations',
          modelPolicyRef: 'standard_turn',
          systemPromptTemplate: 'Assist customers',
          allowedTools: ['activepieces.flow_ct_sync_01'],
        },
      ],
      journeys: [
        {
          journeyId: 'journey_canonical',
          version: '1.0.0',
          displayName: 'Canonical Journey',
          name: 'Canonical Journey',
          goals: ['sync_catalog'],
          initialStage: 'stage_sync',
          stages: {
            stage_sync: {
              stageId: 'stage_sync',
              displayName: 'Sync Stage',
              allowedCapabilities: ['activepieces.flow_ct_sync_01'],
              requiredFacts: [],
            },
          },
          transitions: [],
        },
      ],
      rules: [],
      capabilities: {
        version: '1.0.0',
        toolDefinitions: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            displayName: 'Sync Catalog',
            description: 'Sync with commercetools',
            category: 'integration',
            sideEffect: 'read',
            risk: 'low',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            requiresUserConfirmation: false,
          },
        ],
        toolBindings: [
          {
            toolId: 'activepieces.flow_ct_sync_01',
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            executor: {
              type: 'activepieces_flow',
              flowId: 'flow_ct_sync_01',
              connectionRef: 'conn_ct_caroma_secret',
            },
            policy: {
              timeoutMs: 10000,
              maxRetries: 3,
              requiresConfirmation: false,
            },
          },
        ],
        stageBindings: [
          {
            journeyId: 'journey_canonical',
            stageId: 'stage_sync',
            tools: [{ toolId: 'activepieces.flow_ct_sync_01' }],
          },
        ],
      },
      experience: {
        version: '1.0.0',
        theme: {
          primaryColor: '#000',
          accentColor: '#fff',
          fontFamily: 'sans-serif',
          borderRadius: '4px',
          customCssVars: {},
        },
        cards: {
          allowedCardTypes: ['bundle'],
          defaultCardRenderer: '@journeyax/ui-cards',
        },
      },
      evaluations: [],
    };

    // Publish using REAL publishBusinessPack
    const pubResult = await publishBusinessPack(mockDb, canonicalPack as any);
    assert.ok(pubResult.checksum, 'Publish result must have checksum');

    // Verify release in database has status: 'published' and versionId
    const releaseDoc = await mockDb.collection('business_pack_releases').findOne({
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      version: '3.0.0',
    });
    assert.ok(releaseDoc, 'Release document must be stored');
    assert.equal(releaseDoc.status, 'published', 'Release document status must be published');
    assert.equal(releaseDoc.versionId, '3.0.0', 'Release document versionId must be set');

    // Verify pointer in database has status: 'active' and activeVersionId
    const pointerDoc = await mockDb.collection('business_pack_pointers').findOne({
      tenantId: 'tenant_caroma',
      environmentId: 'production',
    });
    assert.ok(pointerDoc, 'Pointer document must be stored');
    assert.equal(pointerDoc.status, 'active', 'Pointer status must be active');
    assert.equal(pointerDoc.activeVersionId, '3.0.0', 'Pointer activeVersionId must be set');
    assert.equal(pointerDoc.checksum, pubResult.checksum, 'Pointer checksum must match publication checksum');

    // Consumer resolution via OutboxWorker
    let capDispatched = false;
    const mockCapDispatcher = {
      dispatch: async (toolDef: any, toolBinding: any, req: any, ctx: any) => {
        capDispatched = true;
        assert.equal(toolBinding.executor.type, 'activepieces_flow');
        assert.equal(toolBinding.executor.flowId, 'flow_ct_sync_01');
        assert.equal(toolBinding.executor.connectionRef, 'conn_ct_caroma_secret');
        assert.equal(ctx.tenantId, 'tenant_caroma');
        assert.equal(ctx.environmentId, 'production');
        return { status: 'success' as const, output: { syncCount: 99 } };
      },
    } as any;

    const service = new OutboxWorkerService();
    service.configureHandlers({
      db: mockDb,
      capabilityDispatcher: mockCapDispatcher,
    });

    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success' }),
      });

      const eventId = await repo.enqueueEvent(
        'tenant_caroma',
        'production',
        'activepieces.dispatch',
        {
          flowId: 'flow_ct_sync_01',
          connectionRef: 'conn_ct_caroma_secret',
          input: { test: 'canonical_resolution' },
        },
        undefined,
        undefined,
        {
          workspaceId: 'ws_caroma',
          sessionId: 'session_caroma_01',
          toolId: 'activepieces.flow_ct_sync_01',
          packVersionId: '3.0.0',
        }
      );

      const worker = service.startWithRepository(repo, undefined, {
        workerId: 'worker_canonical_pub',
        batchSize: 1,
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
      });

      const batchRes = await worker.processNextBatch();
      assert.equal(batchRes.succeeded, 1, 'Outbox worker must resolve real-published Business Pack successfully');
      const event = repo.getEvents().find((e) => e.eventId === eventId)!;
      assert.equal(event.status, 'published', 'Event must transition to published');

      service.stopWorker();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Test 31: Injected failure between decision and enqueue proves atomic rollback / no stranded approval ──
  await test('31. Injected failure between decision and enqueue proves atomic rollback without stranded approval', async () => {
    const testRepo = new OutboxRepository();
    const mockDb = createMockOutboxDb();
    const testApprovalService = new ApprovalService(undefined, testRepo, mockDb);

    const pending31 = await testApprovalService.createPending(
      'activepieces.flow_ct_write_01',
      { action: 'fail_me' },
      {
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        workspaceId: 'ws_caroma',
        sessionId: 'session_caroma_01',
        stageId: 'stage_sync',
        packVersionId: '1.0.0',
        principalRole: 'customer',
        principalId: 'user_caroma_01',
        correlationId: 'corr_31',
      }
    );

    // Mock enqueueEvent to throw injected failure
    testRepo.enqueueEvent = async () => {
      throw new Error('INJECTED_DISPATCH_FAILURE');
    };

    await assert.rejects(
      async () => {
        await testApprovalService.decide(
          'tenant_caroma',
          'production',
          'ws_caroma',
          pending31.approvalRequestId,
          'approved',
          'admin_31'
        );
      },
      /INJECTED_DISPATCH_FAILURE/
    );

    // Verify atomic rollback: approval status MUST remain 'pending', not stranded as 'approved'
    const rolledBackApproval = await testApprovalService.getApproval(pending31.approvalRequestId);
    assert.equal(rolledBackApproval?.status, 'pending', 'Approval must be reverted to pending on enqueue failure');
    assert.equal((rolledBackApproval as any)?.reviewedBy, undefined, 'reviewedBy must be unset on rollback');
  });

  // ── Test 32: Missing immutable approval fields fail closed ──
  await test('32. Missing immutable approval fields fail closed at creation and worker evaluation', async () => {
    const testRepo = new OutboxRepository();
    const mockDb = createMockOutboxDb();
    const testApprovalService = new ApprovalService(undefined, testRepo, mockDb);

    // Missing sessionId
    await assert.rejects(
      async () => {
        await testApprovalService.createPending(
          'activepieces.flow_ct_write_01',
          { test: true },
          {
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            workspaceId: 'ws_caroma',
            sessionId: '', // Missing
            stageId: 'stage_sync',
            packVersionId: '1.0.0',
            principalRole: 'customer',
            principalId: 'user_caroma_01',
            correlationId: 'corr_32a',
          }
        );
      },
      /missing mandatory immutable execution context bindings/
    );

    // Missing stageId
    await assert.rejects(
      async () => {
        await testApprovalService.createPending(
          'activepieces.flow_ct_write_01',
          { test: true },
          {
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            workspaceId: 'ws_caroma',
            sessionId: 'session_caroma_01',
            stageId: '', // Missing
            packVersionId: '1.0.0',
            principalRole: 'customer',
            principalId: 'user_caroma_01',
            correlationId: 'corr_32b',
          }
        );
      },
      /missing mandatory immutable execution context bindings/
    );

    // Missing principalRole
    await assert.rejects(
      async () => {
        await testApprovalService.createPending(
          'activepieces.flow_ct_write_01',
          { test: true },
          {
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            workspaceId: 'ws_caroma',
            sessionId: 'session_caroma_01',
            stageId: 'stage_sync',
            packVersionId: '1.0.0',
            principalRole: '', // Missing
            principalId: 'user_caroma_01',
            correlationId: 'corr_32c',
          }
        );
      },
      /missing mandatory immutable execution context bindings/
    );

    // Missing payload/input
    await assert.rejects(
      async () => {
        await testApprovalService.createPending(
          'activepieces.flow_ct_write_01',
          null, // Missing
          {
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            workspaceId: 'ws_caroma',
            sessionId: 'session_caroma_01',
            stageId: 'stage_sync',
            packVersionId: '1.0.0',
            principalRole: 'customer',
            principalId: 'user_caroma_01',
            correlationId: 'corr_32d',
          }
        );
      },
      /missing mandatory immutable execution context bindings/
    );
  });

  // ── Test 33: Staging/misconfigured Mongo cannot use memory ──
  await test('33. Staging and production ApprovalStore fail closed loudly when Mongo is unavailable (memory prohibited)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origMongoUri = process.env.MONGODB_URI;
    const origAllowMemory = process.env.ALLOW_IN_MEMORY_APPROVALS;
    try {
      delete process.env.MONGODB_URI;
      delete process.env.ALLOW_IN_MEMORY_APPROVALS;

      // Staging NODE_ENV
      process.env.NODE_ENV = 'staging';
      const stagingStore = new ApprovalStore();
      await assert.rejects(
        async () => {
          await stagingStore.createPending(
            'tool_any',
            { test: true },
            {
              tenantId: 'tenant_caroma',
              environmentId: 'staging',
              workspaceId: 'ws_caroma',
              sessionId: 's1',
              stageId: 'st1',
              packVersionId: '1.0.0',
              principalRole: 'admin',
              principalId: 'u1',
              correlationId: 'c1',
            }
          );
        },
        /MONGODB_URI is required; memory fallback is prohibited in staging/
      );

      // Production NODE_ENV
      process.env.NODE_ENV = 'production';
      const prodStore = new ApprovalStore();
      await assert.rejects(
        async () => {
          await prodStore.createPending(
            'tool_any',
            { test: true },
            {
              tenantId: 'tenant_caroma',
              environmentId: 'production',
              workspaceId: 'ws_caroma',
              sessionId: 's1',
              stageId: 'st1',
              packVersionId: '1.0.0',
              principalRole: 'admin',
              principalId: 'u1',
              correlationId: 'c1',
            }
          );
        },
        /MONGODB_URI is required; memory fallback is prohibited in production/
      );
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      process.env.MONGODB_URI = origMongoUri;
      if (origAllowMemory !== undefined) {
        process.env.ALLOW_IN_MEMORY_APPROVALS = origAllowMemory;
      }
    }
  });

  // ── Test 34: Transaction unknown-result test proves no sequential duplicate ──
  await test('34. TurnApplicationService unknown-commit transaction error throws without sequential retry / duplication', async () => {
    let saveCount = 0;
    let enqueueCount = 0;

    const mockPackRepo: any = {
      loadActivePack: async () => ({
        manifest: { version: '1.0.0', packId: 'pack_test' },
        journeys: [{ initialStage: 'stage_sync', journeyId: 'journey_test' }],
      }),
    };
    const mockWorkspaceRepo: any = {
      getOrCreate: async () => ({
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        workspaceId: 'ws_tx_test',
        currentStage: 'stage_sync',
        lastProcessedTurnId: 'prev_turn',
      }),
      save: async () => {
        saveCount++;
      },
    };
    const mockOutboxRepo: any = {
      enqueueEvent: async () => {
        enqueueCount++;
        return 'evt_tx_test';
      },
    };
    const mockJourneyResolver: any = {
      resolveJourneyResolution: () => ({
        status: 'resolved',
        journeyId: 'journey_test',
        journey: { journeyId: 'journey_test', initialStage: 'stage_sync' },
      }),
      decide: () => ({ type: 'complete' }),
    };
    const mockInterpreter: any = {
      interpret: async () => ({}),
    };
    const mockFactReducer: any = {
      apply: (ws: any) => ws,
    };

    // Mock Mongo client with session whose withTransaction throws UnknownTransactionCommitResult
    const mockTxClient: any = {
      topology: { description: { type: 'ReplicaSetWithPrimary', setName: 'rs0' } },
      startSession: () => ({
        withTransaction: async () => {
          saveCount++;
          throw new Error('TransientTransactionError: UnknownTransactionCommitResult');
        },
        endSession: async () => {},
      }),
    };

    setTestDatabase({ client: mockTxClient, collection: () => ({}) });
    const origTxUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://localhost:27017/journeyx';

    try {
      const turnService = new TurnApplicationService(
        mockPackRepo,
        mockWorkspaceRepo,
        mockJourneyResolver,
        undefined,
        undefined,
        undefined,
        new ApprovalService(undefined, mockOutboxRepo),
        undefined,
        mockOutboxRepo,
        undefined,
        mockInterpreter,
        mockFactReducer
      );

      await assert.rejects(
        async () => {
          await turnService.executeTurn({
            tenantId: 'tenant_caroma',
            environmentId: 'production',
            workspaceId: 'ws_tx_test',
            userMessage: 'test message',
            correlationId: 'corr_tx_test',
            idempotencyKey: 'idemp_tx_test',
          });
        },
        /UnknownTransactionCommitResult/
      );

      // Assert: save was NOT called a second time sequentially, and enqueue was NOT called sequentially
      assert.equal(saveCount, 1, 'Workspace save must NOT be retried sequentially after transaction failure');
      assert.equal(enqueueCount, 0, 'Outbox enqueue must NOT be called sequentially after transaction failure');
    } finally {
      process.env.MONGODB_URI = origTxUri;
      setTestDatabase(null);
    }
  });

  console.log(`\nOutbox Real Consumers Test Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runOutboxRealConsumersSuite().catch((err) => {
  console.error('Fatal test error in Outbox Real Consumers suite:', err);
  process.exit(1);
});
