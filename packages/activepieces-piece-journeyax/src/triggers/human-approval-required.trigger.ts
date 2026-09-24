import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

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

export const humanApprovalRequiredTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'human_approval_required',
  displayName: 'Human Approval Required',
  description: 'Triggers when a policy gate halts a write or high-risk tool until human approval is granted.',
  props: {
    toolId: Property.ShortText({
      displayName: 'Tool ID (Optional Filter)',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('human_approval_required', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('human_approval_required', context);
  },
  async run(context) {
    const payload = context.payload.body as HumanApprovalRequiredPayload;
    if (context.propsValue.toolId && payload.toolId !== context.propsValue.toolId) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_sample_appr',
    approvalRequestId: 'appr_req_sample',
    toolId: 'crm.create_lead',
    risk: 'medium',
    reason: 'Tool binding requires human confirmation before external CRM sync',
    payload: {
      email: 'lead@example.com.au',
      name: 'Trade Enterprise Buyer',
    },
    timestamp: new Date().toISOString(),
  },
});
