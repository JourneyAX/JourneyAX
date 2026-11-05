/**
 * The small part of the Model Context Protocol (MCP) the platform speaks as a client: JSON-RPC 2.0 messages, `initialize`, `tools/list`
 * and `tools/call`. Wire-compatible with the "streamable HTTP" transport in its plain-JSON form; nothing here knows who the server is.
 */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

export interface JsonRpcRequest { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }
export interface JsonRpcError { code: number; message: string; data?: unknown }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: JsonRpcError }

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, any>;
  annotations?: McpToolAnnotations;
}

export interface McpContentBlock { type: string; text?: string; [key: string]: unknown }
export interface McpCallResult { content?: McpContentBlock[]; structuredContent?: unknown; isError?: boolean }

/** What the platform knows about this call, passed to the server as headers. The tenant always comes from server-side context. */
export interface McpRequestMeta {
  tenantId: string;
  environmentId: string;
  correlationId?: string;
  principalId?: string;
  connectionRef?: string;
  callerScope?: string;
}

export interface McpSendOptions { meta: McpRequestMeta; signal?: AbortSignal }

export interface McpTransport {
  /** Sends a request and returns its response; a notification returns undefined. Throws {@link McpTransportError} on HTTP-level failure. */
  send(message: JsonRpcRequest | JsonRpcNotification, options: McpSendOptions): Promise<JsonRpcResponse | undefined>;
  /** The id of the session the server opened, if it uses sessions. */
  readonly sessionId?: string;
  resetSession(): void;
  close(): Promise<void>;
}

export class McpTransportError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export class McpProtocolError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

/** A tool result as the model gets it: capped in size, secrets removed. */
export interface McpToolOutput {
  isError: boolean;
  /** Text content; empty when the server sent structured data (which carries the same information). */
  text: string;
  data?: unknown;
  /** True when the result was cut to fit the size cap. */
  truncated: boolean;
  /** How many list items were left out when it was cut. */
  omitted?: number;
  /** Size of what is returned, in bytes. */
  bytes: number;
}

/** Where a call is made from: which tenant and environment, and which stored connection and secret reference it uses. */
export interface McpScope {
  tenantId: string;
  environmentId: string;
  connectionRef?: string;
  secretRef?: string;
}

export interface McpClientLimits {
  /** Largest result handed to the model, in bytes. */
  maxResultBytes: number;
  callTimeoutMs: number;
  /** How long a tool list is reused. */
  listTtlMs: number;
  maxListPages: number;
  maxTools: number;
}

export const DEFAULT_MCP_LIMITS: McpClientLimits = {
  maxResultBytes: 32 * 1024,
  callTimeoutMs: 15_000,
  listTtlMs: 5 * 60_000,
  maxListPages: 10,
  maxTools: 200,
};
