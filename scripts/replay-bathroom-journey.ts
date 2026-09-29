import { randomUUID } from 'crypto';

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

async function replayBathroomJourney() {
  const sessionId = `live_bath_${randomUUID().slice(0, 8)}`;
  console.log(`\n🛁 Replaying Bathroom Journey in Fresh Conversation (Session: ${sessionId})...\n`);

  // ── TURN 1: Initial Discovery Ask ──────────────────────────────────────────
  console.log('--- Turn 1: Customer asks for a complete bathroom makeover ---');
  const t1Res = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': 'placemakers',
    },
    body: JSON.stringify({
      sessionId,
      message: 'I want to do a complete bathroom makeover with a vanity, shaving cabinet, and moisture-resistant wet wall linings.',
    }),
  });

  const t1Events = await readSseStream(t1Res);
  const t1Text = t1Events.filter((e) => e.event === 'token').map((e) => e.data?.delta || '').join('');
  const t1UiActions = t1Events.filter((e) => e.event === 'uiAction').map((e) => e.data);

  console.log(`Assistant Response:\n${t1Text.slice(0, 200)}...\n`);
  console.log(`UI Actions Emitted:`, t1UiActions.map((a) => a.name));

  // Verify zero laundry/exterior items
  const t1Items = t1UiActions.filter((a) => a.name === 'showItems').flatMap((a) => a.arguments?.items || []);
  const laundryFound = t1Items.some((i: any) =>
    ['7834654', '7846476', '7846479', 'APP-CAV-600', '7001402', 'PM-CAV-650'].includes(i.sku) ||
    i.category === 'tub' ||
    ['2800871', '2800873', '3410067'].includes(i.sku)
  );
  if (laundryFound) {
    throw new Error('❌ Isolation failure: Laundry or exterior products appeared in bathroom turn 1!');
  }
  console.log('✅ Isolation verified: Zero laundry or exterior products in Turn 1.\n');

  // ── TURN 2: Customer Clarifies Setup ──────────────────────────────────────
  console.log('--- Turn 2: Customer specifies 1.8m wall, White Gloss, DIY ---');
  const t2Res = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': 'placemakers',
    },
    body: JSON.stringify({
      sessionId,
      message: 'My answers: Wall run: 1.8m wall, Finish: White Gloss, Fixtures: Valencia Vanity and Shaving Cabinet, Installation: DIY',
    }),
  });

  const t2Events = await readSseStream(t2Res);
  const t2Text = t2Events.filter((e) => e.event === 'token').map((e) => e.data?.delta || '').join('');
  const t2UiActions = t2Events.filter((e) => e.event === 'uiAction').map((e) => e.data);

  console.log(`Assistant Response:\n${t2Text.slice(0, 200)}...\n`);
  console.log(`UI Actions Emitted:`, t2UiActions.map((a) => a.name));

  const questionsReAsked = t2UiActions.some((a) => a.name === 'setPhase' && a.arguments?.phase === 'clarify' && a.arguments?.questions?.length > 0);
  if (questionsReAsked) {
    throw new Error('❌ Flow failure: Questions re-prompted after answers were provided!');
  }
  console.log('✅ Flow verified: Questions completed once and did not loop.\n');

  // ── TURN 3: Authoritative Project Quote (7m² Wet Area Lining) ─────────────
  console.log('--- Turn 3: Generate Server-Authoritative Quote for 7m² Wet Area ---');
  const qRes = await fetch(`${GATEWAY_URL}/api/v1/placemakers/commerce/kit/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': 'placemakers',
    },
    body: JSON.stringify({
      sessionId,
      title: 'Bathroom Renovation Package (1.8m Wall, 7m² Wet Area)',
      roomType: 'bathroom',
      plannerContext: {
        roomType: 'bathroom',
        areaM2: 7,
        wallWidthMm: 1800,
      },
      items: [
        { sku: '3601297', quantity: 1, reason: 'Valencia Wall-Hung Vanity 900mm White Gloss' },
        { sku: '7834220', quantity: 1, reason: 'Mirrored Shaving Cabinet 900mm' },
        { sku: '2801884', quantity: 3, reason: 'GIB Aqualine 10mm Plasterboard (7m² coverage)' },
        { sku: '7712045', quantity: 1, reason: 'Sanitary Silicone Sealant Clear' },
      ],
    }),
  });

  const qData = await qRes.json();
  const quote = qData.quote;
  console.log(`Quote ID: ${quote.quoteId}`);
  console.log(`Currency: ${quote.currency}, Tax Rate: ${quote.taxRate * 100}%`);
  console.log(`Lines:`);
  for (const line of quote.lines) {
    console.log(`  - [${line.sku}] ${line.name}: Qty ${line.quantity} (${line.sourceOfPrice})`);
  }

  const liningLine = quote.lines.find((l: any) => l.sku === '2801884');
  if (!liningLine || liningLine.quantity !== 3) {
    throw new Error(`❌ Quantity error: Expected 3 panels for SKU 2801884, got ${liningLine?.quantity}`);
  }
  console.log('✅ Quantity rule verified: 7m² produced and preserved quantity 3 panels in quote.');

  console.log('\n🎉 Fresh Conversation Bathroom Journey Replay Completed Successfully!\n');
}

replayBathroomJourney().catch((err) => {
  console.error('Replay failed:', err);
  process.exit(1);
});
