import './setup/no-world';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { InProcessMcpTransport, McpClient, type McpRequestMeta } from '@journeyax/capability-sdk';
import { ConnectorsSchema, connectorToolState } from '@journeyax/business-pack';
import * as jaxIq from '@journeyax/jax-iq';
import { SampleConnectorServer } from '../../connectors-sample/src/server';

/**
 * The skeleton works end to end without touching anything outside the process: a sample connector answers in the same process, the real
 * MCP client reaches it, the shared packages load from this worktree's source, and the no-world guard is on.
 */
const suite = createSuite('jax-iq: the skeleton and the no-world guard');

const TENANT = 'placemakers';
const WORKTREE = path.resolve(__dirname, '../../..');
const SRC = path.resolve(__dirname, '../src');
const meta: McpRequestMeta = { tenantId: TENANT, environmentId: 'dev', correlationId: 'corr-smoke' };
const MODULES = ['model', 'dictionary', 'keys', 'rules', 'plan', 'shape', 'exec', 'merge', 'freshness', 'errors', 'audit', 'ports', 'contracts', 'signals', 'scope', 'query'];

/** A sample connector server that is only ever called through `handle`: it never listens. */
const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });

const callBalance = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'account_balance', arguments: { accountId: 'ACC-0001' } } });

async function main() {
  await suite.test('the sample ERP answers account_balance for ACC-0001 in the same process, with no listener', async () => {
    const answer: any = await server.handle('ace-erp', TENANT, callBalance(1));
    assert.equal(answer.id, 1);
    assert.equal(answer.result.isError, undefined);
    const payload = answer.result.structuredContent;
    assert.equal(payload.ok, true);
    assert.equal(payload.connector, 'ace-erp');
    assert.equal(payload.record.accountId, 'ACC-0001');
    assert.deepEqual(JSON.parse(answer.result.content[0].text), payload, 'the text and the structured answer agree');
  });

  await suite.test('the real MCP client reaches the same server over the in-process transport and gets the same payload', async () => {
    const direct: any = await server.handle('ace-erp', TENANT, callBalance(1));
    const transport = new InProcessMcpTransport((message) => server.handle('ace-erp', TENANT, message as any) as any);
    const client = new McpClient(transport, 'ace-erp');
    try {
      const tools = await client.listTools(meta);
      assert.equal(tools.find((tool) => tool.name === 'account_balance')?.annotations?.readOnlyHint, true);
      const out = await client.callTool('account_balance', { accountId: 'ACC-0001' }, meta);
      assert.equal(out.isError, false);
      assert.equal(out.truncated, false);
      assert.deepEqual(out.data, direct.result.structuredContent);
    } finally {
      await client.close();
    }
  });

  await suite.test('@journeyax/business-pack loads through paths and connectorToolState reads a connector table', () => {
    // A table made up for this test.
    const table = ConnectorsSchema.parse({
      connectors: [{ connectorId: 'ace-erp', displayName: 'ERP', description: 'Accounts and balances.', owner: 'Test owner', sample: true, tools: [{ name: 'account_balance' }] }],
      policy: [{ connectorId: 'ace-erp', tool: 'account_balance', audience: 'staff', groups: ['test-team'], state: 'allow' }],
    });
    assert.deepEqual(connectorToolState(table, 'ace-erp', 'account_balance', { audience: 'staff', groups: ['test-team'] }), { state: 'allow', known: true, via: 'tool' });
    assert.deepEqual(connectorToolState(table, 'ace-erp', 'account_balance', { audience: 'staff', groups: ['other-team'] }), { state: 'blocked', known: true, via: 'none' });
    assert.deepEqual(connectorToolState(table, 'ace-erp', 'account_balance', { audience: 'shopper', groups: [] }), { state: 'blocked', known: true, via: 'none' });
    assert.deepEqual(connectorToolState(table, 'ace-erp', 'no_such_tool', { audience: 'staff', groups: ['test-team'] }), { state: 'blocked', known: false, via: 'none' });
    assert.deepEqual(connectorToolState(table, 'no-such-connector', 'account_balance', { audience: 'staff', groups: ['test-team'] }), { state: 'blocked', known: false, via: 'none' });
  });

  await suite.test('the shared packages load from this worktree\'s source, including the imports made inside the SDK', () => {
    const loaded = Object.keys(require.cache);
    for (const name of ['business-pack', 'capability-sdk', 'shared-types', 'test-support']) {
      const folder = path.join(WORKTREE, 'packages', name) + path.sep;
      assert.ok(loaded.some((file) => file.startsWith(path.join(folder, 'src') + path.sep)), `${name} loaded from this worktree's src`);
      const elsewhere = loaded.filter((file) => file.includes(`${path.sep}packages${path.sep}${name}${path.sep}`) && !file.startsWith(folder));
      assert.deepEqual(elsewhere, [], `${name} was also loaded from somewhere else`);
    }
    const sdkSecrets = require.cache[path.join(WORKTREE, 'packages/capability-sdk/src/mcp/secrets.ts')];
    assert.ok(sdkSecrets, 'the SDK file that imports @journeyax/business-pack is loaded');
    assert.ok(
      sdkSecrets.children.some((child) => child.filename.startsWith(path.join(WORKTREE, 'packages/business-pack/src') + path.sep)),
      'the SDK\'s own import of @journeyax/business-pack resolved to this worktree',
    );
  });

  await suite.test('the test tsconfig maps the six shared packages to source folders of this worktree', () => {
    const file = path.join(__dirname, 'tsconfig.json');
    const paths: Record<string, string[]> = JSON.parse(readFileSync(file, 'utf8')).compilerOptions.paths;
    assert.deepEqual(Object.keys(paths).sort(), [
      '@journeyax/business-pack', '@journeyax/capability-sdk', '@journeyax/jax-iq', '@journeyax/knowledge', '@journeyax/shared-types', '@journeyax/test-support',
    ]);
    for (const [name, targets] of Object.entries(paths)) {
      assert.equal(targets.length, 1, name);
      const folder = path.resolve(path.dirname(file), targets[0]);
      assert.ok(folder.startsWith(WORKTREE + path.sep), `${name} points inside this worktree`);
      assert.ok(existsSync(path.join(folder, 'index.ts')), `${name} points at a folder with an index.ts`);
    }
    assert.equal(path.resolve(path.dirname(file), paths['@journeyax/jax-iq'][0]), SRC);
  });

  await suite.test('@journeyax/jax-iq resolves, and the sixteen module stubs are in place and re-exported', () => {
    assert.equal(typeof jaxIq, 'object');
    const entry = readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    for (const name of MODULES) {
      assert.ok(existsSync(path.join(SRC, name, 'index.ts')), `${name}/index.ts exists`);
      assert.ok(entry.includes(`export * from './${name}';`), `src/index.ts re-exports ${name}`);
    }
  });

  await suite.test('the guard is on: fetch throws and a socket cannot connect', () => {
    assert.throws(() => fetch('http://127.0.0.1:1/'), /no-world guard/);
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    assert.throws(() => socket.connect(1, '127.0.0.1'), /no-world guard/);
    socket.destroy();
    assert.throws(() => net.createConnection(1, '127.0.0.1').on('error', () => undefined), /no-world guard/);
  });

  await suite.test('a database or key variable set before the guard is imported is gone after it, and an ordinary one stays', () => {
    const guard = require.resolve('./setup/no-world');
    const set = { MONGODB_URI: 'test-only', TEST_MONGODB_URI: 'test-only', INTERNAL_API_KEY: 'test-only', CONNECTOR_MCP_SERVERS: 'test-only', JAX_IQ_ENABLED: '1' };
    Object.assign(process.env, set);
    try {
      delete require.cache[guard];
      require('./setup/no-world');
      for (const name of ['MONGODB_URI', 'TEST_MONGODB_URI', 'INTERNAL_API_KEY', 'CONNECTOR_MCP_SERVERS']) assert.equal(process.env[name], undefined, name);
      assert.equal(process.env.JAX_IQ_ENABLED, '1');
    } finally {
      for (const name of Object.keys(set)) delete process.env[name];
    }
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
