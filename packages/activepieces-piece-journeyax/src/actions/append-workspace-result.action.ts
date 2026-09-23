export interface AppendWorkspaceResultInput {
  gatewayUrl: string;
  internalApiKey: string;
  tenantId: string;
  workspaceId: string;
  key: string;
  value: any;
  source: string;
}

export const appendWorkspaceResultAction = {
  name: 'append_workspace_result',
  displayName: 'Append Workspace Result',
  description: 'Writes external automation results (CRM Lead ID, ticket number, tracking code) back into workspace facts.',
  async run(input: AppendWorkspaceResultInput) {
    const url = `${input.gatewayUrl.replace(/\/$/, '')}/api/v1/${input.tenantId}/workspace/${input.workspaceId}/facts`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-internal-key': input.internalApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: input.key,
        value: input.value,
        source: input.source,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to append workspace fact: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  },
};
