import assert from 'node:assert/strict';
import { DurableConnectionOwnershipRepository } from '../src/kernel/connection-ownership.repository';

async function runTypedConnectorOwnershipTests() {
  console.log('\n🔒 Running Typed Connector Ownership & Studio Security Suite (Workstream B)...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  }

  // Set up in-memory DB collections fake
  const connectionsTable: any[] = [];
  const secretsTable: any[] = [];

  const mockDb = {
    collection: (name: string) => ({
      findOne: async (query: any) => {
        const table = name === 'tenant_connections' ? connectionsTable : secretsTable;
        return table.find((doc) => {
          for (const [k, v] of Object.entries(query)) {
            if (k === 'environmentId' && v && typeof v === 'object' && '$in' in v) {
              const inList = (v as any).$in;
              if (!inList.includes(doc.environmentId) && doc.environmentId !== 'all') {
                return false;
              }
            } else if (k === 'status' && v && typeof v === 'object' && '$nin' in v) {
              if ((v as any).$nin.includes(doc.status)) return false;
            } else if (doc[k] !== v) {
              return false;
            }
          }
          return true;
        }) || null;
      },
    }),
  };

  const repo = new DurableConnectionOwnershipRepository(() => mockDb);

  // Seed sample data
  connectionsTable.push(
    {
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      connectionRef: 'conn_ct_caroma_prod',
      pieceName: '@activepieces/piece-commercetools',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_catalog_sync', 'flow_pricing_validate'],
    },
    {
      tenantId: 'tenant_caroma',
      environmentId: 'staging',
      connectionRef: 'conn_ct_caroma_staging',
      pieceName: '@activepieces/piece-commercetools',
      status: 'active',
      enabled: true,
    },
    {
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      connectionRef: 'conn_ct_revoked',
      pieceName: '@activepieces/piece-commercetools',
      status: 'revoked',
      enabled: false,
    },
    {
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      connectionRef: 'conn_ct_inactive',
      pieceName: '@activepieces/piece-commercetools',
      status: 'inactive',
      enabled: true,
    },
    {
      tenantId: 'tenant_shopify_user',
      environmentId: 'production',
      connectionRef: 'conn_shopify_prod',
      pieceName: '@activepieces/piece-shopify',
      status: 'active',
      enabled: true,
    }
  );

  secretsTable.push({
    tenantId: 'tenant_caroma',
    environmentId: 'production',
    secretRef: 'raw_api_key_secret',
    value: 'secret_value_123',
  });

  // ── Test 1: Cross-tenant connection ownership fails closed ─────────────────
  await test('1. Cross-tenant connection ownership access is rejected (fails closed)', async () => {
    const isOwner = await repo.validateOwnership(
      'tenant_adversary',
      'production',
      'conn_ct_caroma_prod'
    );
    assert.equal(isOwner, false, 'Adversary tenant must not be granted ownership of Caroma connection');
  });

  // ── Test 2: Cross-environment connection ownership fails closed ────────────
  await test('2. Cross-environment connection reference access is rejected', async () => {
    const isOwner = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_caroma_staging'
    );
    assert.equal(isOwner, false, 'Staging connection must not be valid for production environment');
  });

  // ── Test 3: Wrong pieceId is rejected ───────────────────────────────────────
  await test('3. Connection registered for one piece is rejected when requested for another', async () => {
    const isShopifyValidForCommercetools = await repo.validateOwnership(
      'tenant_shopify_user',
      'production',
      'conn_shopify_prod',
      { pieceId: '@activepieces/piece-commercetools' }
    );
    assert.equal(
      isShopifyValidForCommercetools,
      false,
      'Shopify connection must not be valid for commercetools piece'
    );

    const isShopifyValidForShopify = await repo.validateOwnership(
      'tenant_shopify_user',
      'production',
      'conn_shopify_prod',
      { pieceId: '@activepieces/piece-shopify' }
    );
    assert.equal(isShopifyValidForShopify, true, 'Shopify connection must be valid for shopify piece');
  });

  // ── Test 4: Inactive or revoked connection lifecycle fails closed ──────────
  await test('4. Revoked and inactive connections are rejected', async () => {
    const revokedValid = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_revoked'
    );
    assert.equal(revokedValid, false, 'Revoked connection must be rejected');

    const inactiveValid = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_inactive'
    );
    assert.equal(inactiveValid, false, 'Inactive connection must be rejected');
  });

  // ── Test 5: Arbitrary secret references are NOT treated as connections ─────
  await test('5. Arbitrary tenant_secrets cannot masquerade as Activepieces connections', async () => {
    const isSecretTreatedAsConn = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'raw_api_key_secret'
    );
    assert.equal(
      isSecretTreatedAsConn,
      false,
      'Arbitrary secret from tenant_secrets must NEVER be validated as connection ownership'
    );
  });

  // ── Test 6: Active connection with flow binding succeeds ───────────────────
  await test('6. Active connection succeeds and enforces allowed flow bindings', async () => {
    // Permitted flow
    const allowedFlowValid = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_caroma_prod',
      { flowId: 'flow_catalog_sync' }
    );
    assert.equal(allowedFlowValid, true, 'Permitted flow must be allowed');

    // Forbidden flow
    const unallowedFlowValid = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_caroma_prod',
      { flowId: 'flow_unauthorized_action' }
    );
    assert.equal(unallowedFlowValid, false, 'Flow not in allowedFlows must be rejected');
  });

  // ── Test 7: Blank or missing inputs fail closed ────────────────────────────
  await test('7. Missing or whitespace inputs fail closed', async () => {
    assert.equal(await repo.validateOwnership('', 'production', 'conn_ct_caroma_prod'), false);
    assert.equal(await repo.validateOwnership('tenant_caroma', '', 'conn_ct_caroma_prod'), false);
    assert.equal(await repo.validateOwnership('tenant_caroma', 'production', '  '), false);
  });

  // ── Test 8: Substring piece name matching is strictly rejected ─────────────
  await test('8. Substring piece names do not match canonical aliases', async () => {
    // Seed a connection with an adversary/substring piece name
    connectionsTable.push({
      tenantId: 'tenant_caroma',
      environmentId: 'production',
      connectionRef: 'conn_ct_sub_exploit',
      pieceName: '@activepieces/piece-commercetools-fake',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_catalog_sync'],
    });

    const isMatch = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_sub_exploit',
      { pieceId: '@activepieces/piece-commercetools' }
    );
    assert.equal(isMatch, false, 'Substring piece name must not be accepted as canonical commercetools piece');
  });

  // ── Test 9: Missing allowedFlows fails closed when flowId is requested ──────
  await test('9. Missing or empty allowedFlows fails closed when flowId is requested', async () => {
    // conn_ct_caroma_staging has no allowedFlows defined
    const hasFlowBinding = await repo.validateOwnership(
      'tenant_caroma',
      'staging',
      'conn_ct_caroma_staging',
      { flowId: 'flow_any_action' }
    );
    assert.equal(hasFlowBinding, false, 'Connection without explicit allowedFlows must fail closed when flowId is requested');
  });

  // ── Test 10: Wrong flowId fails closed ─────────────────────────────────────
  await test('10. Wrong flowId fails closed against allowedFlows whitelist', async () => {
    const isWrongFlowAllowed = await repo.validateOwnership(
      'tenant_caroma',
      'production',
      'conn_ct_caroma_prod',
      { flowId: 'flow_malicious_export' }
    );
    assert.equal(isWrongFlowAllowed, false, 'Unwhitelisted flowId must fail closed');
  });

  // ── Test 11: Real CapabilityDispatcher with PolicyGate handles requires_approval / denied ──
  await test('11. CapabilityDispatcher policy gate returns requires_approval and denied appropriately', async () => {
    const { CapabilityDispatcher } = await import('@journeyax/capability-sdk');

    const dispatcher = new CapabilityDispatcher({
      activepiecesApiUrl: 'http://localhost:3010',
      activepiecesApiKey: 'test_key',
      activepiecesWebhookSecret: 'test_sec',
      validateConnectionOwnership: async (t, e, c, opts) => repo.validateOwnership(t, e, c, opts),
    });

    const toolDef = {
      toolId: 'commercetools.restricted_action',
      version: '1.0.0',
      displayName: 'Restricted Action',
      description: 'Test policy gates',
      inputSchema: {},
      outputSchema: {},
      sideEffect: 'transactional' as const,
      risk: 'high' as const,
      timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
      idempotencyPolicy: { required: true, ttlSeconds: 60 },
      approvalPolicy: { requiresApproval: true, ttlMinutes: 10 },
      dataClassification: 'internal' as const,
    };

    const toolBinding = {
      tenantId: 'tenant_caroma',
      environmentId: 'production' as const,
      toolId: 'commercetools.restricted_action',
      bindingVersion: '1.0.0',
      executor: {
        type: 'activepieces_flow' as const,
        flowId: 'flow_catalog_sync',
        connectionRef: 'conn_ct_caroma_prod',
      },
      enabled: true,
      policy: {
        requiredRole: 'admin',
        requiresConfirmation: true,
        idempotencyRequired: true,
        timeoutMs: 5000,
        retryAttempts: 0,
      },
    };

    // 11a: Role check failure (customer vs admin) -> denied
    const deniedCtx = {
      workspaceId: 'ws_caroma',
      tenantId: 'tenant_caroma',
      environmentId: 'production' as const,
      sessionId: 'sess_1',
      stageId: 'stage_test',
      packVersionId: '1.0.0',
      correlationId: 'corr_1',
      principalRole: 'customer', // Insufficient role
    };
    const deniedRes = await dispatcher.dispatch(
      toolDef,
      toolBinding,
      { toolId: toolDef.toolId, input: {}, userConfirmationConfirmed: true, idempotencyKey: 'idemp_1' },
      deniedCtx
    );
    assert.equal(deniedRes.status, 'denied', 'Insufficient role must yield status denied');

    // 11b: Confirmation failure -> requires_approval
    const unconfirmedCtx = {
      ...deniedCtx,
      principalRole: 'admin',
    };
    const unconfirmedRes = await dispatcher.dispatch(
      toolDef,
      toolBinding,
      { toolId: toolDef.toolId, input: {}, userConfirmationConfirmed: false, idempotencyKey: 'idemp_2' },
      unconfirmedCtx
    );
    assert.equal(unconfirmedRes.status, 'requires_approval', 'Unconfirmed transactional tool must yield requires_approval');
  });

  console.log(`\nTyped Connector Ownership Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runTypedConnectorOwnershipTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
