import { createAction, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth, JourneyAxAuthData } from '../auth';

export const resolveHumanApprovalAction = createAction({
  auth: journeyaxAuth,
  name: 'resolve_human_approval',
  displayName: 'Resolve Human Approval',
  description: 'Submits human authorization to resume paused tool execution.',
  props: {
    workspaceId: Property.ShortText({
      displayName: 'Workspace ID',
      required: true,
    }),
    approvalRequestId: Property.ShortText({
      displayName: 'Approval Request ID',
      required: true,
    }),
    decision: Property.StaticDropdown({
      displayName: 'Decision',
      required: true,
      options: {
        options: [
          { label: 'Approved', value: 'approved' },
          { label: 'Rejected', value: 'rejected' },
        ],
      },
    }),
    reason: Property.LongText({
      displayName: 'Reason / Notes',
      required: false,
    }),
  },
  async run(context) {
    const auth = context.auth as any as JourneyAxAuthData;
    const tenantId = auth.tenantId;
    const env = auth.environmentId || 'production';
    const workspaceId = context.propsValue.workspaceId;
    const approvalRequestId = context.propsValue.approvalRequestId;
    const url = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${tenantId}/${env}/runtime/workspaces/${workspaceId}/approvals/${approvalRequestId}/decide`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-internal-key': auth.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        decision: context.propsValue.decision,
        reason: context.propsValue.reason,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to resolve approval: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
});
