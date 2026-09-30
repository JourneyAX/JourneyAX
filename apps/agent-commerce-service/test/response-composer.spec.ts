import { ResponseComposer } from '../src/presentation/response-composer';

async function runTests() {
  console.log('🧪 Running ResponseComposer Boundary Test Suite...');

  const composer = new ResponseComposer();

  // Test 1: stripChatMedia removes markdown images and stray media URLs
  const mediaMarkdown = 'Check out this product: ![Cabinet Image](https://cdn.example.com/images/cab.png) It looks great!';
  const stripped = composer.stripChatMedia(mediaMarkdown);
  if (stripped.includes('http') || stripped.includes('![') || stripped.includes('.png')) {
    throw new Error(`Test 1 failed: media was not stripped: "${stripped}"`);
  }
  if (!stripped.includes('Check out this product:') || !stripped.includes('It looks great!')) {
    throw new Error(`Test 1 failed: substantive prose was lost: "${stripped}"`);
  }
  console.log('  ✅ PASS: stripChatMedia cleans image links and bare URLs without losing text');

  // Test 2: shownItemNames extracts unique product names from tool calls
  const calls: any[] = [
    {
      function: {
        name: 'showItems',
        arguments: JSON.stringify({
          products: [
            { sku: '111', name: 'Boston Mirror Cabinet' },
            { sku: '222', name: 'Wall Tower 300mm' },
          ],
        }),
      },
    },
  ];
  const names = composer.shownItemNames(calls);
  if (names.length !== 2 || !names.includes('Boston Mirror Cabinet') || !names.includes('Wall Tower 300mm')) {
    throw new Error(`Test 2 failed: expected 2 names, got ${JSON.stringify(names)}`);
  }
  console.log('  ✅ PASS: shownItemNames accurately retrieves card product names');

  // Test 3: compactItemListing drops redundant numbered lines
  const redundantText = `I have selected two options for you:
1. Boston Mirror Cabinet: $349
2. Wall Tower 300mm: $289
Would you like me to add these to your quote?`;
  const compacted = composer.compactItemListing(redundantText, names);
  if (compacted.includes('1. Boston Mirror Cabinet') || compacted.includes('2. Wall Tower 300mm')) {
    throw new Error(`Test 3 failed: redundant enumeration was not compacted: "${compacted}"`);
  }
  if (!compacted.includes('selected two options') || !compacted.includes('add these to your quote')) {
    throw new Error(`Test 3 failed: framing sentences were dropped: "${compacted}"`);
  }
  console.log('  ✅ PASS: compactItemListing suppresses card-redundant bullet lists');

  // Test 4: composeCard generates generic presentCard envelope
  const envelope = composer.composeCard(
    'productComparison',
    { template: 'side-by-side', bindings: { primarySku: 'item.sku' } },
    { title: 'Comparison', items: ['A', 'B'] }
  );
  if (envelope.cardType !== 'productComparison' || envelope.template !== 'side-by-side' || envelope.bindings?.primarySku !== 'item.sku') {
    throw new Error('Test 4 failed: dynamic card envelope composition failed');
  }
  console.log('  ✅ PASS: composeCard generates standard dynamic card envelope');

  // Test 5: SSE event framing
  const emittedEvents: Array<{ event: string; data: any }> = [];
  const testEmit = (event: string, data: any) => {
    emittedEvents.push({ event, data });
  };

  composer.emitToken(testEmit, 'Hello ');
  composer.emitUiAction(testEmit, 'showItems', { products: [] });
  composer.emitPresentCard(testEmit, envelope);
  composer.emitData(testEmit, { sessionId: 'sess-123' });
  composer.emitDone(testEmit);

  if (emittedEvents.length !== 5) {
    throw new Error(`Test 5 failed: expected 5 SSE events, got ${emittedEvents.length}`);
  }
  if (emittedEvents[0].event !== 'token' || emittedEvents[0].data.token !== 'Hello ') {
    throw new Error('Test 5 failed: token event mismatch');
  }
  if (emittedEvents[1].event !== 'uiAction' || emittedEvents[1].data.name !== 'showItems') {
    throw new Error('Test 5 failed: uiAction event mismatch');
  }
  if (emittedEvents[2].event !== 'uiAction' || emittedEvents[2].data.name !== 'presentCard') {
    throw new Error('Test 5 failed: presentCard envelope event mismatch');
  }
  if (emittedEvents[3].event !== 'data' || emittedEvents[3].data.sessionId !== 'sess-123') {
    throw new Error('Test 5 failed: data event mismatch');
  }
  if (emittedEvents[4].event !== 'done') {
    throw new Error('Test 5 failed: done event mismatch');
  }
  console.log('  ✅ PASS: SSE event framing produces exact SSE protocol contract');

  console.log('🎉 ALL RESPONSE COMPOSER TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ ResponseComposer tests failed:', err);
  process.exit(1);
});
