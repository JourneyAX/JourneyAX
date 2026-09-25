import { randomUUID } from 'crypto';
import { ApprovalStore } from '../approval/approval.store';
import { ExecutionContext } from '@journeyax/capability-sdk';
import { ToolApprovalRecord, EnvironmentId, connectToDatabase } from '@journeyax/database';
import { OutboxRepository } from './outbox.repository';

export class ApprovalService {
  private store: ApprovalStore;
  private outboxRepo?: OutboxRepository;
  private db?: any;

  constructor(store?: ApprovalStore, outboxRepo?: OutboxRepository, db?: any) {
    this.store = store || new ApprovalStore(db);
    this.outboxRepo = outboxRepo;
    this.db = db;
  }

  setOutboxRepo(repo: OutboxRepository): void {
    this.outboxRepo = repo;
  }

  getOutboxRepo(): OutboxRepository | undefined {
    return this.outboxRepo;
  }

  async createPending(
    toolId: string,
    input: unknown,
    ctx: ExecutionContext,
    ttlMs = 15 * 60_000
  ): Promise<ToolApprovalRecord> {
    return this.store.createPending(toolId, input, ctx, ttlMs);
  }

  async getApproval(approvalRequestId: string): Promise<ToolApprovalRecord | null> {
    return this.store.getApproval(approvalRequestId);
  }

  async decide(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string
  ): Promise<boolean> {
    const approvalRecord = await this.store.getApproval(approvalRequestId);
    if (!approvalRecord) {
      return false;
    }

    if (
      approvalRecord.tenantId !== tenantId ||
      approvalRecord.environmentId !== environmentId ||
      approvalRecord.workspaceId !== workspaceId
    ) {
      throw new Error(
        `[ApprovalService] Approval record '${approvalRequestId}' tenant/environment/workspace mismatch`
      );
    }

    if (approvalRecord.status !== 'pending') {
      return false;
    }

    // Fail closed if immutable bindings are missing
    if (
      !approvalRecord.sessionId ||
      !approvalRecord.stageId ||
      !approvalRecord.packVersionId ||
      !approvalRecord.principalId ||
      !approvalRecord.principalRole ||
      !approvalRecord.inputHash ||
      !approvalRecord.executionReference
    ) {
      throw new Error(
        `[ApprovalService] Cannot decide approval '${approvalRequestId}': missing mandatory immutable context bindings (sessionId, stageId, packVersionId, principalId, principalRole, inputHash, executionReference); failing closed`
      );
    }

    if (decision === 'rejected') {
      return this.store.decide(
        tenantId,
        environmentId,
        workspaceId,
        approvalRequestId,
        'rejected',
        decidedBy,
        reason
      );
    }

    // Approved path: bind outbox event
    const eventId = `evt_${randomUUID()}`;
    const payload = approvalRecord.requestedPayload || {};
    const executionReference = approvalRecord.executionReference;
    const sessionId = approvalRecord.sessionId;
    const stageId = approvalRecord.stageId;
    const packVersionId = approvalRecord.packVersionId;

    const uri = process.env.MONGODB_URI;
    let client: any = this.db?.client || null;
    if (!client && uri) {
      try {
        const conn = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
        client = conn.client;
      } catch {}
    }

    if (client && typeof client.startSession === 'function' && this.outboxRepo) {
      try {
        const session = client.startSession();
        try {
          let decided = false;
          await session.withTransaction(async () => {
            decided = await this.store.decide(
              tenantId,
              environmentId,
              workspaceId,
              approvalRequestId,
              'approved',
              decidedBy,
              reason,
              session,
              eventId
            );
            if (!decided) {
              throw new Error(`[ApprovalService] Approval '${approvalRequestId}' could not be transitioned to approved`);
            }
            await this.outboxRepo!.enqueueEvent(
              tenantId,
              environmentId,
              'activepieces.dispatch',
              payload,
              undefined,
              session,
              {
                workspaceId,
                sessionId,
                toolId: approvalRecord.toolId,
                packVersionId,
                approvalId: approvalRequestId,
                executionReference,
                eventId,
              }
            );
          });
          return decided;
        } finally {
          await session.endSession();
        }
      } catch (txErr: any) {
        // Any transaction failure: abort has already rolled back the decision. No stranded approval!
        throw txErr;
      }
    }

    // Non-transactional test / dev mode without Mongo session:
    // First update the decision in store
    const success = await this.store.decide(
      tenantId,
      environmentId,
      workspaceId,
      approvalRequestId,
      'approved',
      decidedBy,
      reason,
      undefined,
      eventId
    );
    if (!success) return false;

    if (this.outboxRepo) {
      try {
        await this.outboxRepo.enqueueEvent(
          tenantId,
          environmentId,
          'activepieces.dispatch',
          payload,
          undefined,
          undefined,
          {
            workspaceId,
            sessionId,
            toolId: approvalRecord.toolId,
            packVersionId,
            approvalId: approvalRequestId,
            executionReference,
            eventId,
          }
        );
      } catch (enqueueErr) {
        // Enqueue failed! Explicitly rollback approval to pending so it is NOT stranded
        await this.store.revertApprovalToPending(approvalRequestId);
        throw enqueueErr;
      }
    }

    return success;
  }
}
