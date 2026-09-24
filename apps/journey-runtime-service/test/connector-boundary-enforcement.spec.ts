import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityDispatcher } from '@journeyax/capability-sdk';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';

async function runArchitectureEnforcementTests() {
  console.log('\n🔒 Running Connector Architecture Boundary & Enforcement Tests (PR 9)...\n');
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

  // ── Test 1: Modern runtime cannot import direct connector adapters ─────────────
  await test('1. Modern Journey Runtime source code cannot import direct connector adapters', () => {
    const runtimeSrcDir = path.resolve(__dirname, '../src');
    const violations: string[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Check for forbidden legacy adapter imports
          if (/@journeyax\/integration/.test(content)) {
            violations.push(`${fullPath}: Prohibited import from '@journeyax/integration'`);
          }
          if (/@journeyax\/configurator-core/.test(content)) {
            violations.push(`${fullPath}: Prohibited import from '@journeyax/configurator-core'`);
          }
          if (/CommercetoolsKnowledgeAdapter|ShopifyCommerceAdapter|SalesforceCrmAdapter|SapErpConnector/i.test(content)) {
            violations.push(`${fullPath}: Direct connector adapter class referenced`);
          }
        }
      }
    }

    scanDir(runtimeSrcDir);
    assert.equal(
      violations.length,
      0,
      `Modern Journey Runtime must not import direct connector adapters:\n${violations.join('\n')}`
    );
  });

  // ── Test 2: Browser routes and Studio components cannot call provider APIs ─────
  await test('2. Studio browser routes and UI components cannot call provider APIs directly', () => {
    const adminSrcDir = path.resolve(__dirname, '../../../apps/backoffice-admin/src');
    const violations: string[] = [];

    const forbiddenDomains = [
      'api.australia-southeast1.gcp.commercetools.com',
      'auth.australia-southeast1.gcp.commercetools.com',
      'api.stripe.com',
      'api.sendgrid.com',
      'api.shopify.com',
      'api.salesforce.com',
      'api.hubspot.com',
    ];

    function scanAdminDir(dir: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanAdminDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const domain of forbiddenDomains) {
            if (content.includes(domain)) {
              violations.push(`${fullPath}: Prohibited direct provider URL '${domain}' found in browser codebase`);
            }
          }
        }
      }
    }

    scanAdminDir(adminSrcDir);
    assert.equal(
      violations.length,
      0,
      `Browser routes and components must not call provider APIs directly:\n${violations.join('\n')}`
    );
  });

  // ── Test 3: Connector bindings require tenant and environment ownership validation ──
  await test('3. Connector bindings require tenant and environment ownership validation (fail-closed)', async () => {
    // 3a. Missing ownership validator throws fail-closed
    const unvalidatedDispatcher = new CapabilityDispatcher();
    const unvalidatedResult = await unvalidatedDispatcher.dispatch(
      {
        toolId: 'catalog.sync',
        version: '1.0.0',
        displayName: 'Catalog Sync',
        description: 'Sync',
        inputSchema: {},
        outputSchema: {},
        sideEffect: 'read',
        risk: 'low',
        timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
        idempotencyPolicy: { required: false, ttlSeconds: 60 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
        dataClassification: 'internal',
      },
      {
        toolId: 'catalog.sync',
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        bindingVersion: '1.0.0',
        executor: {
          type: 'activepieces_flow',
          flowId: 'flow_ct_sync_01',
          connectionRef: 'conn_ct_caroma_secret',
        },
        enabled: true,
      },
      { toolId: 'catalog.sync', input: {} },
      {
        workspaceId: 'ws_01',
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        correlationId: 'corr_01',
      }
    );

    assert.equal(unvalidatedResult.status, 'failure');
    assert.match(
      unvalidatedResult.error || '',
      /validateConnectionOwnership validator is mandatory when connectionRef is provided; failing closed/i
    );

    // 3b. Ownership validator rejects cross-tenant connection reference
    const verifiedDispatcher = new CapabilityDispatcher({
      validateConnectionOwnership: (tId, envId, connRef) => {
        // Only allow conn_ct_caroma_secret for tenant_caroma in production
        return tId === 'tenant_caroma' && envId === 'production' && connRef === 'conn_ct_caroma_secret';
      },
    });

    const crossTenantResult = await verifiedDispatcher.dispatch(
      {
        toolId: 'catalog.sync',
        version: '1.0.0',
        displayName: 'Catalog Sync',
        description: 'Sync',
        inputSchema: {},
        outputSchema: {},
        sideEffect: 'read',
        risk: 'low',
        timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
        idempotencyPolicy: { required: false, ttlSeconds: 60 },
        approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
        dataClassification: 'internal',
      },
      {
        toolId: 'catalog.sync',
        tenantId: 'tenant_adversary',
        environmentId: 'production',
        bindingVersion: '1.0.0',
        executor: {
          type: 'activepieces_flow',
          flowId: 'flow_ct_sync_01',
          connectionRef: 'conn_ct_caroma_secret', // Cross-tenant theft attempt!
        },
        enabled: true,
      },
      { toolId: 'catalog.sync', input: {} },
      {
        workspaceId: 'ws_02',
        tenantId: 'tenant_adversary',
        environmentId: 'production',
        correlationId: 'corr_02',
      }
    );

    assert.equal(crossTenantResult.status, 'failure');
    assert.match(
      crossTenantResult.error || '',
      /connectionRef 'conn_ct_caroma_secret' not owned by tenant 'tenant_adversary'/i
    );
  });

  // ── Test 4: Activepieces failure remains durable and retryable (never log-and-ack) ──
  await test('4. Activepieces failure remains durable/retryable and never marks published', async () => {
    const mockRepo = new OutboxRepository();
    const outboxService = new OutboxWorkerService();
    // Register real handler that throws when external Activepieces invocation fails
    outboxService.registerHandler('activepieces.dispatch', async () => {
      throw new Error('Activepieces service unavailable: HTTP 503 upstream connect timeout');
    });

    const eventId = await mockRepo.enqueueEvent(
      'tenant_caroma',
      'production',
      'activepieces.dispatch',
      { flowId: 'flow_sync', itemId: 'item_101' }
    );

    const worker = new OutboxWorker(mockRepo, {
      workerId: 'worker_boundary_test',
      batchSize: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 10000,
      maxAttempts: 3,
      backoffBaseMs: 100,
      dispatcher: async (evt) => {
        await outboxService.dispatchEvent(evt);
      },
    });

    // Run one processing batch
    const batchResult = await worker.processNextBatch();
    assert.equal(batchResult.processed, 1);
    assert.equal(batchResult.failed, 1);
    assert.equal(batchResult.succeeded, 0);

    // Verify event is NOT marked published, but scheduled for retry
    const storedEvents = mockRepo.getEvents();
    const storedEvent = storedEvents.find((e) => e.eventId === eventId);
    assert.ok(storedEvent);
    assert.equal(storedEvent.status, 'pending', 'Event MUST remain pending/retryable on Activepieces failure');
    assert.notEqual(storedEvent.status, 'published', 'Event must NEVER be marked published on failure');
    assert.equal(storedEvent.attempts, 1);
    assert.match(storedEvent.error || '', /Activepieces service unavailable/i);
  });

  // ── Test 5: Grounded normalized retrieval stays tenant-scoped ───────────────────
  await test('5. Grounded normalized retrieval strictly isolates data by tenantId (no cross-tenant leakage)', async () => {
    const multiTenantCatalog = [
      {
        projectId: 'tenant_caroma',
        sku: 'CAROMA-BASIN-001',
        name: 'Caroma Luna Basin',
        category: 'Basins',
        priceCents: 45000,
        stock: { inStock: true, availableQuantity: 10 },
      },
      {
        projectId: 'tenant_other',
        sku: 'OTHER-BASIN-999',
        name: 'Competitor Basin',
        category: 'Basins',
        priceCents: 32000,
        stock: { inStock: true, availableQuantity: 5 },
      },
    ];

    const handler = new CatalogSearchHandler(multiTenantCatalog);

    // Search from tenant_caroma context
    const caromaResults = await handler.execute(
      { query: 'Basin' },
      {
        workspaceId: 'ws_caroma',
        tenantId: 'tenant_caroma',
        environmentId: 'production',
        correlationId: 'corr_c1',
      }
    );

    assert.equal(caromaResults.items.length, 1);
    assert.equal(caromaResults.items[0].sku, 'CAROMA-BASIN-001');
    assert.equal(caromaResults.items.some((i: any) => i.sku === 'OTHER-BASIN-999'), false, 'Cross-tenant SKU leaked!');

    // Search from tenant_other context
    const otherResults = await handler.execute(
      { query: 'Basin' },
      {
        workspaceId: 'ws_other',
        tenantId: 'tenant_other',
        environmentId: 'production',
        correlationId: 'corr_c2',
      }
    );

    assert.equal(otherResults.items.length, 1);
    assert.equal(otherResults.items[0].sku, 'OTHER-BASIN-999');
    assert.equal(otherResults.items.some((i: any) => i.sku === 'CAROMA-BASIN-001'), false, 'Cross-tenant SKU leaked!');
  });

  // ── Test 6: Truthful migration inventory classifies synthetic fixtures and flags blockers ──
  await test('6. Truthful migration inventory classifies synthetic fixtures and flags mandatory blockers', async () => {
    const { runTenantConnectorInventory } = await import('../../../scripts/inventory-tenant-connectors');
    const auditResults = await runTenantConnectorInventory({ writeReport: false });

    assert.ok(auditResults.length > 0, 'Audit must produce tenant results');

    // 6a. Discovered filesystem packs are properly categorized
    const royalCyber = auditResults.find((r) => r.tenantId === 'royalcyber');
    assert.ok(royalCyber, 'royalcyber must be in audit results');
    assert.equal(royalCyber.source, 'filesystem_pack');
    assert.equal(royalCyber.groundedRetrievalIsolated, true);
    assert.equal(royalCyber.rawSecretsCount, 0);
    assert.equal(royalCyber.directUrlsCount, 0);
    // Must NOT claim zero blockers because cutover approval record is missing
    assert.ok(royalCyber.blockers.includes('Cutover approval record missing in tenant_cutovers'));
    assert.notEqual(royalCyber.migrationStatus, 'READY');

    // 6b. Synthetic fixtures must NEVER be classified as discovered projects or claim production cutover
    const placemakers = auditResults.find((r) => r.tenantId === 'placemakers');
    assert.ok(placemakers, 'placemakers must be in audit results');
    assert.equal(placemakers.source, 'synthetic_fixture');
    assert.equal(placemakers.migrationStatus, 'FIXTURE_EVALUATION_ONLY');
    assert.ok(
      placemakers.blockers.includes('Synthetic test fixture: not a discovered customer project'),
      'Synthetic fixture must explicitly flag non-discovered blocker'
    );
  });

  // ── Test 7: Inventory prevents false zero-blocker claims when cutover records are missing ──
  await test('7. Inventory prevents false zero-blocker claims when cutover records are missing', async () => {
    const { runTenantConnectorInventory } = await import('../../../scripts/inventory-tenant-connectors');
    const auditResults = await runTenantConnectorInventory({ writeReport: false });

    for (const res of auditResults) {
      assert.ok(
        res.blockers.length > 0,
        `Tenant '${res.tenantId}' must have truthful blockers while cutover records remain unprovisioned`
      );
      assert.notEqual(
        res.cutoverRecordState,
        'VERIFIED_ACTIVE',
        `Tenant '${res.tenantId}' cannot claim VERIFIED_ACTIVE without production cutover record`
      );
    }
  });

  console.log(`\nConnector Architecture Boundary Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runArchitectureEnforcementTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
