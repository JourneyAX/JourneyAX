import { createAction, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth, JourneyAxAuthData } from '../auth';

export const getWorkspaceFactsAction = createAction({
  auth: journeyaxAuth,
  name: 'get_workspace_facts',
  displayName: 'Get Workspace Facts',
  description: 'Fetches accumulated facts, constraints, and current journey stage from a customer workspace.',
  props: {
    workspaceId: Property.ShortText({
      displayName: 'Workspace ID',
      description: 'The unique JourneyAX customer workspace ID',
      required: true,
    }),
  },
  async run(context) {
    const auth = context.auth as any as JourneyAxAuthData;
    const tenantId = auth.tenantId;
    const env = auth.environmentId || 'production';
    const workspaceId = context.propsValue.workspaceId;
    const url = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${tenantId}/${env}/runtime/workspaces/${workspaceId}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-internal-key': auth.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch workspace: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return {
      workspaceId: data.workspaceId,
      currentStage: data.currentStage,
      facts: data.facts,
      status: data.status,
      stateVersion: data.stateVersion,
      updatedAt: data.updatedAt,
    };
  },
});
