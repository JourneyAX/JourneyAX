export interface GetWorkspaceFactsInput {
  gatewayUrl: string;
  internalApiKey: string;
  tenantId: string;
  workspaceId: string;
}

export const getWorkspaceFactsAction = {
  name: 'get_workspace_facts',
  displayName: 'Get Workspace Facts',
  description: 'Fetches accumulated facts, constraints, and current journey stage from a customer workspace.',
  async run(input: GetWorkspaceFactsInput) {
    const url = `${input.gatewayUrl.replace(/\/$/, '')}/api/v1/${input.tenantId}/workspace/${input.workspaceId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-internal-key': input.internalApiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch workspace: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return {
      workspaceId: data.workspaceId,
      currentStageId: data.currentStageId,
      facts: data.facts,
      constraints: data.constraints,
      updatedAt: data.updatedAt,
    };
  },
};
