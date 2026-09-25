import { connectToDatabase, OutboxRepository as DbOutboxRepository, OutboxEventRecord, EnvironmentId } from '@journeyax/database';
import { ClientSession } from 'mongodb';

export class OutboxRepository {
  private inMemoryQueue: OutboxEventRecord[] = [];

  private isMemoryPermitted(environmentId?: string): boolean {
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.APP_ENV === 'production' ||
      process.env.APP_ENV === 'staging'
    ) {
      return false;
    }
    if (environmentId === 'production' || environmentId === 'staging') {
      return process.env.ALLOW_IN_MEMORY_OUTBOX === 'true';
    }
    return (
      process.env.ALLOW_IN_MEMORY_OUTBOX === 'true' ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test'
    );
  }

  private isProductionOrStaging(environmentId?: string): boolean {
    if (this.isMemoryPermitted(environmentId)) {
      return false;
    }
    return (
      environmentId === 'production' ||
      environmentId === 'staging' ||
      process.env.NODE_ENV === 'production' ||
      process.env.APP_ENV === 'production' ||
      process.env.APP_ENV === 'staging'
    );
  }

  getHealthState(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    mode: 'mongodb' | 'memory';
    inMemoryCount: number;
    warning?: string;
  } {
    if (this.inMemoryQueue.length > 0) {
      return {
        status: 'degraded',
        mode: 'memory',
        inMemoryCount: this.inMemoryQueue.length,
        warning: `[OutboxRepository DEGRADED] Operating with ${this.inMemoryQueue.length} volatile in-memory events; durable MongoDB storage is bypassed`,
      };
    }
    return {
      status: 'healthy',
      mode: 'mongodb',
      inMemoryCount: 0,
    };
  }

  private async getDbRepo(): Promise<DbOutboxRepository | null> {
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      return new DbOutboxRepository(db);
    } catch (err: any) {
      console.warn('[OutboxRepository] Mongo unavailable:', err.message);
      return null;
    }
  }

  async enqueueEvent(
    tenantId: string,
    environmentId: EnvironmentId,
    eventType: string,
    payload: Record<string, any>,
    correlationId?: string,
    session?: ClientSession,
    options?: {
      workspaceId?: string;
      sessionId?: string;
      toolId?: string;
      packVersionId?: string;
      approvalId?: string;
      executionReference?: string;
      eventId?: string;
    }
  ): Promise<string> {
    const isProdOrStaging = this.isProductionOrStaging(environmentId);
    const allowMemory = this.isMemoryPermitted(environmentId);

    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      try {
        const record = await dbRepo.enqueue(
          {
            tenantId,
            environmentId,
            eventType,
            payload: { ...payload, correlationId },
            workspaceId: options?.workspaceId,
            sessionId: options?.sessionId,
            toolId: options?.toolId,
            packVersionId: options?.packVersionId,
            approvalId: options?.approvalId,
            executionReference: options?.executionReference,
            eventId: options?.eventId,
          },
          session
        );
        return record.eventId;
      } catch (err: any) {
        if (isProdOrStaging || !allowMemory) {
          throw new Error(
            `[OutboxRepository] Failed to enqueue event to durable MongoDB outbox in ${environmentId}: ${err.message}`
          );
        }
        console.warn('[OutboxRepository] Failed to enqueue to Mongo outbox, falling back to memory in dev/test:', err.message);
      }
    } else {
      if (isProdOrStaging || !allowMemory) {
        throw new Error(
          `[OutboxRepository] Durable MongoDB storage unavailable for environment '${environmentId}'; failing closed in production/staging (in-memory queue prohibited)`
        );
      }
    }

    const eventId = options?.eventId || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const memRecord: OutboxEventRecord = {
      eventId,
      tenantId,
      environmentId,
      eventType,
      payload: { ...payload, correlationId },
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      createdAt: new Date(),
      workspaceId: options?.workspaceId,
      sessionId: options?.sessionId,
      toolId: options?.toolId,
      packVersionId: options?.packVersionId,
      approvalId: options?.approvalId,
      executionReference: options?.executionReference,
    };
    this.inMemoryQueue.push(memRecord);
    return eventId;
  }

  async claimLeases(
    workerId: string,
    leaseDurationMs = 30000,
    batchSize = 10
  ): Promise<OutboxEventRecord[]> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.claimLeases(workerId, leaseDurationMs, batchSize);
    }
    if (this.isProductionOrStaging()) {
      throw new Error('[OutboxRepository] Cannot claim leases from in-memory queue in production/staging; durable MongoDB storage required');
    }

    // In-memory simulation of atomic lease claiming
    const now = new Date();
    const claimed: OutboxEventRecord[] = [];

    for (const record of this.inMemoryQueue) {
      if (claimed.length >= batchSize) break;
      const isPending =
        record.status === 'pending' &&
        (!record.nextAttemptAt || record.nextAttemptAt <= now);
      const isExpiredLease =
        record.status === 'leased' &&
        record.leaseExpiresAt &&
        record.leaseExpiresAt < now;

      if (isPending || isExpiredLease) {
        record.status = 'leased';
        record.leasedBy = workerId;
        record.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
        claimed.push(structuredClone(record));
      }
    }

    return claimed;
  }

  async markPublished(eventId: string, session?: ClientSession): Promise<void> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      await dbRepo.markPublished(eventId, session);
      return;
    }
    if (this.isProductionOrStaging()) {
      throw new Error('[OutboxRepository] Cannot mark published in in-memory queue in production/staging; durable MongoDB storage required');
    }

    const item = this.inMemoryQueue.find((e) => e.eventId === eventId);
    if (item) {
      item.status = 'published';
      item.publishedAt = new Date();
      delete item.leasedBy;
      delete item.leaseExpiresAt;
    }
  }

  async recordFailure(
    eventId: string,
    error: string,
    maxAttempts = 5,
    backoffBaseMs = 1000
  ): Promise<'retry_scheduled' | 'dead_letter'> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.recordFailure(eventId, error, maxAttempts, backoffBaseMs);
    }
    if (this.isProductionOrStaging()) {
      throw new Error('[OutboxRepository] Cannot record failure in in-memory queue in production/staging; durable MongoDB storage required');
    }

    const item = this.inMemoryQueue.find((e) => e.eventId === eventId);
    if (!item) return 'dead_letter';

    item.attempts = (item.attempts || 0) + 1;
    const configuredMax = maxAttempts || item.maxAttempts || 5;

    if (item.attempts >= configuredMax) {
      item.status = 'dead_letter';
      item.error = error;
      delete item.leasedBy;
      delete item.leaseExpiresAt;
      return 'dead_letter';
    }

    const delay = backoffBaseMs * Math.pow(2, item.attempts - 1);
    item.status = 'pending';
    item.error = error;
    item.nextAttemptAt = new Date(Date.now() + delay);
    delete item.leasedBy;
    delete item.leaseExpiresAt;
    return 'retry_scheduled';
  }

  async renewLease(eventId: string, workerId: string, additionalMs = 30000): Promise<boolean> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.renewLease(eventId, workerId, additionalMs);
    }
    const item = this.inMemoryQueue.find(e => e.eventId === eventId && e.leasedBy === workerId && e.status === 'leased');
    if (item) {
      item.leaseExpiresAt = new Date(Date.now() + additionalMs);
      return true;
    }
    return false;
  }

  async replayDeadLetter(eventId: string, session?: ClientSession): Promise<boolean> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.replayDeadLetter(eventId, session);
    }
    const item = this.inMemoryQueue.find(e => e.eventId === eventId && e.status === 'dead_letter');
    if (item) {
      item.status = 'pending';
      item.attempts = 0;
      delete item.error;
      delete item.leasedBy;
      delete item.leaseExpiresAt;
      item.nextAttemptAt = new Date();
      return true;
    }
    return false;
  }

  async resolveDeadLetter(eventId: string, resolutionNote: string, session?: ClientSession): Promise<boolean> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.resolveDeadLetter(eventId, resolutionNote, session);
    }
    const item = this.inMemoryQueue.find(e => e.eventId === eventId && e.status === 'dead_letter');
    if (item) {
      item.status = 'resolved';
      item.resolutionNote = resolutionNote;
      item.resolvedAt = new Date();
      delete item.leasedBy;
      delete item.leaseExpiresAt;
      return true;
    }
    return false;
  }

  async getMetrics(tenantId?: string): Promise<{ pending: number; leased: number; published: number; deadLetter: number }> {
    const dbRepo = await this.getDbRepo();
    if (dbRepo) {
      return dbRepo.getMetrics(tenantId);
    }
    const filtered = tenantId ? this.inMemoryQueue.filter(e => e.tenantId === tenantId) : this.inMemoryQueue;
    return {
      pending: filtered.filter(e => e.status === 'pending').length,
      leased: filtered.filter(e => e.status === 'leased').length,
      published: filtered.filter(e => e.status === 'published').length,
      deadLetter: filtered.filter(e => e.status === 'dead_letter').length,
    };
  }

  getEvents(): OutboxEventRecord[] {
    return [...this.inMemoryQueue];
  }
}

