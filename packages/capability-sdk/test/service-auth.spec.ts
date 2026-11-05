import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudServiceHeaders } from '../src/mcp/service-auth';
import { McpClientPool } from '../src/mcp/pool';
import { StaticMcpServerDirectory } from '../src/mcp/directory';

test('private hosted calls use the exact audience and keep application Authorization separate', async () => {
  const audiences: string[] = [];
  const headers = createCloudServiceHeaders({ token: async audience => { audiences.push(audience); return 'fixture-identity-token'; }, env: () => ({ NODE_ENV: 'production' }) });
  assert.deepEqual(await headers('http://127.0.0.1:4020/mcp/crm'), {});
  assert.deepEqual(await headers('https://vendor.example/api'), {});
  const identity = await headers('https://iq-test.run.app/api/v1/test');
  assert.deepEqual(audiences, ['https://iq-test.run.app']); assert.equal(identity.Authorization, undefined);
  assert.equal(identity['X-Serverless-Authorization'], 'Bearer fixture-identity-token');
  await assert.rejects(() => headers('http://iq-test.run.app/'), /secure service origin/);
  await assert.rejects(() => headers('https://user:password@iq-test.run.app/'), /secure service origin/);
});

test('a missing hosted identity and a production bypass fail closed', async () => {
  const production = createCloudServiceHeaders({ token: async () => 'fixture-identity-token', env: () => ({ NODE_ENV: 'production', DISABLE_GCP_AUTH: 'true' }) });
  await assert.rejects(() => production('https://iq-test.run.app/'), /cannot be disabled/);
  const invalid = createCloudServiceHeaders({ token: async () => '', env: () => ({ NODE_ENV: 'production' }) });
  await assert.rejects(() => invalid('https://iq-test.run.app/'), /no usable identity/);
});

test('MCP retains both identities and scrubs either credential if a source echoes it', async () => {
  const seen: Record<string, string>[] = [];
  const pool = new McpClientPool({ directory: new StaticMcpServerDirectory({ source: 'https://source-test.run.app/mcp/crm' }), secrets: { resolve: async () => 'fixture-connection-secret' }, serviceHeaders: async () => ({ 'X-Serverless-Authorization': 'Bearer fixture-cloud-identity' }), fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); const headers = init?.headers as Record<string, string>; seen.push(headers);
    const result = request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : { content: [{ type: 'text', text: JSON.stringify({ cloud: headers['X-Serverless-Authorization'], application: headers.Authorization }) }] };
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  } });
  try {
    const client = await pool.getClient('source', { tenantId: 'tenant-a', environmentId: 'test', secretRef: 'tenant-secret://tenant-a/test/source' });
    const result = await client.callTool('read_record', {}, { tenantId: 'tenant-a', environmentId: 'test' });
    assert.equal(seen.at(-1)?.Authorization, 'Bearer fixture-connection-secret');
    assert.equal(seen.at(-1)?.['X-Serverless-Authorization'], 'Bearer fixture-cloud-identity');
    assert.doesNotMatch(JSON.stringify(result), /fixture-cloud-identity|fixture-connection-secret/);
  } finally { await pool.closeAll(); }
});
