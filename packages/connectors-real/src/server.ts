import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryJtiStore, verifyScope, hashScopeArguments, readIqPath, type CallScope } from '@journeyax/jax-iq';
import { timingSafeEqual } from 'node:crypto';
import { ToolError, type RealConnector, type Rec } from './types';
import { clip } from './http';
import { validateArguments } from './validate';
import type { ReplayStore } from '@journeyax/database';

const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 256 * 1024;

export interface RealServerOptions {
  connectors: RealConnector[];
  /** The tenants this server may answer for. A request for any other tenant is refused. No default tenant is granted. */
  tenants?: string[];
  /** When set, every request must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Fixed source scope for a dedicated connection. A request cannot relabel its records as another environment. */
  environmentId?: string;
  connectionRef?: string;
  /** When configured, every read requires an argument/identity/release-bound IQ scope. */
  iqScopeSecret?: string;
  /** Separate harness authority for exact, governed write calls. Unsigned commands never reach a vendor. */
  commandScopeSecret?: string;
  /** Atomic shared nonce claims are mandatory for signed production source connections. */
  replayStore?: ReplayStore;
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
  private readonly scopes = new MemoryJtiStore();

  constructor(private readonly options: RealServerOptions) {
    if ((options.tenants?.length ?? 0) > 1) throw new Error('A vendor connection must serve exactly one tenant; run separate scoped connections.');
    if ((options.iqScopeSecret || options.commandScopeSecret) && (!options.connectionRef || !options.environmentId || (options.iqScopeSecret && options.iqScopeSecret.length < 32) || (options.commandScopeSecret && options.commandScopeSecret.length < 32))) throw new Error('Signed source connections require environment, connection reference and a strong signing secret.');
    if (process.env.NODE_ENV === 'production' && (options.iqScopeSecret || options.commandScopeSecret) && (!options.replayStore || options.tenants?.length !== 1)) throw new Error('Signed production sources require one tenant and shared replay storage.');
    for (const connector of options.connectors) this.connectors.set(connector.connectorId, connector);
    this.tenants = new Set(options.tenants ?? []);
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
  async handle(connectorId: string, body: JsonRpcBody, callerScope?: CallScope): Promise<Rec | undefined> {
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
        if (tool.staffOnly && callerScope?.principal.audience === 'shopper') return rpcError(body.id, -32003, 'This tool returns staff-only information');
        if (!tool.readOnly && (!this.options.commandScopeSecret || callerScope?.operation !== 'command' || !callerScope.actionId)) return rpcError(body.id, -32003, 'A verified harness command scope is required');
        if (tool.requiresPaymentReceipt && !callerScope?.capRuleIds.includes('paid-order-delivery')) return rpcError(body.id, -32003, 'This command requires a provider-confirmed paid order workflow');
        if (tool.requiredWorkflowGrant && !callerScope?.capRuleIds.includes(tool.requiredWorkflowGrant)) return rpcError(body.id, -32003, 'This tool requires its registered server-owned workflow grant');
        if (tool.readOnly && callerScope?.operation === 'command') return rpcError(body.id, -32003, 'A command grant cannot authorise a read');
        if (tool.readOnly && this.options.iqScopeSecret && !callerScope) return rpcError(body.id, -32003, 'A verified IQ caller scope is required');
        const args = (body.params?.arguments ?? {}) as Rec;
        if (callerScope?.principal.audience === 'shopper' && tool.shopperIdentityFields?.some(field =>
          typeof args[field] !== 'string' || args[field].trim().toLowerCase() !== callerScope.principal.id.trim().toLowerCase()
        )) return rpcError(body.id, -32003, 'This operation must use the authenticated requester.');
        const problems = validateArguments(tool.inputSchema, args);
        if (problems.length > 0) {
          return rpcResult(body.id, toolResult({ ok: false, connector: connectorId, error: { code: 'invalid_arguments', message: problems.join('; ') } }, true));
        }
        try {
          const execution = callerScope?.operation === 'command' && callerScope.actionId ? {
            actionId: callerScope.actionId, tenantId: callerScope.tenantId, environmentId: callerScope.environmentId,
            principalId: callerScope.principal.id, releaseChecksum: callerScope.release.checksum,
          } : undefined;
          const result = { ok: true, connector: connectorId, ...(await tool.run(args, execution)) };
          return rpcResult(body.id, toolResult(callerScope && tool.readOnly ? scopedAnswer(result, callerScope.fields) : result));
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
    if (this.options.environmentId && req.headers['x-environment-id'] !== this.options.environmentId) return send(403, rpcError(null, -32002, 'This server holds no connection for that environment'));
    if (this.options.connectionRef && req.headers['x-connection-ref'] !== this.options.connectionRef) return send(403, rpcError(null, -32002, 'The requested connection is not available'));

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
    let callerScope: CallScope | undefined;
    const sourceTool = this.connectors.get(route[1])?.tools.find(tool => tool.name === body.params?.name);
    if (body.method === 'tools/call' && sourceTool && ((!sourceTool.readOnly) || this.options.iqScopeSecret)) {
      const secret = sourceTool.readOnly ? this.options.iqScopeSecret : this.options.commandScopeSecret;
      if (!secret) return send(403, rpcError(body.id, -32003, 'A governed source connection is required'));
      const verdict = verifyScope(String(req.headers['x-caller-scope'] ?? ''), {
        secret, operation: sourceTool.readOnly ? 'read' : 'command', now: new Date(), method: body.method,
        tenantHeader: tenantId, environmentHeader: String(req.headers['x-environment-id'] ?? ''),
        connectorId: route[1], connectionRef: this.options.connectionRef, toolName: String(body.params?.name ?? ''),
        argsHash: hashScopeArguments((body.params?.arguments ?? {}) as Rec), seen: { seen: () => false },
      });
      if (verdict.ok === false) return send(403, rpcError(body.id, -32003, 'The IQ caller scope was refused'));
      callerScope = verdict.scope;
      if (req.headers['x-principal-id'] !== callerScope.principal.id) return send(403, rpcError(body.id, -32003, 'The caller identity does not match'));
      if (this.options.replayStore) {
        try {
          const nonce = `source:${this.options.connectionRef}:${route[1]}:${callerScope.jti}`;
          const claimed = await this.options.replayStore.claim(nonce, tenantId, callerScope.environmentId, new Date(callerScope.exp * 1000));
          if (claimed !== 'success') return send(403, rpcError(body.id, -32003, 'The source scope was already used'));
        } catch { return send(503, rpcError(body.id, -32003, 'The source replay guard is unavailable')); }
      } else if (this.scopes.seen(callerScope.jti, callerScope.exp)) return send(403, rpcError(body.id, -32003, 'The source scope was already used'));
      if (callerScope.exp * 1000 <= Date.now()) return send(403, rpcError(body.id, -32003, 'The source scope expired before execution'));
    }
    const answer = await this.handle(route[1], body, callerScope);
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

/** Project at the source boundary. IQ retains only explicitly allowed paths; vendor extras never leave this server. */
export function scopedAnswer(value: unknown, fields: string[]): Rec {
  const answer: Rec = { ok: true };
  const source = value as Rec;
  for (const marker of ['sample', 'source', 'truncated', 'more']) if (typeof source?.[marker] === 'boolean' || typeof source?.[marker] === 'string') answer[marker] = source[marker];
  for (const field of fields) {
    const parts = field.split('.');
    if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) continue;
    const found = readIqPath(value, field);
    if (found === undefined) continue;
    let into = answer;
    for (const part of parts.slice(0, -1)) into = into[part] ??= {};
    into[parts[parts.length - 1]] = found;
  }
  return answer;
}
