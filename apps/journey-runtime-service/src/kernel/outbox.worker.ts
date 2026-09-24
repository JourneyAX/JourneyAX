import { OutboxRepository } from './outbox.repository';
import { OutboxEventRecord } from '@journeyax/database';
import { randomUUID } from 'crypto';

export type OutboxEventDispatcher = (event: OutboxEventRecord) => Promise<void>;
export type DeadLetterAlertHandler = (event: OutboxEventRecord, error: string) => Promise<void> | void;

export interface OutboxWorkerOptions {
  workerId?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  dispatcher?: OutboxEventDispatcher;
  onDeadLetterAlert?: DeadLetterAlertHandler;
}

export interface OutboxWorkerState {
  workerId: string;
  status: 'running' | 'stopped' | 'polling' | 'idle';
  running: boolean;
  lastPollStartedAt: string | null;
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
  leaseDurationMs: number;
  pollIntervalMs: number;
  batchSize: number;
  activeLeasesCount: number;
}

export class OutboxWorker {
  public readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly dispatcher: OutboxEventDispatcher;
  private readonly onDeadLetterAlert?: DeadLetterAlertHandler;

  private running = false;
  private isPolling = false;
  private timer: NodeJS.Timeout | null = null;
  private lastPollStartedAt: string | null = null;
  private lastSuccessfulPollAt: string | null = null;
  private lastError: string | null = null;
  private activeLeasesCount = 0;

  constructor(
    private readonly outboxRepo: OutboxRepository = new OutboxRepository(),
    options: OutboxWorkerOptions = {}
  ) {
    this.workerId = options.workerId || `worker_${randomUUID().substring(0, 8)}`;
    this.leaseDurationMs = options.leaseDurationMs || 30_000;
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.batchSize = options.batchSize || 10;
    this.maxAttempts = options.maxAttempts || 5;
    this.backoffBaseMs = options.backoffBaseMs || 1000;
    if (!options.dispatcher) {
      throw new Error(
        '[OutboxWorker] OutboxEventDispatcher is mandatory. A real delivery dispatcher must be supplied to ensure events are genuinely delivered.'
      );
    }
    this.dispatcher = options.dispatcher;
    this.onDeadLetterAlert = options.onDeadLetterAlert;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    this.isPolling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getState(): OutboxWorkerState {
    let status: OutboxWorkerState['status'] = 'stopped';
    if (this.running) {
      status = this.isPolling ? 'polling' : 'running';
    }
    return {
      workerId: this.workerId,
      status,
      running: this.running,
      lastPollStartedAt: this.lastPollStartedAt,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastError: this.lastError,
      leaseDurationMs: this.leaseDurationMs,
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      activeLeasesCount: this.activeLeasesCount,
    };
  }

  async getMetrics(tenantId?: string) {
    return this.outboxRepo.getMetrics(tenantId);
  }

  async renewCurrentLease(eventId: string, additionalMs?: number): Promise<boolean> {
    return this.outboxRepo.renewLease(eventId, this.workerId, additionalMs);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.processNextBatch();
      } catch (err: any) {
        console.warn(`[OutboxWorker ${this.workerId}] Batch processing error:`, err.message);
      } finally {
        if (this.running) {
          this.scheduleNext();
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Processes a single batch of claimed outbox events with atomic leasing and backoff.
   */
  async processNextBatch(): Promise<{ processed: number; succeeded: number; failed: number }> {
    this.isPolling = true;
    this.lastPollStartedAt = new Date().toISOString();

    try {
      const claimed = await this.outboxRepo.claimLeases(
        this.workerId,
        this.leaseDurationMs,
        this.batchSize
      );
      this.activeLeasesCount = claimed.length;

      let succeeded = 0;
      let failed = 0;

      for (const event of claimed) {
        try {
          await this.dispatcher(event);
          await this.outboxRepo.markPublished(event.eventId);
          succeeded++;
          this.activeLeasesCount = Math.max(0, this.activeLeasesCount - 1);
        } catch (err: any) {
          failed++;
          this.activeLeasesCount = Math.max(0, this.activeLeasesCount - 1);
          const result = await this.outboxRepo.recordFailure(
            event.eventId,
            err.message || 'Dispatch error',
            this.maxAttempts,
            this.backoffBaseMs
          );
          if (result === 'dead_letter') {
            console.error(
              `[OutboxWorker ${this.workerId}] Event '${event.eventId}' (${event.eventType}) reached max retries. Moved to dead-letter.`
            );
            if (this.onDeadLetterAlert) {
              try {
                await this.onDeadLetterAlert(event, err.message || 'Dispatch error');
              } catch (alertErr: any) {
                console.error(`[OutboxWorker ${this.workerId}] Operational alert callback failed:`, alertErr.message);
              }
            }
          }
        }
      }

      this.lastSuccessfulPollAt = new Date().toISOString();
      this.lastError = null;
      return { processed: claimed.length, succeeded, failed };
    } catch (pollErr: any) {
      this.lastError = pollErr.message || 'Poll error';
      throw pollErr;
    } finally {
      this.isPolling = false;
    }
  }
}
