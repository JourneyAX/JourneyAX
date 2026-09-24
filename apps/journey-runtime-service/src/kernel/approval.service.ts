import { ApprovalStore } from '../approval/approval.store';
import { ExecutionContext } from '@journeyax/capability-sdk';
import { ToolApprovalRecord, EnvironmentId } from '@journeyax/database';

export class ApprovalService {
  private store: ApprovalStore;

  constructor(store?: ApprovalStore) {
    this.store = store || new ApprovalStore();
  }

  async createPending(
    toolId: string,
    input: unknown,
    ctx: ExecutionContext,
    ttlMs = 15 * 60_000
  ): Promise<ToolApprovalRecord> {
    return this.store.createPending(toolId, input, ctx, ttlMs);
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
    return this.store.decide(
      tenantId,
      environmentId,
      workspaceId,
      approvalRequestId,
      decision,
      decidedBy,
      reason
    );
  }
}
