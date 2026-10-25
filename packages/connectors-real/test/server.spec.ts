import assert from 'node:assert/strict';
import { RealConnectorServer } from '../src/server';
import { createRealConnectors } from '../src/index';
import { ToolError, type RealConnector } from '../src/types';
import { suite } from './helpers';

const KEY = 'real-connectors-bearer-key-123';

/** A tiny connector that does what the test says, so the server's own behaviour can be seen without any vendor. */
const fake = (run: (args: any) => Promise<any>, connected = true): RealConnector => ({
  connectorId: 'fake', title: 'Fake', description: 'A fake system.', required: ['FAKE_SETTING'], missing: () => (connected ? [] : ['FAKE_SETTING']),
  tools: [{ name: 'echo', description: 'Echoes.', readOnly: true, inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 10 }, count: { type: 'integer', minimum: 1, maximum: 5 } } }, run }],
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-tenant-id': 'placemakers', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

const t = suite('connectors-real: the MCP server');

async function main() {
  const warnings: string[] = [];
  const server = new RealConnectorServer({ connectors: [fake(async (args) => ({ echoed: args.text })), { ...fake(async () => ({}), false), connectorId: 'offline' }, { ...fake(async () => { throw new Error('boom: secret-token-xyz at /private/path'); }), connectorId: 'broken' }, { ...fake(async () => { throw new ToolError('not_found', 'No such thing.'); }), connectorId: 'missing-thing' }], apiKey: KEY, warn: (message) => warnings.push(message) });
  const base = await server.listen(0);

  await t.test('it answers the MCP handshake and lists a connector\'s tools with their read-only hints', async () => {
    const init: any = await (await post(base, '/mcp/fake', rpc('initialize'))).json();
    assert.equal(init.result.serverInfo.name, 'real-fake');
    assert.equal(init.result.instructions, 'A fake system.');
    const tools: any = await (await post(base, '/mcp/fake', rpc('tools/list'))).json();
    assert.equal(tools.result.tools[0].name, 'echo');
    assert.deepEqual(tools.result.tools[0].annotations, { readOnlyHint: true });
    assert.deepEqual(((await (await post(base, '/mcp/fake', rpc('ping'))).json()) as any).result, {});
  });

  await t.test('a notification gets no answer body (202), and an unknown method or connector is a JSON-RPC error', async () => {
    assert.equal((await post(base, '/mcp/fake', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal(((await (await post(base, '/mcp/fake', rpc('nope'))).json()) as any).error.code, -32601);
    assert.equal(((await (await post(base, '/mcp/ghost', rpc('tools/list'))).json()) as any).error.code, -32004);
  });

  await t.test('a tool call returns the result as text and as structured content, with the connector id added', async () => {
    const answer: any = await (await post(base, '/mcp/fake', rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }))).json();
    assert.deepEqual(answer.result.structuredContent, { ok: true, connector: 'fake', echoed: 'hi' });
    assert.deepEqual(JSON.parse(answer.result.content[0].text), { ok: true, connector: 'fake', echoed: 'hi' });
    assert.equal(answer.result.isError, undefined);
  });

  await t.test('arguments are checked against the tool\'s schema before the tool runs', async () => {
    let ran = 0;
    const local = new RealConnectorServer({ connectors: [fake(async () => { ran++; return {}; })] });
    for (const args of [{}, { text: 5 }, { text: 'far too long for this' }, { text: 'ok', count: 9 }, { text: 'ok', count: 1.5 }]) {
      const answer: any = await local.handle('fake', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: args } });
      assert.equal(answer.result.isError, true, JSON.stringify(args));
      assert.equal(JSON.parse(answer.result.content[0].text).error.code, 'invalid_arguments');
    }
    assert.equal(ran, 0);
    assert.equal(((await local.handle('fake', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } })) as any).error.code, -32602);
  });

  await t.test('a failure the tool names reaches the model as it is; any other failure is hidden and only logged briefly', async () => {
    const named: any = await (await post(base, '/mcp/missing-thing', rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }))).json();
    assert.deepEqual(JSON.parse(named.result.content[0].text), { ok: false, connector: 'missing-thing', error: { code: 'not_found', message: 'No such thing.' } });
    const hidden: any = await (await post(base, '/mcp/broken', rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }))).json();
    const text = hidden.result.content[0].text as string;
    assert.equal(JSON.parse(text).error.code, 'internal_error');
    assert.ok(!text.includes('secret-token-xyz') && !text.includes('/private/path'), 'what went wrong inside is not shown to the model');
    assert.equal(warnings.length, 1);
  });

  await t.test('a connector that is not set up is served but offers no tools, and a call says it is not connected', async () => {
    assert.deepEqual(((await (await post(base, '/mcp/offline', rpc('tools/list'))).json()) as any).result.tools, []);
    const answer: any = await (await post(base, '/mcp/offline', rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }))).json();
    assert.equal(JSON.parse(answer.result.content[0].text).error.code, 'not_connected');
    assert.ok(((await (await post(base, '/mcp/offline', rpc('initialize'))).json()) as any).result.instructions.endsWith('Not connected yet.'));
  });

  await t.test('without the bearer key the server refuses, even to say what it offers', async () => {
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong-key-123456789012345678' }, { authorization: 'Basic abc' }]) {
      const response = await post(base, '/mcp/fake', rpc('tools/list'), headers);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
  });

  await t.test('every request names a tenant, and only the tenants the server was started for are answered', async () => {
    assert.equal((await post(base, '/mcp/fake', rpc('tools/list'), { 'x-tenant-id': '' })).status, 400);
    assert.equal((await post(base, '/mcp/fake', rpc('tools/list'), { 'x-tenant-id': 'someone-else' })).status, 403);
    assert.equal((await post(base, '/mcp/fake', rpc('tools/list'), { 'x-tenant-id': 'placemakers' })).status, 200);
  });

  await t.test('bad input is refused: not JSON, a body that is too large, a wrong path or verb', async () => {
    assert.equal((await post(base, '/mcp/fake', '{not json')).status, 400);
    assert.equal((await post(base, '/mcp/fake', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(300 * 1024) }))).status, 413);
    assert.equal((await fetch(`${base}/mcp/fake`, { headers: { authorization: `Bearer ${KEY}` } })).status, 405);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
    assert.equal((await post(base, '/mcp/Fake_1', rpc('ping'))).status, 404, 'a connector name is lower-case letters, digits and dashes only');
  });

  await t.test('the health page says which connectors are connected and which settings are missing (names only), without needing the key', async () => {
    const health: any = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(health.connectors.find((entry: any) => entry.id === 'offline'), { id: 'offline', connected: false, missing: ['FAKE_SETTING'] });
    assert.deepEqual(health.connectors.find((entry: any) => entry.id === 'fake'), { id: 'fake', connected: true });
  });

  await server.close();

  await t.test('the four real connectors are all there, named as the pack names them, and none is connected without settings', async () => {
    const connectors = createRealConnectors({});
    assert.deepEqual(connectors.map((connector) => connector.connectorId), ['commercetools', 'salesforce', 'google-analytics', 'power-bi']);
    assert.ok(connectors.every((connector) => connector.missing().length > 0));
    const all = new RealConnectorServer({ connectors });
    const health = all.health() as any;
    assert.equal(health.connectors.every((entry: any) => entry.connected === false && Array.isArray(entry.missing)), true);
    assert.equal(JSON.stringify(health).includes('SECRET'), true, 'setting names are listed so the owner knows what to fill in');
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
