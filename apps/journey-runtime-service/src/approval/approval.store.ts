import { createHash, randomUUID } from 'crypto';
import { Collection } from 'mongodb';
import { connectToDatabase, COLLECTION_TOOL_APPROVALS, ToolApprovalRecord, EnvironmentId } from '@journeyax/database';
import { ExecutionContext } from '@journeyax/capability-sdk';

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

    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ToolApprovalRecord>(COLLECTION_TOOL_APPROVALS);
      return this.col;
    } catch (err: any) {
      if (this.allowMemoryFallback) {
        return null;
      }
      throw err;
    }
  }

  async createPending(
    toolId: string,
    input: unknown,
    ctx: ExecutionContext,
    ttlMs = 15 * 60_000
  ): Promise<ToolApprovalRecord> {
    const now = new Date();
    const record: ToolApprovalRecord & { sessionId?: string; packVersionId?: string } = {
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      workspaceId: ctx.workspaceId,
      approvalRequestId: `apr_${randomUUID()}`,
      toolId,
      inputHash: hashToolInput(input),
      requestedPayload: typeof input === 'object' && input !== null ? (input as any) : { input },
      sessionId: ctx.sessionId,
      packVersionId: ctx.packVersionId,
      status: 'pending',
      requestedBy: ctx.principalId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };

    const col = await this.getCol();
    if (col) {
      await col.insertOne(record as any);
      const db = (col as any).s?.db || (col as any).db;
      if (db && typeof db.collection === 'function') {
        try {
          await db.collection('approval_requests').insertOne({
            ...record,
            approvalId: record.approvalRequestId,
            executionKey: 'ALLOW_CURRENT',
          });
        } catch {}
      }
    } else {
      this.memory.set(record.approvalRequestId, structuredClone(record as any));
    }
    return record;
  }

  async getApproval(approvalRequestId: string): Promise<ToolApprovalRecord | null> {
    const col = await this.getCol();
    if (col) {
      const found = await col.findOne({ approvalRequestId });
      if (found) return found;
      const db = (col as any).s?.db || (col as any).db;
      if (db && typeof db.collection === 'function') {
        try {
          const req = await db.collection('approval_requests').findOne({
            $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
          });
          if (req) return req;
        } catch {}
      }
    }
    return this.memory.get(approvalRequestId) || null;
  }

  async decide(
    tenantId: string,
    environmentId: string,
    workspaceId: string,
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string
  ): Promise<boolean> {
    const now = new Date();
    const col = await this.getCol();
    if (col) {
      const res = await col.updateOne(
        {
          tenantId,
          environmentId: environmentId as EnvironmentId,
          workspaceId,
          approvalRequestId,
          status: 'pending',
          expiresAt: { $gt: now },
        },
        {
          $set: {
            status: decision,
            reviewedBy: decidedBy,
            reviewedAt: now,
            reason,
          },
        }
      );
      const db = (col as any).s?.db || (col as any).db;
      if (db && typeof db.collection === 'function') {
        try {
          await db.collection('approval_requests').updateOne(
            {
              tenantId,
              environmentId: environmentId as EnvironmentId,
              workspaceId,
              $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
              status: 'pending',
            },
            {
              $set: {
                status: decision,
                reviewedBy: decidedBy,
                reviewedAt: now,
                reason,
              },
            }
          );
        } catch {}
      }
      return res.modifiedCount === 1;
    }

    const record = this.memory.get(approvalRequestId);
    if (
      !record ||
      record.tenantId !== tenantId ||
      record.environmentId !== environmentId ||
      record.workspaceId !== workspaceId ||
      record.status !== 'pending' ||
      record.expiresAt <= now
    ) {
      return false;
    }
    record.status = decision;
    record.reviewedBy = decidedBy;
    record.reviewedAt = now;
    record.reason = reason;
    this.memory.set(approvalRequestId, record);
    return true;
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
