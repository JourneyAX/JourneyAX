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

      this.worker = new OutboxWorker(
        dbRepo as any,
        {
          dispatcher: async (event) => {
            this.logger.log(`Dispatched durable outbox event: ${event.eventId} (${event.eventType})`);
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
    this.worker = new OutboxWorker(
      repo as any,
      {
        ...options,
        dispatcher: dispatcher || (async () => {}),
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
