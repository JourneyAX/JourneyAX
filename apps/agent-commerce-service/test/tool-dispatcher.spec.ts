import {
  findBalancedToolCall,
  safeParseArgs,
  buildToolset,
  executeTool,
  isExecutableTool,
  REGISTERED_TOOL_HANDLERS,
} from '../src/orchestration/tool-dispatcher';

async function runTests() {
  console.log('🧪 Running ToolDispatcher Boundary & Canonical Capability Test Suite...');

  // Test 1: findBalancedToolCall extracts balanced function calls from buffer
  const sampleBuffer = 'I can help with that. TOOL_CALL: openSpacePlanner({"roomType":"bathroom","wallWidthMm":2400}) Hope this helps!';
  const parsed = findBalancedToolCall(sampleBuffer);
  if (!parsed || parsed.toolName !== 'openSpacePlanner') {
    throw new Error('Test 1 failed: findBalancedToolCall did not detect openSpacePlanner');
  }
  const args = JSON.parse(parsed.rawArgs);
  if (args.roomType !== 'bathroom' || args.wallWidthMm !== 2400) {
    throw new Error('Test 1 failed: arguments not extracted accurately');
  }
  console.log('  ✅ PASS: findBalancedToolCall correctly extracts open model balanced calls');

  // Test 2: safeParseArgs handles both valid and malformed JSON
  if (safeParseArgs('{"sku":"7615114"}').sku !== '7615114') {
    throw new Error('Test 2 failed: safeParseArgs failed on valid JSON');
  }
  if (Object.keys(safeParseArgs('invalid-json-content')).length !== 0) {
    throw new Error('Test 2 failed: safeParseArgs did not fall back safely on invalid JSON');
  }
  console.log('  ✅ PASS: safeParseArgs safely parses arguments');

  // Test 3: Fail closed: buildToolset fails closed when mappings/capabilities are absent
  const emptyToolset = buildToolset([]);
  if (emptyToolset.length !== 0) {
    throw new Error(`Test 3 failed: absent capabilities must return empty toolset, got ${emptyToolset.length}`);
  }
  const nullToolset = buildToolset(undefined);
  if (nullToolset.length !== 0) {
    throw new Error(`Test 3 failed: undefined capabilities must return empty toolset, got ${nullToolset.length}`);
  }
  console.log('  ✅ PASS: buildToolset fails closed and exposes zero tools when mappings/capabilities are absent');

  // Test 4: Capability-based fallback binds only explicitly enabled tools
  const spacePlannerTools = buildToolset(['spacePlanner', 'products']);
  const toolNames = spacePlannerTools.map((t: any) => t.function.name);
  if (!toolNames.includes('openSpacePlanner') || !toolNames.includes('showItems')) {
    throw new Error('Test 4 failed: spacePlanner and products capabilities were not bound');
  }
  if (toolNames.includes('checkBranchStock') || toolNames.includes('researchSchool')) {
    throw new Error('Test 4 failed: unrequested tools were bound');
  }
  console.log('  ✅ PASS: buildToolset binds only explicitly requested capabilities');

  // Test 5: Pack-driven toolset with stage bindings and permissions
  const mockPack: any = {
    capabilities: {
      toolDefinitions: [
        { toolId: 'catalog.search', description: 'Search catalogue' },
        { toolId: 'products.present', description: 'Show product cards' },
        { toolId: 'trade.branch_stock', description: 'Check branch inventory' },
        { toolId: 'unsupported.fictional_tool', description: 'Non-executable tool' },
      ],
      stageBindings: [
        {
          journeyId: 'trade-decking',
          stageId: 'discovery',
          tools: [{ toolId: 'catalog.search' }, { toolId: 'products.present' }],
        },
        {
          journeyId: 'trade-decking',
          stageId: 'fulfilment',
          tools: [{ toolId: 'trade.branch_stock' }],
        },
      ],
    },
  };

  // Discovery stage should ONLY expose catalog.search and products.present
  const discoveryTools = buildToolset({
    pack: mockPack,
    journeyId: 'trade-decking',
    stageId: 'discovery',
  });
  const discoveryNames = discoveryTools.map((t: any) => t.function.name);
  if (!discoveryNames.includes('catalog.search') || !discoveryNames.includes('products.present')) {
    throw new Error('Test 5 failed: stage-allowed tools missing from discovery toolset');
  }
  if (discoveryNames.includes('trade.branch_stock')) {
    throw new Error('Test 5 failed: fulfilment tool leaked into discovery stage');
  }
  if (discoveryNames.includes('unsupported.fictional_tool')) {
    throw new Error('Test 5 failed: unexecutable tool was advertised');
  }
  console.log('  ✅ PASS: Business Pack stage bindings strictly control stage toolsets');

  // Test 6: Every advertised tool has a real registered executable handler
  for (const tool of discoveryTools) {
    if (!isExecutableTool(tool.function.name)) {
      throw new Error(`Test 6 failed: advertised tool "${tool.function.name}" has no registered handler`);
    }
  }
  console.log('  ✅ PASS: Every advertised tool has an executable registered handler');

  // Test 7: Unknown or unbound tools fail closed (never return { executed: true })
  try {
    await executeTool('nonExistentToolXYZ', '{"test":123}', {
      tenantId: 'test-tenant',
      intent: { intent: 'chat' } as any,
    });
    throw new Error('Test 7 failed: executeTool must throw on unknown tool');
  } catch (err: any) {
    if (!err.message.includes('Unknown or unbound tool') || !err.message.includes('fail closed')) {
      throw new Error(`Test 7 failed: unexpected error message: ${err.message}`);
    }
  }
  console.log('  ✅ PASS: Unknown or unbound tools fail closed with security exception (never { executed: true })');

  // Test 8: Supported tool execution works predictably
  const showItemsRes = await executeTool(
    'showItems',
    JSON.stringify({ products: [{ sku: 'SKU-001', name: 'Premium Basin' }] }),
    { tenantId: 'test-tenant', intent: { intent: 'chat' } as any }
  );
  if (!showItemsRes.ok || showItemsRes.count !== 1) {
    throw new Error('Test 8 failed: showItems execution failed');
  }
  console.log('  ✅ PASS: Registered tools execute with expected domain payload');

  console.log('🎉 ALL TOOL DISPATCHER TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ ToolDispatcher tests failed:', err);
  process.exit(1);
});
