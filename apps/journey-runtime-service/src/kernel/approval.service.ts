import { ApprovalStore } from '../approval/approval.store';
import { ExecutionContext } from '@journeyax/capability-sdk';
import { ToolApprovalRecord, EnvironmentId } from '@journeyax/database';
import { OutboxRepository } from './outbox.repository';

export class ApprovalService {
  private store: ApprovalStore;
  private outboxRepo?: OutboxRepository;

  constructor(store?: ApprovalStore, outboxRepo?: OutboxRepository) {
    this.store = store || new ApprovalStore();
    this.outboxRepo = outboxRepo;
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
    const success = await this.store.decide(
      tenantId,
      environmentId,
      workspaceId,
      approvalRequestId,
      decision,
      decidedBy,
      reason
    );

    if (success && decision === 'approved' && this.outboxRepo) {
      const approvalRecord = await this.store.getApproval(approvalRequestId);
      if (approvalRecord) {
        const sessionId = (approvalRecord as any).sessionId || workspaceId;
        const packVersionId = (approvalRecord as any).packVersionId || '1.0.0';
        const payload = (approvalRecord as any).requestedPayload || {};

        // Transactionally enqueue activepieces.dispatch with the top-level immutable envelope refs
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
            executionReference: `exec_${approvalRequestId}`,
          }
        );
      }
    }

    return success;
  }
}
