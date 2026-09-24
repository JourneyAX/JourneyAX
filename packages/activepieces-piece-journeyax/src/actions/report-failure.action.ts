import { createAction, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth, JourneyAxAuthData } from '../auth';

export const reportFailureAction = createAction({
  auth: journeyaxAuth,
  name: 'report_failure',
  displayName: 'Report Automation Failure',
  description: 'Reports an external automation or sync failure back to the customer workspace.',
  props: {
    workspaceId: Property.ShortText({
      displayName: 'Workspace ID',
      required: true,
    }),
    toolId: Property.ShortText({
      displayName: 'Tool ID',
      required: true,
    }),
    errorCode: Property.ShortText({
      displayName: 'Error Code',
      required: true,
    }),
    errorMessage: Property.LongText({
      displayName: 'Error Message',
      required: true,
    }),
    details: Property.Json({
      displayName: 'Failure Details (Optional JSON)',
      required: false,
    }),
  },
  async run(context) {
    const auth = context.auth as any as JourneyAxAuthData;
    const tenantId = auth.tenantId;
    const env = auth.environmentId || 'production';
    const workspaceId = context.propsValue.workspaceId;
    const toolId = context.propsValue.toolId;
    const url = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${tenantId}/${env}/runtime/workspaces/${workspaceId}/facts`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-internal-key': auth.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: `failure_${toolId}`,
        value: {
          errorCode: context.propsValue.errorCode,
          errorMessage: context.propsValue.errorMessage,
          details: context.propsValue.details || {},
          failedAt: new Date().toISOString(),
        },
        source: 'external',
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to report failure: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
});
