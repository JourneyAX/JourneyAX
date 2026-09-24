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

  // ── Test 1: Safe URI guards reject production URIs and preserve safe test URIs ──
  await test('1. Safe URI resolution accepts test URIs without deletion and strictly refuses production URIs', () => {
    // 1a. Safe test URI
    const safeEnv = { TEST_MONGODB_URI: 'mongodb://localhost:27017/journeyax_test' };
    const resSafe = resolveSafeDatabaseEnvironment(safeEnv);
    assert.equal(resSafe.mode, 'connected');
    assert.equal(resSafe.uri, 'mongodb://localhost:27017/journeyax_test');
    assert.equal(safeEnv.TEST_MONGODB_URI, 'mongodb://localhost:27017/journeyax_test', 'Safe URI must NOT be cleared');

    // 1b. Production Atlas URI
    const prodEnv1 = { MONGODB_URI: 'mongodb+srv://admin:secret@cluster0.prod.mongodb.net/journeyax' };
    const resProd1 = resolveSafeDatabaseEnvironment(prodEnv1);
    assert.equal(resProd1.mode, 'rejected_production');
    assert.equal(resProd1.uri, undefined);
    assert.match(resProd1.warning || '', /Production-like MongoDB URI detected/);

    // 1c. Production keyword in DB URI
    const prodEnv2 = { TEST_MONGODB_URI: 'mongodb://db-prod.internal:27017/production_commerce' };
    const resProd2 = resolveSafeDatabaseEnvironment(prodEnv2);
    assert.equal(resProd2.mode, 'rejected_production');
    assert.equal(resProd2.uri, undefined);

    // 1d. Empty URI -> offline safe mode
    const emptyEnv = {};
    const resEmpty = resolveSafeDatabaseEnvironment(emptyEnv);
    assert.equal(resEmpty.mode, 'offline_safe');
    assert.equal(resEmpty.uri, undefined);
  });

  // ── Test 2: Required customer tenants not found are marked not_discovered and blocked ──
  await test('2. Undiscovered required customer tenants fail closed as not_discovered and BLOCKED', async () => {
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

  // ── Test 3: Synthetic test fixtures are strictly separated and excluded from readiness ──
  await test('3. Synthetic test fixtures are categorized as FIXTURE_EVALUATION_ONLY with topology blockers', async () => {
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

  // ── Test 4: Contradictory status prevention (no READY when blockers exist) ─────
  await test('4. Contradictory status prevention: immutableReleaseReadiness is NOT_READY whenever blockers exist', async () => {
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

  // ── Test 5: Parity is UNEVALUATED unless actual scenario evidence exists ───────
  await test('5. Parity is UNEVALUATED when offline or when no scenario run evidence exists', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });

    for (const r of results) {
      assert.equal(
        r.parityResult,
        'UNEVALUATED',
        `Tenant '${r.tenantId}' parity must be UNEVALUATED without durable scenario execution evidence`
      );
    }
  });

  // ── Test 6: Cutover and Rollback evidence truthfulness ─────────────────────────
  await test('6. Cutover records and rollback baselines are truthfully NO_RECORD_FOUND / NO_ROLLBACK_BASELINE when unprovisioned', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });

    for (const r of results) {
      assert.equal(
        r.cutoverRecordState,
        'NO_RECORD_FOUND',
        `Tenant '${r.tenantId}' cannot claim cutover approval without durable tenant_cutovers record`
      );
      assert.equal(
        r.rollbackEvidence,
        'NO_ROLLBACK_BASELINE',
        `Tenant '${r.tenantId}' cannot claim confirmed rollback without pointer baseline snapshot`
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
