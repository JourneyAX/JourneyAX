import assert from 'node:assert/strict';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { PricingValidateHandler } from '../src/capabilities/handlers/pricing-validate.handler';
import { OrderCommitHandler } from '../src/capabilities/handlers/order-commit.handler';
import { TradeQuoteCreateHandler } from '../src/capabilities/handlers/trade-quote-create.handler';
import { ProjectPlanHandler } from '../src/capabilities/handlers/project-plan.handler';
import { KnowledgeSearchHandler } from '../src/capabilities/handlers/knowledge-search.handler';
import { ExecutionContext } from '@journeyax/capability-sdk';

const mockContext: ExecutionContext = {
  tenantId: 'tenant-test-grounded',
  environmentId: 'test',
  workspaceId: 'ws-grounded-01',
  sessionId: 'sess-grounded-01',
  stageId: 'stage-selection',
  packVersionId: '1.0.0',
  correlationId: 'corr-grounded-101',
  idempotencyKey: 'idem-grounded-ctx-101',
};

const sampleCatalog = [
  {
    projectId: 'tenant-test-grounded',
    sku: 'BOOT-STEEL-01',
    parentSku: 'BOOT-STEEL',
    name: 'Heavy Duty Steel Toe Work Boot',
    category: 'Footwear',
    price: { amount: 180.0, currency: 'AUD' },
    stock: { inStock: true, availableQuantity: 25 },
    safety: {
      toeProtection: 'steel',
      certifications: ['AS/NZS 2210.3', 'ASTM F2413'],
    },
  },
  {
    projectId: 'tenant-test-grounded',
    sku: 'BOOT-COMP-02',
    parentSku: 'BOOT-COMP',
    name: 'Lightweight Composite Toe Athletic Boot',
    category: 'Footwear',
    price: { amount: 210.0, currency: 'AUD' },
    stock: { inStock: false, availableQuantity: 0 },
    safety: {
      toeProtection: 'composite',
      certifications: ['AS/NZS 2210.3'],
    },
  },
  {
    projectId: 'tenant-test-grounded',
    sku: 'VEST-HI-VIS-01',
    parentSku: 'VEST-HI-VIS',
    name: 'Day/Night Hi-Vis Safety Vest',
    category: 'Hi-Vis',
    price: { amount: 35.0, currency: 'AUD' },
    stock: { inStock: true, availableQuantity: 100 },
    safety: {
      certifications: ['AS/NZS 4602.1'],
    },
  },
  {
    projectId: 'tenant-test-grounded',
    sku: 'GLOVE-NITRILE-USD',
    name: 'Chemical Nitrile Gloves (Imported)',
    category: 'PPE',
    price: { amount: 25.0, currency: 'USD' },
    stock: { inStock: true, availableQuantity: 50 },
    safety: {
      certifications: ['EN 388'],
    },
  },
];

async function runCatalogOrderPortsTests() {
  console.log('🛒 Running PR 5: Grounded Catalog & Order Ports Verification Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // --- 1. Catalog Search Grounding ---
  await test('1. Catalog search filters by category and text query with safe regex', async () => {
    const handler = new CatalogSearchHandler(sampleCatalog);
    const result = await handler.execute(
      { category: 'Footwear', query: 'steel' },
      mockContext
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sku, 'BOOT-STEEL');
    assert.equal(result.items[0].inStock, true);
    assert.equal(result.items[0].priceCents, 18000);
  });

  await test('2. Catalog search enforces inStockOnly and does not fabricate stock for out-of-stock items', async () => {
    const handler = new CatalogSearchHandler(sampleCatalog);

    // Search without filter returns both in-stock and out-of-stock
    const all = await handler.execute({ category: 'Footwear' }, mockContext);
    assert.equal(all.items.length, 2);

    // inStockOnly excludes out-of-stock item
    const inStockOnly = await handler.execute(
      { category: 'Footwear', inStockOnly: true },
      mockContext
    );
    assert.equal(inStockOnly.items.length, 1);
    assert.equal(inStockOnly.items[0].sku, 'BOOT-STEEL');
  });

  await test('3. Catalog search validates safety certifications grounded against records', async () => {
    const handler = new CatalogSearchHandler(sampleCatalog);
    const result = await handler.execute(
      { requiredCertifications: ['ASTM F2413'] },
      mockContext
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sku, 'BOOT-STEEL');
  });

  // --- 2. Pricing Validation Grounding ---
  await test('4. Pricing validation computes accurate totals for valid in-stock items', async () => {
    const handler = new PricingValidateHandler(sampleCatalog);
    const result = await handler.execute(
      { skus: ['BOOT-STEEL-01', 'VEST-HI-VIS-01'] },
      mockContext
    );

    assert.equal(result.valid, true);
    assert.equal(result.totalCents, 21500); // 18000 + 3500
    assert.equal(result.currency, 'AUD');
    assert.equal(result.items.length, 2);
  });

  await test('5. Pricing validation fails closed when multi-currency items are mixed in cart', async () => {
    const handler = new PricingValidateHandler(sampleCatalog);
    const result = await handler.execute(
      { skus: ['BOOT-STEEL-01', 'GLOVE-NITRILE-USD'] }, // AUD and USD
      mockContext
    );

    assert.equal(result.valid, false);
    assert(result.reason?.includes('Multi-currency'));
  });

  await test('6. Pricing validation marks valid: false when items are out of stock', async () => {
    const handler = new PricingValidateHandler(sampleCatalog);
    const result = await handler.execute(
      { skus: ['BOOT-STEEL-01', 'BOOT-COMP-02'] }, // BOOT-COMP is out of stock
      mockContext
    );

    assert.equal(result.valid, false);
    assert.equal(result.details.allInStock, false);
  });

  // --- 3. Order Commit Grounding ---
  await test('7. Order commit rejects empty cart or invalid negative items', async () => {
    const handler = new OrderCommitHandler();
    await assert.rejects(async () => {
      await handler.execute({ items: [] }, mockContext);
    }, /Cannot commit order with empty cart/);

    await assert.rejects(async () => {
      await handler.execute(
        { items: [{ sku: 'SKU-NEG', quantity: -1, priceCents: 100 }] },
        mockContext
      );
    }, /Invalid item quantity/);
  });

  await test('8. Order commit creates grounded order with real totals and zero fabricated URLs', async () => {
    const inMemoryOrders: any[] = [];
    const handler = new OrderCommitHandler(inMemoryOrders, sampleCatalog);

    const result = await handler.execute(
      {
        quoteId: 'quote-test-99',
        currency: 'AUD',
        items: [
          { sku: 'BOOT-STEEL-01', quantity: 2, priceCents: 18000 },
          { sku: 'VEST-HI-VIS-01', quantity: 5, priceCents: 3500 },
        ],
        customerEmail: 'contractor@safety.com.au',
      },
      mockContext
    );

    assert.ok(result.orderId.startsWith('ord_'));
    assert.equal(result.status, 'pending_payment');
    assert.equal(result.totalCents, 36000 + 17500); // 53500
    assert.equal(result.currency, 'AUD');
    assert.equal(result.itemsCount, 2);

    // Verify persisted in store
    assert.equal(inMemoryOrders.length, 1);
    assert.equal(inMemoryOrders[0].orderId, result.orderId);
    assert.equal(inMemoryOrders[0].totalCents, 53500);
    assert.equal(inMemoryOrders[0].projectId, 'tenant-test-grounded');
  });

  // --- 4. Strict Budget, Composite Toe & Authoritative Pricing Tests ---
  await test('9. Catalog search applies minPriceCents and maxPriceCents strictly', async () => {
    const handler = new CatalogSearchHandler(sampleCatalog);

    // Search items between $40 and $200 AUD (4000 to 20000 cents)
    // BOOT-STEEL-01 is $180 (18000), VEST is $35 (3500), BOOT-COMP is $210 (21000)
    const result = await handler.execute(
      { minPriceCents: 4000, maxPriceCents: 20000, currency: 'AUD' },
      mockContext
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sku, 'BOOT-STEEL');
    assert.equal(result.items[0].priceCents, 18000);
  });

  await test('10. Catalog search strictly separates composite toe from steel toe (steel toe never matches composite)', async () => {
    const handler = new CatalogSearchHandler(sampleCatalog);

    const compResult = await handler.execute(
      { toeType: 'composite' },
      mockContext
    );
    // BOOT-COMP-02 has toeProtection: 'composite'; BOOT-STEEL-01 has 'steel'
    assert.equal(compResult.items.length, 1);
    assert.equal(compResult.items[0].sku, 'BOOT-COMP');
    assert.equal(compResult.items[0].toeProtection, 'composite');

    const steelResult = await handler.execute(
      { toeType: 'steel' },
      mockContext
    );
    assert.equal(steelResult.items.length, 1);
    assert.equal(steelResult.items[0].sku, 'BOOT-STEEL');
    assert.equal(steelResult.items[0].toeProtection, 'steel');
  });

  await test('11. Order commit rejects fabricated caller price differing from authoritative catalog snapshot', async () => {
    const handler = new OrderCommitHandler([], sampleCatalog);

    // BOOT-STEEL-01 is $180 (18000 cents) in catalog, but caller attempts $50 (5000 cents)
    await assert.rejects(async () => {
      await handler.execute(
        {
          items: [{ sku: 'BOOT-STEEL-01', quantity: 1, priceCents: 5000 }],
        },
        mockContext
      );
    }, /Authoritative price mismatch/);
  });

  await test('12. Order commit rejects out-of-stock items referenced in authoritative catalog', async () => {
    const handler = new OrderCommitHandler([], sampleCatalog);

    // BOOT-COMP-02 is stock.inStock: false
    await assert.rejects(async () => {
      await handler.execute(
        {
          items: [{ sku: 'BOOT-COMP-02', quantity: 1, priceCents: 21000 }],
        },
        mockContext
      );
    }, /is out of stock/);
  });

  await test('13. Order commit idempotent replay returns cached order without duplicate persistence', async () => {
    const inMemoryOrders: any[] = [];
    const handler = new OrderCommitHandler(inMemoryOrders, sampleCatalog);

    const cmd = {
      idempotencyKey: 'idem-order-token-77',
      items: [{ sku: 'BOOT-STEEL-01', quantity: 1, priceCents: 18000 }],
    };

    const first = await handler.execute(cmd, mockContext);
    assert.equal(inMemoryOrders.length, 1);

    const second = await handler.execute(cmd, mockContext);
    assert.equal(inMemoryOrders.length, 1, 'Duplicate idempotency key MUST NOT insert second order');
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.replayed, true);
  });

  await test('13a. OKF order commit rejects items that do not equal the authoritative scoped cart', async () => {
    const handler = new OrderCommitHandler([], sampleCatalog, undefined, async () => ({
      projectId: 'tenant-test-grounded', workspaceId: mockContext.workspaceId,
      cartId: 'cart-authoritative', status: 'active',
      items: [{ sku: 'BOOT-STEEL-01', quantity: 1 }, { sku: 'VEST-HI-VIS', quantity: 1 }],
    }));
    await assert.rejects(() => handler.execute({
      idempotencyKey: 'unsafe-subset', cartId: 'cart-authoritative',
      items: [{ sku: 'BOOT-STEEL-01', quantity: 1 }],
    }, { ...mockContext, requiresAuthoritativeCart: true } as any), /authoritative cart mismatch/i);
  });

  await test('14. Order commit fails closed when storage layer is unavailable or persistence fails', async () => {
    // When no in-memory storage and no MONGODB_URI, handler MUST throw and never return pending_payment
    delete process.env.MONGODB_URI;
    const handler = new OrderCommitHandler();

    await assert.rejects(async () => {
      await handler.execute(
        {
          idempotencyKey: 'fail-closed-test-key',
          items: [{ sku: 'BOOT-STEEL-01', quantity: 1, priceCents: 18000 }],
        },
        mockContext
      );
    }, /Durable persistence failure/);
  });

  await test('15. Order commit fails closed when item has no authoritative catalog or quote evidence', async () => {
    const handler = new OrderCommitHandler([], sampleCatalog);
    await assert.rejects(async () => {
      await handler.execute(
        {
          idempotencyKey: 'unverified-item-key',
          items: [{ sku: 'NON-EXISTENT-SKU', quantity: 1, priceCents: 5000 }],
        },
        mockContext
      );
    }, /Missing authoritative catalog evidence/);
  });

  await test('16. Order commit rejects currency defaulting and enforces strict match', async () => {
    const catalogWithoutCurrency = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'NO-CURR-ITEM',
        name: 'No Currency Item',
        priceCents: 5000,
        stock: { inStock: true },
      },
    ];
    const handler = new OrderCommitHandler([], catalogWithoutCurrency);
    await assert.rejects(async () => {
      await handler.execute(
        {
          idempotencyKey: 'no-curr-key',
          items: [{ sku: 'NO-CURR-ITEM', quantity: 1, priceCents: 5000 }],
        },
        mockContext
      );
    }, /Missing authoritative currency/);
  });

  // --- 4. Missing and Mixed Currency Fail-Closed Negative Tests ---
  await test('17. Pricing validation fails closed when currency is missing across catalog, pack, and input', async () => {
    const catalogNoCurrency = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'NO-CURR-P1',
        name: 'Product without currency',
        price: { amount: 100 },
        priceCents: 10000,
        stock: { inStock: true },
      },
    ];
    const handler = new PricingValidateHandler(catalogNoCurrency);
    const result = await handler.execute({ skus: ['NO-CURR-P1'] }, mockContext);

    assert.equal(result.valid, false, 'Validation must fail closed when currency is missing');
    assert.ok(result.reason?.includes('Missing authoritative currency'), 'Must explain missing currency');
  });

  await test('18. Pricing validation fails closed when input currency conflicts with catalogue currency', async () => {
    const handler = new PricingValidateHandler(sampleCatalog); // BOOT-STEEL-01 is AUD
    const result = await handler.execute(
      { skus: ['BOOT-STEEL-01'], currency: 'USD' },
      mockContext
    );

    assert.equal(result.valid, false, 'Must fail closed on currency conflict');
    assert.ok(result.reason?.includes('Conflicting currency'), 'Must report conflicting currency');
  });

  await test('19. Trade quote creation fails closed when currency is missing across catalog, pack, and input', async () => {
    const catalogNoCurrency = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'NO-CURR-Q1',
        name: 'Item without currency',
        priceCents: 5000,
      },
    ];
    const handler = new TradeQuoteCreateHandler(undefined, undefined, catalogNoCurrency);
    await assert.rejects(
      async () => {
        await handler.execute(
          { items: [{ sku: 'NO-CURR-Q1', quantity: 1 }] },
          mockContext
        );
      },
      /Missing authoritative currency/,
      'TradeQuoteCreateHandler must fail closed when currency is missing'
    );
  });

  await test('20. Trade quote creation fails closed when mixed currencies are detected across items', async () => {
    const mixedCatalog = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'ITEM-AUD',
        priceCents: 4000,
        currency: 'AUD',
      },
      {
        projectId: 'tenant-test-grounded',
        sku: 'ITEM-NZD',
        priceCents: 4500,
        currency: 'NZD',
      },
    ];
    const handler = new TradeQuoteCreateHandler(undefined, undefined, mixedCatalog);
    await assert.rejects(
      async () => {
        await handler.execute(
          {
            items: [
              { sku: 'ITEM-AUD', quantity: 1 },
              { sku: 'ITEM-NZD', quantity: 1 },
            ],
          },
          mockContext
        );
      },
      /Mixed currencies detected/,
      'TradeQuoteCreateHandler must fail closed on mixed currencies'
    );
  });

  await test('21. Trade quote creation fails closed when caller requests conflicting currency', async () => {
    const handler = new TradeQuoteCreateHandler(undefined, undefined, sampleCatalog); // BOOT-STEEL-01 is AUD
    await assert.rejects(
      async () => {
        await handler.execute(
          {
            items: [{ sku: 'BOOT-STEEL-01', quantity: 1 }],
            currency: 'NZD', // Conflicts with AUD!
          },
          mockContext
        );
      },
      /Conflicting currency/,
      'TradeQuoteCreateHandler must fail closed when caller currency conflicts with catalogue currency'
    );
  });

  await test('22. Pricing validation fails closed on input-only currency when authoritative currency is missing', async () => {
    const catalogNoCurrency = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'NO-CURR-ITEM-X',
        name: 'Item without currency',
        priceCents: 5000,
        stock: { inStock: true },
      },
    ];
    const handler = new PricingValidateHandler(catalogNoCurrency);
    // Caller passes currency: 'USD', but catalogue and pack have NO currency
    const result = await handler.execute(
      { skus: ['NO-CURR-ITEM-X'], currency: 'USD' },
      mockContext
    );
    assert.equal(result.valid, false, 'Validation must fail closed because input.currency cannot be sole authority');
    assert.ok(
      result.reason?.includes('input.currency cannot be sole authority') ||
      result.reason?.includes('Missing authoritative currency'),
      'Must explain missing authoritative currency'
    );
  });

  await test('23. Trade quote creation fails closed on input-only currency when authoritative currency is missing', async () => {
    const catalogNoCurrency = [
      {
        projectId: 'tenant-test-grounded',
        sku: 'NO-CURR-ITEM-Y',
        name: 'Item without currency',
        priceCents: 6000,
      },
    ];
    const handler = new TradeQuoteCreateHandler(undefined, undefined, catalogNoCurrency);
    // Caller passes currency: 'NZD', but catalogue and pack have NO currency
    await assert.rejects(
      async () => {
        await handler.execute(
          {
            items: [{ sku: 'NO-CURR-ITEM-Y', quantity: 1 }],
            currency: 'NZD',
          },
          mockContext
        );
      },
      /input\.currency cannot be sole authority|Missing authoritative currency/,
      'TradeQuoteCreateHandler must fail closed because input.currency cannot be sole authority'
    );
  });

  await test('24. Catalog search never fabricates a currency when neither catalog nor Business Pack input supplies one', async () => {
    const handler = new CatalogSearchHandler([{
      projectId: 'tenant-test-grounded',
      sku: 'NO-CURRENCY-CATALOG',
      name: 'Currency-neutral catalog item',
      category: 'General',
    }]);
    const result = await handler.execute({ query: 'currency-neutral' }, mockContext);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].currency, undefined);
  });

  await test('25. Project plan refuses to fabricate products, quantities, formulas, prices, or compliance notes', async () => {
    const handler = new ProjectPlanHandler();
    const result = await handler.execute(
      { projectType: 'merchant-authored-project' },
      mockContext
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingInputs.sort(), ['calculationRef', 'materials']);
    assert.equal(result.materials, undefined);
  });

  await test('26. Project plan assembles only verified catalog and calculation outputs', async () => {
    const handler = new ProjectPlanHandler();
    const result = await handler.execute(
      {
        projectType: 'merchant-authored-project',
        projectName: 'Published plan',
        calculationRef: 'calc://tenant-test-grounded/project/v3',
        calculationVersion: '3.0.0',
        currency: 'AUD',
        materials: [{
          sku: 'BOOT-STEEL-01',
          title: 'Heavy Duty Steel Toe Work Boot',
          quantity: 2,
          unit: 'pair',
          unitPrice: 180,
          currency: 'AUD',
          catalogVerified: true,
          pricingVerified: true,
        }],
        verifiedNotes: ['Merchant-authored plan note'],
      },
      mockContext
    );
    assert.equal(result.ok, true);
    assert.equal(result.materials[0].sku, 'BOOT-STEEL-01');
    assert.equal(result.materials[0].lineTotal, 360);
    assert.equal(result.total, 360);
    assert.deepEqual(result.verifiedNotes, ['Merchant-authored plan note']);
  });

  await test('27. Knowledge retrieval fails closed without OKF scope when no legacy tenant port is configured', async () => {
    let called = false;
    const handler = new KnowledgeSearchHandler(undefined, async () => ({
      async search() {
        called = true;
        return { found: true, results: [] };
      },
    }));
    const result = await handler.execute({ query: 'care instructions' }, mockContext);
    assert.equal(result.verified, false);
    assert.equal(result.resultCount, 0);
    assert.equal(called, false, 'backend must not be called without an immutable evidence allow-list');
  });

  await test('28. Knowledge retrieval forwards exact release identity and filters backend results to allowed sources', async () => {
    let received: any;
    const scope = {
      releaseId: 'okf-tenant-test-1',
      version: '1.0.0',
      checksum: 'a'.repeat(64),
      conceptIds: ['concept://tenant-test-grounded/care/product-family'],
      sourceRefs: ['source-approved'],
      requestedClaimClass: 'care_safety',
    };
    const handler = new KnowledgeSearchHandler(undefined, async () => ({
      async search(_ctx, request) {
        received = request;
        return {
          found: true,
          results: [
            { sourceId: 'source-approved', releaseId: scope.releaseId, title: 'Approved guide', content: 'Verified care instruction.' },
            { sourceId: 'source-other', releaseId: scope.releaseId, title: 'Unapproved guide', content: 'Must not escape.' },
            { sourceId: 'source-approved', releaseId: 'okf-other-release', title: 'Wrong release', content: 'Must not escape.' },
          ],
        };
      },
    }));
    const result = await handler.execute({ query: 'care instructions', knowledgeScope: scope }, mockContext);
    assert.deepEqual(received.knowledgeScope, scope);
    assert.equal(result.verified, true);
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].title, 'Approved guide');
  });

  await test('29. In-memory knowledge fixtures obey the same release and source allow-list', async () => {
    const scope = {
      releaseId: 'okf-test-release',
      version: '1.0.0',
      checksum: 'b'.repeat(64),
      conceptIds: ['concept://tenant-test-grounded/care/test'],
      sourceRefs: ['source-safe'],
    };
    const handler = new KnowledgeSearchHandler([
      { id: 'safe', sourceId: 'source-safe', releaseId: scope.releaseId, title: 'Safe care guide', content: 'Use the verified method.' },
      { id: 'cross-source', sourceId: 'source-other', releaseId: scope.releaseId, title: 'Other guide', content: 'care' },
      { id: 'cross-release', sourceId: 'source-safe', releaseId: 'okf-other', title: 'Old guide', content: 'care' },
    ]);
    const result = await handler.execute({ query: 'care', knowledgeScope: scope }, mockContext);
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].sourceId, 'source-safe');
    assert.equal(result.results[0].releaseId, scope.releaseId);
  });

  await test('30. Catalog search excludes discontinued products even when they otherwise match', async () => {
    const handler = new CatalogSearchHandler([
      { projectId: mockContext.tenantId, sku: 'ACTIVE-1', name: 'Deck screw active', category: 'Fastenings' },
      { projectId: mockContext.tenantId, sku: 'OLD-1', name: 'Deck screw discontinued', category: 'Fastenings', discontinued: true },
      { projectId: mockContext.tenantId, sku: 'OLD-2', name: 'Deck screw retired', category: 'Fastenings', lifecycle: { status: 'discontinued' } },
    ]);
    const result = await handler.execute({ query: 'deck screw' }, mockContext);
    assert.deepEqual(result.items.map((item: any) => item.sku), ['ACTIVE-1']);
  });

  await test('31. Grouped overview retrieves independently per governed child scope', async () => {
    const handler = new CatalogSearchHandler([
      { projectId: mockContext.tenantId, sku: 'WOOD-1', name: 'Screw timber', categoryId: 'fastenings.wood-screws' },
      { projectId: mockContext.tenantId, sku: 'METAL-1', name: 'Screw metal', categoryId: 'fastenings.metal-screws' },
      { projectId: mockContext.tenantId, sku: 'TOOL-1', name: 'Screw driver', categoryId: 'tools.screwdrivers' },
    ]);
    const result = await handler.execute({
      query: 'screw',
      groups: [
        { conceptId: 'concept://test/wood', label: 'Wood screws', categoryIds: ['fastenings.wood-screws'], maxItems: 1 },
        { conceptId: 'concept://test/metal', label: 'Metal screws', categoryIds: ['fastenings.metal-screws'], maxItems: 1 },
      ],
    }, mockContext);
    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.map((group: any) => group.items[0]?.sku), ['WOOD-1', 'METAL-1']);
    assert.equal(result.items.some((item: any) => item.sku === 'TOOL-1'), false);
  });

  await test('32. Non-OKF knowledge uses the tenant legacy port but never claims OKF verification', async () => {
    let called = false;
    const handler = new KnowledgeSearchHandler(undefined, undefined, async () => ({
      async search(_ctx, request) {
        called = true;
        assert.equal(request.query, 'installation guide');
        return { found: true, results: [{ sourceId: 'legacy:standalone', releaseId: 'legacy-unpinned', title: 'Legacy guide', content: 'Grounded legacy content.' }] };
      },
    }));
    const result = await handler.execute({ query: 'installation guide' }, mockContext);
    assert.equal(called, true);
    assert.equal(result.found, true);
    assert.equal(result.verified, false);
    assert.equal(result.results[0].title, 'Legacy guide');
  });

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runCatalogOrderPortsTests().catch((e) => {
  console.error('Unhandled test failure:', e);
  process.exit(1);
});
