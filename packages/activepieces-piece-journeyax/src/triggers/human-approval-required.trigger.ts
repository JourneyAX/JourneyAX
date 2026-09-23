export interface HumanApprovalRequiredPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  approvalRequestId: string;
  toolId: string;
  risk: 'medium' | 'high' | 'critical';
  reason: string;
  payload: Record<string, any>;
  timestamp: string;
}

export const humanApprovalRequiredTrigger = {
  name: 'human_approval_required',
  displayName: 'Human Approval Required',
  description: 'Triggers when a policy gate halts a write or high-risk tool until human approval is granted.',
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_wwg_apprentice_1727136000000',
    approvalRequestId: 'appr_req_1727136000000',
    toolId: 'crm.create_lead',
    risk: 'medium',
    reason: 'Tool binding requires human confirmation before external CRM sync',
    payload: {
      email: 'lead@example.com.au',
      name: 'Trade Enterprise Buyer',
    },
    timestamp: '2026-09-23T22:00:00.000Z',
  },
};
