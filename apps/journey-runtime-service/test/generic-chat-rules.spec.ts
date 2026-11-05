import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaceMakersStack } from './helpers/placemakers-stack';
import { buildAbercrombieStack, ABERCROMBIE_TENANT, ABERCROMBIE_ENV } from './helpers/abercrombie-stack';
import { GENERIC_PLATFORM_OPERATING_PROMPT } from '../src/agent/agent-loop';
import { shapeSentence, compileShapeContext } from '../src/kernel/reply-shaper';
import { validateOkfGeneratedClaims } from '../src/kernel/okf-claim-validator';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { QuoteCreateHandler } from '../src/capabilities/handlers/quote-create.handler';

/** Explicit isolated source receipt, rather than the catalogue's historical inStock boolean. */
function sourceStockContext(pack: any, sku: string, available: number) {
  const release = structuredClone(pack);
  release.extensions.branchStock = { connector: 'fixture-inventory', tool: 'stock_by_branch', inputs: { sku: 'sku' } };
  release.extensions.connectors = { connectors: [{ connectorId: 'fixture-inventory', displayName: 'Isolated inventory', sample: false, tools: [{ name: 'stock_by_branch', sideEffect: 'read', claimClasses: ['stock'] }] }] };
  const calls: any[] = [];
  const rows = { records: [{ branchName: 'Auckland Central', sku, onHand: available, reserved: 0, available }] };
  const ctx = {
    tenantId: release.manifest.tenantId, environmentId: 'test', correlationId: `fixture-stock-${sku}`, release,
    catalogSearchHandler: { execute: async () => { throw new Error('Catalogue flags are not the inventory source.'); } },
    turnProductSkus: new Set(), catalogProductCache: new Map(), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false,
    principal: { audience: 'shopper', groups: [] },
    connectorRuntime: {
      summaries: () => [{ connector: 'fixture-inventory', name: 'Isolated inventory' }],
      call: async (_release: unknown, _person: unknown, _ctx: unknown, connector: string, tool: string, args: unknown) => {
        calls.push({ connector, tool, args });
        return { ok: true, connector, tool, result: rows };
      },
    },
  } as unknown as AgentToolContext;
  return { ctx, calls, rows };
}

test('P6: Generic Chat Rules across Five Scenario Fixtures for Both Tenants', async (t) => {
  // ── Rule 1: Tool Narration Suppression (Platform prompt & shaper unit check) ──
  await t.test('Platform & Shaper: Tool narration is explicitly forbidden and dropped by reply shaper', () => {
    // 1. Operating prompt contains tool narration prohibition
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /Tool narration must not be spoken to the customer/i,
      'Prompt must prohibit tool narration'
    );
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /I will now search the catalogue/i,
      'Prompt must list example tool narration to forbid'
    );

    // 2. Reply shaper drops tool narration sentences
    const shapeCtx = compileShapeContext({
      style: {
        maxSentences: 3,
        dropListLines: false,
        dropInternalIds: true,
        dropDirectingToBrowse: true,
        maxQuestions: 1,
        allowFollowUpQuestion: true,
        dropCompanyName: false,
        forbiddenPhrases: [],
        rules: [],
      },
      companyNames: [],
      internalIds: [],
      questionCardShown: false,
      turnKind: 'search_results',
    });

    const narration1 = shapeSentence('I will now search the catalogue for matching timber products.', shapeCtx);
    assert.equal(narration1.keep, false);
    assert.equal(narration1.reason, 'tool narration');

    const narration2 = shapeSentence('Let me consult business knowledge for installation guidelines.', shapeCtx);
    assert.equal(narration2.keep, false);
    assert.equal(narration2.reason, 'tool narration');

    const narration3 = shapeSentence('Searching the catalogue for hoodies.', shapeCtx);
    assert.equal(narration3.keep, false);
    assert.equal(narration3.reason, 'tool narration');

    const normal = shapeSentence('We have 100x50 framing timber available for your project.', shapeCtx);
    assert.equal(normal.keep, true);
  });

  // ── Scenario Fixture 1: No Tool Narration Spoken to Customer ──
  await t.test('Scenario Fixture 1 (PlaceMakers): Agent executes tools without speaking tool narration', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });

    const result = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-narration-pm',
      sessionId: 'sess-narration-pm',
      turnId: 'turn-narration-pm-1',
      message: 'Show me your 100x50 timber',
      correlationId: 'corr-narration-pm-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const reply = result.assistantMessage || '';
    assert.ok(reply.length > 0, 'Must produce a customer response');
    assert.doesNotMatch(reply, /I will now search/i, 'Must not speak search tool narration');
    assert.doesNotMatch(reply, /Let me consult/i, 'Must not speak knowledge tool narration');
    assert.doesNotMatch(reply, /Searching the catalogue/i, 'Must not speak searching narration');
    assert.doesNotMatch(reply, /Consulting business knowledge/i, 'Must not speak consulting narration');
  });

  await t.test('Scenario Fixture 1 (Abercrombie): Agent executes tools without speaking tool narration', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();

    const result = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-narration-anf',
      sessionId: 'sess-narration-anf',
      turnId: 'turn-narration-anf-1',
      message: 'Show me your hoodies',
      correlationId: 'corr-narration-anf-1',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const reply = result.assistantMessage || '';
    assert.ok(reply.length > 0, 'Must produce a customer response');
    assert.doesNotMatch(reply, /I will now search/i, 'Must not speak search tool narration');
    assert.doesNotMatch(reply, /Let me consult/i, 'Must not speak knowledge tool narration');
    assert.doesNotMatch(reply, /Searching the catalogue/i, 'Must not speak searching narration');
  });

  // ── Scenario Fixture 2: Grounded Claims & Evidence Citation ──
  await t.test('Scenario Fixture 2 (PlaceMakers): Agent answers technical inquiry citing verified evidence', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });

    const result = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-evidence-pm',
      sessionId: 'sess-evidence-pm',
      turnId: 'turn-evidence-pm-1',
      message: 'How do I install decking screws correctly?',
      correlationId: 'corr-evidence-pm-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const reply = result.assistantMessage || '';
    assert.ok(reply.length > 0, 'Must produce an answer');
    assert.match(
      reply,
      /verified|guidance|specifications|manufacturer|code/i,
      `Answer must cite verified guidance or standards: ${reply}`
    );
  });

  await t.test('Scenario Fixture 2 (Abercrombie): Agent answers warranty inquiry citing verified terms', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();

    const result = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-evidence-anf',
      sessionId: 'sess-evidence-anf',
      turnId: 'turn-evidence-anf-1',
      message: 'What is the warranty on Abercrombie essential hoodies?',
      correlationId: 'corr-evidence-anf-1',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const reply = result.assistantMessage || '';
    assert.ok(reply.length > 0, 'Must produce an answer');
    assert.match(
      reply,
      /warranty|guarantee|return|coverage/i,
      `Answer must cite verified warranty terms: ${reply}`
    );
  });

  // ── Scenario Fixture 3: Discontinued Product Exclusion ──
  await t.test('Scenario Fixture 3 (PlaceMakers): Discontinued products are excluded from recommendations and quote creation', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });

    // Step A: Search for decking items - discontinued framing timber (DISC-1) must not be returned
    const searchRes = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-disc-pm',
      sessionId: 'sess-disc-pm',
      turnId: 'turn-disc-pm-1',
      message: 'Show me decking products',
      correlationId: 'corr-disc-pm-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyA = searchRes.assistantMessage || '';
    assert.doesNotMatch(replyA, /DISC-1|Legacy discontinued framing timber/i, 'Discontinued item must not be recommended');

    // Step B: Attempt to create quote for discontinued SKU
    const quoteRes = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-disc-pm',
      sessionId: 'sess-disc-pm',
      turnId: 'turn-disc-pm-2',
      message: 'Please create a quote for SKU DISC-1',
      correlationId: 'corr-disc-pm-2',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyB = quoteRes.assistantMessage || '';
    assert.match(
      replyB,
      /cannot|discontinued|active|catalogue/i,
      `Agent must refuse to quote discontinued product: ${replyB}`
    );
  });

  await t.test('Scenario Fixture 3 (Abercrombie): Discontinued products are excluded from recommendations and cart addition', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();

    // Step A: Search for hoodies - ANF-HOODIE-DISC must not be in customer recommendations
    const searchRes = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-disc-anf',
      sessionId: 'sess-disc-anf',
      turnId: 'turn-disc-anf-1',
      message: 'Show me all hoodies',
      correlationId: 'corr-disc-anf-1',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyA = searchRes.assistantMessage || '';
    assert.doesNotMatch(replyA, /ANF-HOODIE-DISC|Vintage Arch Logo/i, 'Discontinued hoodie must not be recommended');

    // Step B: Direct attempt to add discontinued item to cart
    const cartRes = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-disc-anf',
      sessionId: 'sess-disc-anf',
      turnId: 'turn-disc-anf-2',
      message: 'Please add to cart SKU ANF-HOODIE-DISC',
      correlationId: 'corr-disc-anf-2',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyB = cartRes.assistantMessage || '';
    assert.match(
      replyB,
      /cannot|discontinued|active|store/i,
      `Agent must refuse to add discontinued item to cart: ${replyB}`
    );
  });

  // ── Scenario Fixture 4: Stock Claims from check_stock Only ──
  await t.test('Scenario Fixture 4 (PlaceMakers): In-stock claims are only made if check_stock verified them', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });

    // Step A: Catalog search without stock check does NOT authorize saying "in stock"
    const validationWithoutCheckStock = validateOkfGeneratedClaims(
      'This timber framing is in stock and available now.',
      ['catalog_fact'] // 'stock' claim class is absent
    );
    assert.equal(validationWithoutCheckStock.valid, false);
    assert.deepEqual(validationWithoutCheckStock.forbidden, ['stock']);

    // Step B: Explicit stock check for in-stock SKU
    const inStockRes = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-stock-pm',
      sessionId: 'sess-stock-pm',
      turnId: 'turn-stock-pm-1',
      message: 'Is SKU 1000100 in stock at Auckland Central?',
      correlationId: 'corr-stock-pm-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyInStock = inStockRes.assistantMessage || '';
    assert.match(replyInStock, /not been confirmed/i, 'A catalogue inStock flag is not a live inventory receipt');
    assert.doesNotMatch(replyInStock, /verified in stock|is in stock|out of stock/i);

    // Step C: Stock check for out-of-stock SKU (OOS-1)
    const oosRes = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-stock-pm',
      sessionId: 'sess-stock-pm',
      turnId: 'turn-stock-pm-2',
      message: 'Check stock for SKU OOS-1 at Auckland Central',
      correlationId: 'corr-stock-pm-2',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyOos = oosRes.assistantMessage || '';
    assert.match(replyOos, /not been confirmed/i, 'A catalogue false flag cannot establish current out-of-stock status either');
    assert.doesNotMatch(replyOos, /verified in stock|is in stock|out of stock/i);

    for (const available of [7, 0]) {
      const { ctx, rows, calls } = sourceStockContext(stack.pack, '1000100', available);
      const receipt = await executeAgentTool('check_stock', { sku: '1000100', branch: 'Auckland Central' }, ctx);
      assert.equal(receipt.source, 'business_system');
      assert.deepEqual(receipt.branchStock, rows);
      assert.equal(calls.length, 1, 'the declared inventory source actually answered');
      assert.equal(ctx.allowedClaimClasses.has('stock'), true);
      assert.equal(validateOkfGeneratedClaims(available ? 'The source lists this item in stock.' : 'The source lists this item out of stock.', [...ctx.allowedClaimClasses]).valid, true);
    }
  });

  await t.test('Scenario Fixture 4 (Abercrombie): In-stock claims are only made if check_stock verified them', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();

    // Step A: In-stock SKU (ANF-HOODIE-BLK)
    const inStockRes = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-stock-anf',
      sessionId: 'sess-stock-anf',
      turnId: 'turn-stock-anf-1',
      message: 'Is SKU ANF-HOODIE-BLK in stock?',
      correlationId: 'corr-stock-anf-1',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyInStock = inStockRes.assistantMessage || '';
    assert.match(replyInStock, /not been confirmed/i, 'Apparel catalogue availability is not an authoritative inventory read');
    assert.doesNotMatch(replyInStock, /verified in stock|is in stock|out of stock/i);

    // Step B: Out-of-stock SKU (ANF-TEE-OOS)
    const oosRes = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-stock-anf',
      sessionId: 'sess-stock-anf',
      turnId: 'turn-stock-anf-2',
      message: 'Is SKU ANF-TEE-OOS in stock?',
      correlationId: 'corr-stock-anf-2',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const replyOos = oosRes.assistantMessage || '';
    assert.match(replyOos, /not been confirmed/i);
    assert.doesNotMatch(replyOos, /verified in stock|is in stock|out of stock/i);
    for (const available of [4, 0]) {
      const { ctx, rows, calls } = sourceStockContext(stack.release, 'ANF-HOODIE-BLK', available);
      const receipt = await executeAgentTool('check_stock', { sku: 'ANF-HOODIE-BLK', branch: 'Auckland Central' }, ctx);
      assert.equal(receipt.source, 'business_system');
      assert.deepEqual(receipt.branchStock, rows);
      assert.equal(calls.length, 1);
      assert.equal(ctx.allowedClaimClasses.has('stock'), true);
    }
  });

  // ── Scenario Fixture 5: End-to-End Customer Consultation & Action Scenario ──
  await t.test('Scenario Fixture 5 (PlaceMakers): End-to-end customer consultation adheres to all rules', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });

    // Multi-turn consultation: search products -> customer adds to quote -> agent responds with next step
    const turn1 = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-e2e-pm',
      sessionId: 'sess-e2e-pm',
      turnId: 'turn-e2e-pm-1',
      message: 'Find timber screws for my deck framing project',
      correlationId: 'corr-e2e-pm-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const msg1 = turn1.assistantMessage || '';
    assert.doesNotMatch(msg1, /I will now search/i, 'Turn 1 must not contain tool narration');
    assert.match(msg1, /available|options|matching/i, 'Turn 1 must provide product information');

    // Customer performs quote addition action event
    const turn2 = await service.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId: 'ws-e2e-pm',
      sessionId: 'sess-e2e-pm',
      turnId: 'turn-e2e-pm-2',
      message: '',
      customerEvent: {
        type: 'addToQuote',
        payload: { sku: '1000100', title: 'Exterior wood screw 8g x 50mm', quantity: 50 },
      },
      correlationId: 'corr-e2e-pm-2',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const msg2 = turn2.assistantMessage || '';
    assert.doesNotMatch(msg2, /I will now search|calling the/i, 'Turn 2 must not contain tool narration');
    assert.match(msg2, /quote/i, 'Turn 2 must acknowledge the quote action');
    assert.match(msg2, /now|next step|proceed|review/i, 'Turn 2 must provide actionable next step');
    assert.doesNotMatch(msg2, /I(?:'ve| have) added|quote has been created|successfully created/i, 'A browser action does not prove a saved quote');
    assert.equal(stack.db.dump('quotes').length, 0, 'the browser event alone creates no quote');

    // The quote capability itself must execute against the authoritative isolated catalogue/store before a commit can be claimed.
    // The product-advisor fixture does not grant create_quote, so do not silently expand its permissions just for this positive.
    const handler = new QuoteCreateHandler(undefined, undefined, undefined, async () => stack.db as any);
    const quote = await handler.execute({ items: [{ sku: '1000100', quantity: 10 }] }, {
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-e2e-pm', sessionId: 'sess-e2e-pm',
      correlationId: 'corr-e2e-pm-3', idempotencyKey: 'quote-e2e-pm-3', principalId: 'builder-dan',
      release: stack.pack, packSettings: { catalogMapping: stack.pack.catalogMapping },
    } as any);
    const quotes = stack.db.dump('quotes');
    assert.equal(quotes.length, 1, 'a successful quote claim requires the actual handler to persist a quote');
    assert.equal(quotes[0].lines[0].sku, '1000100');
    assert.equal(quotes[0].lines[0].unitPrice, 12.5, 'the price comes from the mapped catalogue rather than the event or model');
    assert.equal(quotes[0].principalId, 'builder-dan');
    assert.equal(quote.quoteId, quotes[0].quoteId);
  });

  await t.test('Scenario Fixture 5 (Abercrombie): End-to-end customer shopping adheres to all rules', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();

    // Turn 1: Search products
    const turn1 = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-e2e-anf',
      sessionId: 'sess-e2e-anf',
      turnId: 'turn-e2e-anf-1',
      message: 'I am looking for a black hoodie',
      correlationId: 'corr-e2e-anf-1',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const msg1 = turn1.assistantMessage || '';
    assert.doesNotMatch(msg1, /I will now search/i, 'Turn 1 must not contain tool narration');
    assert.match(msg1, /available|options|matching|hoodie/i, 'Turn 1 must present items');

    // Turn 2: Customer performs cart addition action event
    const turn2 = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-e2e-anf',
      sessionId: 'sess-e2e-anf',
      turnId: 'turn-e2e-anf-2',
      message: '',
      customerEvent: {
        type: 'addToCart',
        payload: { sku: 'ANF-HOODIE-BLK', title: 'Essential Popover Hoodie - Black', quantity: 1 },
      },
      correlationId: 'corr-e2e-anf-2',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    } as any);

    const msg2 = turn2.assistantMessage || '';
    assert.doesNotMatch(msg2, /I will now search|calling the/i, 'Turn 2 must not contain tool narration');
    assert.match(msg2, /cart/i, 'Turn 2 must acknowledge cart addition');
    assert.match(msg2, /now|next step|proceed|checkout/i, 'Turn 2 must provide actionable next step');
  });
});
