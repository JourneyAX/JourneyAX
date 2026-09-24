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

  console.log(`\nTyped Connector Ownership Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runTypedConnectorOwnershipTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
