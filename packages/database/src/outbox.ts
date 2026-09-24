import { Db, ClientSession } from 'mongodb';
import { randomUUID } from 'crypto';
import { COLLECTION_OUTBOX_EVENTS, OutboxEventRecord } from './types';
import { EnvironmentId } from '@journeyax/journey-core';

export class OutboxRepository {
  constructor(private db: Db) {}

  async enqueue(
    event: {
      tenantId: string;
      environmentId: EnvironmentId;
      eventType: string;
      payload: any;
      maxAttempts?: number;
    },
    session?: ClientSession
  ): Promise<OutboxEventRecord> {
    const record: OutboxEventRecord = {
      eventId: `evt_${randomUUID()}`,
      tenantId: event.tenantId,
      environmentId: event.environmentId,
      eventType: event.eventType,
      payload: event.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: event.maxAttempts || 5,
      createdAt: new Date(),
    };

    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    await col.insertOne(record, { session });
    return record;
  }

  /**
   * Atomically claims exclusive leases on available pending or expired events.
   * Concurrency-safe across multiple distributed worker instances.
   */
  async claimLeases(
    workerId: string,
    leaseDurationMs = 30000,
    batchSize = 10
  ): Promise<OutboxEventRecord[]> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    const claimed: OutboxEventRecord[] = [];

    for (let i = 0; i < batchSize; i++) {
      const now = new Date();
      const filter = {
        $or: [
          {
            status: 'pending' as const,
            $or: [
              { nextAttemptAt: { $exists: false } },
              { nextAttemptAt: { $lte: now } },
            ],
          },
          {
            status: 'leased' as const,
            leaseExpiresAt: { $lt: now },
          },
        ],
      };

      const update = {
        $set: {
          status: 'leased' as const,
          leasedBy: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        },
      };

      const result = await col.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
      });

      if (!result) break;
      claimed.push(result);
    }

    return claimed;
  }

  async fetchPending(batchSize = 20): Promise<OutboxEventRecord[]> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    return col
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(batchSize)
      .toArray();
  }

  async markPublished(eventId: string, session?: ClientSession): Promise<void> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    await col.updateOne(
      { eventId },
      {
        $set: {
          status: 'published',
          publishedAt: new Date(),
        },
        $unset: {
          leasedBy: '',
          leaseExpiresAt: '',
        },
      },
      { session }
    );
  }

  async recordFailure(
    eventId: string,
    error: string,
    maxAttempts = 5,
    backoffBaseMs = 1000
  ): Promise<'retry_scheduled' | 'dead_letter'> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    const existing = await col.findOne({ eventId });
    if (!existing) return 'dead_letter';

    const nextAttempts = (existing.attempts || 0) + 1;
    const configuredMax = maxAttempts || existing.maxAttempts || 5;

    if (nextAttempts >= configuredMax) {
      await col.updateOne(
        { eventId },
        {
          $set: {
            status: 'dead_letter',
            error,
            attempts: nextAttempts,
          },
          $unset: {
            leasedBy: '',
            leaseExpiresAt: '',
          },
        }
      );
      return 'dead_letter';
    }

    const backoffDelay = backoffBaseMs * Math.pow(2, nextAttempts - 1);
    const nextAttemptAt = new Date(Date.now() + backoffDelay);

    await col.updateOne(
      { eventId },
      {
        $set: {
          status: 'pending',
          error,
          attempts: nextAttempts,
          nextAttemptAt,
        },
        $unset: {
          leasedBy: '',
          leaseExpiresAt: '',
        },
      }
    );

    return 'retry_scheduled';
  }

  async releaseLease(eventId: string): Promise<void> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    await col.updateOne(
      { eventId },
      {
        $set: { status: 'pending' },
        $unset: { leasedBy: '', leaseExpiresAt: '' },
      }
    );
  }

  async getMetrics(tenantId?: string): Promise<{
    pending: number;
    leased: number;
    published: number;
    deadLetter: number;
  }> {
    const col = this.db.collection<OutboxEventRecord>(COLLECTION_OUTBOX_EVENTS);
    const filter = tenantId ? { tenantId } : {};
    const [pending, leased, published, deadLetter] = await Promise.all([
      col.countDocuments({ ...filter, status: 'pending' }),
      col.countDocuments({ ...filter, status: 'leased' }),
      col.countDocuments({ ...filter, status: 'published' }),
      col.countDocuments({ ...filter, status: 'dead_letter' }),
    ]);
    return { pending, leased, published, deadLetter };
  }
}

