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
  private timer: NodeJS.Timeout | null = null;

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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
        this.scheduleNext();
      }
    }, this.pollIntervalMs);
  }

  /**
   * Processes a single batch of claimed outbox events with atomic leasing and backoff.
   */
  async processNextBatch(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const claimed = await this.outboxRepo.claimLeases(
      this.workerId,
      this.leaseDurationMs,
      this.batchSize
    );

    let succeeded = 0;
    let failed = 0;

    for (const event of claimed) {
      try {
        await this.dispatcher(event);
        await this.outboxRepo.markPublished(event.eventId);
        succeeded++;
      } catch (err: any) {
        failed++;
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

    return { processed: claimed.length, succeeded, failed };
  }
}
