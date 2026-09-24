import { Collection } from 'mongodb';
import { connectToDatabase, COLLECTION_TOOL_EXECUTIONS, EnvironmentId } from '@journeyax/database';

export interface ExecutionRecord {
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  correlationId: string;
  toolId: string;
  idempotencyKey?: string;
  status: 'started' | 'completed' | 'failed' | 'requires_approval';
  inputHash?: string;
  inputPayload?: any;
  outputPayload?: any;
  error?: string;
  durationMs?: number;
  executedBy?: string;
  executedAt: Date;
}

export class ExecutionRepository {
  private col: Collection<ExecutionRecord> | null = null;
  private inMemoryAudit: ExecutionRecord[] = [];

  private async getCol(): Promise<Collection<ExecutionRecord> | null> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ExecutionRecord>(COLLECTION_TOOL_EXECUTIONS);
      return this.col;
    } catch {
      return null;
    }
  }

  async findExecution(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    toolId: string,
    idempotencyKey: string
  ): Promise<ExecutionRecord | null> {
    const col = await this.getCol();
    if (col) {
      try {
        const found = await col.findOne({
          tenantId,
          environmentId,
          workspaceId,
          toolId,
          idempotencyKey,
        });
        if (found) return found;
      } catch (err: any) {
        console.warn('[ExecutionRepository] findExecution failed in Mongo:', err.message);
      }
    }

    return (
      this.inMemoryAudit.find(
        (e) =>
          e.tenantId === tenantId &&
          e.environmentId === environmentId &&
          e.workspaceId === workspaceId &&
          e.toolId === toolId &&
          e.idempotencyKey === idempotencyKey
      ) || null
    );
  }

  async recordExecution(record: ExecutionRecord): Promise<void> {
    const col = await this.getCol();
    if (col) {
      try {
        if (record.idempotencyKey) {
          await col.updateOne(
            {
              tenantId: record.tenantId,
              environmentId: record.environmentId,
              workspaceId: record.workspaceId,
              toolId: record.toolId,
              idempotencyKey: record.idempotencyKey,
            },
            { $set: record },
            { upsert: true }
          );
        } else {
          await col.insertOne(record);
        }
        return;
      } catch (err: any) {
        console.warn('[ExecutionRepository] Failed to record execution in Mongo:', err.message);
      }
    }

    if (record.idempotencyKey) {
      const idx = this.inMemoryAudit.findIndex(
        (e) =>
          e.tenantId === record.tenantId &&
          e.environmentId === record.environmentId &&
          e.workspaceId === record.workspaceId &&
          e.toolId === record.toolId &&
          e.idempotencyKey === record.idempotencyKey
      );
      if (idx >= 0) {
        this.inMemoryAudit[idx] = record;
        return;
      }
    }

    this.inMemoryAudit.push(record);
  }

  getAuditTrail(): ExecutionRecord[] {
    return [...this.inMemoryAudit];
  }
}

