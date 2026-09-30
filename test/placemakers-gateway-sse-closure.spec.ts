/**
 * Non-mocked Public Gateway & SSE Closure Test Suite for PlaceMakers
 *
 * Proves the 6 mandatory requirements:
 * 1. Bathroom questions complete once (clarification flow does not loop infinitely).
 * 2. No laundry or exterior products appear in bathroom recommendations or layouts.
 * 3. Demonstrated 7 m² wet area produces quantity 3 panels (ceil(7 / 2.88)).
 * 4. The server-authoritative quote preserves quantity 3.
 * 5. Replay is idempotent across turns.
 * 6. Cross-tenant access strictly fails with 403 Forbidden.
 */

import assert from 'node:assert/strict';
import {
  calculateMaterialQuantityFromPack,
  validateRoomLayoutAgainstPack,
  validateAccessoryCompatibilityAgainstPack,
  SpacePlannerExtension,
} from '@journeyax/business-pack';
import placemakersSpacePlannerPack from './fixtures/business-packs/placemakers-space-planner.json';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

interface SseEvent {
  event: string;
  data: any;
}

async function readSseStream(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = 'message';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        const rawData = trimmed.slice(5).trim();
        try {
          events.push({ event: currentEvent, data: JSON.parse(rawData) });
        } catch {
          events.push({ event: currentEvent, data: rawData });
        }
      }
    }
  }
  return events;
}

async function runGatewayClosureSuite() {
  console.log('🧪 Running PlaceMakers Public Gateway / SSE Closure Test Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
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

  const testSessionId = `test_session_${Date.now()}`;
  let createdQuoteId: string = '';

  // ── TEST 1: BATHROOM QUESTIONS COMPLETE ONCE VIA SSE STREAM ─────────────
  await test('1. Bathroom discovery questions complete once and advance to space planner', async () => {
    // Turn 1: Discovery ask
    const res1 = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'placemakers',
      },
      body: JSON.stringify({
        sessionId: testSessionId,
        message: 'I want to plan a bathroom makeover with a vanity, mirror, and wet wall lining',
      }),
    });

    assert.equal(res1.status, 200, 'Gateway stream endpoint must return 200');
    assert.ok(res1.headers.get('content-type')?.includes('text/event-stream'), 'Must return SSE text/event-stream');

    const events1 = await readSseStream(res1);
    assert.ok(events1.length > 0, 'Must stream events');

    // Confirm the response uses the intended active Business Pack rather than legacy configV=draft
    const rawEvents1Str = JSON.stringify(events1);
    assert.equal(
      rawEvents1Str.includes('configV=draft'),
      false,
      'Turn 1 must use the active Business Pack rather than legacy configV=draft'
    );

    // Collect UI actions (supports both legacy setPhase/openSpacePlanner and canonical presentCard)
    const uiActions1 = events1.filter((e) => e.event === 'uiAction').map((e) => e.data);
    const hasClarify = uiActions1.some((a) =>
      (a.name === 'setPhase' && a.arguments?.phase === 'clarify') ||
      (a.name === 'presentCard' && (a.arguments?.card?.cardType === 'clarify' || a.card?.cardType === 'clarify'))
    );
    const hasPlanner = uiActions1.some((a) =>
      a.name === 'openSpacePlanner' ||
      (a.name === 'presentCard' && (a.arguments?.card?.cardType === 'space-planner' || a.card?.cardType === 'space-planner'))
    );

    // Either the turn clarifies or opens planner immediately
    assert.ok(hasClarify || hasPlanner, 'Turn 1 must trigger clarification questions or openSpacePlanner');

    // Turn 2: Provide answers
    const res2 = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'placemakers',
      },
      body: JSON.stringify({
        sessionId: testSessionId,
        message: 'PlaceMakers Trade BOM & Estimation Flow: Wall run: 1.8m wall, Finish: White Gloss, Fixtures: Vanity and Shaving Cabinet',
      }),
    });

    assert.equal(res2.status, 200);
    const events2 = await readSseStream(res2);
    const uiActions2 = events2.filter((e) => e.event === 'uiAction').map((e) => e.data);

    // Questions complete once: Turn 2 should NOT ask the same questions again!
    const reAskedQuestions = uiActions2.filter(
      (a) =>
        (a.name === 'setPhase' && a.arguments?.phase === 'clarify' && a.arguments?.questions?.length > 0) ||
        (a.name === 'presentCard' &&
          (a.arguments?.card?.cardType === 'clarify' || a.card?.cardType === 'clarify') &&
          (a.arguments?.card?.state?.questions?.some((q: any) => q.id === 'selected_journey') ||
            a.card?.state?.questions?.some((q: any) => q.id === 'selected_journey')))
    );
    assert.equal(
      reAskedQuestions.length,
      0,
      'Clarification questions must complete once and NOT re-prompt once answered'
    );
  });

  // ── TEST 2: NO LAUNDRY OR EXTERIOR PRODUCTS APPEAR IN BATHROOM ───────────
  await test('2. No laundry products or exterior barrier tapes appear in bathroom flows', async () => {
    // Check Pack Isolation Definition
    const pack = placemakersSpacePlannerPack as unknown as SpacePlannerExtension;
    const bathroomDef = pack.roomTypes.find((r) => r.id === 'bathroom');
    assert.ok(bathroomDef, 'Pack must define bathroom room type');

    const forbiddenCategories = new Set(bathroomDef.forbiddenComponentCategories.map((c) => c.toLowerCase()));
    assert.ok(forbiddenCategories.has('tub') || forbiddenCategories.has('laundry_tub'), 'Tubs must be forbidden in bathrooms');
    assert.ok(forbiddenCategories.has('appliance') || forbiddenCategories.has('washer_cavity'), 'Washer cavities must be forbidden in bathrooms');

    // Validate that layout validator rejects laundry items
    const invalidItems = [
      { sku: '3622003', category: 'tub', componentId: 'supertub-standard' },
      { sku: '5708109', category: 'appliance', componentId: 'laundry-appliance-washer' },
    ];
    const errors = validateRoomLayoutAgainstPack(invalidItems, 'bathroom', pack);
    assert.ok(errors.length >= 2, 'Layout validator must reject laundry products in bathroom');

    // Validate exterior barrier tapes are strictly rejected
    const exteriorTapes = ['2800871', '2800873', '3410067'];
    const accResult = validateAccessoryCompatibilityAgainstPack(
      exteriorTapes.map((sku) => ({ sku, systemType: 'exterior_barrier' })),
      'bathroom',
      pack
    );
    assert.equal(accResult.valid, false, 'Exterior barrier tapes must be rejected for bathrooms');
    assert.equal(accResult.errors.length, 3, 'All 3 exterior barrier tapes must be flagged');
  });

  // ── TEST 3: 7 M² WET AREA PRODUCES QUANTITY 3 ────────────────────────────
  await test('3. Demonstrated 7 m² wet area produces quantity 3 panels from Business Pack formula', () => {
    const pack = placemakersSpacePlannerPack as unknown as SpacePlannerExtension;
    const qty = calculateMaterialQuantityFromPack(7, 'lining', pack);
    assert.equal(qty, 3, '7 m² / 2.88 m² unit coverage ceil must produce exactly 3 panels');

    // Default bathroom components in pack must reflect 3 panels
    const bathroomDef = pack.roomTypes.find((r) => r.id === 'bathroom')!;
    const liningComp = bathroomDef.defaultComponents.find((c) => c.sku === '2801884');
    assert.ok(liningComp, 'Bathroom default components must include GIB Aqualine (2801884)');
    assert.equal(liningComp.quantity, 3, 'Default lining quantity for demonstrated wet area must be 3');
  });

  const quoteIdempotencyKey = `pm-idem-${testSessionId}`;

  // ── TEST 4: QUOTE SERVICE PRESERVES QUANTITY 3 ───────────────────────────
  await test('4. Public Gateway quote creation preserves quantity 3 for lining material', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/kit/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'placemakers',
        'X-Idempotency-Key': quoteIdempotencyKey,
      },
      body: JSON.stringify({
        sessionId: testSessionId,
        idempotencyKey: quoteIdempotencyKey,
        title: 'Bathroom Materials Package (7m² Wet Area)',
        roomType: 'bathroom',
        plannerContext: {
          roomType: 'bathroom',
          areaM2: 7,
          wallWidthMm: 1800,
        },
        items: [
          { sku: '3601297', quantity: 1, reason: 'Wall-Hung Vanity 900mm' },
          { sku: '2801884', quantity: 3, reason: 'GIB Aqualine 10mm Plasterboard (7 m² coverage)' },
        ],
      }),
    });

    assert.ok(res.status === 200 || res.status === 201, `Quote endpoint must return 200 or 201, got ${res.status}`);
    const data = await res.json();
    assert.ok(data.quote, 'Response must contain quote object');
    assert.ok(data.quote.quoteId, 'Quote must have a quoteId');
    createdQuoteId = data.quote.quoteId;

    const liningLine = data.quote.lines.find((l: any) => l.sku === '2801884');
    assert.ok(liningLine, 'Quote must contain line for SKU 2801884');
    assert.equal(liningLine.quantity, 3, 'Quote must preserve quantity 3');
    assert.equal(data.quote.tenantId, 'placemakers', 'Quote must belong to placemakers');
  });

  // ── TEST 5: REPLAY IS IDEMPOTENT ─────────────────────────────────────────
  await test('5. Replaying quote request is idempotent and returns consistent results', async () => {
    assert.ok(createdQuoteId, 'Previous test must have created a quote');

    // Replay with identical payload and idempotency key
    const res = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/kit/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'placemakers',
        'X-Idempotency-Key': quoteIdempotencyKey,
      },
      body: JSON.stringify({
        sessionId: testSessionId,
        idempotencyKey: quoteIdempotencyKey,
        title: 'Bathroom Materials Package (7m² Wet Area)',
        roomType: 'bathroom',
        plannerContext: {
          roomType: 'bathroom',
          areaM2: 7,
          wallWidthMm: 1800,
        },
        items: [
          { sku: '3601297', quantity: 1, reason: 'Wall-Hung Vanity 900mm' },
          { sku: '2801884', quantity: 3, reason: 'GIB Aqualine 10mm Plasterboard (7 m² coverage)' },
        ],
      }),
    });

    assert.ok(res.status === 200 || res.status === 201);
    const data = await res.json();
    assert.ok(data.quote);
    assert.equal(data.quote.quoteId, createdQuoteId, 'Replay with identical idempotencyKey must return exact same quoteId');
    assert.equal(data.quote.lines.length, 2, 'Line count must be identical on replay');
    const liningLine = data.quote.lines.find((l: any) => l.sku === '2801884');
    assert.equal(liningLine.quantity, 3, 'Quantity 3 must remain constant on replay');
  });

  // ── TEST 6: CROSS-TENANT ACCESS FAILS WITH 403 FORBIDDEN ─────────────────
  await test('6. Cross-tenant access strictly fails with 403 Forbidden', async () => {
    assert.ok(createdQuoteId, 'Requires quote created by placemakers');

    // Case A: Request to PlaceMakers with header claiming Caroma
    const resHeaderMismatch = await fetch(
      `${GATEWAY_URL}/api/v1/placemakers/commerce/quote/${createdQuoteId}`,
      {
        headers: {
          'X-Tenant-ID': 'caroma',
        },
      }
    );
    assert.equal(
      resHeaderMismatch.status,
      403,
      `Cross-tenant header mismatch must return 403 Forbidden, got ${resHeaderMismatch.status}`
    );

    // Case B: Request through Caroma route targeting PlaceMakers quote
    const resCaromaRoute = await fetch(
      `${GATEWAY_URL}/api/v1/caroma/commerce/quote/${createdQuoteId}`,
      {
        headers: {
          'X-Tenant-ID': 'caroma',
        },
      }
    );
    assert.equal(
      resCaromaRoute.status,
      403,
      `Accessing PlaceMakers quote from Caroma tenant must return 403 Forbidden, got ${resCaromaRoute.status}`
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runGatewayClosureSuite().catch((err) => {
  console.error('Fatal error in gateway closure suite:', err);
  process.exit(1);
});
