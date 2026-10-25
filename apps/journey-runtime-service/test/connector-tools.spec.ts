import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpClientPool, StaticMcpServerDirectory } from '@journeyax/capability-sdk';
import { ModelGateway, type AgentExecutionRequest } from '../src/kernel/model.gateway';
import { AgentTurnLoop } from '../src/agent/agent-loop';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { startTestServer, structured } from '../../../packages/capability-sdk/test/helpers/mcp-test-server';
import { connectorList } from '../src/kernel/connector.runtime';
import { FakeApprovals, REGISTRY, SECRET_REF, SECRET_VALUE, TENANT, connectorPack, workspace } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

type Round = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }> };
type Step = (req: AgentExecutionRequest, round: number) => Round;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function setup(options: { registry?: unknown; tools?: Record<string, any> } = {}) {
  const server = await startTestServer({
    tools: {
      stock_by_branch: { description: 'Stock on hand for a product at a branch.', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] }, call: (args: any, seen: any) => structured({ ok: true, tenantHeader: seen.headers['x-tenant-id'], received: args, rows: [{ sku: args.sku, onHand: 12, sample: true }], echo: `key=${SECRET_VALUE}` }) },
      delivery_status: { description: 'Where a delivery is.', call: () => structured({ ok: true, status: 'on the truck' }) },
      reserve_stock: { description: 'Set stock aside for an order.', inputSchema: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'number' } } }, call: (args: any) => structured({ ok: true, reserved: args }) },
      secret_admin_tool: { description: 'A tool the pack does not list.', call: () => structured({ ok: true, admin: true }) },
      find_account: { description: 'Find an account.', call: () => structured({ ok: true, account: 'A-1' }) },
      create_case: { description: 'Open a case.', call: (args: any) => structured({ ok: true, case: args }) },
      ...(options.tools ?? {}),
    },
  });
  closers.push(server.close);
  const audit: any[] = [];
  const pool = new McpClientPool({
    directory: new StaticMcpServerDirectory({ 'stock-system': server.url, crm: server.url }),
    secrets: { resolve: async () => SECRET_VALUE },
    nodeEnv: 'test',
  });
  const gateway = new CapabilityGateway({ mcpClients: pool, connectorAudit: (event) => audit.push(event) });
  const approvals = new FakeApprovals();
  const release = connectorPack(options.registry === undefined ? REGISTRY : options.registry || undefined);
  return { server, audit, gateway, approvals, release };
}

type World = Awaited<ReturnType<typeof setup>>;

async function turn(world: World, steps: Step[], who: { role?: string; groups?: string[]; agentId?: string; message?: string; workspace?: any; customerEvent?: any; disabledConnectors?: string[] } = {}) {
  const model = new ModelGateway();
  const requests: AgentExecutionRequest[] = [];
  const toolMessages: string[] = [];
  let round = 0;
  model.mockAgentExecutor = async (req) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    for (const message of req.messages) if (message.role === 'tool') toolMessages.push(String(message.content));
    const step = steps[Math.min(round, steps.length - 1)];
    const out = step(req, round++);
    return { content: out.content ?? '', toolCalls: out.toolCalls ?? [] };
  };
  const emitted: any[] = [];
  const outcome = await new AgentTurnLoop().execute({
    command: {
      tenantId: TENANT, environmentId: 'test', workspaceId: 'ws-connector-test', sessionId: 'sess-1', correlationId: 'corr-1', message: who.message ?? 'Is there stock?',
      principalId: who.role ? `${who.role}@example.test` : undefined, principalRole: who.role, principalGroups: who.groups, agentId: who.agentId ?? 'front_desk',
      ...(who.customerEvent ? { customerEvent: who.customerEvent } : {}),
      ...(who.disabledConnectors ? { disabledConnectors: who.disabledConnectors } : {}),
    } as any,
    release: world.release,
    workspace: who.workspace ?? workspace(),
    modelGateway: model,
    catalogSearchHandler: { execute: async () => ({ products: [] }) } as any,
    capabilityGateway: world.gateway,
    approvalService: world.approvals as any,
    sink: (event, data) => emitted.push({ event, data }),
  });
  return { outcome, requests, toolMessages, emitted };
}

const call = (id: string, name: string, args: Record<string, any>) => ({ id, name, arguments: args });
const toolNames = (req: AgentExecutionRequest) => (req.tools ?? []).map((t) => t.name);
const parse = (text: string) => JSON.parse(text);
const lastTool = (toolMessages: string[]) => parse(toolMessages[toolMessages.length - 1]);

describe('Connector tools in the agent loop', () => {
  describe('the list the person sees in the chat\'s + menu, and switching a connector off for one chat', () => {
    const release = connectorPack(REGISTRY);
    const staff = { audience: 'staff' as const, groups: ['customer-service'] };

    test('the list is exactly what this person may use: tools they may call, ask-first ones marked, blocked ones left out, nothing a shopper may not', () => {
      const list = connectorList(release, staff);
      assert.deepEqual(list.map((item) => item.connector), ['stock-system', 'crm']);
      const stock = list.find((item) => item.connector === 'stock-system')!;
      assert.deepEqual(stock.tools.map((tool) => `${tool.name}:${tool.kind}:${tool.state}`), ['stock_by_branch:read:allow', 'delivery_status:read:allow', 'reserve_stock:write:ask']);
      const crm = list.find((item) => item.connector === 'crm')!;
      assert.deepEqual(crm.tools.map((tool) => `${tool.name}:${tool.state}`), ['find_account:allow', 'create_case:ask']);
      assert.equal(stock.sample, true);
      // finance staff are blocked from delivery_status, and have no CRM row
      const finance = connectorList(release, { audience: 'staff', groups: ['finance'] });
      assert.deepEqual(finance.map((item) => item.connector), ['stock-system']);
      assert.ok(!finance[0].tools.some((tool) => tool.name === 'delivery_status'));
      // a shopper may look up stock by branch and nothing else
      const shopper = connectorList(release, { audience: 'shopper', groups: [] });
      assert.deepEqual(shopper.map((item) => item.connector), ['stock-system']);
      assert.deepEqual(shopper[0].tools.map((tool) => tool.name), ['stock_by_branch']);
      assert.deepEqual(connectorList(connectorPack(undefined), staff), [], 'a pack without a registry lists nothing');
      assert.equal(JSON.stringify(list).includes('tenant-secret'), false, 'no secret reference reaches the person');
    });

    test('a connector switched off for the chat is left out of the prompt, and the connector tools refuse it; the others still work', async () => {
      const world = await setup();
      const { requests, toolMessages } = await turn(world, [
        () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system' }), call('c2', 'get_connector_tools', { connector: 'crm' })] }),
        () => ({ content: 'Done.' }),
      ], { role: 'operator', groups: ['customer-service'], disabledConnectors: ['stock-system'] });
      const prompt = requests[0].systemPrompt ?? '';
      assert.ok(!prompt.includes('- stock-system:'), 'the switched-off connector is not described to the model');
      assert.match(prompt, /- crm: Accounts and support cases\./);
      assert.match(toolMessages.join('\n'), /stock-system connector is switched off for this chat/);
      assert.match(toolMessages.join('\n'), /find_account/, 'the connector left on loads normally');
      assert.equal(world.server.seen.filter((seen: any) => /stock/.test(JSON.stringify(seen))).length, 0, 'nothing reached the switched-off connector\'s server');
    });

    test('a call to a switched-off connector never runs, even when the model names it', async () => {
      const world = await setup();
      const { toolMessages } = await turn(world, [
        () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1' } })] }),
        () => ({ content: 'Done.' }),
      ], { role: 'operator', groups: ['customer-service'], disabledConnectors: ['stock-system'] });
      assert.equal(lastTool(toolMessages).ok, false);
      assert.match(lastTool(toolMessages).error, /switched off for this chat/);
      assert.equal(world.server.seen.length, 0);
    });

    test('switching everything off removes the connector tools and text altogether, and a name the person has no right to cannot be switched on', async () => {
      const world = await setup();
      const { requests } = await turn(world, [() => ({ content: 'Hello.' })], { role: 'operator', groups: ['customer-service'], disabledConnectors: ['stock-system', 'crm'] });
      assert.ok(!toolNames(requests[0]).some((name) => /connector/.test(name)));
      assert.ok(!(requests[0].systemPrompt ?? '').includes('Connectors you can use'));
      // naming a connector only narrows: a shopper cannot gain the CRM by it
      const shopper = await turn(world, [() => ({ content: 'Hello.' })], { disabledConnectors: [] });
      assert.ok(!(shopper.requests[0].systemPrompt ?? '').includes('- crm:'));
    });
  });

  test('a pack without a registry changes nothing: no connector tool is offered, even to an agent that allows everything, and the prompt has no connector text', async () => {
    const world = await setup({ registry: null });
    const { requests } = await turn(world, [() => ({ content: 'Hello there.' })], { role: 'operator', agentId: 'everything' });
    assert.ok(!toolNames(requests[0]).some((name) => /connector/.test(name)), toolNames(requests[0]).join(','));
    assert.ok(!(requests[0].systemPrompt ?? '').includes('Connectors you can use'));
    assert.equal(world.server.seen.length, 0);
  });

  test('staff see connectors by name and description only; tools are loaded when asked, and not before', async () => {
    const world = await setup();
    let seenBeforeModel = -1;
    const { outcome, requests } = await turn(world, [
      (req) => { seenBeforeModel = world.server.seen.length; return { toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system' })] }; },
      () => ({ content: 'Done.' }),
    ], { role: 'operator', groups: ['customer-service'] });

    const prompt = requests[0].systemPrompt ?? '';
    assert.match(prompt, /# Connectors you can use/);
    assert.match(prompt, /- stock-system: Stock by branch and delivery status\. \(sample data\)/);
    assert.match(prompt, /- crm: Accounts and support cases\./);
    assert.ok(!prompt.includes('stock_by_branch') && !prompt.includes('reserve_stock'), 'no tool names in the prompt');
    assert.deepEqual(toolNames(requests[0]).filter((n) => /connector/.test(n)).sort(), ['call_connector_tool', 'get_connector_tools', 'list_connectors']);
    assert.equal(seenBeforeModel, 0, 'nothing was sent to any server before the model asked');
    assert.ok(world.server.seen.some((s) => s.method === 'tools/list'), 'the tools were listed when asked');
    assert.equal(outcome.toolsCalled[0].name, 'get_connector_tools');
  });

  test('get_connector_tools shows only what this person may use: unlisted and blocked tools are left out and only counted', async () => {
    const world = await setup();
    const staff = await turn(world, [() => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system' })] }), () => ({ content: 'ok' })], { role: 'operator', groups: ['customer-service'] });
    const listed = lastTool(staff.toolMessages);
    assert.deepEqual(listed.tools.map((t: any) => t.name).sort(), ['delivery_status', 'reserve_stock', 'stock_by_branch']);
    assert.equal(listed.hidden, 3, 'the server also offered a tool the pack does not list, and two belong to another connector');
    assert.equal(listed.tools.find((t: any) => t.name === 'reserve_stock').asksFirst, true);
    assert.equal(listed.tools.find((t: any) => t.name === 'reserve_stock').changesData, true);
    assert.equal(listed.tools.find((t: any) => t.name === 'stock_by_branch').asksFirst, false);
    assert.equal(listed.sample, true);
    assert.match(listed.notice, /sample data/);
    assert.ok(!JSON.stringify(listed).includes('secret_admin_tool'));

    const shopper = await turn(world, [() => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system' }), call('c2', 'get_connector_tools', { connector: 'crm' })] }), () => ({ content: 'ok' })]);
    const [stock, crm] = shopper.toolMessages.map(parse);
    assert.deepEqual(stock.tools.map((t: any) => t.name), ['stock_by_branch'], 'a shopper may only look up stock');
    assert.equal(crm.ok, false, 'a connector a shopper has no tool in does not exist for them');
    assert.deepEqual(crm.available, ['stock-system']);
    const finance = await turn(world, [() => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system', query: 'delivery' })] }), () => ({ content: 'ok' })], { role: 'manager', groups: ['finance'] });
    assert.ok(!lastTool(finance.toolMessages).tools.some((t: any) => t.name === 'delivery_status'), 'finance has delivery blocked');
  });

  test('call_connector_tool runs an allowed tool over MCP, and the result says it is sample data', async () => {
    const world = await setup();
    const { toolMessages, outcome } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1' } })] }),
      () => ({ content: 'Checked.' }),
    ], { role: 'operator', groups: ['customer-service'] });
    const result = parse(toolMessages[0]);
    assert.equal(result.ok, true);
    assert.equal(result.sample, true);
    assert.match(result.notice, /sample data/);
    assert.equal(result.result.rows[0].sku, 'S-1');
    assert.equal(outcome.toolsCalled[0].name, 'call_connector_tool');
    assert.equal(outcome.toolsCalled[0].ok, true);
    assert.equal(world.audit.length, 1);
    assert.equal(world.audit[0].outcome, 'success');
  });

  test('the tenant comes from the server, never from the model: a tenantId in the arguments is dropped and the server is told the real one', async () => {
    const world = await setup();
    const { toolMessages } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1', tenantId: 'someone-else', environmentId: 'production' } })] }),
      () => ({ content: 'ok' }),
    ], { role: 'operator' });
    const result = parse(toolMessages[0]);
    assert.equal(result.result.tenantHeader, TENANT);
    assert.deepEqual(result.result.received, { sku: 'S-1' });
    const toolCall = world.server.seen.filter((s) => s.method === 'tools/call').pop()!;
    assert.equal(toolCall.headers['x-tenant-id'], TENANT);
    assert.equal(toolCall.headers['x-environment-id'], 'test');
  });

  test('a blocked tool cannot run: nothing reaches the server, and the same goes for a tool the pack does not list', async () => {
    const world = await setup();
    const { toolMessages, outcome } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: { sku: 'S-1', quantity: 1 } }), call('c2', 'call_connector_tool', { connector: 'stock-system', tool: 'secret_admin_tool', arguments: {} }), call('c3', 'call_connector_tool', { connector: 'crm', tool: 'find_account', arguments: {} })] }),
      () => ({ content: 'ok' }),
    ]); // a shopper
    const [reserve, unlisted, crm] = toolMessages.map(parse);
    assert.equal(reserve.status, 'blocked');
    assert.equal(unlisted.status, 'blocked');
    assert.equal(crm.status, 'not_found');
    assert.equal(world.server.seen.filter((s) => s.method === 'tools/call').length, 0, 'no call reached the server');
    assert.ok(outcome.toolsCalled.every((t) => t.ok === false));
    assert.deepEqual(world.audit.map((e) => e.outcome), ['blocked', 'blocked', 'blocked']);
  });

  test('an ask-first tool waits for a person: no call runs until an approval for that exact call is given, and it is spent once', async () => {
    const world = await setup();
    const who = { role: 'operator', groups: ['customer-service'] };
    const args = { sku: 'S-1', quantity: 2 };
    const reserveCalls = () => world.server.seen.filter((s) => s.method === 'tools/call' && s.body.params.name === 'reserve_stock').length;

    const first = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args })] }), () => ({ content: 'Waiting for approval.' })], who);
    const waiting = lastTool(first.toolMessages);
    assert.equal(waiting.status, 'needs_approval');
    assert.match(waiting.message, /Nothing has been done yet/);
    assert.equal(waiting.connector, 'stock-system');
    assert.deepEqual(waiting.arguments, args);
    assert.ok(waiting.approvalRequestId.startsWith('apr_'));
    assert.ok(waiting.expiresAt);
    assert.equal(reserveCalls(), 0);
    assert.equal(world.approvals.records.size, 1, 'a pending approval was created through the approval service');

    // The model cannot approve its own call by naming the id: it is still pending.
    const early = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'x' })], who);
    assert.equal(lastTool(early.toolMessages).status, 'needs_approval');
    assert.equal(lastTool(early.toolMessages).approvalRequestId, waiting.approvalRequestId, 'still the same request, not a new one');
    assert.equal(reserveCalls(), 0);
    assert.equal(world.approvals.records.size, 1);

    // A person approves; an approval for other arguments does not unlock a different call.
    world.approvals.approve(waiting.approvalRequestId);
    const different = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: { sku: 'S-1', quantity: 99 }, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'x' })], who);
    assert.equal(lastTool(different.toolMessages).status, 'needs_approval');
    assert.equal(reserveCalls(), 0);

    const approved = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'Reserved.' })], who);
    assert.equal(lastTool(approved.toolMessages).ok, true);
    assert.deepEqual(lastTool(approved.toolMessages).result.reserved, args);
    assert.equal(reserveCalls(), 1);

    const reused = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args, approvalRequestId: waiting.approvalRequestId })] }), () => ({ content: 'x' })], who);
    assert.equal(lastTool(reused.toolMessages).status, 'needs_approval', 'an approval is spent once');
    assert.equal(reserveCalls(), 1);
    assert.deepEqual(world.audit.map((e) => e.outcome).filter((o) => o !== 'needs_approval'), ['success']);
  });

  describe('ask first on a card in the chat (connectors.askVia = "card")', () => {
    const cardRegistry = () => ({ ...REGISTRY, askVia: 'card' });
    const who = { role: 'operator', groups: ['customer-service'] };
    const args = { sku: 'S-1', quantity: 2 };
    const reserveCalls = (world: World) => world.server.seen.filter((s) => s.method === 'tools/call' && s.body.params.name === 'reserve_stock').length;
    const askTurn = (world: World, shared: any) => turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args })] }), () => ({ content: 'Waiting for your yes.' })], { ...who, workspace: shared });
    const tap = (world: World, shared: any, confirmationId: string, decision: 'allow' | 'deny') => turn(world, [() => ({ content: 'Done.' })], { ...who, workspace: shared, message: '', customerEvent: { type: 'confirmTool', payload: { confirmationId, decision } } });

    test('the call is held, the person is asked on a card, and no approval record is made and nothing reaches the server', async () => {
      const world = await setup({ registry: cardRegistry() });
      const shared = workspace();
      const first = await askTurn(world, shared);
      const held = lastTool(first.toolMessages);
      assert.equal(held.status, 'needs_confirmation');
      assert.match(held.confirmationId, /^cf_/);
      assert.equal(reserveCalls(world), 0);
      assert.equal(world.approvals.records.size, 0, 'no pending approval for an approver: the person in the chat decides');
      const card: any = first.outcome.turnResult.uiInstructions?.find((c) => c.component === 'confirm');
      assert.ok(card, 'the card is shown');
      assert.deepEqual(card.props.details.map((d: any) => `${d.label}: ${d.value}`), ['Connector: Stock system', 'Tool: reserve stock', 'Sku: S-1', 'Quantity: 2']);
    });

    test('Allow runs exactly the kept call, once; Not now runs nothing; the model cannot make the call run by naming anything', async () => {
      const world = await setup({ registry: cardRegistry() });
      const shared = workspace();
      const first = await askTurn(world, shared);
      const id = lastTool(first.toolMessages).confirmationId;
      // The model repeating the call, with an invented approval id, does not run it: it is held again (the same confirmation).
      const repeat = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args, approvalRequestId: 'apr_made_up' })] }), () => ({ content: 'x' })], { ...who, workspace: shared });
      assert.equal(lastTool(repeat.toolMessages).confirmationId, id, 'the same call is the same confirmation');
      assert.equal(reserveCalls(world), 0);
      const allowed = await tap(world, shared, id, 'allow');
      assert.equal(reserveCalls(world), 1, 'the kept call ran');
      assert.match(JSON.stringify(allowed.requests[0].messages), /which the person allowed/);
      const again = await tap(world, shared, id, 'allow');
      assert.equal(reserveCalls(world), 1, 'a confirmation is used once');
      assert.match(JSON.stringify(again.requests[0].messages), /could not be used \(unknown\)/);

      const second = await askTurn(world, shared);
      const declined = await tap(world, shared, lastTool(second.toolMessages).confirmationId, 'deny');
      assert.equal(reserveCalls(world), 1, 'Not now runs nothing');
      assert.match(JSON.stringify(declined.requests[0].messages), /chose not to allow/);
    });

    test('a shopper still cannot ask for a staff tool, and a tool that is blocked is not unlocked by a card', async () => {
      const world = await setup({ registry: cardRegistry() });
      const shopper = await turn(world, [() => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'reserve_stock', arguments: args })] }), () => ({ content: 'x' })]);
      assert.equal(lastTool(shopper.toolMessages).status, 'blocked');
      assert.ok(!shopper.outcome.turnResult.uiInstructions?.some((c) => c.component === 'confirm'));
      assert.equal(reserveCalls(world), 0);
    });
  });

  test('a connection secret never reaches the model, the trace or the audit, even when a server echoes it', async () => {
    const world = await setup();
    const { requests, emitted, outcome } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1' } })] }),
      () => ({ content: 'Done.' }),
    ], { role: 'operator' });
    assert.ok(world.server.seen.some((s) => s.headers.authorization === `Bearer ${SECRET_VALUE}`), 'the server did receive the secret');
    for (const [label, value] of [['model requests', requests], ['sink events', emitted], ['audit', world.audit], ['outcome', outcome.toolsCalled]] as const) {
      assert.ok(!JSON.stringify(value).includes(SECRET_VALUE), `${label} hold no secret`);
    }
    assert.match(JSON.stringify(requests), /\[redacted\]/);
    assert.ok(!JSON.stringify(world.audit).includes('S-1'), 'the audit holds no arguments');
  });

  test('an agent whose tool list does not name the connector tools cannot use them, and a refused call reaches nothing', async () => {
    const world = await setup();
    const { requests, outcome } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1' } })] }),
      () => ({ content: 'ok' }),
    ], { role: 'operator', agentId: 'no_connectors' });
    assert.ok(!toolNames(requests[0]).some((name) => /connector/.test(name)));
    assert.equal(outcome.toolsCalled[0].ok, false);
    assert.equal(world.server.seen.length, 0);
    const everything = await turn(world, [() => ({ content: 'Hi.' })], { role: 'operator', agentId: 'everything' });
    assert.ok(toolNames(everything.requests[0]).includes('call_connector_tool'), 'an agent that allows everything is offered them when the person has connectors');
  });

  test('a server that is down gives the model a short failure, not a crash', async () => {
    const world = await setup();
    await world.server.close();
    closers.length = 0;
    const { toolMessages, outcome } = await turn(world, [
      () => ({ toolCalls: [call('c1', 'get_connector_tools', { connector: 'stock-system' }), call('c2', 'call_connector_tool', { connector: 'stock-system', tool: 'stock_by_branch', arguments: { sku: 'S-1' } })] }),
      () => ({ content: 'ok' }),
    ], { role: 'operator' });
    const [listed, called] = toolMessages.map(parse);
    assert.equal(listed.ok, false);
    assert.equal(called.status, 'failed');
    assert.match(called.error, /Could not reach the MCP server/);
    assert.ok(outcome.toolsCalled.every((t) => t.ok === false));
    assert.equal(world.audit[0].errorType, 'unreachable');
  });
});
