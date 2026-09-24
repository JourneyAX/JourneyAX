import assert from 'node:assert/strict';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { PricingValidateHandler } from '../src/capabilities/handlers/pricing-validate.handler';
import { OrderCommitHandler } from '../src/capabilities/handlers/order-commit.handler';
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
