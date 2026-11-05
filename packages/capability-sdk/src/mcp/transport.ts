import {
  McpTransportError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpRequestMeta,
  type McpSendOptions,
  type McpTransport,
} from './types';
import { MCP_PROTOCOL_VERSION } from './types';

export interface HttpTransportOptions {
  url: string;
  /** Extra headers per request, for example the authorization built from a resolved secret. Called for every request. */
  headers?: (meta: McpRequestMeta) => Promise<Record<string, string>> | Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Scrubs text before it goes into an error message. */
  redact?: (text: string) => string;
}

/** Pulls the response that matches `id` out of a server-sent-events body. */
function responseFromEventStream(body: string, id: number | string | null): JsonRpcResponse | undefined {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message && message.jsonrpc === '2.0' && message.id === id && ('result' in message || 'error' in message)) return message;
    } catch {
      // not JSON: ignore the event
    }
  }
  return undefined;
}

/** JSON-RPC over HTTP POST, one request per POST. Redirects are refused. */
export class HttpMcpTransport implements McpTransport {
  sessionId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  resetSession(): void {
    this.sessionId = undefined;
  }

  async send(message: JsonRpcRequest | JsonRpcNotification, { meta, signal }: McpSendOptions): Promise<JsonRpcResponse | undefined> {
    const redact = this.options.redact ?? ((text: string) => text);
    const extra = (await this.options.headers?.(meta)) ?? {};
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'X-Tenant-ID': meta.tenantId,
      'X-Environment-ID': meta.environmentId,
      ...(meta.correlationId ? { 'X-Correlation-ID': meta.correlationId } : {}),
      ...(meta.principalId ? { 'X-Principal-ID': meta.principalId } : {}),
      ...(meta.connectionRef ? { 'X-Connection-Ref': meta.connectionRef } : {}),
      ...(meta.callerScope ? { 'X-Caller-Scope': meta.callerScope } : {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...extra,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.options.url, { method: 'POST', headers, body: JSON.stringify(message), signal, redirect: 'error' });
    } catch (err: any) {
      if (signal?.aborted) throw err;
      throw new McpTransportError(redact(`Could not reach the MCP server: ${err?.cause?.code || err?.message || 'network error'}`));
    }
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (res.status === 202 || res.status === 204) return undefined;
    const body = await res.text();
    if (!res.ok) throw new McpTransportError(redact(`The MCP server answered HTTP ${res.status}: ${body.slice(0, 200)}`), res.status);
    if (!('id' in message)) return undefined;
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const found = responseFromEventStream(body, message.id);
      if (!found) throw new McpTransportError('The MCP server sent no answer to the request');
      return found;
    }
    try {
      return JSON.parse(body) as JsonRpcResponse;
    } catch {
      throw new McpTransportError(redact('The MCP server sent an answer that is not JSON'));
    }
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}

/** Calls a function instead of the network: for tests and for a server that runs in the same process. */
export class InProcessMcpTransport implements McpTransport {
  sessionId?: string;
  constructor(private readonly handle: (message: JsonRpcRequest | JsonRpcNotification, meta: McpRequestMeta) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined) {}
  resetSession(): void {}
  async send(message: JsonRpcRequest | JsonRpcNotification, { meta }: McpSendOptions): Promise<JsonRpcResponse | undefined> {
    return this.handle(message, meta);
  }
  async close(): Promise<void> {}
}
