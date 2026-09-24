import assert from 'node:assert/strict';
import { PresentationPort } from '../src/kernel/presentation.port';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState, Decision } from '@journeyax/journey-core';

// Test mock release for UI presentation
const mockRelease: BusinessPackRelease = {
  manifest: {
    packId: 'ui-test-pack',
    name: 'UI Test Pack',
    version: '1.0.0',
    description: 'Testing UI standardization and presentCard envelopes',
    tenantId: 'tenant-ui-test',
    environmentId: 'test',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'mock-checksum-ui',
  },
  profile: {
    companyName: 'UI Test Store',
    industry: 'UI Testing',
    primaryCurrency: 'USD',
    supportedCurrencies: ['USD'],
    primaryLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [],
    acronyms: {},
    slotSynonyms: {},
    slotMappings: {},
    prohibitedTerms: [],
  },
  entities: {
    version: '1.0.0',
    entities: [],
  },
  conversationPolicy: {
    fencingRules: [],
    prohibitedTopics: [],
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  },
  journeys: [
    {
      journeyId: 'ui_journey',
      version: '1.0.0',
      goals: ['Test UI envelopes'],
      initialStage: 'stage_test',
      stages: {
        stage_test: {
          stageId: 'stage_test',
          requiredFacts: [],
          allowedCapabilities: [],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [],
        },
      },
    },
  ],
  rules: [],
  capabilities: {
    version: '1.0.0',
    toolDefinitions: [],
    toolBindings: [],
    stageBindings: [],
  },
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'default',
    policies: [
      {
        policyId: 'default',
        candidates: [{ provider: 'open-model', model: 'mock-model', priority: 1 }],
        dataResidency: 'us',
        maxInputTokens: 4000,
        maxOutputTokens: 1000,
        fallbackAllowed: true,
        timeoutMs: 5000,
      },
    ],
  },
  agents: [
    {
      agentId: 'default-agent',
      purpose: 'UI testing agent',
      inputSchema: {},
      outputSchema: {},
      allowedTools: [],
      modelPolicyRef: 'default',
      maxTurns: 3,
      handoffConditions: [],
    },
  ],
  experience: {
    version: '1.0.0',
    theme: {
      primaryColor: '#0055ff',
      accentColor: '#3B82F6',
      fontFamily: 'sans-serif',
      borderRadius: '8px',
      customCssVars: {},
    },
    cards: {
      allowedCardTypes: ['bundle', 'products', 'productDetail', 'quote'],
      defaultCardRenderer: '@journeyax/ui-cards',
    },
  },
  evaluations: [],
};

const mockWs: WorkspaceState = {
  tenantId: 'tenant-ui-test',
  environmentId: 'test',
  workspaceId: 'ws-ui-1',
  packVersionId: '1.0.0',
  journeyId: 'ui_journey',
  currentStage: 'stage_test',
  goal: 'UI Testing',
  facts: {},
  decisions: [],
  selectedObjects: [],
  openQuestions: [],
  status: 'active',
  stateVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function runTests() {
  console.log('=== Running UI Standardization & Cutover Tests (PR 8) ===\n');

  const port = new PresentationPort();

  // Test 1: Action Button Group strictly outputs presentCard CardEnvelope
  {
    console.log('Test 1: Approval request emits presentCard CardEnvelope');
    const decision: Decision = {
      decisionId: 'dec_appr_1',
      type: 'requires_approval',
      payload: { displayName: 'Publish Catalog' },
      reason: 'Write action requires confirmation',
      createdAt: new Date().toISOString(),
    };

    const res = port.compose({ valid: true }, decision, mockWs, mockRelease);
    assert.equal(res.uiInstructions.length, 1);
    const inst = res.uiInstructions[0];

    assert.equal(inst.component, 'action_button_group');
    assert.ok(inst.envelope, 'UIInstruction must contain CardEnvelope');
    assert.equal(inst.envelope?.name, 'presentCard');
    assert.equal(inst.envelope?.arguments.card.cardType, 'action_button_group');
    assert.ok(Array.isArray(inst.envelope?.arguments.card.state.actions));
    assert.equal(inst.envelope?.arguments.card.state.actions.length, 2);
    console.log('✓ Action button group emitted in strict presentCard envelope\n');
  }

  // Test 2: Recommendation Bundle strictly outputs presentCard CardEnvelope
  {
    console.log('Test 2: Verified recommendation bundle emits presentCard CardEnvelope');
    const decision: Decision = {
      decisionId: 'dec_bundle_1',
      type: 'invoke_capability',
      payload: {},
      reason: 'Items verified',
      createdAt: new Date().toISOString(),
    };

    const outcome = {
      bundle: {
        totalPriceCents: 4500,
        currency: 'USD',
        items: [
          {
            sku: 'SKU-TEST-1',
            name: 'Industrial Sensor Alpha',
            priceCents: 4500,
            brand: 'SensorCorp',
            category: 'sensors',
            certifications: ['CE', 'ISO-9001'],
          },
        ],
      },
    };

    const res = port.compose({ valid: true, outcome }, decision, mockWs, mockRelease);
    const bundleInst = res.uiInstructions.find((i) => i.component === 'bundle');
    assert.ok(bundleInst, 'Bundle UI instruction must be present');
    assert.ok(bundleInst?.envelope, 'Bundle instruction must contain envelope');
    assert.equal(bundleInst?.envelope?.name, 'presentCard');
    assert.equal(bundleInst?.envelope?.arguments.card.cardType, 'bundle');
    assert.equal(bundleInst?.envelope?.arguments.card.state.totals.total, 45);
    assert.equal(bundleInst?.envelope?.arguments.card.state.items.length, 1);
    console.log('✓ Recommendation bundle emitted in strict presentCard envelope\n');
  }

  // Test 3: Grounded Order Confirmation strictly outputs presentCard CardEnvelope
  {
    console.log('Test 3: Grounded order confirmation emits presentCard CardEnvelope');
    const decision: Decision = {
      decisionId: 'dec_order_1',
      type: 'complete_goal',
      payload: {},
      reason: 'Order placed',
      createdAt: new Date().toISOString(),
    };

    const outcome = {
      order: {
        orderId: 'ord_test_8819',
        currency: 'USD',
        totalPriceCents: 4500,
        status: 'authorized',
        items: [{ sku: 'SKU-TEST-1', quantity: 1, unitPriceCents: 4500 }],
        committedAt: new Date().toISOString(),
      },
    };

    const res = port.compose({ valid: true, outcome }, decision, mockWs, mockRelease);
    const orderInst = res.uiInstructions.find((i) => i.component === 'order_confirmation');
    assert.ok(orderInst, 'Order confirmation instruction must be present');
    assert.ok(orderInst?.envelope, 'Order instruction must contain envelope');
    assert.equal(orderInst?.envelope?.name, 'presentCard');
    assert.equal(orderInst?.envelope?.arguments.card.cardType, 'order_confirmation');
    assert.equal(orderInst?.envelope?.arguments.card.state.orderId, 'ord_test_8819');
    console.log('✓ Grounded order confirmation emitted in strict presentCard envelope\n');
  }

  // Test 4: Web UI uiActionToCards Envelope Parser
  {
    console.log('Test 4: Web UI uiActionToCards ingestion of presentCard envelopes');
    // Import uiActionToCards from web app
    const { uiActionToCards } = await import('../../journeyax-web/src/lib/cards/uiActionToCards');

    // Case A: Standard CardEnvelope
    const standardFrame = {
      name: 'presentCard',
      arguments: {
        card: {
          id: 'card_bundle_unique_1',
          cardType: 'bundle',
          state: { heading: 'Recommended' },
        },
      },
    };
    const cardsA = uiActionToCards(standardFrame);
    assert.equal(cardsA.length, 1);
    assert.equal(cardsA[0].id, 'card_bundle_unique_1');
    assert.equal(cardsA[0].cardType, 'bundle');
    assert.equal(cardsA[0].state.heading, 'Recommended');

    // Case B: Direct arguments as card
    const directFrame = {
      name: 'presentCard',
      arguments: {
        cardType: 'action_button_group',
        state: { actions: [] },
      },
    };
    const cardsB = uiActionToCards(directFrame);
    assert.equal(cardsB.length, 1);
    assert.equal(cardsB[0].cardType, 'action_button_group');

    // Case C: Legacy card object frame
    const legacyFrame = {
      name: 'legacy_show_items',
      card: {
        cardType: 'bundle' as any,
        state: { legacy: true },
      },
    };
    const cardsC = uiActionToCards(legacyFrame);
    assert.equal(cardsC.length, 1);
    assert.equal(cardsC[0].cardType, 'bundle');
    assert.equal(cardsC[0].state.legacy, true);

    // Case D: Non-card frame returns empty array
    const emptyFrame = {
      name: 'unknown_frame',
    };
    assert.equal(uiActionToCards(emptyFrame).length, 0);

    console.log('✓ uiActionToCards parses presentCard envelopes and maintains backward compatibility\n');
  }

  // Test 5: Server-Owned Cutover Routing Decisions & Deterministic Canary
  {
    console.log('Test 5: Authoritative Server-Owned Cutover Routing Decisions & Deterministic Canary');
    const { resolveTenantRouting, computeCanaryBucket } = await import('../../journeyax-web/src/lib/routing/cutover');

    // Case A: Unmigrated tenant without record fails closed to legacy commerce
    const unmigratedRoute = await resolveTenantRouting('unknown_brand_999');
    assert.equal(unmigratedRoute.cutoverState, 'unmigrated');
    assert.equal(unmigratedRoute.useRuntime, false);

    // Case B: Explicit tenant migration override via TENANT_CUTOVER_<TENANT>
    process.env.TENANT_CUTOVER_CUSTOM_STORE = 'migrated';
    const customRoute = await resolveTenantRouting('custom_store');
    assert.equal(customRoute.cutoverState, 'migrated');
    assert.equal(customRoute.useRuntime, true);
    delete process.env.TENANT_CUTOVER_CUSTOM_STORE;

    // Case C: Explicit tenant rollback pointer via TENANT_CUTOVER_<TENANT>
    process.env.TENANT_CUTOVER_ROLLBACK_TENANT = 'rollback';
    const rollbackRoute = await resolveTenantRouting('rollback_tenant');
    assert.equal(rollbackRoute.cutoverState, 'rollback');
    assert.equal(rollbackRoute.useRuntime, false);
    delete process.env.TENANT_CUTOVER_ROLLBACK_TENANT;

    // Case D: Global deliberate rollback pointer
    process.env.RUNTIME_GLOBAL_ROLLBACK = 'true';
    const globalRollbackRoute = await resolveTenantRouting('custom_store');
    assert.equal(globalRollbackRoute.cutoverState, 'rollback');
    assert.equal(globalRollbackRoute.useRuntime, false);
    delete process.env.RUNTIME_GLOBAL_ROLLBACK;

    // Case E: Deterministic canary bucketing (canaryPercentage > 0 does NOT route 100% of users)
    const canaryPercentage = 25; // 25% canary
    let selectedCount = 0;
    const totalKeys = 100;
    for (let i = 0; i < totalKeys; i++) {
      const bucket = computeCanaryBucket(`user_session_${i}`);
      assert.ok(bucket >= 0 && bucket < 100, 'Bucket must be in range 0 - 99');
      if (bucket < canaryPercentage) {
        selectedCount++;
      }
    }
    // With 100 hash samples and 25% target, count should be reasonably distributed around 25%, not 0% or 100%!
    assert.ok(selectedCount > 10 && selectedCount < 40, `Deterministic canary count (${selectedCount}) must not be 0 or 100`);

    console.log('✓ Server-owned cutover routing decisions & deterministic canary verified\n');
  }

  // Test 6: Runtime Service & Controller Cutover Registry Verification
  {
    console.log('Test 6: Runtime Service & Controller Cutover Registry Verification');
    const { RuntimeService } = await import('../src/runtime.service');
    const { RuntimeController } = await import('../src/runtime.controller');

    const runtimeService = new RuntimeService();
    const runtimeController = new RuntimeController(runtimeService);

    // Setup: Explicit test record injection
    runtimeService.setCutoverRecordForTest({
      tenantId: 'workweargroup',
      environmentId: 'production',
      status: 'migrated',
      approvedReleaseChecksum: 'sha256:wwg-prod-v1',
      approvedReleaseVersion: '1.0.0',
      revision: 1,
      approvedBy: 'cutover-governance',
      promotedAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      notes: 'Durable cutover record approved for Workwear Group',
    });

    // Case A: Query existing durable seed cutover
    const wwg = await runtimeService.getCutoverRecord('workweargroup', 'production');
    assert.ok(wwg, 'Workwear Group record must exist');
    assert.equal(wwg?.status, 'migrated');
    assert.equal(wwg?.approvedReleaseVersion, '1.0.0');

    // Case B: Query unmigrated tenant returns null (fail closed)
    const unknown = await runtimeService.getCutoverRecord('unknown-tenant-999', 'production');
    assert.equal(unknown, null);

    // Case C: Controller getCutoverRecord returns record for valid tenant
    const ctrlWwg = await runtimeController.getCutoverRecord('workweargroup', 'production', { authContext: {} });
    assert.equal(ctrlWwg.tenantId, 'workweargroup');
    assert.equal(ctrlWwg.status, 'migrated');

    // Case D: Controller throws NotFoundException for unmigrated tenant
    await assert.rejects(
      async () => {
        await runtimeController.getCutoverRecord('unknown-tenant-999', 'production', { authContext: {} });
      },
      (err: any) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // Case E: Dynamic registration of a new cutover record via Controller
    await runtimeController.setCutoverRecord(
      'new-brand',
      'production',
      {
        status: 'migrated',
        approvedReleaseChecksum: 'sha256:new-brand-v1',
        approvedReleaseVersion: '1.0.0',
        expectedRevision: 0,
        approvedBy: 'security-governance',
      },
      { authContext: { principalId: 'admin-user' } }
    );

    const newBrand = await runtimeService.getCutoverRecord('new-brand', 'production');
    assert.ok(newBrand);
    assert.equal(newBrand?.status, 'migrated');
    assert.equal(newBrand?.approvedReleaseChecksum, 'sha256:new-brand-v1');
    assert.equal(newBrand?.revision, 1);

    // Case F: Compare-and-Swap (CAS) conflict rejection
    await assert.rejects(
      async () => {
        // Attempt to update with wrong expectedRevision (should fail with 409 Conflict)
        await runtimeController.setCutoverRecord(
          'new-brand',
          'production',
          {
            status: 'migrated',
            approvedReleaseChecksum: 'sha256:new-brand-v1',
            approvedReleaseVersion: '1.0.0',
            expectedRevision: 99, // Mismatched revision
            approvedBy: 'admin-user',
          },
          { authContext: { principalId: 'admin-user' } }
        );
      },
      (err: any) => {
        assert.equal(err.status, 409);
        return true;
      }
    );

    console.log('✓ Runtime Service & Controller Cutover Registry verified\n');
  }

  console.log('====================================================');
  console.log('✓ All 6 UI Standardization & Cutover Tests PASSED!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
