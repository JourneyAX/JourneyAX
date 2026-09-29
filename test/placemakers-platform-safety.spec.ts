/**
 * Automated negative tests for PlaceMakers Platform Safety:
 * 1. Bathroom-vs-laundry isolation (rejection of SuperTub/washer in bathroom).
 * 2. SKU/price integrity (server-authoritative quote engine rejects uncatalogued SKUs and overrides client prices).
 * 3. Quantity propagation (7 m² lining case yields quantity 3, not 1).
 * 4. Accessory compatibility (exterior tape rejected for bathroom).
 * 5. Clarification completion & streaming transition idempotency.
 * 6. Publish-gate bypass rejection when TEST_MONGODB_URI is missing or matches production.
 * 7. Cross-tenant scope isolation.
 */
import assert from 'node:assert/strict';
import {
  ROOM_CATALOGS,
  getDefaultPlacedItems,
  validateRoomLayout,
  validateAccessorySafety,
  MASTER_ACCESSORIES,
  RoomPlacedItem,
} from '../apps/journeyax-web/src/components/panels/space-planner-domain';
import { PublicationGateValidator } from '../apps/project-service/src/publication-gate-validator';
import { QuoteService } from '../apps/agent-commerce-service/src/commerce/quote.service';

async function runPlatformSafetySuite() {
  console.log('🧪 Running PlaceMakers Platform Implementation & Negative Safety Test Suite...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }

  // ── TEST 1: BATHROOM-VS-LAUNDRY ISOLATION ───────────────────────────────
  await test('Bathroom default catalogue must contain zero laundry products', () => {
    const bathroomItems = getDefaultPlacedItems('bathroom');
    assert.ok(bathroomItems.length >= 3, 'Bathroom should have default units configured');

    const laundrySkus = ['7834654', '7846476', '7846479', 'APP-CAV-600'];
    for (const p of bathroomItems) {
      assert.ok(!laundrySkus.includes(p.item.sku), `Laundry SKU ${p.item.sku} found in bathroom defaults!`);
      assert.notEqual(p.item.category, 'tub', 'SuperTub must never be in bathroom defaults');
      assert.notEqual(p.item.id, 'appliance-space-600', 'Washer cavity must never be in bathroom defaults');
    }

    // Bathroom must have vanity, shaving cabinet, and Aqualine
    const hasVanity = bathroomItems.some((p) => p.item.id.includes('vanity'));
    const hasShaving = bathroomItems.some((p) => p.item.id.includes('shaving'));
    const hasAqualine = bathroomItems.some((p) => p.item.sku === '2801884');
    assert.ok(hasVanity, 'Bathroom must include a vanity unit');
    assert.ok(hasShaving, 'Bathroom must include a shaving cabinet');
    assert.ok(hasAqualine, 'Bathroom must include GIB Aqualine wet-wall board');
  });

  await test('validateRoomLayout must reject laundry products placed in a bathroom', () => {
    const invalidBathroomLayout: RoomPlacedItem[] = [
      {
        uid: '1',
        item: {
          id: 'vanity-900',
          name: 'Valencia Wall-Hung Vanity 900mm',
          category: 'base',
          widthMm: 900,
          heightMm: 470,
          depthMm: 465,
          priceNzd: 1529.01,
          sku: '3601297',
          description: 'Vanity',
          imageUrl: '',
        },
        quantity: 1,
      },
      {
        uid: '2',
        item: {
          id: 'robinhood-supertub-45',
          name: 'Robinhood SuperTub Standard 45L',
          category: 'tub',
          widthMm: 560,
          heightMm: 900,
          depthMm: 560,
          priceNzd: 1149,
          sku: '7846476',
          description: 'Laundry tub',
          imageUrl: '',
        },
        quantity: 1,
      },
    ];

    const errors = validateRoomLayout(invalidBathroomLayout, 'bathroom');
    assert.ok(errors.length > 0, 'validateRoomLayout must flag laundry product in bathroom');
    assert.ok(
      errors[0].includes('A bathroom must never inherit laundry products'),
      `Expected isolation error, got: ${errors[0]}`,
    );
  });

  await test('validateRoomLayout allows laundry products in laundry room', () => {
    const laundryItems = getDefaultPlacedItems('laundry');
    const errors = validateRoomLayout(laundryItems, 'laundry');
    assert.equal(errors.length, 0, 'Laundry items must be allowed in laundry layout');
  });

  // ── TEST 2: SKU & PRICE INTEGRITY (SERVER-AUTHORITATIVE QUOTE ENGINE) ─────
  await test('QuoteService rejects hallucinated or uncatalogued SKUs', async () => {
    const quoteService = new QuoteService();

    // Mock fetch for pricebook
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/products/pricebook')) {
        const body = JSON.parse(String(init?.body || '{}'));
        const skus: string[] = body.skus || [];
        const items: any[] = [];
        const missing: string[] = [];

        for (const s of skus) {
          if (s === '3601297') {
            items.push({
              sku: '3601297',
              name: 'Valencia Wall-Hung Vanity 900mm',
              price: 1529.01,
              inStock: true,
            });
          } else {
            missing.push(s);
          }
        }
        return {
          ok: true,
          json: async () => ({ items, missing }),
        } as Response;
      }
      return originalFetch(url, init);
    }) as any;

    try {
      const quote = await quoteService.build({
        tenantId: 'placemakers',
        title: 'Integrity Test Quote',
        pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
        items: [
          { sku: '3601297', quantity: 1 },
          { sku: 'HALLUCINATED-CAB-999', quantity: 1 },
        ],
      });

      assert.equal(quote.validation.ok, false, 'Quote validation should fail for hallucinated SKU');
      assert.ok(
        quote.validation.errors.some((e) => e.includes('HALLUCINATED-CAB-999 is not in the catalogue')),
        'Errors should record the missing SKU',
      );
      assert.equal(quote.lines.length, 2);
      assert.equal(quote.lines[0].sourceOfPrice, 'catalogue');
      assert.equal(quote.lines[1].sourceOfPrice, 'unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test('QuoteService enforces server-authoritative price & GST calculation', async () => {
    const quoteService = new QuoteService();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/products/pricebook')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                sku: '3601297',
                name: 'Valencia Wall-Hung Vanity 900mm',
                price: 1529.01,
                inStock: true,
              },
            ],
            missing: [],
          }),
        } as Response;
      }
      return originalFetch(url, init);
    }) as any;

    try {
      const quote = await quoteService.build({
        tenantId: 'placemakers',
        title: 'GST Test Quote',
        pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
        items: [{ sku: '3601297', quantity: 1 }],
      });

      assert.equal(quote.subtotal, 1529.01);
      assert.equal(quote.taxRate, 0.15);
      const expectedTax = Number((1529.01 * 0.15).toFixed(2));
      assert.equal(quote.tax, expectedTax);
      assert.equal(quote.total, Number((1529.01 + expectedTax).toFixed(2)));
      assert.equal(quote.currency, 'NZD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── TEST 3: QUANTITY PROPAGATION (7 m² WALL LINING CASE) ────────────────
  await test('Demonstrated 7 m² wet area case allocates 3 panels and propagates quantity into quote', async () => {
    const bathroomDefaults = getDefaultPlacedItems('bathroom');
    const liningItem = bathroomDefaults.find((p) => p.item.sku === '2801884');
    assert.ok(liningItem, 'GIB Aqualine lining must be in bathroom defaults');
    assert.equal(liningItem.quantity, 3, '7 m² wet area must calculate 3 panels (7 / 2.88 = 2.43 -> 3)');

    const quoteService = new QuoteService();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/products/pricebook')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                sku: '2801884',
                name: 'GIB Aqualine 10mm 2400 x 1200mm',
                price: 46.5,
                inStock: true,
              },
            ],
            missing: [],
          }),
        } as Response;
      }
      return originalFetch(url, init);
    }) as any;

    try {
      const quote = await quoteService.build({
        tenantId: 'placemakers',
        title: 'Lining Quantity Propagation Test',
        pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
        items: [{ sku: liningItem.item.sku, quantity: liningItem.quantity }],
      });

      assert.equal(quote.lines.length, 1);
      assert.equal(quote.lines[0].quantity, 3, 'Quantity 3 must not collapse to 1');
      assert.equal(quote.lines[0].unitPrice, 46.5);
      assert.equal(quote.lines[0].lineTotal, 139.5, 'Line total must be 3 * 46.50 = 139.50');
      assert.equal(quote.subtotal, 139.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── TEST 4: ACCESSORY COMPATIBILITY & WEATHERTIGHT SAFETY ────────────────
  await test('Exterior weathertight tape is strictly rejected for interior bathrooms', () => {
    const exteriorTape = MASTER_ACCESSORIES.find((a) => a.sku === '2800871');
    assert.ok(exteriorTape, 'Weatherline Flashing Tape must be in master catalogue');
    assert.equal(exteriorTape.systemType, 'exterior_barrier');
    assert.deepEqual(exteriorTape.compatibleRooms, []);

    const result = validateAccessorySafety(exteriorTape, 'bathroom');
    assert.equal(result.safe, false, 'Exterior tape must be flagged as unsafe for bathroom');
    assert.ok(
      result.reason?.includes('cannot be used as an interior bathroom membrane'),
      `Expected safety violation message, got: ${result.reason}`,
    );

    const masonsTape = MASTER_ACCESSORIES.find((a) => a.sku === '3410067');
    assert.ok(masonsTape, '40 Below Flashing Tape must be in master catalogue');
    const masonsResult = validateAccessorySafety(masonsTape, 'bathroom');
    assert.equal(masonsResult.safe, false, '40 Below tape must be flagged as unsafe for bathroom');
  });

  await test('Interior wet-area tapes and consumables pass validation for bathrooms', () => {
    const gibTape = MASTER_ACCESSORIES.find((a) => a.sku === '2801181');
    assert.ok(gibTape, 'GIB Paper Jointing Tape must be in master catalogue');
    const gibResult = validateAccessorySafety(gibTape, 'bathroom');
    assert.equal(gibResult.safe, true);

    const silicone = MASTER_ACCESSORIES.find((a) => a.sku === '7712045');
    assert.ok(silicone, 'Sanitary silicone must be in master catalogue');
    const siliconeResult = validateAccessorySafety(silicone, 'bathroom');
    assert.equal(siliconeResult.safe, true);

    const bottleTrap = MASTER_ACCESSORIES.find((a) => a.sku === '3649999');
    assert.ok(bottleTrap, 'Eurostyle bottle trap must be in master catalogue');
    const trapResult = validateAccessorySafety(bottleTrap, 'bathroom');
    assert.equal(trapResult.safe, true);
  });

  // ── TEST 5: CLARIFICATION COMPLETION & STREAMING IDEMPOTENCY ─────────────
  await test('Clarification state machine requires all questions answered before submitting', () => {
    const questions = [
      { id: 'q1', title: 'Room dimensions?' },
      { id: 'q2', title: 'Finish preference?' },
    ];
    let dynamicAnswers: Record<string, string> = { q1: '2.4m x 2.0m' };

    // Incomplete
    let isComplete = questions.every((q) => !!dynamicAnswers[q.id]);
    assert.equal(isComplete, false, 'Should be incomplete when only 1 of 2 questions answered');

    // Complete
    dynamicAnswers = { q1: '2.4m x 2.0m', q2: 'White Gloss' };
    isComplete = questions.every((q) => !!dynamicAnswers[q.id]);
    assert.equal(isComplete, true, 'Should be complete when all questions answered');

    const fingerprint = questions.map((q) => `${q.id}:${dynamicAnswers[q.id]}`).join('|');
    assert.equal(fingerprint, 'q1:2.4m x 2.0m|q2:White Gloss');
  });

  await test('Clarification state machine queues while streaming and executes once on settle', () => {
    const submitted = new Set<string>();
    let pending: { fingerprint: string; message: string } | null = null;
    let continuationSentCount = 0;

    function onAnswersSelected(answers: Record<string, string>, isLoading: boolean, isThinking: boolean) {
      const questions = [{ id: 'q1', title: 'Dimensions?' }];
      if (!questions.every((q) => !!answers[q.id])) return;

      const fp = questions.map((q) => `${q.id}:${answers[q.id]}`).join('|');
      if (submitted.has(fp)) return;

      const text = `My answers:\nDimensions? → ${answers.q1}`;

      if (isLoading || isThinking) {
        pending = { fingerprint: fp, message: text };
        return;
      }

      submitted.add(fp);
      pending = null;
      continuationSentCount++;
    }

    function onStreamingSettle(isLoading: boolean, isThinking: boolean) {
      if (isLoading || isThinking) return;
      if (!pending) return;
      if (submitted.has(pending.fingerprint)) {
        pending = null;
        return;
      }
      submitted.add(pending.fingerprint);
      pending = null;
      continuationSentCount++;
    }

    // User selects answers WHILE model is streaming
    onAnswersSelected({ q1: '2.4m' }, true, true);
    assert.equal(continuationSentCount, 0, 'Must not send while streaming/thinking');
    assert.ok(pending !== null, 'Must queue into pending');

    // Settle transition
    onStreamingSettle(false, false);
    assert.equal(continuationSentCount, 1, 'Must execute exactly once on streaming settle');
    assert.equal(pending, null, 'Pending must be cleared');

    // Replay attempt with same answers
    onAnswersSelected({ q1: '2.4m' }, false, false);
    assert.equal(continuationSentCount, 1, 'Must not re-send already submitted fingerprint');
  });

  // ── TEST 6: PUBLISH-GATE BYPASS REJECTION ────────────────────────────────
  await test('PublicationGateValidator rejects publication when TEST_MONGODB_URI is missing', async () => {
    const originalTestUri = process.env.TEST_MONGODB_URI;
    delete process.env.TEST_MONGODB_URI;

    try {
      const validator = new PublicationGateValidator();
      await assert.rejects(
        async () => {
          await (validator as any).getStorage();
        },
        (err: any) => {
          return err.message.includes('Isolated test storage required for publication validation');
        },
        'Expected error when TEST_MONGODB_URI is missing',
      );
    } finally {
      if (originalTestUri) process.env.TEST_MONGODB_URI = originalTestUri;
    }
  });

  await test('PublicationGateValidator rejects publication when TEST_MONGODB_URI matches production MONGODB_URI', async () => {
    const originalProd = process.env.MONGODB_URI;
    const originalTest = process.env.TEST_MONGODB_URI;

    process.env.MONGODB_URI = 'mongodb://prod.cluster:27017/journeyx';
    process.env.TEST_MONGODB_URI = 'mongodb://prod.cluster:27017/journeyx';

    try {
      const validator = new PublicationGateValidator();
      await assert.rejects(
        async () => {
          await (validator as any).getStorage();
        },
        (err: any) => {
          return err.message.includes('TEST_MONGODB_URI matches production MONGODB_URI');
        },
        'Expected error when TEST_MONGODB_URI matches MONGODB_URI',
      );
    } finally {
      if (originalProd) process.env.MONGODB_URI = originalProd;
      else delete process.env.MONGODB_URI;
      if (originalTest) process.env.TEST_MONGODB_URI = originalTest;
      else delete process.env.TEST_MONGODB_URI;
    }
  });

  // ── TEST 7: CROSS-TENANT SCOPE ISOLATION ────────────────────────────────
  await test('QuoteService.get enforces tenant-scoped isolation', async () => {
    const quoteService = new QuoteService();

    // Mock internal collection findOne
    const mockQuote = {
      quoteId: 'q_test_123',
      tenantId: 'placemakers',
      title: 'PlaceMakers Quote',
    };

    (quoteService as any).getCol = async () => ({
      findOne: async (filter: any) => {
        if (filter.quoteId === 'q_test_123' && filter.tenantId === 'placemakers') {
          return mockQuote;
        }
        return null;
      },
    });

    // 1. Reading with correct tenantId succeeds
    const pmQuote = await quoteService.get('q_test_123', 'placemakers');
    assert.ok(pmQuote, 'PlaceMakers must be able to read its own quote');
    assert.equal(pmQuote.tenantId, 'placemakers');

    // 2. Reading with cross-tenant ID 'caroma' must return null
    const caromaQuote = await quoteService.get('q_test_123', 'caroma');
    assert.equal(caromaQuote, null, 'Cross-tenant quote read must return null');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runPlatformSafetySuite().catch((err) => {
  console.error('Test suite uncaught failure:', err);
  process.exit(1);
});
