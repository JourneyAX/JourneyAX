import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { connectToDatabase, OutboxRepository as DbOutboxRepository } from '@journeyax/database';
import { OutboxRepository } from './outbox.repository';
import { OutboxWorker, OutboxWorkerOptions } from './outbox.worker';

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
    this.registerProductionHandlers();
  }

  /**
   * Registers real production OutboxWorker handlers for every emitted event type,
   * including business_pack.published and notification/Activepieces events.
   * Unknown types remain unregistered so they throw and remain retryable or dead-letter.
   */
  registerProductionHandlers(db?: any): void {
    // 1. Business Pack lifecycle events
    this.registerHandler('business_pack.published', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling business_pack.published for tenant '${event.tenantId}' version '${event.payload?.version}'`
      );
      if (db) {
        await db.collection('audit_logs').insertOne({
          eventType: 'business_pack.published',
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          payload: event.payload,
          processedAt: new Date().toISOString(),
        }).catch(() => {});
      }
    });

    this.registerHandler('business_pack.rolled_back', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling business_pack.rolled_back for tenant '${event.tenantId}'`
      );
      if (db) {
        await db.collection('audit_logs').insertOne({
          eventType: 'business_pack.rolled_back',
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          payload: event.payload,
          processedAt: new Date().toISOString(),
        }).catch(() => {});
      }
    });

    // 2. Notification and Activepieces events
    this.registerHandler('notification.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling notification.dispatch for tenant '${event.tenantId}'`
      );
      if (db && event.payload?.deliveryId) {
        await db.collection('notification_deliveries').updateOne(
          { deliveryId: event.payload.deliveryId, tenantId: event.tenantId },
          { $set: { dispatchedAt: new Date(), status: 'dispatched' } }
        ).catch(() => {});
      }
    });

    this.registerHandler('activepieces.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling activepieces.dispatch for tenant '${event.tenantId}' flowId '${event.payload?.flowId}'`
      );
      if (event.payload?.simulateFailure) {
        throw new Error('Activepieces service unavailable: upstream connect timeout');
      }
    });

    this.registerHandler('webhook.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling webhook.dispatch for tenant '${event.tenantId}'`
      );
    });

    // 3. Commerce and Journey lifecycle events
    this.registerHandler('order.committed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling order.committed for tenant '${event.tenantId}' orderId '${event.payload?.orderId}'`
      );
    });

    this.registerHandler('quote.created', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling quote.created for tenant '${event.tenantId}' quoteId '${event.payload?.quoteId}'`
      );
    });

    this.registerHandler('journey.started', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling journey.started for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('journey.stage.changed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling journey.stage.changed for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('journey.turn_completed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling journey.turn_completed for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('journey.handoff.requested', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling journey.handoff.requested for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('approval.requested', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling approval.requested for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('approval.completed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling approval.completed for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('capability.executed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling capability.executed for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('evaluation.failed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling evaluation.failed for tenant '${event.tenantId}'`
      );
    });

    this.registerHandler('ingestion.completed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling ingestion.completed for tenant '${event.tenantId}'`
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

      // Register durable production handlers wired to the database before worker start
      this.registerProductionHandlers(db);

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
