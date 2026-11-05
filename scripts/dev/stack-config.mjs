import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

export const services = [
  ['sources', 'REAL_CONNECTORS_PORT', 4020],
  ['iq', 'JAX_IQ_SERVICE_PORT', 8088],
  ['authentication', 'AUTH_SERVICE_PORT', 8080],
  ['project', 'PROJECT_SERVICE_PORT', 8082],
  ['products', 'PRODUCT_SERVICE_PORT', 8083],
  ['runtime', 'JOURNEY_RUNTIME_PORT', 3012],
  ['commerce', 'AGENT_SERVICE_PORT', 3004],
  ['gateway', 'GATEWAY_PORT', 3010],
  ['organization', 'ORG_SERVICE_PORT', 8085],
  ['analytics', 'ANALYTICS_SERVICE_PORT', 8086],
];

// Vendor credentials belong only to the connector process, not the Next.js apps.
export const vendorKey = key => /^(SALESFORCE_|CTP_|COMMERCETOOLS_|ZENDESK_|SAP_|GA4_|GOOGLE_ANALYTICS_|POWER_BI_|POWERBI_)/.test(key);

export function developmentConfig(root, ambient = process.env) {
  const file = resolve(root, ambient.JOURNEYAX_ENV_FILE || '.env.development.local');
  if (!existsSync(file)) throw new Error('Missing .env.development.local. See docs/local-development.md; startup never prepares or publishes a release.');
  const profile = parse(readFileSync(file));
  const env = { ...ambient, ...profile, NODE_ENV: 'development', JOURNEYAX_ENV_FILE: file,
    AUTH_DEV_BYPASS: 'false', AGENT_TRACE_RESULTS: '0', NEXT_TELEMETRY_DISABLED: '1' };
  if (env.COMMERCE_ENVIRONMENT !== 'dev') throw new Error('npm run dev requires COMMERCE_ENVIRONMENT=dev.');
  if (!env.MONGODB_URI) throw new Error('The development MongoDB connection is required.');
  if (!env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || env.STRIPE_PUBLISHABLE_KEY && !env.STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_')) throw new Error('Local development requires Stripe test-mode keys.');
  if (env.REAL_CONNECTORS_ENVIRONMENT !== 'dev' || env.JAX_IQ_ENABLED !== '1') throw new Error('The connected DEV profile must explicitly enable IQ and DEV connectors.');
  const offset = Number(env.DEV_PORT_OFFSET || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000) throw new Error('Invalid DEV_PORT_OFFSET.');
  const ports = services.map(([name, key, base]) => {
    const port = Number(profile[key] || base + offset);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid development port for ${name}.`);
    env[key] = String(port);
    return { name, port };
  });
  ports.push({ name: 'Go', port: 3008 }, { name: 'back office', port: 3009 });
  if (new Set(ports.map(row => row.port)).size !== ports.length) throw new Error('Development services must have distinct ports.');
  const url = name => `http://127.0.0.1:${ports.find(row => row.name === name).port}`;
  Object.assign(env, {
    GATEWAY_URL: url('gateway'), AGENT_SERVICE_URL: url('commerce'), AGENT_URL: url('commerce'),
    AUTH_SERVICE_URL: url('authentication'), AUTH_API: url('authentication'),
    PROJECT_SERVICE_URL: url('project'), PROJECT_API: url('project'),
    PRODUCT_SERVICE_URL: url('products'), PRODUCT_API: url('products'),
    JOURNEY_RUNTIME_SERVICE_URL: url('runtime'), JOURNEY_RUNTIME_URL: url('runtime'), RUNTIME_SERVICE_URL: url('runtime'),
    JAX_IQ_SERVICE_URL: url('iq'), ORG_SERVICE_URL: url('organization'), ORG_API: url('organization'),
    ANALYTICS_SERVICE_URL: url('analytics'), CONNECTOR_MCP_BASE_URL: url('sources'),
    STOREFRONT_URL: 'http://localhost:3008', STOREFRONT_PUBLIC_ORIGIN: 'http://localhost:3008',
    NEXT_PUBLIC_AUTH_API: url('authentication'), NEXT_PUBLIC_COMMERCE_ENVIRONMENT: 'dev',
    JOURNEYAX_CONNECTORS_ENV_FILE: resolve(root, env.JOURNEYAX_CONNECTORS_ENV_FILE || '.env.connectors.local'),
  });
  if (!existsSync(env.JOURNEYAX_CONNECTORS_ENV_FILE)) throw new Error('Missing local connector credentials file. See docs/local-development.md.');
  // Preserve the release-bound connector URLs. Refuse stale routing instead of silently changing bindings.
  const sources = JSON.parse(env.CONNECTOR_MCP_SERVERS || '{}');
  if (!Object.keys(sources).length || Object.values(sources).some(value => typeof value !== 'string' || !value.startsWith(`${url('sources')}/mcp/`))) throw new Error('DEV connector routes must point to the configured local source port.');
  for (const key of Object.keys(env)) if (vendorKey(key)) delete env[key];
  delete env.PORT; // A shared PORT would make every backend collide.
  return { env, ports };
}
