export interface ResolveHumanApprovalInput {
  gatewayUrl: string;
  internalApiKey: string;
  tenantId: string;
  workspaceId: string;
  approvalRequestId: string;
  decision: 'approved' | 'rejected';
  reviewerId: string;
  reason?: string;
}

export const resolveHumanApprovalAction = {
  name: 'resolve_human_approval',
  displayName: 'Resolve Human Approval',
  description: 'Submits human authorization to resume paused tool execution.',
  async run(input: ResolveHumanApprovalInput) {
    const url = `${input.gatewayUrl.replace(/\/$/, '')}/api/v1/${input.tenantId}/workspace/${input.workspaceId}/approvals/${input.approvalRequestId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-internal-key': input.internalApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        decision: input.decision,
        reviewerId: input.reviewerId,
        reason: input.reason,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to resolve approval: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
};
