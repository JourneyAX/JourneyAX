import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest { method: string; headers: Record<string, string | string[] | undefined>; body: any }

export interface TestServerOptions {
  /** Tools by name; `call` returns an MCP result. */
  tools?: Record<string, { description?: string; inputSchema?: any; call: (args: any, seen: SeenRequest) => any | Promise<any> }>;
  pageSize?: number;
  sessionId?: string;
  sse?: boolean;
  /** Called first for every request; return true if it handled the response. */
  intercept?: (req: IncomingMessage, res: ServerResponse, seen: SeenRequest) => boolean | Promise<boolean>;
}

/** A small MCP server over HTTP for tests: initialize, tools/list (paged) and tools/call. */
export async function startTestServer(options: TestServerOptions = {}): Promise<{ url: string; seen: SeenRequest[]; server: Server; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const tools = options.tools ?? {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const record: SeenRequest = { method: body?.method, headers: req.headers, body };
    seen.push(record);
    if (options.intercept && (await options.intercept(req, res, record))) return;
    const reply = (payload: unknown) => {
      const headers: Record<string, string> = { 'content-type': options.sse ? 'text/event-stream' : 'application/json' };
      if (options.sessionId) headers['mcp-session-id'] = options.sessionId;
      res.writeHead(200, headers);
      res.end(options.sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
    };
    if (body?.id === undefined) { res.writeHead(202); res.end(); return; }
    if (body.method === 'initialize') return reply({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } });
    if (body.method === 'tools/list') {
      const names = Object.keys(tools);
      const size = options.pageSize ?? names.length;
      const start = body.params?.cursor ? Number(body.params.cursor) : 0;
      const page = names.slice(start, start + size).map((name) => ({ name, description: tools[name].description ?? name, inputSchema: tools[name].inputSchema ?? { type: 'object', properties: {} } }));
      return reply({ jsonrpc: '2.0', id: body.id, result: { tools: page, ...(start + size < names.length ? { nextCursor: String(start + size) } : {}) } });
    }
    if (body.method === 'tools/call') {
      const tool = tools[body.params?.name];
      if (!tool) return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Unknown tool: ${body.params?.name}` } });
      try {
        return reply({ jsonrpc: '2.0', id: body.id, result: await tool.call(body.params.arguments ?? {}, record) });
      } catch (err: any) {
        return reply({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] } });
      }
    }
    return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp/test`, seen, server, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

export const structured = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
