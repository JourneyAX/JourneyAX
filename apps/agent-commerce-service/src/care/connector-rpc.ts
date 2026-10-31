/**
 * Calls a tool on the real connector server (the one the assistant's connectors use) with the shop's key, so the care module never holds a
 * vendor secret. Same door as the order mirror uses: a JSON-RPC `tools/call`, the answer's text is the tool's payload.
 *
 *   CONNECTOR_MCP_SERVERS   {"zendesk":"http://127.0.0.1:4020/mcp/zendesk", ...}
 *   CONNECTOR_SECRET_REAL_CONNECTORS_KEY   the shop's key for that server
 */
export interface ConnectorCaller {
  call(connector: string, tool: string, args: Record<string, unknown>, tenantId: string): Promise<any>;
}

export class ConnectorCallError extends Error {
  constructor(message: string, readonly code: string = 'failed') { super(message); this.name = 'ConnectorCallError'; }
}

export interface RpcDeps { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number }

export function connectorUrl(connector: string, env: Record<string, string | undefined> = process.env): string | null {
  try { return String(JSON.parse(env.CONNECTOR_MCP_SERVERS || '{}')[connector] || '').trim() || null; } catch { return null; }
}

/** A caller that talks to the connector server over HTTP, or null when no key is set (so the care module can say it is not connected). */
export function httpConnectorCaller(deps: RpcDeps = {}): ConnectorCaller | null {
  const env = deps.env ?? process.env;
  const key = (env.CONNECTOR_SECRET_REAL_CONNECTORS_KEY || '').trim();
  if (!key) return null;
  return {
    async call(connector, tool, args, tenantId) {
      const url = connectorUrl(connector, env);
      if (!url) throw new ConnectorCallError(`${connector} is not set up on this server.`, 'not_connected');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
      try {
        const response = await (deps.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, 'x-tenant-id': tenantId },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
          signal: controller.signal,
        });
        if (!response.ok) throw new ConnectorCallError(`The connector server answered ${response.status}.`, 'unavailable');
        const body: any = await response.json();
        if (body?.error) throw new ConnectorCallError(String(body.error.message || 'The connector server refused the call.').slice(0, 200), 'refused');
        const payload = JSON.parse(String(body?.result?.content?.[0]?.text ?? '{}'));
        if (body?.result?.isError || payload?.ok === false) throw new ConnectorCallError(String(payload?.error?.message || `${connector} did not do that.`).slice(0, 200), String(payload?.error?.code || 'rejected'));
        return payload;
      } catch (error: any) {
        if (error instanceof ConnectorCallError) throw error;
        throw new ConnectorCallError(error?.name === 'AbortError' ? 'The connector server did not answer in time.' : String(error?.message || error).slice(0, 200), 'unavailable');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
