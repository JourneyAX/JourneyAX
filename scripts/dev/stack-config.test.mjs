import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentConfig, vendorKey } from './stack-config.mjs';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'journeyax-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { COMMERCE_ENVIRONMENT: 'dev', REAL_CONNECTORS_ENVIRONMENT: 'dev',
    JAX_IQ_ENABLED: '1', MONGODB_URI: 'mongodb://unused', STRIPE_SECRET_KEY: 'sk_test_unused',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_unused', DEV_PORT_OFFSET: '100',
    CONNECTOR_MCP_SERVERS: '{"crm":"http://127.0.0.1:4120/mcp/salesforce"}', ...overrides };
  writeFileSync(join(root, '.env.development.local'), Object.entries(profile).map(([key, value]) => `${key}='${value}'`).join('\n'));
  writeFileSync(join(root, '.env.connectors.local'), "SALESFORCE_CLIENT_SECRET='unused'\n");
  return root;
}

test('one DEV profile routes both UIs and every backend coherently; source credentials remain private', t => {
  const { env, ports } = developmentConfig(fixture(t), { PORT: '9999', CTP_CLIENT_SECRET: 'unused' });
  assert.equal(env.GATEWAY_URL, 'http://127.0.0.1:3110');
  assert.equal(env.AUTH_SERVICE_PORT, '8180');
  assert.equal(env.JOURNEY_RUNTIME_PORT, '3112');
  assert.equal(env.ORG_SERVICE_URL, 'http://127.0.0.1:8185');
  assert.equal(env.STOREFRONT_URL, 'http://localhost:3008');
  assert.equal(env.NEXT_PUBLIC_COMMERCE_ENVIRONMENT, 'dev');
  assert.equal(env.PORT, undefined);
  assert.equal(env.AUTH_DEV_BYPASS, 'false');
  assert.equal(Object.keys(env).some(vendorKey), false);
  assert.equal(ports.length, 12);
  assert.equal(new Set(ports.map(row => row.port)).size, ports.length);
});

test('production, live payments, disabled IQ, stale source routes and colliding ports are refused before starting anything', t => {
  for (const overrides of [
    { COMMERCE_ENVIRONMENT: 'production' }, { REAL_CONNECTORS_ENVIRONMENT: 'production' },
    { STRIPE_SECRET_KEY: 'sk_live_unused' }, { STRIPE_PUBLISHABLE_KEY: 'pk_live_unused' },
    { JAX_IQ_ENABLED: '0' }, { CONNECTOR_MCP_SERVERS: '{"crm":"https://example.invalid/mcp/salesforce"}' },
    { GATEWAY_PORT: '3008' }, { DEV_PORT_OFFSET: 'invalid' },
  ]) assert.throws(() => developmentConfig(fixture(t, overrides), {}));
});
