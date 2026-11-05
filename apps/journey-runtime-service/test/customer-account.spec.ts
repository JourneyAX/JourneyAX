import '../../../packages/jax-iq/test/setup/no-world';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpClientPool, StaticMcpServerDirectory } from '@journeyax/capability-sdk';
import { ConnectorsSchema } from '@journeyax/business-pack';
import { ModelGateway, type AgentExecutionRequest } from '../src/kernel/model.gateway';
import { AgentTurnLoop } from '../src/agent/agent-loop';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { CompanyDirectory, cleanCompanies, type PersonCompany } from '../src/kernel/company-directory';
import { CUSTOMER_ACCOUNT_TOOL_NAMES, executeCustomerAccountTool } from '../src/agent/customer-account';
import { SampleConnectorServer } from '../../../packages/connectors-sample/src/server';
import { loadConnectors } from '../../../packages/connectors-sample/src/loader';
import { connectorPack, workspace } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

/**
 * A signed-in trade customer and their own company: the tools are offered only to a customer the team linked to a company, they take no
 * company, they cut what they return down to what a customer may see, and nothing a customer or the model says reaches another company.
 * The accounts system is the sample ERP server, spoken to over MCP like in the other end-to-end tests.
 */
const TENANT = 'placemakers';
const ENVIRONMENT = 'production';
const KEY = 'e2e-customer-key-4b21d7e0b2a64f1f';
const SAMPLE_REGISTRY = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/sample-connectors-registry.json'), 'utf8'));
const SEEDS = loadConnectors();
const erp = (collection: string) => SEEDS.get('ace-erp')!.seed.collections[collection];

// The demo companies: ACC-0028 (silver, has deliveries) and ACC-0016 (bronze).
const HARLOW: PersonCompany = { id: 'ACC-0028', name: 'Harlow & Talbot Landscapes Ltd', role: 'account_admin' };
const BUYER_AT_HARLOW: PersonCompany = { ...HARLOW, role: 'buyer' };
const MARLOW: PersonCompany = { id: 'ACC-0016', name: 'Marlow & Tasman Framing Ltd', role: 'job_viewer' };

let server: SampleConnectorServer;
let gateway: CapabilityGateway;
let base = '';

before(async () => {
  server = new SampleConnectorServer({ tenants: [TENANT], apiKey: KEY });
  base = 'http://sample.test';
  const pool = new McpClientPool({
    directory: new StaticMcpServerDirectory(Object.fromEntries(server.connectorIds().map((id) => [id, `${base}/mcp/${id}`]))),
    secrets: { resolve: async () => KEY },
    nodeEnv: 'test',
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      const answer = await server.handle(new URL(url).pathname.split('/').pop()!, headers.get('x-tenant-id')!, body);
      return answer === undefined ? new Response(null, { status: 202 }) : new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  gateway = new CapabilityGateway({ mcpClients: pool });
});
after(async () => { await server.close(); });

const ALL_TOOLS = ['search_products', 'present_card', 'hand_off_to_human', ...CUSTOMER_ACCOUNT_TOOL_NAMES];
function release(options: { customerAccount?: unknown } = { customerAccount: { enabled: true, connector: 'ace-erp', tools: { balance: 'account_balance', deliveries: 'list_deliveries', price: 'trade_price' }, pricingFields: { bronze: 'bronzePrice', silver: 'silverPrice', gold: 'goldPrice' } } }) {
  const pack: any = connectorPack(ConnectorsSchema.parse(SAMPLE_REGISTRY), {
    tenantId: TENANT, environmentId: ENVIRONMENT,
    agents: [{ agentId: 'advisor', name: 'advisor', purpose: 'Help customers.', systemPromptTemplate: 'You help customers.', allowedTools: ALL_TOOLS, modelPolicyRef: 'default', maxTurns: 6, handoffConditions: [], isDefault: true }],
  });
  if (options.customerAccount) pack.extensions = { ...pack.extensions, customerAccount: options.customerAccount };
  return pack;
}

/** A directory that knows who is linked to what, keyed by login as the real one is. */
const directory = (links: Record<string, PersonCompany[]>) => ({ companiesFor: async (_tenant: string, login: string) => links[String(login).toLowerCase()] ?? [] }) as unknown as CompanyDirectory;

type Step = (req: AgentExecutionRequest, round: number) => { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }> };
async function turn(steps: Step[], who: { principalId?: string; role?: string; links?: Record<string, PersonCompany[]>; release?: any } = {}) {
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
  const outcome = await new AgentTurnLoop().execute({
    command: {
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-cust', sessionId: 'sess-cust', correlationId: `corr-${Math.random().toString(16).slice(2, 8)}`,
      message: 'Hello', principalId: who.principalId ?? 'anonymous', principalRole: who.role ?? 'customer', agentId: 'advisor',
    } as any,
    release: who.release ?? release(),
    workspace: workspace(TENANT, ENVIRONMENT),
    modelGateway: model,
    catalogSearchHandler: { execute: async () => ({ products: [] }) } as any,
    capabilityGateway: gateway,
    companyDirectory: directory(who.links ?? {}),
    sink: () => undefined,
  });
  return { outcome, requests, toolResults, reply: outcome.turnResult.assistantMessage };
}
const call = (id: string, name: string, args: Record<string, any>) => ({ id, name, arguments: args });
const offered = (req: AgentExecutionRequest) => (req.tools ?? []).map((t) => t.name).filter((n) => (CUSTOMER_ACCOUNT_TOOL_NAMES as readonly string[]).includes(n)).sort();
const LINKS = { 'hemi@harlow.example': [HARLOW], 'jo@harlow.example': [BUYER_AT_HARLOW], 'ana@marlow.example': [MARLOW] };

describe('A signed-in trade customer and their own company', () => {
  test('a linked customer is offered the four account tools and told who they are; nobody else is, however they got here', async () => {
    const linked = await turn([() => ({ content: 'Hi.' })], { principalId: 'hemi@harlow.example', links: LINKS });
    assert.deepEqual(offered(linked.requests[0]), [...CUSTOMER_ACCOUNT_TOOL_NAMES].sort());
    assert.match(linked.requests[0].systemPrompt ?? '', /## This customer's business account/);
    assert.match(linked.requests[0].systemPrompt ?? '', /Harlow & Talbot Landscapes Ltd: account administrator/);
    assert.match(linked.requests[0].systemPrompt ?? '', /never ask for an account number/);

    for (const [label, who] of Object.entries({
      'a signed-in customer nobody linked': { principalId: 'stranger@example.com', links: LINKS },
      'a guest': { principalId: 'anonymous', links: LINKS },
      'a guest who typed a login as an id (the gateway signs it as anonymous)': { principalId: 'anonymous', links: LINKS },
      'a member of staff, even one whose login is on the list': { principalId: 'hemi@harlow.example', role: 'operator', links: LINKS },
      'a customer when the pack leaves the feature off': { principalId: 'hemi@harlow.example', links: LINKS, release: release({ customerAccount: undefined } as any) },
      'a customer when the pack switches it off': { principalId: 'hemi@harlow.example', links: LINKS, release: release({ customerAccount: { enabled: false } }) },
    })) {
      const answer = await turn([() => ({ content: 'Hi.' })], who as any);
      assert.deepEqual(offered(answer.requests[0]), [], label);
      assert.doesNotMatch(answer.requests[0].systemPrompt ?? '', /trade account/, label);
    }
  });

  test('deliveries are the company\'s own, cut to what a customer needs, and an account id the model supplies is not used', async () => {
    const mine = erp('deliveries').filter((d) => d.accountId === HARLOW.id);
    assert.ok(mine.length >= 3, 'the demo company has deliveries to show');
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'my_deliveries', {}), call('c2', 'my_deliveries', { accountId: 'ACC-0016', company: 'Marlow & Tasman Framing Ltd' }), call('c3', 'my_deliveries', { orderId: mine[0].orderId })] }),
      () => ({ content: 'Done.' }),
    ], { principalId: 'hemi@harlow.example', links: LINKS });
    const [all, other, one] = toolResults.map((r) => r.body);
    assert.equal(all.ok, true);
    assert.deepEqual(all.deliveries.map((d: any) => d.deliveryId).sort(), mine.map((d) => d.deliveryId).sort(), 'exactly this company\'s deliveries');
    for (const row of all.deliveries) {
      assert.deepEqual(Object.keys(row).filter((k) => !['note'].includes(k)).sort(), ['day', 'deliveryId', 'orderId', 'status', 'window'].sort(), 'no driver, vehicle, stops or branch');
    }
    assert.equal(other.ok, false, 'naming another company is refused');
    assert.match(other.error, /not one of your companies/);
    assert.ok(!JSON.stringify(other).includes('ACC-0016'), 'the other company is not echoed back');
    assert.deepEqual(one.deliveries.map((d: any) => d.orderId), [mine[0].orderId]);
    assert.match(all.notice, /sample data/, 'the sample data notice is carried');
  });

  test('the balance is for the account administrator and accounts payable; a buyer and a job viewer are told so, and the credit limit is never shown', async () => {
    const row = erp('account_balances').find((b) => b.accountId === HARLOW.id)!;
    const admin = await turn([() => ({ toolCalls: [call('c1', 'my_balance', {})] }), () => ({ content: 'ok' })], { principalId: 'hemi@harlow.example', links: LINKS });
    const shown = admin.toolResults[0].body;
    assert.equal(shown.ok, true);
    assert.equal(shown.balance, row.balance);
    assert.equal(shown.overdue, row.overdue);
    assert.equal(shown.paymentTerms, row.terms);
    assert.ok(!('creditLimit' in shown) && !JSON.stringify(shown).includes(String(row.creditLimit)) || String(row.creditLimit) === String(row.balance), 'no credit limit');
    for (const [login, role] of [['jo@harlow.example', 'buyer'], ['ana@marlow.example', 'job viewer']]) {
      const refused = (await turn([() => ({ toolCalls: [call('c1', 'my_balance', {})] }), () => ({ content: 'ok' })], { principalId: login, links: LINKS })).toolResults[0].body;
      assert.equal(refused.ok, false, login);
      assert.match(refused.error, new RegExp(`As ${role}`), login);
      assert.ok(!('balance' in refused), 'nothing of the balance leaks in the refusal');
    }
  });

  test('a trade price is the customer\'s own tier, with the retail price beside it, and the other tiers are not shown', async () => {
    const price = erp('price_list')[3];
    const account = erp('account_balances').find((b) => b.accountId === HARLOW.id)!;
    const tier = account.tier as 'bronze' | 'silver' | 'gold';
    assert.ok(tier, 'accounts carry a tier');
    const { toolResults } = await turn([() => ({ toolCalls: [call('c1', 'my_price', { sku: price.sku })] }), () => ({ content: 'ok' })], { principalId: 'hemi@harlow.example', links: LINKS });
    const body = toolResults[0].body;
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.yourPrice, price[`${tier}Price`]);
    assert.equal(body.retailPrice, price.retailPrice);
    assert.equal(body.yourTier, tier);
    const others = (['bronze', 'silver', 'gold'] as const).filter((t) => t !== tier);
    for (const other of others) assert.ok(!(`${other}Price` in body), `${other}Price is not in the answer`);
    const missing = (await turn([() => ({ toolCalls: [call('c1', 'my_price', { sku: 'NOPE-0' })] }), () => ({ content: 'ok' })], { principalId: 'hemi@harlow.example', links: LINKS })).toolResults[0].body;
    assert.equal(missing.ok, false);
  });

  test('my_company says who they are and what they can ask; with two companies the model must say which, and only their own count', async () => {
    const one = (await turn([() => ({ toolCalls: [call('c1', 'my_company', {})] }), () => ({ content: 'ok' })], { principalId: 'jo@harlow.example', links: LINKS })).toolResults[0].body;
    assert.equal(one.company, HARLOW.name);
    assert.equal(one.yourRole, 'buyer');
    assert.ok(!one.youCanAskAbout.some((entry: string) => /balance/.test(entry)), 'a buyer is not told they can ask for the balance');
    const two = { 'multi@example.com': [HARLOW, MARLOW] };
    const results = (await turn([
      () => ({ toolCalls: [call('c1', 'my_deliveries', {}), call('c2', 'my_deliveries', { company: 'marlow' }), call('c3', 'my_deliveries', { company: 'Ngata & Penrose Joinery Ltd' })] }),
      () => ({ content: 'ok' }),
    ], { principalId: 'multi@example.com', links: two })).toolResults.map((r) => r.body);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /more than one company/);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].company, MARLOW.name);
    assert.equal(results[2].ok, false);
    assert.ok(!JSON.stringify(results[2]).includes('Ngata'), 'a company the person is not in is never echoed');
  });

  test('called without a company (the server is asked directly, or the pack is off), each tool refuses and reads nothing', async () => {
    const ctx = (over: Record<string, unknown>) => ({ tenantId: TENANT, environmentId: ENVIRONMENT, release: release(), connectorRuntime: gateway.getConnectorRuntime?.(), ...over }) as any;
    const exec = { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'w', sessionId: 's', correlationId: 'c', principalId: 'x', principalRole: 'customer' } as any;
    for (const name of CUSTOMER_ACCOUNT_TOOL_NAMES) {
      const none = await executeCustomerAccountTool(name, { sku: 'x' }, ctx({ companies: [] }), exec);
      assert.equal(none.ok, false, name);
      assert.ok(!('company' in none) && !('balance' in none) && !('deliveries' in none), `${name} gives nothing away`);
      const off = await executeCustomerAccountTool(name, { sku: 'x' }, ctx({ companies: [HARLOW], release: release({ customerAccount: { enabled: false } }) }), exec);
      assert.equal(off.ok, false, `${name} (off)`);
    }
  });

  test('what the accounts system is declared to support may be quoted in the reply: figures and dates are not withheld', async () => {
    const registry: any = JSON.parse(JSON.stringify(SAMPLE_REGISTRY));
    for (const connector of registry.connectors) if (connector.connectorId === 'ace-erp') for (const tool of connector.tools) if (['account_balance', 'list_deliveries', 'trade_price'].includes(tool.name)) tool.claimClasses = ['catalog_fact'];
    const pack: any = release();
    pack.extensions.connectors = ConnectorsSchema.parse(registry);
    const allowed = new Set<string>();
    const ctx: any = { tenantId: TENANT, environmentId: ENVIRONMENT, release: pack, connectorRuntime: gateway.getConnectorRuntime?.(), companies: [HARLOW], allowedClaimClasses: allowed };
    const exec = { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'w', sessionId: 's', correlationId: 'c', principalId: 'x', principalRole: 'customer' } as any;
    const answer = await executeCustomerAccountTool('my_balance', {}, ctx, exec);
    assert.equal(answer.ok, true);
    assert.ok(allowed.has('catalog_fact'), 'the class the pack declares for the tool is unlocked');
    assert.ok(!('claimClasses' in answer), 'the class list is not part of what the model sees');
    const bare: any = JSON.parse(JSON.stringify(SAMPLE_REGISTRY));
    for (const connector of bare.connectors) for (const tool of connector.tools) delete tool.claimClasses;
    const barePack: any = release();
    barePack.extensions.connectors = ConnectorsSchema.parse(bare);
    const none: any = { ...ctx, allowedClaimClasses: new Set<string>(), release: barePack };
    await executeCustomerAccountTool('my_balance', {}, none, exec);
    assert.equal(none.allowedClaimClasses.size, 0, 'a tool the pack declares nothing for unlocks nothing');
  });

  test('the connector tools a write needs stay out of reach: the account tools can only read, whatever the pack lists', async () => {
    const runtime = gateway.getConnectorRuntime!()!;
    const writeRegistry: any = JSON.parse(JSON.stringify(SAMPLE_REGISTRY));
    const refused = await (runtime as any).callRead(release(), { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'w', sessionId: 's', correlationId: 'c' } as any, 'sap-commerce', 'add_to_cart', { sku: 'x' });
    assert.equal(refused.ok, false, 'a tool that changes data is never called on a customer\'s behalf');
    assert.ok(writeRegistry.connectors.length > 0);
    const missing = await (runtime as any).callRead(release(), { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'w', sessionId: 's', correlationId: 'c' } as any, 'no-such', 'x', {});
    assert.equal(missing.ok, false);
  });
});

describe('The company directory fails closed', () => {
  const ok = (body: unknown, status = 200) => (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  const make = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => new CompanyDirectory({ baseUrl: () => 'http://projects.test', headers: async () => ({ 'x-internal-key': 'k' }), fetchImpl, warn: () => undefined, ...extra });

  test('it returns the companies the project service names, cleaned, and only for something that looks like a login', async () => {
    let asked = 0;
    const dir = make((async () => { asked++; return { ok: true, status: 200, json: async () => ({ companies: [HARLOW, { id: 'x', name: 'Bad role', role: 'owner' }, { id: '', name: 'No id', role: 'buyer' }, HARLOW] }) }; }) as unknown as typeof fetch);
    assert.deepEqual(await dir.companiesFor('placemakers', 'Hemi@Harlow.example'), [HARLOW]);
    assert.deepEqual(await dir.companiesFor('placemakers', 'hemi@harlow.example'), [HARLOW]);
    assert.equal(asked, 1, 'the answer is kept for a minute');
    for (const odd of ['', 'anonymous', 'guest@anonymous', 'no-at-sign', '   ']) assert.deepEqual(await dir.companiesFor('placemakers', odd), [], odd);
    assert.equal(asked, 1, 'nothing is asked for what is not a login');
  });

  test('a refusal, an error, a timeout, a missing address and nonsense all mean no company', async () => {
    assert.deepEqual(await make(ok({}, 403)).companiesFor('placemakers', 'a@b.c'), []);
    assert.deepEqual(await make((async () => { throw new Error('connection refused'); }) as unknown as typeof fetch).companiesFor('placemakers', 'a@b.c'), []);
    assert.deepEqual(await make(ok({ companies: 'all of them' })).companiesFor('placemakers', 'a@b.c'), []);
    assert.deepEqual(await make(ok({ companies: [{ id: 'A', name: 'A', role: 'admin' }] })).companiesFor('placemakers', 'a@b.c'), []);
    const noAddress = new CompanyDirectory({ baseUrl: () => undefined, headers: async () => ({}), warn: () => undefined });
    assert.deepEqual(await noAddress.companiesFor('placemakers', 'a@b.c'), []);
  });

  test('a failure is remembered only briefly, and a company list is cut to a few', async () => {
    let now = 0;
    let fail = true;
    const dir = make((async () => fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ companies: [HARLOW] }) }) as unknown as typeof fetch, { now: () => now });
    assert.deepEqual(await dir.companiesFor('p', 'a@b.c'), []);
    fail = false;
    assert.deepEqual(await dir.companiesFor('p', 'a@b.c'), [], 'still remembered as a failure for a few seconds');
    now += 11_000;
    assert.deepEqual(await dir.companiesFor('p', 'a@b.c'), [HARLOW]);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `ACC-${i}`, name: `Company ${i}`, role: 'buyer' }));
    assert.equal(cleanCompanies(many).length, 3);
  });
});
