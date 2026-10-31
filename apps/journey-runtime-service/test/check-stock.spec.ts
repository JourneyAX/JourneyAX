import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOL_DEFINITIONS, executeAgentTool, branchStockRoute, type AgentToolContext } from '../src/agent/agent-tools';
import { connectorPack, REGISTRY } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

const SKU = '1357711';
const ROWS = { records: [{ branchName: 'Te Anau', branchCode: '451', onHand: 1, reserved: 1, available: 0 }, { branchName: 'Albany', branchCode: '402', onHand: 12, reserved: 11, available: 1 }] };

function ctxFor(release: any, extra: Partial<AgentToolContext> = {}) {
  const catalogueCalls: any[] = [];
  const traces: any[] = [];
  const ctx = {
    tenantId: 'test-tenant', environmentId: 'test', correlationId: 'corr-stock', release,
    catalogSearchHandler: { execute: async (input: any) => { catalogueCalls.push(input); return { products: [{ sku: SKU, title: 'Shiplap weatherboard', inStock: true }] }; } },
    turnProductSkus: new Set<string>(), catalogProductCache: new Map(), readSourceIds: new Set<string>(), allowedClaimClasses: new Set<string>(), presentedCards: [], isHumanHandoffRequested: false,
    emitTrace: (name: string, payload: unknown) => traces.push({ name, payload }),
    ...extra,
  } as unknown as AgentToolContext;
  return { ctx, catalogueCalls, traces };
}

/** A stock system the pack names: answers branch by branch and records what it was asked. */
function stockSystem(answer: any = { ok: true, connector: 'stock-system', tool: 'stock_by_branch', result: ROWS }, offered = true) {
  const seen: any[] = [];
  return {
    seen,
    runtime: {
      summaries: () => (offered ? [{ connector: 'stock-system', name: 'Stock system', description: 'Stock by branch.' }] : []),
      call: async (_release: unknown, _person: unknown, _ctx: unknown, connector: string, tool: string, args: Record<string, unknown>) => { seen.push({ connector, tool, args }); return answer; },
    } as any,
  };
}

const withRoute = () => {
  const release: any = connectorPack(REGISTRY);
  release.extensions.branchStock = { connector: 'stock-system', tool: 'stock_by_branch', inputs: { sku: 'sku' }, extra: { limit: 25 }, note: 'Branch codes are three digits.' };
  return release;
};

describe('check_stock tells the truth about what it read', () => {
  test('without a stock system the answer is the catalogue flag, said as shop-wide, and a named branch is reported as NOT checked', async () => {
    const { ctx } = ctxFor(connectorPack(undefined));
    const result = await executeAgentTool('check_stock', { sku: SKU, branch: 'Te Anau' }, ctx);
    assert.equal(result.source, 'catalogue');
    assert.equal(result.inStock, true);
    assert.equal(result.branchChecked, false);
    assert.equal(result.branch, 'Te Anau');
    assert.match(result.message, /catalogue lists SKU 1357711 as in stock \(shop-wide\)/);
    assert.match(result.message, /Stock at Te Anau was NOT checked/);
    assert.match(result.message, /Do not say the item is in stock at Te Anau/);
    assert.doesNotMatch(result.message, /verified IN STOCK/);
    assert.ok(ctx.allowedClaimClasses.has('stock'), 'the catalogue flag still supports a shop-wide stock sentence');
  });

  test('without a branch named, the catalogue answer is plain, says shop-wide, and names no branch', async () => {
    const { ctx } = ctxFor(connectorPack(undefined));
    const result = await executeAgentTool('check_stock', { sku: SKU }, ctx);
    assert.equal(result.source, 'catalogue');
    assert.equal('branch' in result, false, 'no branch was asked for, so none is echoed back');
    assert.match(result.message, /shop-wide/);
    assert.doesNotMatch(result.message, /NOT checked/);
  });

  test('when the pack names the stock system\'s tool, the figures come from it branch by branch, with the pack\'s inputs, and the claim class is unlocked', async () => {
    const release = withRoute();
    const system = stockSystem();
    const { ctx, catalogueCalls, traces } = ctxFor(release, { connectorRuntime: system.runtime, principal: { audience: 'staff', groups: ['branch'] } });
    const result = await executeAgentTool('check_stock', { sku: SKU, branch: 'Te Anau' }, ctx);
    assert.equal(result.source, 'business_system');
    assert.equal(result.connector, 'stock-system');
    assert.equal(result.tool, 'stock_by_branch');
    assert.deepEqual(result.branchStock, ROWS, 'the system\'s rows reach the model as they are');
    assert.deepEqual(system.seen, [{ connector: 'stock-system', tool: 'stock_by_branch', args: { limit: 25, sku: SKU } }], 'the SKU goes under the pack\'s input name, with the pack\'s extras; the branch name is not passed when the tool wants a code');
    assert.match(result.message, /find Te Anau among the rows/);
    assert.match(result.message, /"available" \(on hand less reserved\) is what can be sold/);
    assert.match(result.message, /Branch codes are three digits\./, 'the pack\'s own note is carried');
    assert.equal('inStock' in result, false, 'no single yes/no is made up from several branches');
    assert.ok(ctx.allowedClaimClasses.has('stock') && ctx.allowedClaimClasses.has('catalog_fact'));
    assert.ok(ctx.usedConnectorIds?.has('stock-system'));
    assert.equal(catalogueCalls.length, 0, 'the catalogue was not read when the system answered');
    assert.equal(ctx.turnProductSkus.has(SKU), false, 'the SKU is not counted as a catalogue product this turn, so a card or quote for it still needs a product lookup');
    assert.deepEqual(traces, [{ name: 'connector_call', payload: { connector: 'stock-system', tool: 'stock_by_branch', outcome: 'success' } }]);
  });

  test('when the pack says the tool takes the branch as the person says it, the branch is passed under that name', async () => {
    const release = withRoute();
    release.extensions.branchStock.inputs = { sku: 'productCode', branch: 'branchName' };
    const system = stockSystem();
    const { ctx } = ctxFor(release, { connectorRuntime: system.runtime, principal: { audience: 'staff', groups: ['branch'] } });
    await executeAgentTool('check_stock', { sku: SKU, branch: 'Albany' }, ctx);
    assert.deepEqual(system.seen[0].args, { limit: 25, productCode: SKU, branchName: 'Albany' });
  });

  test('a connector switched off for the chat, not offered to this person, or failing, leaves the catalogue answer with the branch reported as NOT checked', async () => {
    const release = withRoute();
    for (const [label, runtime, extra] of [
      ['switched off', stockSystem().runtime, { disabledConnectors: new Set(['stock-system']) }],
      ['not offered', stockSystem(undefined, false).runtime, {}],
      ['failing', stockSystem({ ok: false, status: 'failed', error: 'Stock system is not answering.' }).runtime, {}],
    ] as const) {
      const { ctx } = ctxFor(release, { connectorRuntime: runtime, principal: { audience: 'staff', groups: ['branch'] }, ...(extra as any) });
      const result = await executeAgentTool('check_stock', { sku: SKU, branch: 'Te Anau' }, ctx);
      assert.equal(result.source, 'catalogue', label);
      assert.equal(result.branchChecked, false, label);
      assert.match(result.message, /Stock at Te Anau was NOT checked/, label);
      assert.match(result.message, /read the branch figures from the business system/, `${label}: with connectors in the chat, the model is pointed at them`);
    }
  });

  test('the pack setting is read strictly: a missing or odd connector or tool name means no route', () => {
    assert.equal(branchStockRoute({ extensions: {} }), undefined);
    assert.equal(branchStockRoute({ extensions: { branchStock: { connector: 'stock system!', tool: 'stock_by_branch' } } }), undefined);
    assert.equal(branchStockRoute({ extensions: { branchStock: { connector: 'stock-system' } } }), undefined);
    assert.deepEqual(branchStockRoute({ extensions: { branchStock: { connector: 'stock-system', tool: 'stock_by_branch' } } }), { connector: 'stock-system', tool: 'stock_by_branch', inputs: undefined, extra: undefined, note: undefined });
  });

  test('the tool description tells the model what a branch claim needs', () => {
    const tool = AGENT_TOOL_DEFINITIONS.find((entry) => entry.name === 'check_stock')!;
    assert.match(tool.description, /branch by branch/);
    assert.match(tool.description, /shop-wide/);
    assert.match(tool.description, /only a branch row from it supports/);
    assert.doesNotMatch(tool.description, /real-time/);
  });
});
