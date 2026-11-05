import assert from 'node:assert/strict';
import { CapabilityDispatcher } from '../src/dispatcher';
import { MemoryActionLedger } from '../src/action-ledger';
import {
  EnvMcpServerDirectory,
  EnvSecretResolver,
  connectorSecretVariable,
  HttpMcpTransport,
  McpClient,
  McpClientPool,
  StaticMcpServerDirectory,
  assertSafeMcpUrl,
  capValue,
  type McpScope,
} from '../src/mcp';
import type { ToolBinding, ToolDefinition } from '../src/types';
import { startTestServer, structured } from './helpers/mcp-test-server';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ❌ FAIL: ${name}\n     ${err?.stack || err}`);
  }
}

const META = { tenantId: 'tenant_a', environmentId: 'dev', correlationId: 'corr_1', principalId: 'person_1' };
const SECRET_REF = 'tenant-secret://tenant_a/dev/sample-key';
const SECRET = 'canary-secret-value-123456';
const secrets = new EnvSecretResolver({ [connectorSecretVariable(SECRET_REF)]: SECRET } as any);

function poolFor(url: string, extra: Record<string, unknown> = {}) {
  return new McpClientPool({ directory: new StaticMcpServerDirectory({ stock: url }), secrets, nodeEnv: 'test', ...extra } as any);
}
const scope = (extra: Partial<McpScope> = {}): McpScope => ({ tenantId: 'tenant_a', environmentId: 'dev', secretRef: SECRET_REF, ...extra });

async function main() {
  console.log('🔌 MCP client, pool and mcp_tool executor\n');

  await test('the client connects only when first used, lists tools with paging, and reuses the list', async () => {
    const server = await startTestServer({ tools: { a: { call: () => structured({}) }, b: { call: () => structured({}) }, c: { call: () => structured({}) } }, pageSize: 2 });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      assert.equal(server.seen.length, 0, 'getting a client sends nothing');
      const first = await client.listTools(META);
      assert.deepEqual(first.map((t) => t.name), ['a', 'b', 'c']);
      const methods = server.seen.map((s) => s.method);
      assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
      await client.listTools(META);
      assert.equal(server.seen.length, 4, 'the second list is served from the cache');
      await client.listTools(META, { refresh: true });
      assert.equal(server.seen.length, 6, 'a refresh asks again, without initialising again');
    } finally { await server.close(); }
  });

  await test('a tool result comes back structured, a tool that reports an error comes back as an error, an unknown tool is a protocol error', async () => {
    const server = await startTestServer({ tools: { ok: { call: () => structured({ ok: true, rows: [1, 2] }) }, bad: { call: () => { throw new Error('no such account'); } } } });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      const ok = await client.callTool('ok', {}, META);
      assert.deepEqual(ok.data, { ok: true, rows: [1, 2] });
      assert.equal(ok.isError, false);
      assert.equal(ok.text, '', 'the text that repeats the structured data is dropped');
      const bad = await client.callTool('bad', {}, META);
      assert.equal(bad.isError, true);
      assert.equal(bad.text, 'no such account');
      await assert.rejects(client.callTool('nope', {}, META), /Unknown tool/);
    } finally { await server.close(); }
  });

  await test('a big result is cut to the size cap: the largest list is halved until it fits, and what was left out is counted', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, note: 'x'.repeat(100) }));
    const server = await startTestServer({ tools: { big: { call: () => structured({ ok: true, records: rows, total: 400 }) }, longText: { call: () => ({ content: [{ type: 'text', text: 'é'.repeat(50_000) }] }) } } });
    try {
      const client = await new McpClientPool({ directory: new StaticMcpServerDirectory({ stock: server.url }), secrets, nodeEnv: 'test', limits: { maxResultBytes: 4096 } }).getClient('stock', scope());
      const big = await client.callTool('big', {}, META);
      assert.equal(big.truncated, true);
      assert.ok(big.bytes <= 4096, `fits: ${big.bytes}`);
      assert.ok((big.omitted ?? 0) > 0 && (big.data as any).records.length + big.omitted! >= 400 - 1, 'the count of left-out items is reported');
      assert.equal((big.data as any).total, 400, 'the rest of the object is kept');
      const long = await client.callTool('longText', {}, META);
      assert.equal(long.truncated, true);
      assert.ok(Buffer.byteLength(long.text, 'utf8') <= 4096);
    } finally { await server.close(); }
    assert.deepEqual(capValue({ a: 1 }, 100), { value: { a: 1 }, truncated: false, omitted: 0 });
    const noList = capValue({ text: 'y'.repeat(5000) }, 300);
    assert.equal(noList.truncated, true);
    assert.ok(JSON.stringify(noList.value).length <= 300 + 40);
  });

  await test('the secret is sent as a bearer token, resolved from its reference, and never appears in a result or an error', async () => {
    const server = await startTestServer({
      tools: {
        echo: { call: () => structured({ ok: true, leaked: `the key is ${SECRET}` }) },
        boom: { call: () => { throw new Error(`failed with key ${SECRET}`); } },
      },
    });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      const echo = await client.callTool('echo', {}, META);
      assert.ok(server.seen.some((s) => s.headers.authorization === `Bearer ${SECRET}`), 'the server received the secret');
      assert.ok(!JSON.stringify(echo).includes(SECRET), 'a result that echoes the secret is scrubbed');
      const boom = await client.callTool('boom', {}, META);
      assert.ok(!JSON.stringify(boom).includes(SECRET), 'an error that echoes the secret is scrubbed');
      assert.match(JSON.stringify(echo), /\[redacted\]/);
    } finally { await server.close(); }
  });

  await test('a failing server answers with a short error that has no secret and no stack', async () => {
    const server = await startTestServer({ intercept: (_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`internal error, bearer ${SECRET}`); return true; } });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      await assert.rejects(client.listTools(META), (err: any) => {
        assert.match(err.message, /HTTP 500/);
        assert.ok(!err.message.includes(SECRET));
        return true;
      });
    } finally { await server.close(); }
    const dead = await poolFor('http://127.0.0.1:1/mcp/x').getClient('stock', scope());
    await assert.rejects(dead.listTools(META), /Could not reach the MCP server/);
  });

  await test('a secret reference must be a reference to the caller\'s own tenant and environment; a raw key is refused', async () => {
    const pool = poolFor('http://127.0.0.1:1/mcp/x');
    await assert.rejects(pool.getClient('stock', scope({ secretRef: 'tenant-secret://tenant_b/dev/sample-key' })), /CROSS_TENANT/);
    await assert.rejects(pool.getClient('stock', scope({ secretRef: 'tenant-secret://tenant_a/production/sample-key' })), /CROSS_ENVIRONMENT/);
    await assert.rejects(pool.getClient('stock', scope({ secretRef: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' })), /RAW_SECRET/);
    await assert.rejects(pool.getClient('unknown-server', scope()), /not configured/);
  });

  await test('a call that takes too long stops at the timeout', async () => {
    const server = await startTestServer({ tools: { slow: { call: () => new Promise((resolve) => setTimeout(() => resolve(structured({})), 1500)) } } });
    try {
      const client = await poolFor(server.url, { limits: { callTimeoutMs: 150 } }).getClient('stock', scope());
      const started = Date.now();
      await assert.rejects(client.callTool('slow', {}, META), /did not answer within 150 ms/);
      assert.ok(Date.now() - started < 1200);
    } finally { await server.close(); }
  });

  await test('redirects are refused', async () => {
    const server = await startTestServer({ intercept: (_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return true; } });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      await assert.rejects(client.listTools(META), /Could not reach the MCP server/);
    } finally { await server.close(); }
  });

  await test('server addresses are checked: metadata and link-local always refused; production wants https and a public address', () => {
    assert.throws(() => assertSafeMcpUrl('http://169.254.169.254/latest', 'development'), /link-local or metadata/);
    assert.throws(() => assertSafeMcpUrl('http://metadata.google.internal/', 'development'), /link-local or metadata/);
    assert.throws(() => assertSafeMcpUrl('https://user:pw@example.test/mcp', 'development'), /credentials/);
    assert.throws(() => assertSafeMcpUrl('ftp://example.test/mcp', 'development'), /http or https/);
    assert.throws(() => assertSafeMcpUrl('not a url', 'development'), /not a valid URL/);
    assert.doesNotThrow(() => assertSafeMcpUrl('http://127.0.0.1:4000/mcp/x', 'development'));
    assert.throws(() => assertSafeMcpUrl('http://connectors.example.test/mcp/x', 'production'), /must be https/);
    assert.throws(() => assertSafeMcpUrl('https://127.0.0.1/mcp/x', 'production'), /private or loopback/);
    assert.throws(() => assertSafeMcpUrl('https://10.0.0.5/mcp/x', 'production'), /private or loopback/);
    assert.doesNotThrow(() => assertSafeMcpUrl('https://connectors.example.test/mcp/x', 'production'));
  });

  await test('the directory finds a server by name from the environment, with a base address as the fallback', () => {
    const env = { CONNECTOR_MCP_SERVERS: JSON.stringify({ crm: 'https://crm.example.test/mcp' }), CONNECTOR_MCP_BASE_URL: 'http://127.0.0.1:4010/' } as any;
    const directory = new EnvMcpServerDirectory(env);
    assert.equal(directory.resolve('crm')?.url, 'https://crm.example.test/mcp');
    assert.equal(directory.resolve('ace-erp')?.url, 'http://127.0.0.1:4010/mcp/ace-erp');
    assert.equal(new EnvMcpServerDirectory({} as any).resolve('x'), undefined);
    assert.equal(new EnvMcpServerDirectory({ CONNECTOR_MCP_SERVERS: '{not json' } as any).resolve('x'), undefined);
  });

  await test('sessions: the server\'s session id is sent back, and a forgotten session starts over once', async () => {
    let forget = false;
    const server = await startTestServer({
      sessionId: 'sess-1',
      tools: { ping: { call: () => structured({ pong: true }) } },
      intercept: (_req, res, seen) => {
        if (forget && seen.method === 'tools/call') { forget = false; res.writeHead(404); res.end('no such session'); return true; }
        return false;
      },
    });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      await client.callTool('ping', {}, META);
      assert.ok(server.seen.some((s) => s.headers['mcp-session-id'] === 'sess-1'));
      forget = true;
      const again = await client.callTool('ping', {}, META);
      assert.deepEqual(again.data, { pong: true });
      assert.equal(server.seen.filter((s) => s.method === 'initialize').length, 2);
    } finally { await server.close(); }
  });

  await test('a server that answers in an event stream works too', async () => {
    const server = await startTestServer({ sse: true, tools: { ping: { call: () => structured({ pong: true }) } } });
    try {
      const client = await poolFor(server.url).getClient('stock', scope());
      assert.deepEqual((await client.callTool('ping', {}, META)).data, { pong: true });
    } finally { await server.close(); }
  });

  await test('tenants never share a client, a session or a tool list; the tenant reaches the server in a header', async () => {
    const server = await startTestServer({ tools: { who: { call: (_a, seen) => structured({ tenant: seen.headers['x-tenant-id'] }) } } });
    try {
      const otherRef = 'tenant-secret://tenant_b/dev/sample-key';
      const pool = poolFor(server.url, { secrets: new EnvSecretResolver({ [connectorSecretVariable(SECRET_REF)]: SECRET, [connectorSecretVariable(otherRef)]: 'isolated-other-tenant-secret' }) });
      const a = await pool.getClient('stock', scope());
      const b = await pool.getClient('stock', { tenantId: 'tenant_b', environmentId: 'dev', secretRef: 'tenant-secret://tenant_b/dev/sample-key' });
      assert.notEqual(a, b);
      assert.strictEqual(await pool.getClient('stock', scope()), a, 'the same tenant gets the same client');
      const ra = await a.callTool('who', {}, META);
      const rb = await b.callTool('who', {}, { ...META, tenantId: 'tenant_b' });
      assert.deepEqual([(ra.data as any).tenant, (rb.data as any).tenant], ['tenant_a', 'tenant_b']);
    } finally { await server.close(); }
  });

  // --- the mcp_tool executor and the connector policy state in the gate ---
  const readTool: ToolDefinition = { toolId: 'stock-system.stock_by_branch', version: '1.0.0', displayName: 'stock', description: 'stock', inputSchema: {}, outputSchema: {}, sideEffect: 'read', risk: 'low' } as any;
  const writeTool: ToolDefinition = { ...readTool, toolId: 'stock-system.reserve_stock', sideEffect: 'write' } as any;
  const bindingFor = (extra: Record<string, unknown> = {}): ToolBinding => ({
    toolId: 'x', tenantId: 'tenant_a', environmentId: 'dev',
    executor: { type: 'mcp_tool', mcpServerName: 'stock', mcpToolName: 'tool', secretRef: SECRET_REF, ...extra } as any,
  }) as any;
  const ctx = { tenantId: 'tenant_a', environmentId: 'dev' as const, workspaceId: 'w', sessionId: 's', stageId: 'st', packVersionId: '1', correlationId: 'corr_1', principalId: 'person_1', principalRole: 'operator' };

  await test('the mcp_tool executor calls the named tool and returns its data with the executor type in the provenance', async () => {
    const server = await startTestServer({ tools: { tool: { call: (args) => structured({ ok: true, echoed: args }) } } });
    try {
      const dispatcher = new CapabilityDispatcher({ mcpClients: poolFor(server.url) });
      const res = await dispatcher.dispatch(readTool, bindingFor(), { toolId: readTool.toolId, input: { sku: 'S1' } }, ctx);
      assert.equal(res.status, 'success', res.error);
      assert.deepEqual(res.output.data, { ok: true, echoed: { sku: 'S1' } });
      assert.equal(res.provenance.executorType, 'mcp_tool');
      assert.ok(!JSON.stringify(res).includes(SECRET));
    } finally { await server.close(); }
  });

  await test('the mcp_tool executor fails closed: no client, a bad server or tool name, a tool that reports an error, a connection nobody owns', async () => {
    const server = await startTestServer({ tools: { tool: { call: () => { throw new Error('account not found'); } } } });
    try {
      const none = await new CapabilityDispatcher({}).dispatch(readTool, bindingFor(), { toolId: readTool.toolId, input: {} }, ctx);
      assert.equal(none.status, 'failure');
      assert.match(none.error!, /no MCP client is configured/);
      const dispatcher = new CapabilityDispatcher({ mcpClients: poolFor(server.url) });
      const badName = await dispatcher.dispatch(readTool, bindingFor({ mcpServerName: '../etc' }), { toolId: readTool.toolId, input: {} }, ctx);
      assert.match(badName.error!, /invalid or missing mcpServerName/);
      const badTool = await dispatcher.dispatch(readTool, bindingFor({ mcpToolName: 'a b' }), { toolId: readTool.toolId, input: {} }, ctx);
      assert.match(badTool.error!, /invalid tool name/);
      const reported = await dispatcher.dispatch(readTool, bindingFor(), { toolId: readTool.toolId, input: {} }, ctx);
      assert.equal(reported.status, 'failure');
      assert.match(reported.error!, /reported an error: account not found/);
      const noValidator = await dispatcher.dispatch(readTool, bindingFor({ connectionRef: 'conn_1' }), { toolId: readTool.toolId, input: {} }, ctx);
      assert.match(noValidator.error!, /validateConnectionOwnership validator is mandatory/);
      const notOwner = await new CapabilityDispatcher({ mcpClients: poolFor(server.url), validateConnectionOwnership: () => false }).dispatch(readTool, bindingFor({ connectionRef: 'conn_1' }), { toolId: readTool.toolId, input: {} }, ctx);
      assert.match(notOwner.error!, /not owned by tenant 'tenant_a'/);
    } finally { await server.close(); }
  });

  await test('policy states preserve approval and durable write receipts; replay executes once', async () => {
    const server = await startTestServer({ tools: { tool: { call: () => structured({ ok: true }) } } });
    try {
      const dispatcher = new CapabilityDispatcher({ mcpClients: poolFor(server.url), actionLedger: new MemoryActionLedger() });
      const run = (tool: ToolDefinition, request: Record<string, unknown>) => dispatcher.dispatch(tool, bindingFor(), { toolId: tool.toolId, input: {}, ...request } as any, { ...ctx, idempotencyKey: 'isolated-write-1' });

      const blocked = await run(readTool, { policyState: 'blocked' });
      assert.equal(blocked.status, 'denied');
      assert.match(blocked.error!, /blocked for you/);
      assert.equal(server.seen.length, 0, 'a blocked tool sends nothing to the server');

      const asked = await run(readTool, { policyState: 'ask' });
      assert.equal(asked.status, 'requires_approval');
      assert.equal(server.seen.length, 0, 'an ask-first tool waits');
      const confirmed = await run(readTool, { policyState: 'ask', userConfirmationConfirmed: true });
      assert.equal(confirmed.status, 'success');

      const writeAllowed = await run(writeTool, { policyState: 'allow' });
      assert.equal(writeAllowed.status, 'success', 'an administrator who allows a write tool is obeyed');
      const writesBeforeReplay = server.seen.filter(call => call.method === 'tools/call').length;
      assert.equal((await run(writeTool, { policyState: 'allow' })).status, 'success');
      assert.equal(server.seen.filter(call => call.method === 'tools/call').length, writesBeforeReplay);
      const withoutLedger = await new CapabilityDispatcher({ mcpClients: poolFor(server.url) }).dispatch(writeTool, bindingFor(), { toolId: writeTool.toolId, input: {}, policyState: 'allow' } as any, { ...ctx, idempotencyKey: 'isolated-write-2' });
      assert.equal(withoutLedger.status, 'failure');
      assert.match(withoutLedger.error!, /Durable action receipts/);

      // Without a state the gate is what it always was: a write tool needs a confirmation, and the single-role rule applies.
      const legacy = await run(writeTool, {});
      assert.equal(legacy.status, 'requires_approval');
      const roleBinding = { ...bindingFor(), policy: { requiredRole: 'customer' } } as any;
      const roleDenied = await dispatcher.dispatch(readTool, roleBinding, { toolId: readTool.toolId, input: {} }, ctx);
      assert.equal(roleDenied.status, 'denied');
      const roleSkipped = await dispatcher.dispatch(readTool, roleBinding, { toolId: readTool.toolId, input: {}, policyState: 'allow' }, ctx);
      assert.equal(roleSkipped.status, 'success', 'when the group rules decided, the single-role rule does not apply');
    } finally { await server.close(); }
  });

  await test('the transport can be used on its own against a plain JSON server', async () => {
    const server = await startTestServer({ tools: {} });
    try {
      const transport = new HttpMcpTransport({ url: server.url });
      const client = new McpClient(transport, 'direct');
      assert.deepEqual(await client.listTools(META), []);
    } finally { await server.close(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
