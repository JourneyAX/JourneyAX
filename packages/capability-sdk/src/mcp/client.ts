import { normaliseToolResult } from './result';
import {
  DEFAULT_MCP_LIMITS,
  McpProtocolError,
  McpTransportError,
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallResult,
  type McpClientLimits,
  type McpRequestMeta,
  type McpToolDescriptor,
  type McpToolOutput,
  type McpTransport,
} from './types';

/**
 * A small MCP client. It connects when first used, lists a server's tools on request only (and reuses the list for a few minutes), and
 * caps what a tool call hands back. Everything that leaves it is scrubbed with `redact`.
 */
export class McpClient {
  private initialising?: Promise<void>;
  private nextId = 1;
  private toolCache?: { at: number; tools: McpToolDescriptor[] };
  readonly limits: McpClientLimits;

  constructor(
    private readonly transport: McpTransport,
    readonly serverName: string,
    limits: Partial<McpClientLimits> = {},
    private readonly redact: (text: string) => string = (text) => text,
  ) {
    this.limits = { ...DEFAULT_MCP_LIMITS, ...limits };
  }

  private async request(method: string, params: Record<string, unknown> | undefined, meta: McpRequestMeta, signal?: AbortSignal): Promise<any> {
    const message: JsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) };
    let response: JsonRpcResponse | undefined;
    try {
      response = await this.transport.send(message, { meta, signal });
    } catch (err) {
      // The server may have forgotten the session (a restart): start over once.
      if (err instanceof McpTransportError && err.status === 404 && this.transport.sessionId && method !== 'initialize') {
        this.transport.resetSession();
        this.initialising = undefined;
        await this.ensureInitialised(meta, signal);
        response = await this.transport.send({ ...message, id: this.nextId++ }, { meta, signal });
      } else {
        throw err;
      }
    }
    if (!response) throw new McpTransportError('The MCP server sent no answer');
    if (response.error) throw new McpProtocolError(this.redact(response.error.message || 'MCP error'), response.error.code);
    return response.result;
  }

  private ensureInitialised(meta: McpRequestMeta, signal?: AbortSignal): Promise<void> {
    if (!this.initialising) {
      this.initialising = (async () => {
        await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'journeyax-runtime', version: '1.0.0' } }, meta, signal);
        await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { meta, signal });
      })().catch((err) => {
        this.initialising = undefined;
        throw err;
      });
    }
    return this.initialising;
  }

  /** The server's tools, fetched the first time and then reused until the list is a few minutes old (or `refresh` is set). */
  async listTools(meta: McpRequestMeta, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<McpToolDescriptor[]> {
    if (!options.refresh && this.toolCache && Date.now() - this.toolCache.at < this.limits.listTtlMs) return this.toolCache.tools;
    const signal = options.signal ?? AbortSignal.timeout(this.limits.callTimeoutMs);
    await this.ensureInitialised(meta, signal);
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.limits.maxListPages; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : undefined, meta, signal);
      for (const tool of result?.tools ?? []) {
        if (tool && typeof tool.name === 'string') {
          tools.push({ name: tool.name, ...(tool.title ? { title: String(tool.title) } : {}), description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }, ...(tool.annotations ? { annotations: tool.annotations } : {}) });
        }
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || tools.length >= this.limits.maxTools) break;
    }
    this.toolCache = { at: Date.now(), tools: tools.slice(0, this.limits.maxTools) };
    return this.toolCache.tools;
  }

  /** Calls one tool. A tool that reports its own error comes back with `isError`; a failure of the call itself throws. */
  async callTool(name: string, args: Record<string, unknown>, meta: McpRequestMeta, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpToolOutput> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.limits.callTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      await this.ensureInitialised(meta, signal);
      const result = (await this.request('tools/call', { name, arguments: args }, meta, signal)) as McpCallResult;
      return normaliseToolResult(result ?? {}, this.limits.maxResultBytes, this.redact);
    } catch (err: any) {
      if (timeout.aborted) throw new Error(`The MCP server '${this.serverName}' did not answer within ${options.timeoutMs ?? this.limits.callTimeoutMs} ms`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.initialising = undefined;
    this.toolCache = undefined;
    await this.transport.close();
  }
}
