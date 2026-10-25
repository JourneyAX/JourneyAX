import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpClientPool, StaticMcpServerDirectory } from '@journeyax/capability-sdk';
import { ModelGateway, type AgentExecutionRequest } from '../src/kernel/model.gateway';
import { AgentTurnLoop } from '../src/agent/agent-loop';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { ApprovalService } from '../src/kernel/approval.service';
import { ApprovalStore } from '../src/approval/approval.store';
import { RealConnectorServer, commercetools, googleAnalytics, salesforce } from '../../../packages/connectors-real/src/index';
import { mockVendor, realDeps } from '../../../packages/connectors-real/test/helpers';
import { connectorPack, workspace } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

/**
 * The real path, with a scripted model and pretend vendors: the agent loop offers a person the connectors their team may use, loads one
 * system's tools from the real connector server over MCP, and a call travels through the pack's rules and the MCP client to the real
 * server and on to the vendor's API (a pretend commercetools, Salesforce and Google Analytics here). The registry and the rules are the
 * current draft pack's own, so this is the test that the pack, the runtime and the real server fit together.
 */
const TENANT = 'placemakers';
const ENVIRONMENT = 'production';
const KEY = 'e2e-real-connectors-key-6c1f0a9d2b7e4c35';
const VENDOR_SECRET = 'vendor-client-secret-never-seen-by-the-model-77';
const DRAFT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
// The pack as published switches the real systems on one at a time, as each vendor account is ready. This test is about all four fitting
// together, so it works on a copy of the draft's connectors with all four on.
const REAL_IDS = ['commercetools', 'salesforce', 'google-analytics', 'power-bi'];
const ALL_REAL_ON = { ...DRAFT.extensions.connectors, connectors: DRAFT.extensions.connectors.connectors.map((c: any) => (REAL_IDS.includes(c.connectorId) ? { ...c, enabled: true } : c)) };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

let server: RealConnectorServer;
let gateway: CapabilityGateway;
let approvals: ApprovalService;
const audit: any[] = [];
let shop: Awaited<ReturnType<typeof mockVendor>>;
let analytics: Awaited<ReturnType<typeof mockVendor>>;
let crm: Awaited<ReturnType<typeof mockVendor>>;
let shopBroken = false;
const cartLines: any[] = [{ id: 'li-1', name: { en: 'Combo kit' }, quantity: 1, variant: { sku: '5009059' }, price: { value: { currencyCode: 'NZD', centAmount: 60901, fractionDigits: 2 } }, totalPrice: { currencyCode: 'NZD', centAmount: 60901, fractionDigits: 2 } }];
const CART = '3f2a8c1e-0b7d-4c59-9d6e-5a1b2c3d4e5f';
const cart = (version: number) => ({ id: CART, version, cartState: 'Active', lineItems: cartLines, totalPrice: { currencyCode: 'NZD', centAmount: 60901 * cartLines.length, fractionDigits: 2 } });
let cartVersion = 1;

type Step = (req: AgentExecutionRequest, round: number) => { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }> };

before(async () => {
  shop = await mockVendor((request) => {
    if (request.path === '/oauth/token') return { json: { access_token: 'ct-token', expires_in: 3600 } };
    if (shopBroken) return { status: 503, json: { message: 'upstream down' } };
    if (request.path.endsWith('/product-projections/search')) return { json: { total: 1, count: 1, results: [{ id: 'p1', name: { en: 'Cordless combo kit' }, masterVariant: { sku: '5009059', prices: [{ value: { currencyCode: 'NZD', centAmount: 60901, fractionDigits: 2 } }] }, variants: [] }] } };
    if (request.path === `/shop/carts/${CART}` && request.method === 'GET') return { json: cart(cartVersion) };
    if (request.path === `/shop/carts/${CART}` && request.method === 'POST') {
      cartLines.push({ id: `li-${cartLines.length + 1}`, name: { en: 'Added' }, quantity: request.body.actions[0].quantity, variant: { sku: request.body.actions[0].sku }, price: { value: { currencyCode: 'NZD', centAmount: 1000, fractionDigits: 2 } }, totalPrice: { currencyCode: 'NZD', centAmount: 1000, fractionDigits: 2 } });
      cartVersion++;
      return { json: cart(cartVersion) };
    }
    return undefined;
  });
  analytics = await mockVendor((request) => {
    if (request.path === '/token') return { json: { access_token: 'ga-token', expires_in: 3599 } };
    if (request.path.endsWith(':runReport')) return { json: { dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }], rowCount: 1, rows: [{ dimensionValues: [{ value: '20261024' }], metricValues: [{ value: '310' }, { value: '250' }, { value: '12' }] }] } };
    return undefined;
  });
  crm = await mockVendor((request) => (request.path === '/services/oauth2/token' ? { json: { access_token: 'sf-token' } } : { json: { totalSize: 0, records: [] } }));

  const env = {
    COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_CLIENT_ID: 'c', COMMERCETOOLS_CLIENT_SECRET: VENDOR_SECRET, COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: shop.url, COMMERCETOOLS_AUTH_URL: shop.url,
    GA4_PROPERTY_ID: '1234', GA4_API_URL: analytics.url, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${analytics.url}/token` }),
    SALESFORCE_INSTANCE_URL: crm.url, SALESFORCE_CLIENT_ID: 'sf', SALESFORCE_CLIENT_SECRET: VENDOR_SECRET,
  };
  const deps = realDeps();
  server = new RealConnectorServer({ connectors: [commercetools(env, deps), googleAnalytics(env, deps), salesforce(env, deps)], tenants: [TENANT], apiKey: KEY, warn: () => {} });
  const base = await server.listen(0);
  const pool = new McpClientPool({
    directory: new StaticMcpServerDirectory(Object.fromEntries(server.connectorIds().map((id) => [id, `${base}/mcp/${id}`]))),
    secrets: { resolve: async () => KEY },
    nodeEnv: 'test',
  });
  gateway = new CapabilityGateway({ mcpClients: pool, connectorAudit: (event) => audit.push(event) });
  approvals = new ApprovalService(new ApprovalStore({ explicitMemory: true }));
});
after(async () => { await server.close(); await shop.close(); await analytics.close(); await crm.close(); });

const agents = DRAFT.agents.map((a: any) => ({ ...a, modelPolicyRef: 'default' }));
const release = () => {
  const pack: any = connectorPack(ALL_REAL_ON, { tenantId: TENANT, environmentId: ENVIRONMENT, agents });
  // The plugins and who has them are the draft's own, so a connector a plugin names is the person's only if they have that plugin.
  pack.extensions = { ...pack.extensions, plugins: DRAFT.extensions.plugins, agentAccess: DRAFT.extensions.agentAccess };
  return pack;
};

async function turn(steps: Step[], who: { role?: string; groups?: string[]; agentId?: string; message?: string; workspace?: any; customerEvent?: any } = {}) {
  const model = new ModelGateway();
  const requests: AgentExecutionRequest[] = [];
  const toolResults: any[] = [];
  let round = 0;
  model.mockAgentExecutor = async (req, onDelta) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    for (const message of req.messages) if (message.role === 'tool' && !toolResults.some((r) => r.id === message.tool_call_id)) toolResults.push({ id: message.tool_call_id, name: message.name, body: JSON.parse(String(message.content)) });
    const out = steps[Math.min(round, steps.length - 1)](req, round++);
    if (out.content) onDelta?.(out.content);
    return { content: out.content ?? '', toolCalls: out.toolCalls ?? [] };
  };
  const events: any[] = [];
  const outcome = await new AgentTurnLoop().execute({
    command: {
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-real', sessionId: 'sess-real', correlationId: `corr-real-${Math.random().toString(16).slice(2, 8)}`,
      message: who.message ?? 'Hello', principalId: who.role ? 'person-1' : undefined, principalRole: who.role, principalGroups: who.groups, agentId: who.agentId ?? 'placemakers_product_advisor',
      ...(who.customerEvent ? { customerEvent: who.customerEvent } : {}),
    } as any,
    release: release(),
    workspace: who.workspace ?? workspace(TENANT, ENVIRONMENT),
    modelGateway: model,
    catalogSearchHandler: { execute: async () => ({ products: [] }) } as any,
    capabilityGateway: gateway,
    approvalService: approvals as any,
    sink: (event, data) => events.push({ event, data }),
  });
  return { outcome, requests, toolResults, events, reply: outcome.turnResult.assistantMessage };
}

const call = (id: string, name: string, args: Record<string, any>) => ({ id, name, arguments: args });
const tools = (req: AgentExecutionRequest) => (req.tools ?? []).map((t) => t.name);
const people = {
  admin: { role: 'admin', groups: ['administrators'] },
  sales: { role: 'operator', groups: ['sales'] },
  marketing: { role: 'operator', groups: ['marketing'] },
  insights: { role: 'operator', groups: ['insights'] },
};
const menu = async (who: { role?: string; groups?: string[] }) => {
  const { toolResults } = await turn([() => ({ toolCalls: [call('l', 'list_connectors', {})] }), () => ({ content: 'ok' })], who);
  return toolResults[0].body.connectors as Array<{ connector: string; sample?: boolean }>;
};
const vendorWrites = () => shop.seen.filter((request) => request.method === 'POST' && request.path.includes('/carts/')).length;

describe('The real connectors, end to end with a scripted model and pretend vendors', () => {
  test('each person is offered the systems their team may use: the real ones carry no sample label, the parked ones are never offered', async () => {
    const names = async (who: any) => (await menu(who)).map((entry) => entry.connector).sort();
    assert.deepEqual(await names(people.sales), ['commercetools', 'marketing-cloud', 'salesforce']);
    assert.deepEqual(await names(people.marketing), ['commercetools', 'google-analytics', 'marketing-cloud', 'power-bi', 'salesforce']);
    assert.deepEqual(await names(people.insights), ['google-analytics', 'power-bi']);
    assert.deepEqual(await names(people.admin), ['commercetools', 'google-analytics', 'marketing-cloud', 'power-bi', 'salesforce']);
    const sales = await menu(people.sales);
    assert.equal(sales.find((entry) => entry.connector === 'commercetools')!.sample, false);
    assert.equal(sales.find((entry) => entry.connector === 'marketing-cloud')!.sample, true, 'Marketing Cloud is still sample data, and says so');
    for (const parked of ['sap-commerce', 'ace-erp', 'mulesoft', 'salsify', 'bloomreach', 'uxcam', 'location']) assert.ok(!(await names(people.admin)).includes(parked), parked);
  });

  test('on the default assistant a member of staff can use their connectors: it names the three connector tools, and a shopper is offered none of them', async () => {
    const staff = await turn([() => ({ content: 'Hi.' })], people.sales);
    assert.deepEqual(tools(staff.requests[0]).filter((name) => /connector/.test(name)).sort(), ['call_connector_tool', 'get_connector_tools', 'list_connectors']);
    assert.match(staff.requests[0].systemPrompt ?? '', /# Connectors you can use/);
    const shopper = await turn([() => ({ content: 'Hi.' })]);
    assert.ok(!tools(shopper.requests[0]).some((name) => /connector/.test(name)), 'no connector tool for a shopper');
    assert.ok(!(shopper.requests[0].systemPrompt ?? '').includes('Connectors you can use'));
  });

  test('a read goes from the chat through the pack\'s rules and the MCP client to the real server and on to the vendor, and the answer comes back real-shaped', async () => {
    const { toolResults, outcome } = await turn([
      () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'commercetools', query: 'product' })] }),
      () => ({ toolCalls: [call('c2', 'call_connector_tool', { connector: 'commercetools', tool: 'find_product', arguments: { query: 'cordless drill', limit: 1 }, tenantId: 'someone-else' })] }),
      () => ({ content: 'Found it.' }),
    ], people.sales);
    const [loaded, found] = toolResults.map((r) => r.body);
    assert.ok(loaded.tools.map((tool: any) => tool.name).includes('find_product'));
    assert.equal(found.ok, true);
    assert.equal(found.sample, false);
    assert.equal(found.notice, undefined, 'no sample-data notice on a real system');
    assert.equal(found.result.records[0].sku, '5009059');
    assert.equal(found.result.records[0].name, 'Cordless combo kit');
    assert.equal(found.result.records[0].price, 609.01);
    const search = shop.seen.find((request) => request.path.endsWith('/product-projections/search'))!;
    assert.equal(search.query.get('text.en'), 'cordless drill');
    assert.equal(search.headers.authorization, 'Bearer ct-token', 'the vendor was asked with the connector\'s own sign-in, not anything from the chat');
    assert.ok(outcome.toolsCalled.every((tool) => tool.ok));
  });

  test('a write asks first on a card: nothing reaches the vendor until the person taps Allow, then the vendor really gets the one call', async () => {
    const shared = workspace(TENANT, ENVIRONMENT);
    const before = vendorWrites();
    const args = { cartId: CART, sku: '5009060', quantity: 2 };
    const asked = await turn([() => ({ toolCalls: [call('w1', 'call_connector_tool', { connector: 'commercetools', tool: 'add_to_cart', arguments: args })] }), () => ({ content: 'Please allow that.' })], { ...people.sales, workspace: shared });
    const held = asked.toolResults[0].body;
    assert.equal(held.status, 'needs_confirmation');
    assert.equal(vendorWrites(), before, 'nothing was sent to the vendor');
    assert.ok(asked.outcome.turnResult.uiInstructions?.some((card) => card.component === 'confirm'), 'the person sees the Yes/No card');
    await turn([() => ({ content: 'Added.' })], { ...people.sales, workspace: shared, message: '', customerEvent: { type: 'confirmTool', payload: { confirmationId: held.confirmationId, decision: 'allow' } } });
    assert.equal(vendorWrites(), before + 1, 'the kept call ran, once');
    const write = shop.seen.filter((request) => request.method === 'POST' && request.path.includes('/carts/')).pop()!;
    assert.deepEqual(write.body.actions, [{ action: 'addLineItem', sku: '5009060', quantity: 2 }]);
  });

  test('a tool the person\'s team may not use is blocked before anything is sent: not listed, not callable, and the vendor never hears of it', async () => {
    const before = { analytics: analytics.seen.length, crm: crm.seen.length, shop: shop.seen.length };
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'salesforce' }), call('c2', 'call_connector_tool', { connector: 'salesforce', tool: 'create_case', arguments: { accountId: '0015g00000AbCdEfGh', subject: 'x' } }), call('c3', 'call_connector_tool', { connector: 'google-analytics', tool: 'daily_traffic', arguments: {} })] }),
      () => ({ content: 'ok' }),
    ], people.sales);
    const [loaded, createCase, traffic] = toolResults.map((r) => r.body);
    assert.ok(!loaded.tools.map((tool: any) => tool.name).includes('create_case'), 'sales do not even see create_case');
    assert.equal(createCase.status, 'blocked');
    assert.equal(traffic.ok, false, 'a system the team cannot use at all is not available');
    assert.equal(crm.seen.length + analytics.seen.length, before.crm + before.analytics, 'neither vendor was contacted');
    assert.equal(shop.seen.length, before.shop);
  });

  test('the marketing team reads web traffic through the real server, and cannot read carts or orders', async () => {
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'google-analytics', tool: 'daily_traffic', arguments: { limit: 1 } }), call('c2', 'call_connector_tool', { connector: 'commercetools', tool: 'get_cart', arguments: { cartId: CART } })] }),
      () => ({ content: 'ok' }),
    ], people.marketing);
    const [traffic, blocked] = toolResults.map((r) => r.body);
    assert.equal(traffic.ok, true);
    assert.deepEqual(traffic.result.records[0], { date: '2026-10-24', sessions: 310, visitors: 250, conversions: 12 });
    assert.equal(blocked.status, 'blocked');
  });

  test('a vendor outage reaches the model as a plain message it can explain, and does not break the turn', async () => {
    shopBroken = true;
    try {
      const { toolResults, outcome } = await turn([() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'commercetools', tool: 'find_product', arguments: { query: 'x' } })] }), () => ({ content: 'The shop system is not answering right now.' })], people.sales);
      assert.equal(toolResults[0].body.ok, false);
      assert.match(JSON.stringify(toolResults[0].body), /commercetools is not answering properly right now/);
      assert.equal(outcome.turnResult.assistantMessage, 'The shop system is not answering right now.');
    } finally { shopBroken = false; }
  });

  test('neither the connector server\'s key nor a vendor\'s secret reaches the model, the chat stream, the tool results or the audit', async () => {
    const all = await turn([
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'commercetools', tool: 'find_product', arguments: { query: 'drill' } }), call('c2', 'get_connector_tools', { connector: 'salesforce' })] }),
      () => ({ content: 'Done.' }),
    ], people.admin);
    for (const [label, value] of [['model requests', all.requests], ['stream', all.events], ['audit', audit], ['tool results', all.toolResults]] as const) {
      assert.ok(!JSON.stringify(value).includes(KEY), `${label} hold no connector key`);
      assert.ok(!JSON.stringify(value).includes(VENDOR_SECRET), `${label} hold no vendor secret`);
      assert.ok(!JSON.stringify(value).includes('ct-token') && !JSON.stringify(value).includes('sf-token'), `${label} hold no vendor token`);
    }
  });
});
