import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { runOp, type EngineContext } from './engine';
import { DEFAULT_CONNECTORS_DIR, TenantCollections, loadConnectors, readManifest, type LoadedConnector } from './loader';
import { ToolError, type Rec } from './types';
import { validateArguments } from './validate';

const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-03-26';
const PAGE_SIZE = 50;
const MAX_BODY_BYTES = 256 * 1024;

export interface SampleServerOptions {
  /** Folder of connectors. Default: the package's own. */
  dir?: string;
  /** The tenants this server holds data for, each with its own copy of the seeds. Default: the tenant the seeds were built for. */
  tenants?: string[];
  /** When set, every request must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  now?: () => Date;
}

type JsonRpcBody = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Rec };

const rpcError = (id: JsonRpcBody['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id: JsonRpcBody['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

const toolResult = (payload: Rec, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : { structuredContent: payload }),
});

/**
 * A stand-in for the systems a business keeps its data in, speaking MCP over HTTP. One endpoint per connector (`POST /mcp/<connector>`).
 * Each tenant has its own copy of every connector's records; a request for a tenant the server holds no data for is refused.
 */
export class SampleConnectorServer {
  private readonly connectors: Map<string, LoadedConnector>;
  private readonly tenants = new Map<string, Map<string, TenantCollections>>();
  private readonly now: () => Date;
  private http?: Server;

  constructor(private readonly options: SampleServerOptions = {}) {
    const dir = options.dir ?? DEFAULT_CONNECTORS_DIR;
    this.connectors = loadConnectors(dir);
    this.now = options.now ?? (() => new Date());
    for (const tenantId of options.tenants ?? [readManifest(dir).seedTenantId]) {
      this.tenants.set(tenantId, new Map([...this.connectors].map(([id, loaded]) => [id, new TenantCollections(loaded.seed)])));
    }
  }

  connectorIds(): string[] {
    return [...this.connectors.keys()];
  }

  hasTenant(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  /** Handles one JSON-RPC message for one connector and tenant. Returns undefined for a notification. */
  async handle(connectorId: string, tenantId: string, body: JsonRpcBody): Promise<Rec | undefined> {
    const connector = this.connectors.get(connectorId);
    if (!connector) return rpcError(body.id, -32004, `No connector '${connectorId}'`);
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body.id, -32600, 'Not a JSON-RPC 2.0 request');
    if (body.id === undefined) return undefined; // notifications need no answer

    switch (body.method) {
      case 'initialize':
        return rpcResult(body.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `sample-${connectorId}`, version: SERVER_VERSION },
          instructions: `${connector.definition.description} Runs on sample data.`,
        });
      case 'ping':
        return rpcResult(body.id, {});
      case 'tools/list': {
        const start = Number(body.params?.cursor ?? 0) || 0;
        const tools = connector.definition.tools.slice(start, start + PAGE_SIZE).map((tool) => ({
          name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }));
        const next = start + PAGE_SIZE;
        return rpcResult(body.id, { tools, ...(next < connector.definition.tools.length ? { nextCursor: String(next) } : {}) });
      }
      case 'tools/call': {
        const tool = connector.definition.tools.find((entry) => entry.name === body.params?.name);
        if (!tool) return rpcError(body.id, -32602, `Unknown tool: ${String(body.params?.name)}`);
        const args = (body.params?.arguments ?? {}) as Rec;
        const problems = validateArguments(tool.inputSchema, args);
        if (problems.length > 0) {
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'invalid_arguments', message: problems.join('; ') } }, true));
        }
        const data = this.tenants.get(tenantId)!.get(connectorId)!;
        const context: EngineContext = { connectorId, data, now: this.now };
        try {
          return rpcResult(body.id, toolResult(runOp(tool.op, args, context)));
        } catch (err) {
          if (err instanceof ToolError) {
            return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: err.code, message: err.message } }, true));
          }
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'internal_error', message: 'The sample connector could not run this tool.' } }, true));
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
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, connectors: this.connectorIds().length });
    const route = /^\/mcp\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!route) return send(404, { error: 'Not found' });
    if (req.method !== 'POST') return send(405, { error: 'Use POST' }, { allow: 'POST' });
    if (!this.authorised(req)) return send(401, { error: 'A valid bearer key is required' }, { 'www-authenticate': 'Bearer' });
    const tenantId = String(req.headers['x-tenant-id'] ?? '').trim();
    if (!tenantId) return send(400, rpcError(null, -32001, 'X-Tenant-ID is required'));
    if (!this.hasTenant(tenantId)) return send(403, rpcError(null, -32002, 'This server holds no data for that tenant'));

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
    const answer = await this.handle(route[1], tenantId, body);
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
