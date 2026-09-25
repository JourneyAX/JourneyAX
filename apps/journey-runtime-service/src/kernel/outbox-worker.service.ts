import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import {
  connectToDatabase,
  OutboxRepository as DbOutboxRepository,
  NotificationDispatcher,
} from '@journeyax/database';
import {
  CapabilityDispatcher,
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
  ExecutionRequest,
} from '@journeyax/capability-sdk';
import { OutboxRepository } from './outbox.repository';
import { OutboxWorker, OutboxWorkerOptions } from './outbox.worker';
import {
  IConnectionOwnershipRepository,
  DurableConnectionOwnershipRepository,
} from './connection-ownership.repository';

export interface ProductionHandlersOptions {
  db?: any;
  capabilityDispatcher?: CapabilityDispatcher;
  notificationDispatcher?: NotificationDispatcher;
  ownershipRepository?: IConnectionOwnershipRepository;
}

export interface WorkerHealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy' | 'stopped' | 'error';
  mode: 'mongodb' | 'unconfigured';
  worker: 'active' | 'inactive';
  state: 'running' | 'polling' | 'idle' | 'stopped' | 'failed_config' | 'unconfigured';
  configurationFailure: string | null;
  lastSuccessfulPoll: string | null;
  lastPollStartedAt?: string | null;
  lastError?: string | null;
  leaseStatus: {
    activeLeases: number;
    leaseDurationMs?: number;
  };
  metrics: {
    pending: number;
    leased: number;
    published: number;
    deadLetter: number;
  };
  timestamp: string;
}

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private worker: OutboxWorker | null = null;
  private configurationFailure: string | null = null;
  private repo: OutboxRepository | DbOutboxRepository | null = null;
  private handlers = new Map<string, (event: any) => Promise<void>>();

  constructor() {
    // Empty dependency-free constructor for Nest DI compatibility (avoids Object token injection with emitDecoratorMetadata)
  }

  /**
   * Configuration hook for test harness and programmatic initialization.
   */
  configureHandlers(options: ProductionHandlersOptions): void {
    this.registerProductionHandlers(options);
  }

  /**
   * Registers real production OutboxWorker handlers.
   * Handlers must complete and persist their required side effect or throw
   * so retry and dead-letter applies. Never logs and acks.
   * Unimplemented event types are NOT registered so they fail closed.
   */
  registerProductionHandlers(options: ProductionHandlersOptions = {}): void {
    const { db, capabilityDispatcher, notificationDispatcher, ownershipRepository } = options;
    this.handlers.clear();

    // 1. Business Pack lifecycle events — persists audit trail or throws
    this.registerHandler('business_pack.published', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist audit logs for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling business_pack.published for tenant '${event.tenantId}' version '${event.payload?.version}'`
      );
      await db.collection('audit_logs').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'business_pack.published',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            payload: event.payload,
            processedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
    });

    this.registerHandler('business_pack.rolled_back', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist audit logs for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling business_pack.rolled_back for tenant '${event.tenantId}'`
      );
      await db.collection('audit_logs').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'business_pack.rolled_back',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            payload: event.payload,
            processedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
    });

    // 2. Notification dispatch — calls real NotificationDispatcher and enforces delivery persistence
    this.registerHandler('notification.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling notification.dispatch for tenant '${event.tenantId}'`
      );
      const dispatcher = notificationDispatcher || (db ? new NotificationDispatcher(db) : null);
      if (!dispatcher) {
        throw new Error(
          `[OutboxWorker] NotificationDispatcher or database connection is required to process notification.dispatch for tenant '${event.tenantId}'`
        );
      }

      const payload = event.payload || {};
      const result = await dispatcher.dispatch(
        event.tenantId,
        event.eventId,
        payload.payload || payload,
        payload.channelsConfig,
        {
          environmentId: event.environmentId,
          recipients: payload.recipients,
        }
      );

      if (!result.success) {
        const failureDetails = (result.deliveries || [])
          .filter((d: any) => d.status === 'failed')
          .map((d: any) => d.error || 'Delivery failed');
        throw new Error(
          `[OutboxWorker] Notification dispatch failed: ${failureDetails.join('; ') || 'Dispatcher reported failure'}`
        );
      }
    });

    // 3. Activepieces dispatch — invokes actual CapabilityDispatcher with connection ownership and idempotency
    this.registerHandler('activepieces.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling activepieces.dispatch for tenant '${event.tenantId}' flowId '${event.payload?.flowId}'`
      );
      const payload = event.payload || {};
      if (!payload.flowId) {
        throw new Error("[OutboxWorker] Missing mandatory 'flowId' in activepieces.dispatch payload");
      }
      if (!payload.connectionRef) {
        throw new Error("[OutboxWorker] Missing mandatory 'connectionRef' in activepieces.dispatch payload");
      }

      const capDispatcher =
        capabilityDispatcher ||
        new CapabilityDispatcher({
          activepiecesApiUrl: process.env.ACTIVEPIECES_API_URL,
          activepiecesApiKey: process.env.ACTIVEPIECES_API_KEY,
          activepiecesWebhookSecret: process.env.ACTIVEPIECES_WEBHOOK_SECRET,
          validateConnectionOwnership: async (t, e, c) => {
            if (ownershipRepository) {
              return ownershipRepository.validateOwnership(t, e, c);
            }
            if (db) {
              const repo = new DurableConnectionOwnershipRepository(() => db);
              return repo.validateOwnership(t, e, c);
            }
            return false;
          },
        });

      const toolDef: ToolDefinition = {
        toolId: payload.toolId || `activepieces.${payload.flowId}`,
        version: '1.0.0',
        displayName: payload.flowId,
        description: 'Outbox Activepieces flow execution',
        inputSchema: {},
        outputSchema: {},
        sideEffect: payload.sideEffect || 'transactional',
        risk: payload.risk || 'medium',
        timeoutPolicy: { timeoutMs: 15000, retryAttempts: 1 },
        idempotencyPolicy: { required: true, ttlSeconds: 300 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
        dataClassification: 'internal',
      };

      const toolBinding: ToolBinding = {
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        toolId: toolDef.toolId,
        bindingVersion: '1.0.0',
        executor: {
          type: 'activepieces_flow',
          flowId: payload.flowId,
          connectionRef: payload.connectionRef,
        },
        enabled: true,
        policy: {
          requiredRole: 'customer',
          requiresConfirmation: payload.risk === 'high',
          idempotencyRequired: true,
          timeoutMs: 15000,
          retryAttempts: 1,
        },
      };

      // Require trusted durable execution context — no fabricated fallbacks
      const durableCtx = (event as any).executionContext || payload.executionContext || {};
      const workspaceId = (event as any).workspaceId || payload.workspaceId || durableCtx.workspaceId;
      const sessionId = (event as any).sessionId || payload.sessionId || durableCtx.sessionId;
      const stageId = (event as any).stageId || payload.stageId || durableCtx.stageId;
      const packVersionId = (event as any).packVersionId || payload.packVersionId || durableCtx.packVersionId;
      const principalRole = (event as any).principalRole || payload.principalRole || durableCtx.principalRole;
      const principalId = (event as any).principalId || payload.principalId || durableCtx.principalId;

      if (!workspaceId || !sessionId || !stageId || !packVersionId || !principalRole) {
        throw new Error(
          `[OutboxWorker] Missing trusted durable execution context for activepieces.dispatch: ` +
          `workspaceId=${workspaceId || 'missing'}, sessionId=${sessionId || 'missing'}, ` +
          `stageId=${stageId || 'missing'}, packVersionId=${packVersionId || 'missing'}, ` +
          `principalRole=${principalRole || 'missing'}`
        );
      }

      const ctx: ExecutionContext = {
        workspaceId,
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        sessionId,
        stageId,
        packVersionId,
        correlationId: event.eventId,
        idempotencyKey: event.eventId,
        principalRole,
        principalId,
      };

      // Side-effecting dispatch must require a durable approved approval record or explicit trustworthy confirmation established before enqueue.
      // Never default userConfirmationConfirmed to true.
      let userConfirmationConfirmed = false;
      if (payload.userConfirmationConfirmed === true || (event as any).userConfirmationConfirmed === true) {
        userConfirmationConfirmed = true;
      } else if (payload.approvalId && db) {
        const approval = await db.collection('approval_requests').findOne({
          approvalId: payload.approvalId,
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          status: 'approved',
        });
        if (approval) {
          userConfirmationConfirmed = true;
        }
      } else if (payload.approvalRecord && payload.approvalRecord.status === 'approved') {
        userConfirmationConfirmed = true;
      }

      const isSideEffecting =
        toolDef.sideEffect === 'write' ||
        toolDef.sideEffect === 'transactional' ||
        toolDef.risk === 'medium' ||
        toolDef.risk === 'high' ||
        toolDef.risk === 'critical';

      if (isSideEffecting && !userConfirmationConfirmed) {
        throw new Error(
          `[OutboxWorker] Side-effecting activepieces.dispatch for tool '${toolDef.toolId}' requires a durable approved approval record or explicit trustworthy confirmation established before enqueue`
        );
      }

      const request: ExecutionRequest = {
        toolId: toolDef.toolId,
        input: payload.input || {},
        idempotencyKey: event.eventId,
        userConfirmationConfirmed,
      };

      const dispatchResult = await capDispatcher.dispatch(
        toolDef,
        toolBinding,
        request,
        ctx
      );

      if (dispatchResult.status !== 'success') {
        throw new Error(
          `[OutboxWorker] Activepieces execution failed with status '${dispatchResult.status}': ${dispatchResult.error || 'Execution did not succeed'}`
        );
      }

      if (db) {
        await db.collection('activepieces_executions').updateOne(
          { eventId: event.eventId },
          {
            $set: {
              tenantId: event.tenantId,
              environmentId: event.environmentId,
              flowId: payload.flowId,
              connectionRef: payload.connectionRef,
              output: dispatchResult.output,
              status: 'success',
              executedAt: new Date().toISOString(),
            },
            $setOnInsert: {
              eventId: event.eventId,
            },
          },
          { upsert: true }
        );
      }
    });

    // 4. Order committed — persists side effect or throws
    this.registerHandler('order.committed', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist order events for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling order.committed for tenant '${event.tenantId}' orderId '${event.payload?.orderId}'`
      );
      await db.collection('order_events').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'order.committed',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            orderId: event.payload?.orderId,
            payload: event.payload,
            committedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
    });
  }

  /**
   * Register a delivery handler for a specific event type.
   */
  registerHandler(eventType: string, handler: (event: any) => Promise<void>): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Dispatches an outbox event to its registered handler.
   * Fails closed: if no handler is registered or delivery fails, throws an error so the outbox
   * record remains in retryable or dead-letter state. Never logs and acks.
   */
  async dispatchEvent(event: any): Promise<void> {
    const handler = this.handlers.get(event.eventType);
    if (!handler) {
      throw new Error(
        `[OutboxWorker] No handler registered for event type '${event.eventType}'. Delivery failed and remains retryable or dead-letter.`
      );
    }
    await handler(event);
  }

  async onModuleInit(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri || uri.trim() === '') {
      this.configurationFailure = 'Missing required MONGODB_URI for durable outbox storage';
      this.logger.warn(`OutboxWorker not started: ${this.configurationFailure}`);
      return;
    }

    try {
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);
      const dbRepo = new DbOutboxRepository(db);
      this.repo = dbRepo;

      const ownershipRepo = new DurableConnectionOwnershipRepository(() => db);
      const capabilityDispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: process.env.ACTIVEPIECES_API_URL,
        activepiecesApiKey: process.env.ACTIVEPIECES_API_KEY,
        activepiecesWebhookSecret: process.env.ACTIVEPIECES_WEBHOOK_SECRET,
        validateConnectionOwnership: (tenantId, environmentId, connectionRef) =>
          ownershipRepo.validateOwnership(tenantId, environmentId, connectionRef),
      });
      const notificationDispatcher = new NotificationDispatcher(db, {
        capabilityDispatcher,
        validateConnectionOwnership: (tenantId, environmentId, connectionRef) =>
          ownershipRepo.validateOwnership(tenantId, environmentId, connectionRef),
      });

      // Register durable production handlers wired to the database before worker start
      this.registerProductionHandlers({
        db,
        capabilityDispatcher,
        notificationDispatcher,
        ownershipRepository: ownershipRepo,
      });

      this.worker = new OutboxWorker(
        dbRepo as any,
        {
          dispatcher: async (event) => {
            await this.dispatchEvent(event);
          },
          workerId: `worker-${process.pid}-${Math.random().toString(36).substring(2, 7)}`,
          pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000,
          leaseDurationMs: Number(process.env.OUTBOX_LEASE_DURATION_MS) || 30000,
          batchSize: Number(process.env.OUTBOX_BATCH_SIZE) || 10,
        }
      );

      this.worker.start();
      this.configurationFailure = null;
      this.logger.log(`OutboxWorker successfully started with durable MongoDB storage`);
    } catch (err: any) {
      this.configurationFailure = `Durable storage connection failed: ${err.message}`;
      this.logger.error(`Failed to initialize OutboxWorker: ${this.configurationFailure}`);
      this.worker = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Stopping OutboxWorker gracefully...');
      this.worker.stop();
      this.worker = null;
    }
  }

  /**
   * For testing or explicit wiring with a specific repository instance
   */
  startWithRepository(
    repo: OutboxRepository | DbOutboxRepository,
    dispatcher?: (event: any) => Promise<void>,
    options?: Omit<OutboxWorkerOptions, 'dispatcher'>
  ): OutboxWorker {
    if (this.worker) {
      this.worker.stop();
    }
    this.repo = repo;
    const effectiveDispatcher = dispatcher || (async (evt) => {
      await this.dispatchEvent(evt);
    });
    this.worker = new OutboxWorker(
      repo as any,
      {
        ...options,
        dispatcher: effectiveDispatcher,
      }
    );
    this.worker.start();
    this.configurationFailure = null;
    return this.worker;
  }

  stopWorker(): void {
    if (this.worker) {
      this.worker.stop();
    }
  }

  getWorker(): OutboxWorker | null {
    return this.worker;
  }

  getConfigurationFailure(): string | null {
    return this.configurationFailure;
  }

  setConfigurationFailure(failure: string | null): void {
    this.configurationFailure = failure;
  }

  async getHealthInfo(tenantId?: string): Promise<WorkerHealthResponse> {
    if (!this.worker) {
      return {
        status: 'unhealthy',
        mode: 'unconfigured',
        worker: 'inactive',
        state: this.configurationFailure ? 'failed_config' : 'unconfigured',
        configurationFailure: this.configurationFailure || 'OutboxWorker is not instantiated',
        lastSuccessfulPoll: null,
        leaseStatus: { activeLeases: 0 },
        metrics: { pending: 0, leased: 0, published: 0, deadLetter: 0 },
        timestamp: new Date().toISOString(),
      };
    }

    const state = this.worker.getState();
    let metrics = { pending: 0, leased: 0, published: 0, deadLetter: 0 };
    try {
      metrics = await this.worker.getMetrics(tenantId);
    } catch (err: any) {
      this.logger.warn(`Failed to retrieve outbox metrics: ${err.message}`);
    }

    const isRunning = state.running;
    let status: WorkerHealthResponse['status'] = 'ok';
    if (!isRunning) {
      status = 'stopped';
    } else if (metrics.deadLetter > 50) {
      status = 'degraded';
    }

    return {
      status,
      mode: 'mongodb',
      worker: isRunning ? 'active' : 'inactive',
      state: state.status,
      lastSuccessfulPoll: state.lastSuccessfulPollAt,
      lastPollStartedAt: state.lastPollStartedAt,
      lastError: state.lastError,
      leaseStatus: {
        activeLeases: state.activeLeasesCount,
        leaseDurationMs: state.leaseDurationMs,
      },
      metrics,
      configurationFailure: null,
      timestamp: new Date().toISOString(),
    };
  }
}
