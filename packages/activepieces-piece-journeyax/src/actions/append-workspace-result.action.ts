import { createAction, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth, JourneyAxAuthData } from '../auth';

export const appendWorkspaceResultAction = createAction({
  auth: journeyaxAuth,
  name: 'append_workspace_result',
  displayName: 'Append Workspace Result',
  description: 'Writes external automation results (CRM Lead ID, ticket number, tracking code) back into workspace facts.',
  props: {
    workspaceId: Property.ShortText({
      displayName: 'Workspace ID',
      description: 'The unique JourneyAX customer workspace ID',
      required: true,
    }),
    key: Property.ShortText({
      displayName: 'Fact Key',
      description: 'The state machine fact attribute key (e.g. crm_lead_id, order_tracking_number)',
      required: true,
    }),
    value: Property.Json({
      displayName: 'Fact Value',
      description: 'The value to associate with this fact (primitive or structured JSON)',
      required: true,
    }),
    source: Property.StaticDropdown({
      displayName: 'Fact Source',
      required: false,
      defaultValue: 'external',
      options: {
        options: [
          { label: 'External', value: 'external' },
          { label: 'Tool', value: 'tool' },
          { label: 'System', value: 'system' },
        ],
      },
    }),
  },
  async run(context) {
    const auth = context.auth as any as JourneyAxAuthData;
    const tenantId = auth.tenantId;
    const env = auth.environmentId || 'production';
    const workspaceId = context.propsValue.workspaceId;
    const url = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${tenantId}/${env}/runtime/workspaces/${workspaceId}/facts`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-internal-key': auth.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: context.propsValue.key,
        value: context.propsValue.value,
        source: context.propsValue.source || 'external',
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to append workspace fact: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
});
