import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RealConnectorServer } from '../src/server';
import type { Deps, RealConnector, Rec } from '../src/types';

export interface Seen { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: any; raw: string }
export interface Reply { status?: number; json?: unknown; text?: string }

/** A pretend vendor: records every request it gets and answers with whatever the test says. */
export async function mockVendor(answer: (request: Seen, count: number) => Reply | undefined) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    let body: any;
    try { body = raw ? (req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : undefined; } catch { body = raw; }
    const request: Seen = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, raw };
    seen.push(request);
    const reply = answer(request, seen.length) ?? { status: 404, json: { message: `mock has no answer for ${request.method} ${request.path}` } };
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

export const realDeps = (now: () => number = Date.now): Deps => ({ fetchImpl: fetch, now });

/** Calls a tool through the real MCP handler, the way the runtime would, and returns the payload the model would get. */
export async function callTool(server: RealConnectorServer, connectorId: string, name: string, args: Rec = {}) {
  const answer: any = await server.handle(connectorId, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (answer.error) return { rpcError: answer.error as Rec };
  const payload = JSON.parse(answer.result.content[0].text) as Rec;
  return { payload, isError: Boolean(answer.result.isError) };
}

export async function listTools(server: RealConnectorServer, connectorId: string): Promise<Rec[]> {
  const answer: any = await server.handle(connectorId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return answer.result.tools;
}

export const serverFor = (...connectors: RealConnector[]) => new RealConnectorServer({ connectors, warn: () => {} });

/** A small test harness: each test runs, failures are listed at the end, and the process exits non-zero if any failed. */
export function suite(title: string) {
  let passed = 0;
  const failures: string[] = [];
  return {
    async test(name: string, fn: () => Promise<void> | void) {
      try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error: any) { failures.push(name); console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`); }
    },
    finish() {
      console.log(failures.length ? `✗ ${title}: ${passed} passed, ${failures.length} failed` : `✅ ${title}: ${passed} passed, 0 failed`);
      process.exit(failures.length ? 1 : 0);
    },
  };
}

/** True if no string anywhere in the value contains the secret. */
export const leaks = (value: unknown, secret: string): boolean => JSON.stringify(value).includes(secret);
