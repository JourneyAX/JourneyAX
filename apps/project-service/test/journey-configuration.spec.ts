import assert from 'node:assert/strict';
import { JourneyConfigurationService } from '../src/journey-configuration.service';
import { CapabilityRegistryService } from '../src/capability-registry.service';

async function runJourneyConfigTests() {
  console.log('🧪 Running Journey & Capability Registry Tests in Agent 3...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      failed++;
    }
  }

  const journeyService = new JourneyConfigurationService();
  const capabilityService = new CapabilityRegistryService();

  // Test 1: Capability Registry provides standard schemas
  await test('CapabilityRegistryService lists standard schemas with risk and side-effect metadata', () => {
    const schemas = capabilityService.listStandardToolSchemas();
    assert.ok(schemas.catalog_search);
    assert.equal(schemas.catalog_search.sideEffect, 'read');
    assert.equal(schemas.catalog_search.risk, 'low');

    assert.ok(schemas.order_commit);
    assert.equal(schemas.order_commit.sideEffect, 'transactional');
    assert.equal(schemas.order_commit.requiresApproval, true);
    assert.equal(schemas.order_commit.idempotencyRequired, true);
  });

  // Test 2: Journey Graph Validation rejects missing trigger
  await test('validateAndCompileGraph rejects journey graph without trigger node', () => {
    const graph = {
      nodes: [
        { id: 'action_1', data: { kind: 'action.recommendation', label: 'Recommend Products' } },
      ],
      edges: [],
    };
    const res = journeyService.validateAndCompileGraph('test-proj', 'Test Project', graph);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Trigger node')));
  });

  // Test 3: Journey Graph Validation compiles valid graph
  await test('validateAndCompileGraph compiles valid graph with trigger and action nodes', () => {
    const graph = {
      nodes: [
        { id: 'node_trigger', data: { kind: 'trigger.intent', label: 'User Intent' } },
        { id: 'node_action', data: { kind: 'action.recommendation', label: 'Recommendation' } },
      ],
      edges: [
        { id: 'e1', source: 'node_trigger', target: 'node_action' },
      ],
    };
    const res = journeyService.validateAndCompileGraph('test-proj', 'Test Project', graph);
    assert.equal(res.valid, true);
    assert.ok(res.compiledJourney);
    assert.equal(res.compiledJourney.journeyId, 'test-proj');
  });

  // Test 4: Dynamic capability discovery
  await test('discoverCapabilitiesForTenant discovers platform contracts without hardcoded domain tools', async () => {
    const discovered = await capabilityService.discoverCapabilitiesForTenant('tenant_abc', 'production');
    assert.ok(discovered.length >= 3);
    assert.ok(discovered.some((d) => d.toolId === 'catalog.search'));
    assert.ok(discovered.some((d) => d.toolId === 'pricing.validate'));
    assert.ok(discovered.some((d) => d.toolId === 'order.commit'));
    // Ensure no hardcoded industry tools
    assert.equal(discovered.some((d) => d.toolId === 'roster'), false);
    assert.equal(discovered.some((d) => d.toolId === 'teamColours'), false);
    assert.equal(discovered.some((d) => d.toolId === 'warranty'), false);
    assert.equal(discovered.some((d) => d.toolId === 'installGuide'), false);
  });

  // Test 5: Studio validation of tool bindings rejects raw secrets
  await test('validateToolBinding rejects raw secrets and requires secretRef', () => {
    // 1. Valid binding with secretRef
    const validBinding: any = {
      toolId: 'catalog.search',
      tenantId: 'tenant_abc',
      environmentId: 'production',
      executor: {
        type: 'native_capability',
        nativeHandler: 'catalog.search',
      },
    };
    const res1 = capabilityService.validateToolBinding(validBinding);
    assert.equal(res1.valid, true);

    // 2. Invalid binding with raw secret in policyOverrides
    const invalidBinding: any = {
      toolId: 'crm.sync',
      tenantId: 'tenant_abc',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_123',
        connectionRef: 'missing_crm_secret',
      },
      policyOverrides: {
        rawApiKey: 'sk_live_1234567890abcdef',
      },
    };
    const res2 = capabilityService.validateToolBinding(invalidBinding, ['valid_secret_conn']);
    assert.equal(res2.valid, false);
    assert.ok(res2.errors.some((e) => e.includes('Raw secret detected')));
    assert.ok(res2.errors.some((e) => e.includes('missing_crm_secret')));
  });

  // Test 6: Reference integrity validation
  await test('validateBusinessPackReferenceIntegrity detects undeclared tools in stage bindings', () => {
    const mockPack: any = {
      capabilities: {
        toolDefinitions: [
          { toolId: 'catalog.search' },
        ],
        toolBindings: [
          { toolId: 'catalog.search' },
          { toolId: 'undeclared_tool_xyz' }, // Invalid binding referencing undeclared tool
        ],
        stageBindings: [
          {
            journeyId: 'j1',
            stageId: 's1',
            tools: [{ toolId: 'phantom_tool_123' }], // Invalid stage binding
          },
        ],
      },
    };

    const integrity = capabilityService.validateBusinessPackReferenceIntegrity(mockPack);
    assert.equal(integrity.valid, false);
    assert.ok(integrity.errors.some((e) => e.includes('undeclared_tool_xyz')));
    assert.ok(integrity.errors.some((e) => e.includes('phantom_tool_123')));
  });

  // Test 7: Card and Theme CMS publication and rollback
  await test('publishCardTheme and rollbackCardTheme validate cards with @journeyax/ui-cards', async () => {
    const validCard: any = {
      cardId: 'card_rec_001',
      type: 'products',
      version: '1.0.0',
      data: {
        title: 'Workwear Boot',
        priceCents: 15000,
        currency: 'AUD',
      },
    };

    const publishResult = await capabilityService.publishCardTheme(
      'tenant_abc',
      'production',
      { primaryColor: '#0055ff' },
      [validCard]
    );

    assert.ok(publishResult.version);
    assert.ok(publishResult.checksum);
    assert.equal(publishResult.cardCount, 1);

    // Rollback test
    const rollbackResult = await capabilityService.rollbackCardTheme(
      'tenant_abc',
      'production',
      publishResult.version
    );
    assert.equal(rollbackResult.version, publishResult.version);
    assert.equal(rollbackResult.restored, true);

    // Invalid card fails closed
    const invalidCard: any = {
      cardId: 'card_bad',
      type: 'invalid_type_unknown',
      version: '1.0.0',
      data: {},
    };

    await assert.rejects(
      async () => {
        await capabilityService.publishCardTheme(
          'tenant_abc',
          'production',
          {},
          [invalidCard]
        );
      },
      /Invalid card envelope/
    );
  });

  console.log(`\nJourney & Capability Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runJourneyConfigTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
