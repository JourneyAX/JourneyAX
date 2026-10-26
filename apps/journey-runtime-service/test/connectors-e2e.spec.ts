import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpClientPool, StaticMcpServerDirectory } from '@journeyax/capability-sdk';
import { ConnectorsSchema, validateBusinessPack } from '@journeyax/business-pack';
import { ModelGateway, type AgentExecutionRequest } from '../src/kernel/model.gateway';
import { AgentTurnLoop } from '../src/agent/agent-loop';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { SampleConnectorServer } from '../../../packages/connectors-sample/src/server';
import { loadConnectors } from '../../../packages/connectors-sample/src/loader';
import { ApprovalService } from '../src/kernel/approval.service';
import { ApprovalStore } from '../src/approval/approval.store';
import { connectorPack, workspace } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

/**
 * The whole path, with a scripted model: the agent loop offers connectors by name, loads one connector's tools on request, calls them over
 * MCP through the dispatcher and the policy gate, and gets real-shaped data back from the sample connector server. The registry is the one
 * declared for PlaceMakers in the draft pack.
 */
const TENANT = 'placemakers';
const ENVIRONMENT = 'production';
const KEY = 'e2e-sample-key-9d41c7e0b2a64f1f';
const DRAFT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
/**
 * The registry these tests exercise is a frozen copy of the one the sample setup had (every system backed by the sample server, all staff,
 * reads allowed and writes asking first). These tests are about the connector machinery: loading tools on request, the dispatcher's policy
 * gate, ask-first, the claim classes, the key never leaking. Which team may use which real system is the draft pack's business and is
 * tested where the pack is: project-service persona-access.spec and connectors-real contract.spec.
 */
const SAMPLE_REGISTRY = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/sample-connectors-registry.json'), 'utf8'));
const REGISTRY = ConnectorsSchema.parse(SAMPLE_REGISTRY);
const SEEDS = loadConnectors();
const seed = (connector: string, collection: string) => SEEDS.get(connector)!.seed.collections[collection];

let server: SampleConnectorServer;
let gateway: CapabilityGateway;
let approvals: ApprovalService;
const audit: any[] = [];
let base = '';

type Step = (req: AgentExecutionRequest, round: number) => { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }> };

before(async () => {
  server = new SampleConnectorServer({ tenants: [TENANT], apiKey: KEY });
  base = await server.listen(0);
  const pool = new McpClientPool({
    directory: new StaticMcpServerDirectory(Object.fromEntries(server.connectorIds().map((id) => [id, `${base}/mcp/${id}`]))),
    secrets: { resolve: async () => KEY },
    nodeEnv: 'test',
  });
  gateway = new CapabilityGateway({ mcpClients: pool, connectorAudit: (event) => audit.push(event) });
  // The real approval service and store, kept in memory: no database is touched.
  approvals = new ApprovalService(new ApprovalStore({ explicitMemory: true }));
});
after(async () => { await server.close(); });

const draftAgents = DRAFT.agents.filter((a: any) => ['placemakers_sales_quote', 'placemakers_product_advisor'].includes(a.agentId));
// The draft asks on a card in the chat; the approval-service flow of these tests is the other way an ask-first tool can wait, so they say so.
const approvalMode = (registry: any) => ({ ...JSON.parse(JSON.stringify(registry)), askVia: 'approval' });
function release(registry: unknown = approvalMode(SAMPLE_REGISTRY)) {
  return connectorPack(registry, { tenantId: TENANT, environmentId: ENVIRONMENT, agents: draftAgents.map((a: any) => ({ ...a, modelPolicyRef: 'default' })) });
}

async function turn(steps: Step[], who: { role?: string; groups?: string[]; agentId?: string; tenantId?: string; registry?: unknown; message?: string; workspace?: any; customerEvent?: any } = {}) {
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
      tenantId: who.tenantId ?? TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-e2e', sessionId: 'sess-e2e', correlationId: `corr-e2e-${Math.random().toString(16).slice(2, 8)}`,
      message: who.message ?? 'Hello', principalId: who.role ? 'person-1' : undefined, principalRole: who.role, principalGroups: who.groups, agentId: who.agentId ?? 'placemakers_sales_quote',
      ...(who.customerEvent ? { customerEvent: who.customerEvent } : {}),
    } as any,
    release: release(who.registry),
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
const staff = { role: 'operator', groups: ['sales'] };

describe('Connectors, end to end with a scripted model', () => {
  test('the sample registry matches the sample connectors and has the right defaults: reads allow, writes ask first, staff only', () => {
    const served = new Map([...SEEDS].map(([id, { definition }]) => [id, definition.tools]));
    assert.deepEqual(REGISTRY.connectors.map((c) => c.connectorId), [...served.keys()], 'the eleven connectors of the plan, in order');
    for (const connector of REGISTRY.connectors) {
      assert.deepEqual(connector.tools.map((t) => t.name), served.get(connector.connectorId)!.map((t) => t.name), `${connector.connectorId} lists the tools the server offers`);
      assert.ok(connector.sample && connector.enabled && connector.secretRef?.startsWith('tenant-secret://placemakers/production/'));
      for (const tool of connector.tools) {
        const readOnly = served.get(connector.connectorId)!.find((t) => t.name === tool.name)!.annotations?.readOnlyHint;
        assert.equal(tool.sideEffect, readOnly === false ? 'write' : 'read');
        const rows = REGISTRY.policy.filter((r) => r.connectorId === connector.connectorId && (r.tool === tool.name || r.tool === '*'));
        const own = rows.find((r) => r.tool === tool.name) ?? rows.find((r) => r.tool === '*')!;
        assert.equal(own.state, tool.sideEffect === 'write' ? 'ask' : 'allow', `${connector.connectorId}.${tool.name}`);
        assert.ok(rows.every((r) => r.audience === 'staff'), 'no shopper row');
      }
    }
    const pack: any = { ...release(), modelPolicy: { policies: [{ policyId: 'default' }] } };
    pack.extensions = { ...pack.extensions, connectors: SAMPLE_REGISTRY };
    const issues = validateBusinessPack(pack).issues.filter((i) => i.path.startsWith('extensions.connectors'));
    assert.deepEqual(issues.filter((i) => i.severity === 'error'), [], 'the publication gate finds no error');
    assert.equal(issues.filter((i) => i.severity === 'warning').length, 11, 'one warning per connector: sample data in a production pack, said plainly');
  });

  test('the current draft pack passes the publication gate: the real systems are marked real and raise no sample-data warning, the others still do', () => {
    const current = ConnectorsSchema.parse(DRAFT.extensions.connectors);
    const pack: any = { ...release(), modelPolicy: { policies: [{ policyId: 'default' }] } };
    pack.extensions = { ...pack.extensions, connectors: DRAFT.extensions.connectors };
    const issues = validateBusinessPack(pack).issues.filter((i) => i.path.startsWith('extensions.connectors'));
    assert.deepEqual(issues.filter((i) => i.severity === 'error'), [], 'the publication gate finds no error in the draft');
    const warned = new Set(issues.filter((i) => i.severity === 'warning').map((i) => /connectors\[(\d+)\]/.exec(i.path)?.[1]).filter(Boolean).map(Number));
    current.connectors.forEach((connector, index) => {
      if (['commercetools', 'salesforce', 'google-analytics', 'power-bi', 'zendesk'].includes(connector.connectorId)) {
        assert.equal(connector.sample, false, `${connector.connectorId} is real`);
        assert.equal(warned.has(index), false, `${connector.connectorId} raises no sample-data warning`);
      } else assert.equal(connector.sample, true, `${connector.connectorId} is still sample data until a real system stands behind it`);
    });
  });

  test('staff ask about stock and a trade price: the model loads one connector, calls two tools over MCP and answers from real-shaped data', async () => {
    const row = seed('ace-erp', 'stock').find((r) => r.available > 0)!;
    const price = seed('ace-erp', 'price_list').find((p) => p.sku === row.sku)!;
    let seenAtStart = -1;
    const { requests, toolResults, outcome, reply } = await turn([
      () => ({ toolCalls: [call('c1', 'list_connectors', {})] }),
      () => ({ toolCalls: [call('c2', 'get_connector_tools', { connector: 'ace-erp', query: 'stock' })] }),
      () => ({ toolCalls: [call('c3', 'call_connector_tool', { connector: 'ace-erp', tool: 'stock_by_branch', arguments: { sku: row.sku, branchCode: row.branchCode } }), call('c4', 'call_connector_tool', { connector: 'ace-erp', tool: 'trade_price', arguments: { sku: row.sku } })] }),
      (req) => {
        const stock = JSON.parse(String(req.messages.filter((m) => m.tool_call_id === 'c3').pop()!.content)).result.records[0];
        return { content: `${row.branchName} has ${stock.available} available. The gold price is ${price.goldPrice}. This is sample data.` };
      },
    ], { ...staff, message: 'How much of this is at the branch and what is the gold price?' });

    assert.deepEqual(tools(requests[0]).filter((n) => /connector/.test(n)).sort(), ['call_connector_tool', 'get_connector_tools', 'list_connectors']);
    const prompt = requests[0].systemPrompt ?? '';
    assert.match(prompt, /# Connectors you can use/);
    for (const connector of REGISTRY.connectors) assert.ok(prompt.includes(`- ${connector.connectorId}: ${connector.description}`), connector.connectorId);
    assert.ok(!prompt.includes('stock_by_branch'), 'no tool names are in the prompt: they load on request');

    const [listed, loaded, stockResult, priceResult] = toolResults.map((r) => r.body);
    assert.equal(listed.connectors.length, 11);
    assert.deepEqual(loaded.tools.map((t: any) => t.name), ['stock_by_branch'], 'the query narrows the tools of the one connector');
    assert.equal(loaded.tools[0].asksFirst, false);
    assert.equal(stockResult.ok, true);
    assert.equal(stockResult.sample, true);
    assert.equal(stockResult.result.records[0].sku, row.sku);
    assert.equal(stockResult.result.records[0].available, row.available, 'the figure is the one in the data');
    assert.equal(priceResult.result.record.goldPrice, price.goldPrice);
    assert.match(stockResult.notice, /sample data/);

    assert.deepEqual(outcome.toolsCalled.map((t) => t.name), ['list_connectors', 'get_connector_tools', 'call_connector_tool', 'call_connector_tool']);
    assert.ok(outcome.toolsCalled.every((t) => t.ok));
    assert.ok(reply && reply.includes(String(row.available)) && reply.includes(String(price.goldPrice)), `the answer reached the customer: ${reply}`);
  });

  test('a pack that does not want sample data announced gets no sample label in the instructions and no notice in the answers; the default still announces it', async () => {
    const row = seed('ace-erp', 'stock').find((r) => r.available > 0)!;
    const ask = (registry: unknown) => turn([
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'ace-erp', tool: 'stock_by_branch', arguments: { sku: row.sku } })] }),
      () => ({ content: 'Looked.' }),
    ], { ...staff, registry });
    const quiet = await ask({ ...JSON.parse(JSON.stringify(SAMPLE_REGISTRY)), announceSample: false });
    assert.ok(!(quiet.requests[0].systemPrompt ?? '').includes('(sample data)'), 'no sample label in the instructions');
    assert.equal(quiet.toolResults[0].body.ok, true);
    assert.equal(quiet.toolResults[0].body.notice, undefined, 'no notice in the answer');
    assert.equal(quiet.toolResults[0].body.sample, undefined);
    const loud = await ask(SAMPLE_REGISTRY);
    assert.ok((loud.requests[0].systemPrompt ?? '').includes('(sample data)'), 'by default the instructions say which systems hold sample data');
    assert.match(loud.toolResults[0].body.notice, /sample data/);
  });

  test('what a tool may be quoted for is declared in the registry: with no claim class on stock, the reply checker still holds back a stock claim', async () => {
    const row = seed('ace-erp', 'stock').find((r) => r.available > 0)!;
    const registry = JSON.parse(JSON.stringify(SAMPLE_REGISTRY));
    for (const connector of registry.connectors) for (const t of connector.tools) delete t.claimClasses;
    const ask = (reg: unknown) => turn([
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'ace-erp', tool: 'stock_by_branch', arguments: { sku: row.sku, branchCode: row.branchCode } })] }),
      () => ({ content: `${row.branchName} has ${row.available} in stock.` }),
    ], { ...staff, registry: reg });
    const declared = await ask(SAMPLE_REGISTRY);
    const undeclared = await ask(registry);
    assert.ok(declared.reply!.includes(String(row.available)), `a stock figure from a tool that declares the stock class is let through: ${declared.reply}`);
    assert.equal(undeclared.reply, 'Withheld.', 'the same sentence from a tool that declares nothing is held back by the pack\'s own withheld-answer message');
  });

  test('tools load only for the connector asked about: asking about one connector does not list the tools of the others', async () => {
    const before = audit.length;
    const probe = await fetch(`${base}/health`);
    assert.equal(probe.status, 200);
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'sap-commerce', query: 'cart' })] }),
      () => ({ content: 'Looked.' }),
    ], staff);
    const names = toolResults[0].body.tools.map((t: any) => t.name);
    assert.deepEqual(names.sort(), ['add_to_cart', 'get_cart']);
    assert.equal(toolResults[0].body.tools.find((t: any) => t.name === 'add_to_cart').asksFirst, true);
    assert.equal(toolResults[0].body.tools.find((t: any) => t.name === 'add_to_cart').changesData, true);
    assert.equal(audit.length, before, 'loading tools is not a call');
  });

  test('a write asks first: nothing changes until a person approves that exact call, then the cart really has the line', async () => {
    const cartId = seed('sap-commerce', 'carts')[3].cartId;
    const sku = seed('sap-commerce', 'products')[10].sku;
    const args = { cartId, sku, quantity: 4 };
    const lines = async () => (await turn([() => ({ toolCalls: [call('r', 'call_connector_tool', { connector: 'sap-commerce', tool: 'get_cart', arguments: { cartId } })] }), () => ({ content: 'ok' })], staff)).toolResults[0].body.result.record.lines.length as number;
    const start = await lines();

    const asked = await turn([() => ({ toolCalls: [call('w1', 'call_connector_tool', { connector: 'sap-commerce', tool: 'add_to_cart', arguments: args })] }), () => ({ content: 'I need your approval to add that.' })], staff);
    const waiting = asked.toolResults[0].body;
    assert.equal(waiting.status, 'needs_approval');
    assert.ok(waiting.approvalRequestId);
    assert.equal(await lines(), start, 'the cart is unchanged');
    assert.equal(asked.outcome.toolsCalled[0].ok, false);

    const pending = await approvals.getApproval(waiting.approvalRequestId);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.toolId, 'connector:sap-commerce.add_to_cart');
    assert.deepEqual(pending?.requestedPayload, args, 'the approval holds the exact arguments');
    assert.equal(await approvals.decide(TENANT, ENVIRONMENT, 'ws-e2e', waiting.approvalRequestId, 'approved', 'approver-1'), true);
    const done = await turn([() => ({ toolCalls: [call('w2', 'call_connector_tool', { connector: 'sap-commerce', tool: 'add_to_cart', arguments: args, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'Added.' })], staff);
    assert.equal(done.toolResults[0].body.ok, true);
    assert.equal(done.toolResults[0].body.result.created, true);
    assert.equal(done.toolResults[0].body.result.record.sample, true);
    assert.equal(await lines(), start + 1, 'the cart has the new line');

    const again = await turn([() => ({ toolCalls: [call('w3', 'call_connector_tool', { connector: 'sap-commerce', tool: 'add_to_cart', arguments: args, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'x' })], staff);
    assert.equal(again.toolResults[0].body.status, 'needs_approval', 'the approval was spent');
    assert.equal(await lines(), start + 1);
  });

  test('the draft asks on a card in the chat: nothing changes until the person taps Allow, then the cart really has the line', async () => {
    assert.equal(REGISTRY.askVia, 'card', 'the sample setup asks on a card');
    const cartId = seed('sap-commerce', 'carts')[4].cartId;
    const sku = seed('sap-commerce', 'products')[12].sku;
    const args = { cartId, sku, quantity: 3 };
    const shared = workspace(TENANT, ENVIRONMENT);
    const lines = async () => (await turn([() => ({ toolCalls: [call('r', 'call_connector_tool', { connector: 'sap-commerce', tool: 'get_cart', arguments: { cartId } })] }), () => ({ content: 'ok' })], { ...staff, registry: SAMPLE_REGISTRY })).toolResults[0].body.result.record.lines.length;
    const start = await lines();
    const asked = await turn([() => ({ toolCalls: [call('w1', 'call_connector_tool', { connector: 'sap-commerce', tool: 'add_to_cart', arguments: args })] }), () => ({ content: 'Please allow that.' })], { ...staff, registry: SAMPLE_REGISTRY, workspace: shared });
    const held = asked.toolResults[0].body;
    assert.equal(held.status, 'needs_confirmation');
    assert.equal(await lines(), start, 'the cart is unchanged');
    assert.ok(asked.outcome.turnResult.uiInstructions?.some((c) => c.component === 'confirm'), 'the person sees the card');
    const allowed = await turn([() => ({ content: 'Added.' })], { ...staff, registry: SAMPLE_REGISTRY, workspace: shared, message: '', customerEvent: { type: 'confirmTool', payload: { confirmationId: held.confirmationId, decision: 'allow' } } });
    assert.match(JSON.stringify(allowed.requests[0].messages), /which the person allowed/);
    assert.equal(await lines(), start + 1, 'the kept call ran and the cart has the new line');
  });

  test('strictest wins: a person in two groups gets the stricter state, and a blocked tool is neither listed nor callable', async () => {
    const registry = approvalMode(SAMPLE_REGISTRY);
    registry.policy.push({ connectorId: 'ace-erp', tool: 'account_balance', audience: 'staff', groups: ['finance-restricted'], state: 'blocked' });
    registry.policy.push({ connectorId: 'ace-erp', tool: 'trade_price', audience: 'staff', groups: ['sales'], state: 'ask' });
    const accountId = seed('ace-erp', 'account_balances')[0].accountId;
    const sku = seed('ace-erp', 'price_list')[0].sku;
    const both = { role: 'operator', groups: ['sales', 'finance-restricted'], registry };
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'ace-erp' }), call('c2', 'call_connector_tool', { connector: 'ace-erp', tool: 'account_balance', arguments: { accountId } }), call('c3', 'call_connector_tool', { connector: 'ace-erp', tool: 'trade_price', arguments: { sku } })] }),
      () => ({ content: 'ok' }),
    ], both);
    const [loaded, balance, price] = toolResults.map((r) => r.body);
    const byName = Object.fromEntries(loaded.tools.map((t: any) => [t.name, t]));
    assert.ok(!byName.account_balance, 'a blocked tool is not shown');
    assert.equal(byName.trade_price.asksFirst, true, 'the sales row says ask first, and nothing stricter applies');
    assert.equal(balance.status, 'blocked');
    assert.equal(price.status, 'needs_approval');
    const salesOnly = await turn([() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'ace-erp', tool: 'account_balance', arguments: { accountId } })] }), () => ({ content: 'ok' })], { role: 'operator', groups: ['sales'], registry });
    assert.equal(salesOnly.toolResults[0].body.ok, true, 'without the restricting group the tool is allowed');
  });

  test('a shopper never sees connectors: the draft gives them to staff only, so the tools, the prompt text and the calls are all absent', async () => {
    const shopper = await turn([() => ({ content: 'Hi there.' })], { agentId: 'placemakers_product_advisor' });
    assert.ok(!tools(shopper.requests[0]).some((n) => /connector/.test(n)));
    assert.ok(!(shopper.requests[0].systemPrompt ?? '').includes('Connectors you can use'));
    const forced = await turn([() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'ace-erp', tool: 'trade_price', arguments: { sku: seed('ace-erp', 'price_list')[0].sku } })] }), () => ({ content: 'ok' })], { agentId: 'placemakers_sales_quote' });
    assert.ok(!tools(forced.requests[0]).some((n) => /connector/.test(n)), 'even a staff agent offers nothing to a shopper');
    assert.equal(forced.outcome.toolsCalled[0].ok, false);
  });

  test('another tenant cannot use this tenant\'s connection: the secret reference names placemakers, so a call made for any other tenant is refused before it is sent', async () => {
    const sent = server.hasTenant('someone-else');
    assert.equal(sent, false);
    const { toolResults } = await turn([
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'ace-erp', tool: 'trade_price', arguments: { sku: seed('ace-erp', 'price_list')[0].sku, tenantId: TENANT } })] }),
      () => ({ content: 'ok' }),
    ], { ...staff, tenantId: 'someone-else' });
    assert.equal(toolResults[0].body.ok, false);
    assert.equal(toolResults[0].body.status, 'failed');
    assert.match(toolResults[0].body.error, /CROSS_TENANT/);
  });

  test('the connection key never reaches the model, the chat stream or the audit, across every call of the file', async () => {
    const all = await turn([
      () => ({ toolCalls: SEEDS.size ? [...SEEDS.keys()].slice(0, 6).map((id, i) => call(`g${i}`, 'get_connector_tools', { connector: id })) : [] }),
      () => ({ content: 'Done.' }),
    ], staff);
    assert.ok(all.toolResults.every((r) => r.body.ok === true && r.body.tools.length >= 1));
    for (const [label, value] of [['model requests', all.requests], ['stream', all.events], ['audit', audit], ['tool results', all.toolResults]] as const) {
      assert.ok(!JSON.stringify(value).includes(KEY), `${label} hold no key`);
    }
    for (const event of audit) {
      assert.deepEqual(Object.keys(event).sort().filter((k) => !['errorType'].includes(k)), ['connectorId', 'correlationId', 'durationMs', 'environmentId', 'outcome', 'principalId', 'state', 'tenantId', 'tool'].sort());
    }
    assert.ok(audit.some((e) => e.outcome === 'success') && audit.some((e) => e.outcome === 'needs_approval') && audit.some((e) => e.outcome === 'blocked'));
  });
});
