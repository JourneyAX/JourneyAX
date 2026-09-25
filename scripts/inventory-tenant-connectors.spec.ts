import assert from 'node:assert/strict';
import {
  resolveSafeDatabaseEnvironment,
  runTenantConnectorInventory,
  REQUIRED_CUSTOMER_TENANTS,
  ComputedAuditResult,
} from './inventory-tenant-connectors';

async function runInventoryValidationSuite() {
  console.log('\n📊 Running Truthful Migration Evidence & Inventory Guard Suite (Workstream C)...\n');
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

  // ── Test 1: Safe URI guards reject MONGODB_URI fallback and production URIs ──
  await test('1. Safe URI resolution accepts ONLY explicit TEST_MONGODB_URI, refuses MONGODB_URI fallback and production URIs', () => {
    // 1a. Safe test URI via TEST_MONGODB_URI
    const safeEnv = { TEST_MONGODB_URI: 'mongodb://localhost:27017/journeyax_test' };
    const resSafe = resolveSafeDatabaseEnvironment(safeEnv);
    assert.equal(resSafe.mode, 'connected');
    assert.equal(resSafe.uri, 'mongodb://localhost:27017/journeyax_test');
    assert.equal(safeEnv.TEST_MONGODB_URI, 'mongodb://localhost:27017/journeyax_test', 'Safe URI must NOT be cleared');

    // 1b. MONGODB_URI is strictly ignored (no fallback permitted)
    const fallbackEnv = { MONGODB_URI: 'mongodb://localhost:27017/should_not_connect' };
    const resFallback = resolveSafeDatabaseEnvironment(fallbackEnv);
    assert.equal(resFallback.mode, 'offline_safe', 'Must NOT fall back to MONGODB_URI');
    assert.equal(resFallback.uri, undefined);

    // 1c. Production Atlas URI
    const prodEnv1 = { TEST_MONGODB_URI: 'mongodb+srv://admin:secret@cluster0.prod.mongodb.net/journeyax' };
    const resProd1 = resolveSafeDatabaseEnvironment(prodEnv1);
    assert.equal(resProd1.mode, 'rejected_production');
    assert.equal(resProd1.uri, undefined);
    assert.match(resProd1.warning || '', /Production-like MongoDB URI detected/);

    // 1d. Production keyword in DB URI
    const prodEnv2 = { TEST_MONGODB_URI: 'mongodb://db-prod.internal:27017/production_commerce' };
    const resProd2 = resolveSafeDatabaseEnvironment(prodEnv2);
    assert.equal(resProd2.mode, 'rejected_production');
    assert.equal(resProd2.uri, undefined);

    // 1e. Empty URI -> offline safe mode
    const emptyEnv = {};
    const resEmpty = resolveSafeDatabaseEnvironment(emptyEnv);
    assert.equal(resEmpty.mode, 'offline_safe');
    assert.equal(resEmpty.uri, undefined);
  });

  // ── Test 2: Required customer tenants include all mandatory enterprise customers ──
  await test('2. REQUIRED_CUSTOMER_TENANTS includes all mandatory customer brands', async () => {
    const expectedTenants = [
      'workweargroup',
      'royalcyber',
      'abercrombie',
      'caroma',
      'caroma-nz',
      'placemakers',
      'momentec',
      'garts',
      'dragonshield',
    ];

    for (const expected of expectedTenants) {
      assert.ok(
        REQUIRED_CUSTOMER_TENANTS.includes(expected),
        `REQUIRED_CUSTOMER_TENANTS must contain mandatory customer '${expected}'`
      );
    }
  });

  // ── Test 3: Undiscovered required customer tenants fail closed as not_discovered and blocked ──
  await test('3. Undiscovered required customer tenants fail closed as not_discovered and BLOCKED', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });

    for (const requiredTenantId of REQUIRED_CUSTOMER_TENANTS) {
      const tenantResult = results.find((r) => r.tenantId === requiredTenantId);
      assert.ok(tenantResult, `Required tenant '${requiredTenantId}' must be present in inventory`);

      if (tenantResult.source === 'not_discovered') {
        assert.equal(tenantResult.migrationStatus, 'BLOCKED');
        assert.equal(tenantResult.immutableReleaseReadiness, 'NOT_READY');
        assert.equal(tenantResult.parityResult, 'UNEVALUATED');
        assert.ok(
          tenantResult.blockers.some((b) => b.includes('Required customer tenant not discovered')),
          `Undiscovered tenant '${requiredTenantId}' must have explicit discovery blocker`
        );
      }
    }
  });

  // ── Test 4: Synthetic test fixtures are strictly separated and excluded from customer readiness ──
  await test('4. Synthetic test fixtures are categorized as FIXTURE_EVALUATION_ONLY with topology blockers', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });
    const fixtures = results.filter((r) => r.source === 'synthetic_fixture');

    assert.equal(fixtures.length, 5, 'Must evaluate 5 synthetic fixtures');
    for (const fix of fixtures) {
      assert.equal(fix.migrationStatus, 'FIXTURE_EVALUATION_ONLY');
      assert.equal(fix.immutableReleaseReadiness, 'NOT_READY');
      assert.ok(
        fix.blockers.includes('Synthetic test fixture: not a discovered customer project'),
        `Fixture '${fix.tenantId}' must flag synthetic fixture blocker`
      );
    }
  });

  // ── Test 5: Contradictory status prevention (no READY when blockers exist) ─────
  await test('5. Contradictory status prevention: immutableReleaseReadiness is NOT_READY whenever blockers exist', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });

    for (const r of results) {
      if (r.blockers.length > 0) {
        assert.equal(
          r.immutableReleaseReadiness,
          'NOT_READY',
          `Tenant '${r.tenantId}' has ${r.blockers.length} blockers, so readiness MUST be NOT_READY`
        );
        assert.notEqual(
          r.migrationStatus,
          'CANDIDATE_PACK_VALIDATED',
          `Tenant '${r.tenantId}' with blockers cannot have CANDIDATE_PACK_VALIDATED status`
        );
      }
    }
  });

  // ── Test 6: Parity is UNEVALUATED unless actual scenario evidence exists ───────
  await test('6. Parity is UNEVALUATED when offline or when no scenario run evidence exists', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });

    for (const r of results) {
      assert.equal(
        r.parityResult,
        'UNEVALUATED',
        `Tenant '${r.tenantId}' parity must be UNEVALUATED without durable scenario execution evidence`
      );
    }
  });

  // ── Test 7: Cutover approval presence alone is NOT active cutover ─────────────
  await test('7. Approval presence alone in tenant_cutovers does NOT mark cutover active', async () => {
    const { auditProject } = await import('./inventory-tenant-connectors');
    const mockEvidence = {
      connected: true,
      releases: new Map(),
      pointers: new Map(),
      cutovers: new Map([
        [
          'test_tenant:production',
          {
            tenantId: 'test_tenant',
            environmentId: 'production',
            status: 'pending', // Not active!
            approvalRecord: { approvedBy: 'admin@local', approvedAt: '2026-09-24T00:00:00Z' },
          },
        ],
      ]),
      connections: new Map(),
      secrets: new Map(),
      normalizationReports: new Map(),
      parityEvidence: new Map(),
      discoveredProjects: new Set<string>(),
    };

    const mockProject = {
      tenantId: 'test_tenant',
      name: 'Test Tenant',
      source: 'filesystem_pack' as const,
      industry: 'Retail',
      commerceMode: 'quote' as const,
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'tenant_configured' },
      dataResidency: 'au',
    };

    const auditRes = await auditProject(mockProject, mockEvidence as any, { writeReport: false });
    assert.equal(
      auditRes.cutoverRecordState,
      'PENDING_APPROVAL',
      'Approval presence with status pending must NOT be VERIFIED_ACTIVE'
    );
    assert.ok(
      auditRes.blockers.some((b) => b.includes('Cutover status is not actively verified')),
      'Must contain cutover verification blocker'
    );
  });

  // ── Test 8: Do not invent OpenAI model policy for synthetic/migrated packs ──────
  await test('8. OpenAI model policy is NOT invented for synthetic fixtures or packs without OpenAI', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });
    const syntheticWithoutOpenAI = results.filter(
      (r) => r.source === 'synthetic_fixture' && (r.tenantId.includes('abercrombie') || r.tenantId.includes('momentec') || r.tenantId.includes('garts'))
    );

    assert.ok(syntheticWithoutOpenAI.length >= 3, 'Must check synthetic fixtures without OpenAI');
    for (const r of syntheticWithoutOpenAI) {
      assert.ok(
        !r.connectionRefMappings.some((m) => m.toLowerCase().includes('openai')),
        `Synthetic fixture '${r.tenantId}' must not invent OpenAI connection mappings`
      );
    }
  });

  console.log(`\nInventory Evidence Guard Suite Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runInventoryValidationSuite().catch((err) => {
  console.error('Fatal test error in inventory validation suite:', err);
  process.exit(1);
});
