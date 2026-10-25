import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { ToolError, type RealConnector, type Rec } from './types';
import { clip } from './http';
import { validateArguments } from './validate';

const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 256 * 1024;

export interface RealServerOptions {
  connectors: RealConnector[];
  /** The tenants this server may answer for. A request for any other tenant is refused. Default: `placemakers`. */
  tenants?: string[];
  /** When set, every request must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  warn?: (message: string) => void;
}

type JsonRpcBody = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Rec };

const rpcError = (id: JsonRpcBody['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id: JsonRpcBody['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

const toolResult = (payload: Rec, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : { structuredContent: payload }),
});

/**
 * The real systems' side of a connector call, speaking the same MCP over HTTP as the sample server (one endpoint per connector,
 * `POST /mcp/<connector>`), so pointing a connector at this server instead of the sample one changes nothing for the chat, the rules or
 * the pack. The credentials for each vendor live in this server's own settings and never leave it.
 *
 * A connector whose settings are missing is still served, but offers no tools and says it is not connected; the health page lists which
 * settings are missing (their names only).
 */
export class RealConnectorServer {
  private readonly connectors = new Map<string, RealConnector>();
  private readonly tenants: Set<string>;
  private readonly warn: (message: string) => void;
  private http?: Server;

  constructor(private readonly options: RealServerOptions) {
    for (const connector of options.connectors) this.connectors.set(connector.connectorId, connector);
    this.tenants = new Set(options.tenants?.length ? options.tenants : ['placemakers']);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  connectorIds(): string[] {
    return [...this.connectors.keys()];
  }

  health(): Rec {
    return {
      ok: true,
      connectors: [...this.connectors.values()].map((connector) => {
        const missing = connector.missing();
        return { id: connector.connectorId, connected: missing.length === 0, ...(missing.length ? { missing } : {}) };
      }),
    };
  }

  /** Handles one JSON-RPC message for one connector. Returns undefined for a notification. */
  async handle(connectorId: string, body: JsonRpcBody): Promise<Rec | undefined> {
    const connector = this.connectors.get(connectorId);
    if (!connector) return rpcError(body.id, -32004, `No connector '${connectorId}'`);
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body.id, -32600, 'Not a JSON-RPC 2.0 request');
    if (body.id === undefined) return undefined; // notifications need no answer
    const missing = connector.missing();

    switch (body.method) {
      case 'initialize':
        return rpcResult(body.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `real-${connectorId}`, version: SERVER_VERSION },
          instructions: missing.length ? `${connector.description} Not connected yet.` : connector.description,
        });
      case 'ping':
        return rpcResult(body.id, {});
      case 'tools/list':
        return rpcResult(body.id, {
          tools: missing.length ? [] : connector.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
          })),
        });
      case 'tools/call': {
        const tool = connector.tools.find((entry) => entry.name === body.params?.name);
        if (!tool) return rpcError(body.id, -32602, `Unknown tool: ${String(body.params?.name)}`);
        if (missing.length) {
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'not_connected', message: `${connector.title} is not connected yet. An administrator needs to finish its setup.` } }, true));
        }
        const args = (body.params?.arguments ?? {}) as Rec;
        const problems = validateArguments(tool.inputSchema, args);
        if (problems.length > 0) {
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'invalid_arguments', message: problems.join('; ') } }, true));
        }
        try {
          return rpcResult(body.id, toolResult({ ok: true, connector: connectorId, ...(await tool.run(args)) }));
        } catch (err: any) {
          if (err instanceof ToolError) {
            return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: err.code, message: err.message } }, true));
          }
          this.warn(`[connectors-real] ${connectorId}.${tool.name} failed: ${clip(String(err?.message ?? err), 200)}`);
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'internal_error', message: 'The connector could not run this tool.' } }, true));
        }
      }
      default:
        return rpcError(body.id, -32601, `Method not found: ${body.method}`);
    }
  }

  private authorised(req: IncomingMessage): boolean {
    if (!this.options.apiKey) return true;
    const header = String(req.headers.authorization ?? '');
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const wanted = Buffer.from(this.options.apiKey);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(200, this.health());
    const route = /^\/mcp\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!route) return send(404, { error: 'Not found' });
    if (req.method !== 'POST') return send(405, { error: 'Use POST' }, { allow: 'POST' });
    if (!this.authorised(req)) return send(401, { error: 'A valid bearer key is required' }, { 'www-authenticate': 'Bearer' });
    const tenantId = String(req.headers['x-tenant-id'] ?? '').trim();
    if (!tenantId) return send(400, rpcError(null, -32001, 'X-Tenant-ID is required'));
    if (!this.tenants.has(tenantId)) return send(403, rpcError(null, -32002, 'This server holds no connection for that tenant'));

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return send(413, rpcError(null, -32600, 'Request too large'));
      chunks.push(chunk as Buffer);
    }
    let body: JsonRpcBody;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, rpcError(null, -32700, 'Parse error'));
    }
    const answer = await this.handle(route[1], body);
    if (!answer) { res.writeHead(202); res.end(); return; }
    send(200, answer);
  }

  /** Starts listening. Port 0 picks a free port. Returns the base address (`http://host:port`). */
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.http = createServer((req, res) => { this.onRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    await new Promise<void>((resolve) => this.http!.listen(port, host, resolve));
    const address = this.http.address() as AddressInfo;
    return `http://${host}:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.http) return;
    this.http.closeAllConnections?.();
    await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = undefined;
  }
}
