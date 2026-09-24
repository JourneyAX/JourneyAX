import { createHash, randomUUID } from 'crypto';
import { Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import { ExecutionContext } from '@journeyax/capability-sdk';

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ToolApprovalRecord {
  tenantId: string;
  environmentId: ExecutionContext['environmentId'];
  workspaceId: string;
  approvalRequestId: string;
  toolId: string;
  inputHash: string;
  status: ApprovalStatus;
  requestedBy?: string;
  requestedAt: Date;
  expiresAt: Date;
  reviewedBy?: string;
  reviewedAt?: Date;
  reason?: string;
  consumedAt?: Date;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export class ApprovalStore {
  private col: Collection<ToolApprovalRecord> | null = null;
  private memory = new Map<string, ToolApprovalRecord>();

  private get allowMemoryFallback(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.ALLOW_IN_MEMORY_APPROVALS !== 'false';
  }

  private async getCol(): Promise<Collection<ToolApprovalRecord> | null> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      if (this.allowMemoryFallback) return null;
      throw new Error('[ApprovalStore] MONGODB_URI is required in production.');
    }

    const { db } = await connectToDatabase(uri, 'journeyx');
    this.col = db.collection<ToolApprovalRecord>('tool_approvals');
    await this.col.createIndex(
      { tenantId: 1, environmentId: 1, approvalRequestId: 1 },
      { unique: true }
    );
    await this.col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return this.col;
  }

  async createPending(
    toolId: string,
    input: unknown,
    ctx: ExecutionContext,
    ttlMs = 15 * 60_000
  ): Promise<ToolApprovalRecord> {
    const now = new Date();
    const record: ToolApprovalRecord = {
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      workspaceId: ctx.workspaceId,
      approvalRequestId: `apr_${randomUUID()}`,
      toolId,
      inputHash: hashToolInput(input),
      status: 'pending',
      requestedBy: ctx.principalId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };

    const col = await this.getCol();
    if (col) await col.insertOne(record);
    else this.memory.set(record.approvalRequestId, structuredClone(record));
    return record;
  }

  async consumeApproved(
    approvalRequestId: string,
    toolId: string,
    input: unknown,
    ctx: ExecutionContext
  ): Promise<boolean> {
    const now = new Date();
    const filter = {
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      workspaceId: ctx.workspaceId,
      approvalRequestId,
      toolId,
      inputHash: hashToolInput(input),
      status: 'approved' as const,
      consumedAt: { $exists: false },
      expiresAt: { $gt: now },
    };

    const col = await this.getCol();
    if (col) {
      const result = await col.updateOne(filter, { $set: { consumedAt: now } });
      return result.modifiedCount === 1;
    }

    const record = this.memory.get(approvalRequestId);
    if (
      !record ||
      record.tenantId !== ctx.tenantId ||
      record.environmentId !== ctx.environmentId ||
      record.workspaceId !== ctx.workspaceId ||
      record.toolId !== toolId ||
      record.inputHash !== hashToolInput(input) ||
      record.status !== 'approved' ||
      record.consumedAt ||
      record.expiresAt <= now
    ) {
      return false;
    }
    record.consumedAt = now;
    this.memory.set(approvalRequestId, record);
    return true;
  }
}
