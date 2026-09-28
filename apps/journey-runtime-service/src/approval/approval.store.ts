import { createHash, randomUUID } from 'crypto';
import { Collection, ClientSession } from 'mongodb';
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

  private readonly explicitMemory: boolean = false;

  constructor(dbOrOptions?: any) {
    if (dbOrOptions && typeof dbOrOptions.collection === 'function') {
      this.col = dbOrOptions.collection(COLLECTION_TOOL_APPROVALS);
    } else if (dbOrOptions?.forceInMemory || dbOrOptions?.explicitMemory) {
      this.explicitMemory = true;
    }
  }

  private isMemoryPermitted(environmentId?: string): boolean {
    if (this.explicitMemory) {
      return true;
    }
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'staging' ||
      process.env.APP_ENV === 'production' ||
      process.env.APP_ENV === 'staging'
    ) {
      return false;
    }
    if (environmentId === 'staging' && process.env.NODE_ENV !== 'test') {
      return false;
    }
    return (
      process.env.NODE_ENV === 'test' ||
      process.env.ALLOW_IN_MEMORY_APPROVALS === 'true'
    );
  }

  private async getCol(environmentId?: string): Promise<Collection<ToolApprovalRecord> | null> {
    if (this.col) return this.col;
    if (this.isMemoryPermitted(environmentId)) {
      const uri = process.env.MONGODB_URI;
      if (!uri) return null;
      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
        this.col = db.collection<ToolApprovalRecord>(COLLECTION_TOOL_APPROVALS);
        return this.col;
      } catch {
        return null;
      }
    }

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        `[ApprovalStore] MONGODB_URI is required; memory fallback is prohibited in ${environmentId || process.env.NODE_ENV || 'production/staging'}.`
      );
    }

    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ToolApprovalRecord>(COLLECTION_TOOL_APPROVALS);
      return this.col;
    } catch (err: any) {
      throw new Error(
        `[ApprovalStore] Failed to connect to MongoDB in ${environmentId || process.env.NODE_ENV}; memory fallback prohibited: ${err.message}`
      );
    }
  }

  async createPending(
    toolId: string,
    input: unknown,
    ctx: ExecutionContext,
    ttlMs = 15 * 60_000
  ): Promise<ToolApprovalRecord> {
    if (
      !ctx.sessionId ||
      !ctx.stageId ||
      !ctx.packVersionId ||
      !ctx.principalId ||
      !ctx.principalRole ||
      input === undefined ||
      input === null
    ) {
      throw new Error(
        `[ApprovalStore] Cannot create approval for tool '${toolId}': missing mandatory immutable execution context bindings (sessionId, stageId, packVersionId, principalId, principalRole, and payload/input are required).`
      );
    }

    const now = new Date();
    const approvalRequestId = `apr_${randomUUID()}`;
    const inputHash = hashToolInput(input);
    const executionReference = ctx.idempotencyKey || `exec_${approvalRequestId}`;

    const record: ToolApprovalRecord = {
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      workspaceId: ctx.workspaceId,
      approvalRequestId,
      approvalId: approvalRequestId,
      toolId,
      inputHash,
      requestedPayload: typeof input === 'object' && input !== null ? (input as any) : { input },
      sessionId: ctx.sessionId,
      stageId: ctx.stageId,
      packVersionId: ctx.packVersionId,
      principalId: ctx.principalId,
      principalRole: ctx.principalRole,
      executionReference,
      status: 'pending',
      requestedBy: ctx.principalId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };

    const col = await this.getCol(ctx.environmentId);
    if (col) {
      await col.insertOne(record as any);
    } else {
      this.memory.set(record.approvalRequestId, structuredClone(record));
    }
    return record;
  }

  async getApproval(approvalRequestId: string): Promise<ToolApprovalRecord | null> {
    const col = await this.getCol();
    if (col) {
      const found = await col.findOne({
        $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
      } as any);
      if (found) return found;
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
    reason?: string,
    session?: ClientSession,
    eventId?: string
  ): Promise<boolean> {
    const now = new Date();
    const col = await this.getCol(environmentId);
    if (col) {
      const updateDoc: any = {
        $set: {
          status: decision,
          reviewedBy: decidedBy,
          reviewedAt: now,
          reason,
        },
      };
      if (decision === 'approved' && eventId) {
        updateDoc.$set.eventId = eventId;
      }

      const res = await col.updateOne(
        {
          tenantId,
          environmentId: environmentId as EnvironmentId,
          workspaceId,
          $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
          status: 'pending',
          expiresAt: { $gt: now },
        } as any,
        updateDoc,
        session ? { session } : undefined
      );
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
    if (decision === 'approved' && eventId) {
      record.eventId = eventId;
    }
    this.memory.set(approvalRequestId, record);
    return true;
  }

  async revertApprovalToPending(approvalRequestId: string, session?: ClientSession): Promise<void> {
    const col = await this.getCol();
    if (col) {
      await col.updateOne(
        {
          $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
        } as any,
        {
          $set: { status: 'pending' },
          $unset: { reviewedBy: '', reviewedAt: '', reason: '', eventId: '' },
        } as any,
        session ? { session } : undefined
      );
    } else {
      const record = this.memory.get(approvalRequestId);
      if (record) {
        record.status = 'pending';
        delete record.reviewedBy;
        delete record.reviewedAt;
        delete record.reason;
        delete record.eventId;
      }
    }
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
      $or: [{ approvalRequestId }, { approvalId: approvalRequestId }],
      toolId,
      inputHash: hashToolInput(input),
      sessionId: ctx.sessionId,
      stageId: ctx.stageId,
      packVersionId: ctx.packVersionId,
      principalRole: ctx.principalRole,
      status: 'approved' as const,
      consumedAt: { $exists: false },
      expiresAt: { $gt: now },
    };

    const col = await this.getCol(ctx.environmentId);
    if (col) {
      const result = await col.updateOne(filter as any, {
        $set: {
          consumedAt: now,
          consumedByEventId: (ctx as any).eventId || undefined,
        },
      });
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
      record.sessionId !== ctx.sessionId ||
      record.stageId !== ctx.stageId ||
      record.packVersionId !== ctx.packVersionId ||
      record.principalRole !== ctx.principalRole ||
      record.status !== 'approved' ||
      record.consumedAt ||
      record.expiresAt <= now
    ) {
      return false;
    }
    record.consumedAt = now;
    if ((ctx as any).eventId) {
      record.consumedByEventId = (ctx as any).eventId;
    }
    this.memory.set(approvalRequestId, record);
    return true;
  }
}
