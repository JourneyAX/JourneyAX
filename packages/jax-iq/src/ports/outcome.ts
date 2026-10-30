/**
 * What one call to a connector tool came back as, once the MCP client has done its work. A success carries the answer (cut to the client's
 * size cap when `truncated`). A failure says how the call failed and carries the connector's own words; `classifyConnectorFailure` turns it
 * into a JAX IQ error code.
 */
export type ConnectorOutcome =
  | { ok: true; data: unknown; truncated: boolean; bytes: number }
  | { ok: false; kind: 'tool_error' | 'transport' | 'timeout' | 'not_configured' | 'protocol' | 'not_read_only'; code?: string; message: string };

export type FailedConnectorOutcome = Extract<ConnectorOutcome, { ok: false }>;
