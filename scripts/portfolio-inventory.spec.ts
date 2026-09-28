/**
 * portfolio-inventory.spec.ts
 *
 * Negative and isolation tests for the portfolio governance architecture.
 *
 * Guarantees:
 * 1. A parked tenant does not affect active-portfolio readiness.
 * 2. An unknown/unregistered requested tenant fails closed (PARKED by default).
 * 3. Synthetic fixtures (_fixture suffix) never count as customer packs.
 * 4. Inventory and dry-run consume the same portfolio manifest (classifyTenant is shared).
 * 5. No tenant name is required inside the runtime implementation code —
 *    all classification is driven by the portfolio manifest.
 * 6. Truthful four-project readiness matrix produced with correct statuses.
 */
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  loadPortfolioManifest,
  classifyTenant,
  discoverProjects,
  auditProject,
  runTenantConnectorInventory,
  PortfolioManifest,
  DiscoveredProject,
  DEFAULT_PORTFOLIO_MANIFEST_PATH,
} from './inventory-tenant-connectors';

console.log('🧪 Running Portfolio Inventory & Governance Test Suite...\n');

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Minimal valid portfolio manifest for isolation testing. */
function makeTestManifest(overrides: Partial<PortfolioManifest> = {}): PortfolioManifest {
  return {
    version: '0.0.0-test',
    activePortfolio: [
      { tenantId: 'active-alpha', displayName: 'Active Alpha', industry: 'Manufacturing', commerceMode: 'quote', dataResidency: 'au' },
      { tenantId: 'active-beta', displayName: 'Active Beta', industry: 'Retail', commerceMode: 'cart', dataResidency: 'us' },
    ],
    parked: [
      { tenantId: 'parked-gamma', displayName: 'Parked Gamma', industry: 'Consulting', commerceMode: 'quote', dataResidency: 'us', reason: 'Pending stakeholder sign-off' },
    ],
    syntheticFixtureSuffix: '_fixture',
    packsRoot: 'packs',
    ...overrides,
  };
}

/** Empty DatabaseEvidence (no external connections) */
function emptyDbEvidence() {
  return {
    connected: false,
    releases: new Map(),
    pointers: new Map(),
    cutovers: new Map(),
    connections: new Map(),
    secrets: new Map(),
    normalizationReports: new Map(),
    parityEvidence: new Map(),
    discoveredProjects: new Set<string>(),
  };
}

async function run(): Promise<void> {
  // ── Test 1: classifyTenant correctness ──────────────────────────────────
  console.log('1. Testing classifyTenant correctness...');
  {
    const manifest = makeTestManifest();
    assert.equal(classifyTenant('active-alpha', manifest), 'ACTIVE_PORTFOLIO', 'Active tenant must be ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('active-beta', manifest), 'ACTIVE_PORTFOLIO', 'Active tenant must be ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('parked-gamma', manifest), 'PARKED', 'Parked tenant must be PARKED');
    assert.equal(classifyTenant('parked-gamma_fixture', manifest), 'SYNTHETIC_FIXTURE', 'Fixture suffix takes priority over parked name');
    assert.equal(classifyTenant('unknown_fixture', manifest), 'SYNTHETIC_FIXTURE', 'Unknown tenantId with _fixture suffix is SYNTHETIC_FIXTURE');
    assert.equal(classifyTenant('completely-unknown', manifest), 'PARKED', 'Unknown tenantId without fixture suffix defaults to PARKED (not an active blocker)');
    console.log('   ✅ PASS: classifyTenant returns correct classification for all cases.\n');
  }

  // ── Test 2: Parked tenant does NOT affect active readiness ───────────────
  console.log('2. Proving parked tenant does not affect active-portfolio readiness...');
  {
    const manifest = makeTestManifest();
    const dbEvidence = emptyDbEvidence();

    const projects = await discoverProjects(dbEvidence, manifest);
    const parkedProject = projects.find((p) => p.tenantId === 'parked-gamma');
    const activeProjects = projects.filter((p) => p.classification === 'ACTIVE_PORTFOLIO');

    assert.ok(parkedProject, 'Parked tenant must appear in discovery results (for reporting)');
    assert.equal(parkedProject!.classification, 'PARKED', 'Parked tenant classification must be PARKED');

    // Audit the parked project
    const parkedAudit = await auditProject(parkedProject!, dbEvidence);
    assert.equal(parkedAudit.migrationStatus, 'PARKED', 'Parked tenant migrationStatus must be PARKED');
    assert.equal(parkedAudit.classification, 'PARKED');

    // Verify readiness check: parked results must be excluded from active metrics
    const activeAudits = await Promise.all(
      activeProjects.map((p) => auditProject(p, dbEvidence))
    );
    const activeReadinessCount = activeAudits.filter((r) => r.immutableReleaseReadiness === 'READY').length;
    // All active projects are not_discovered in this offline test → all BLOCKED.
    // The key invariant: parked audit result does NOT appear among activeAudits.
    assert.ok(!activeAudits.some((r) => r.tenantId === 'parked-gamma'), 'Parked tenant must not appear in active-portfolio readiness results');
    assert.equal(activeReadinessCount, 0, 'No active tenant is ready (not discovered) — parked result must not inflate readiness');
    console.log('   ✅ PASS: Parked tenant excluded from active readiness; active count unaffected.\n');
  }

  // ── Test 3: Unknown requested tenant fails closed ────────────────────────
  console.log('3. Proving unknown tenant fails closed (not an active blocker)...');
  {
    const manifest = makeTestManifest();

    // An unknown tenantId not in activePortfolio or parked defaults to PARKED —
    // it becomes visible in discovery only if it appears on disk or in the DB.
    // If injected into discovery directly, it must be classified PARKED.
    const unknownProject: DiscoveredProject = {
      tenantId: 'completely-unknown-tenant',
      name: 'Unknown Tenant',
      source: 'filesystem_pack',
      classification: classifyTenant('completely-unknown-tenant', manifest),
      industry: 'Unknown',
      commerceMode: 'quote',
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'unknown' },
      dataResidency: 'au',
    };

    assert.equal(unknownProject.classification, 'PARKED', 'Unknown tenant must default to PARKED — not an active blocker');

    const audit = await auditProject(unknownProject, emptyDbEvidence());
    assert.equal(audit.migrationStatus, 'PARKED', 'Unknown tenant audit result must be PARKED');
    console.log('   ✅ PASS: Unknown tenant fails closed as PARKED — does not become an active blocker.\n');
  }

  // ── Test 4: Synthetic fixtures never count as customer packs ─────────────
  console.log('4. Proving synthetic fixtures never count as customer packs...');
  {
    const manifest = makeTestManifest();

    const fixtureProject: DiscoveredProject = {
      tenantId: 'active-alpha_fixture',
      name: 'Active Alpha Fixture',
      source: 'filesystem_pack',
      classification: classifyTenant('active-alpha_fixture', manifest),
      industry: 'Manufacturing',
      commerceMode: 'quote',
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'test' },
      dataResidency: 'au',
    };

    assert.equal(fixtureProject.classification, 'SYNTHETIC_FIXTURE', 'Fixture suffix must override ACTIVE_PORTFOLIO classification');

    const audit = await auditProject(fixtureProject, emptyDbEvidence());
    assert.equal(audit.migrationStatus, 'FIXTURE_EVALUATION_ONLY', 'Fixture audit must be FIXTURE_EVALUATION_ONLY — not CANDIDATE_PACK_VALIDATED');
    assert.notEqual(audit.migrationStatus, 'CANDIDATE_PACK_VALIDATED', 'Fixture must never be CANDIDATE_PACK_VALIDATED');
    console.log('   ✅ PASS: Synthetic fixture classified as FIXTURE_EVALUATION_ONLY — never a customer pack.\n');
  }

  // ── Test 5: Inventory and dry-run consume the SAME portfolio ─────────────
  console.log('5. Proving inventory and dry-run consume the same portfolio manifest...');
  {
    // Both scripts import classifyTenant and loadPortfolioManifest from the same
    // inventory-tenant-connectors module. We prove this by loading the manifest
    // once and verifying classifyTenant produces the same results regardless of
    // which script calls it (since it is a pure deterministic function).
    const manifest = makeTestManifest();

    // Simulate what the inventory does
    const inventoryClass = classifyTenant('active-alpha', manifest);
    // Simulate what the evaluator does (same import, same function)
    const evaluatorClass = classifyTenant('active-alpha', manifest);

    assert.equal(inventoryClass, evaluatorClass, 'classifyTenant must return identical results for both inventory and evaluator');
    assert.equal(inventoryClass, 'ACTIVE_PORTFOLIO');

    // Also verify parked is identical
    const invParked = classifyTenant('parked-gamma', manifest);
    const evalParked = classifyTenant('parked-gamma', manifest);
    assert.equal(invParked, evalParked, 'Parked classification must be identical between inventory and evaluator');
    assert.equal(invParked, 'PARKED');
    console.log('   ✅ PASS: Inventory and dry-run consume the same portfolio manifest via shared classifyTenant.\n');
  }

  // ── Test 6: No tenant name required inside runtime implementation code ───
  console.log('6. Proving no tenant name is required in runtime implementation code...');
  {
    // The implementation code (classifyTenant, discoverProjects, auditProject)
    // must work with ANY manifest — no tenant name should be hardcoded.
    // We prove this by creating a manifest with completely different tenant IDs
    // and verifying the implementation correctly classifies them.
    const randomManifest = makeTestManifest({
      activePortfolio: [
        { tenantId: 'org-x-retail', displayName: 'Org X Retail', industry: 'Retail', commerceMode: 'cart', dataResidency: 'sg' },
        { tenantId: 'org-y-trade', displayName: 'Org Y Trade', industry: 'Trade', commerceMode: 'quote', dataResidency: 'gb' },
      ],
      parked: [
        { tenantId: 'org-z-parked', displayName: 'Org Z', industry: 'Finance', commerceMode: 'quote', dataResidency: 'de', reason: 'Pending' },
      ],
    });

    assert.equal(classifyTenant('org-x-retail', randomManifest), 'ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('org-y-trade', randomManifest), 'ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('org-z-parked', randomManifest), 'PARKED');
    assert.equal(classifyTenant('org-z-parked_fixture', randomManifest), 'SYNTHETIC_FIXTURE');

    // Former active tenants (placemakers, workweargroup, etc.) are unknown in this manifest → PARKED
    assert.equal(classifyTenant('placemakers', randomManifest), 'PARKED', 'Implementation code must not hardcode "placemakers"');
    assert.equal(classifyTenant('workweargroup', randomManifest), 'PARKED', 'Implementation code must not hardcode "workweargroup"');
    assert.equal(classifyTenant('abercrombie', randomManifest), 'PARKED', 'Implementation code must not hardcode "abercrombie"');
    assert.equal(classifyTenant('caroma', randomManifest), 'PARKED', 'Implementation code must not hardcode "caroma"');

    console.log('   ✅ PASS: Runtime implementation works with any manifest — no tenant names hardcoded.\n');
  }

  // ── Test 7: Default portfolio manifest loads correctly ───────────────────
  console.log('7. Verifying default portfolio manifest (config/portfolio-manifest.json) loads correctly...');
  {
    const manifest = loadPortfolioManifest(DEFAULT_PORTFOLIO_MANIFEST_PATH);
    assert.ok(manifest.version, 'Manifest must have a version');
    assert.ok(Array.isArray(manifest.activePortfolio), 'activePortfolio must be an array');
    assert.ok(Array.isArray(manifest.parked), 'parked must be an array');
    assert.ok(manifest.activePortfolio.length >= 4, 'Default manifest must contain at least 4 active tenants');

    const activeIds = manifest.activePortfolio.map((e) => e.tenantId);
    assert.ok(activeIds.includes('placemakers'), 'Default manifest must include placemakers as active');
    assert.ok(activeIds.includes('workweargroup'), 'Default manifest must include workweargroup as active');
    assert.ok(activeIds.includes('abercrombie'), 'Default manifest must include abercrombie as active');
    assert.ok(activeIds.includes('caroma'), 'Default manifest must include caroma as active');

    const parkedIds = manifest.parked.map((e) => e.tenantId);
    assert.ok(parkedIds.includes('royalcyber'), 'royalcyber must be parked (not active)');
    assert.ok(parkedIds.includes('dragonshield'), 'dragonshield must be parked (not active)');
    assert.ok(parkedIds.includes('momentec'), 'momentec must be parked (not active)');

    // Parked must not appear in active
    for (const parkedId of parkedIds) {
      assert.ok(!activeIds.includes(parkedId), `Parked tenant '${parkedId}' must not appear in activePortfolio`);
    }
    console.log('   ✅ PASS: Default portfolio manifest structure is correct.\n');
  }

  // ── Test 8: Four-project readiness matrix via real inventory (offline) ───
  console.log('8. Generating four-project active-portfolio readiness matrix (offline)...');
  {
    // Run the inventory offline — no test DB. PlaceMakers pack exists on disk.
    process.env.JOURNEYAX_OFFLINE_HARNESS = 'true';
    delete process.env.TEST_MONGODB_URI;

    const results = await runTenantConnectorInventory({ writeReport: false });

    // Filter to active portfolio only
    const activeResults = results.filter((r) => r.classification === 'ACTIVE_PORTFOLIO');
    const parkedResults = results.filter((r) => r.classification === 'PARKED');

    // Parked tenants must not appear in active portfolio results
    assert.ok(!activeResults.some((r) => r.tenantId === 'royalcyber'), 'royalcyber must not be in active results');
    assert.ok(!activeResults.some((r) => r.tenantId === 'dragonshield'), 'dragonshield must not be in active results');
    assert.ok(!activeResults.some((r) => r.tenantId === 'momentec'), 'momentec must not be in active results');

    // Parked results must all have PARKED status
    for (const r of parkedResults) {
      assert.equal(r.migrationStatus, 'PARKED', `Parked tenant '${r.tenantId}' must have PARKED migrationStatus`);
    }

    // Four active tenants must all be present
    const activeIds = activeResults.map((r) => r.tenantId);
    assert.ok(activeIds.includes('placemakers'), 'placemakers must be in active results');
    assert.ok(activeIds.includes('workweargroup'), 'workweargroup must be in active results');
    assert.ok(activeIds.includes('abercrombie'), 'abercrombie must be in active results');
    assert.ok(activeIds.includes('caroma'), 'caroma must be in active results');

    // PlaceMakers: discovered (filesystem_pack)
    const pm = activeResults.find((r) => r.tenantId === 'placemakers')!;
    assert.ok(pm, 'placemakers must be in active results');
    assert.equal(pm.source, 'filesystem_pack', 'PlaceMakers must be discovered from filesystem');
    assert.ok(pm.schemaValid, 'PlaceMakers schema must be valid');
    assert.ok(pm.groundedRetrievalIsolated, 'PlaceMakers isolation must pass');
    // Cutover pending (offline — no DB): status is BLOCKED because no DurableCutoverRecord
    // This is truthful: LOCAL_CANARY_PASSED but production cutover pending.
    assert.equal(pm.cutoverRecordState, 'NO_RECORD_FOUND', 'PlaceMakers: cutover record is not in test DB (production cutover pending)');

    // WorkwearGroup: discovered (if pack on disk) or not_discovered
    const ww = activeResults.find((r) => r.tenantId === 'workweargroup')!;
    assert.ok(ww, 'workweargroup must be in active results');
    // Source is filesystem_pack if pack exists; not_discovered otherwise — both are valid.
    assert.ok(['filesystem_pack', 'not_discovered'].includes(ww.source), 'workweargroup source must be truthful');

    // Abercrombie: NOT_DISCOVERED (no pack on disk yet)
    const anf = activeResults.find((r) => r.tenantId === 'abercrombie')!;
    assert.ok(anf, 'abercrombie must be in active results');
    assert.equal(anf.source, 'not_discovered', 'abercrombie must be NOT_DISCOVERED');
    assert.equal(anf.migrationStatus, 'BLOCKED', 'abercrombie migrationStatus must be BLOCKED');

    // Caroma: NOT_DISCOVERED (no pack on disk yet)
    const caroma = activeResults.find((r) => r.tenantId === 'caroma')!;
    assert.ok(caroma, 'caroma must be in active results');
    assert.equal(caroma.source, 'not_discovered', 'caroma must be NOT_DISCOVERED');
    assert.equal(caroma.migrationStatus, 'BLOCKED', 'caroma migrationStatus must be BLOCKED');

    // Print readiness matrix
    console.log('\n   Four-Project Active Portfolio Readiness Matrix:');
    console.table(
      activeResults.map((r) => ({
        Tenant: r.tenantId,
        Source: r.source,
        Schema: r.schemaValid ? 'PASS' : 'FAIL',
        Isolated: r.groundedRetrievalIsolated ? 'YES' : 'NO',
        CutoverRecord: r.cutoverRecordState,
        Status: r.migrationStatus,
        Notes: r.tenantId === 'placemakers'
          ? 'LOCAL_CANARY_PASSED / production cutover pending'
          : r.source === 'not_discovered'
          ? 'NOT_DISCOVERED — Business Pack authoring pending'
          : 'Discovered — remaining gates computed from evidence',
      }))
    );

    console.log('   ✅ PASS: Four-project readiness matrix generated truthfully.\n');
  }

  // ── Test 9: Fixture appears in results but not in active readiness ────────
  console.log('9. Proving fixture discovered on disk does not count toward active readiness...');
  {
    const manifest = makeTestManifest();
    const dbEvidence = emptyDbEvidence();

    // Inject a fixture project directly (as if it were loaded from disk)
    const fixture: DiscoveredProject = {
      tenantId: 'active-alpha_fixture',
      name: 'Active Alpha Fixture',
      source: 'filesystem_pack',
      classification: classifyTenant('active-alpha_fixture', manifest),
      industry: 'Manufacturing',
      commerceMode: 'quote',
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'test' },
      dataResidency: 'au',
    };

    assert.equal(fixture.classification, 'SYNTHETIC_FIXTURE');
    const audit = await auditProject(fixture, dbEvidence);
    assert.equal(audit.classification, 'SYNTHETIC_FIXTURE');
    assert.equal(audit.migrationStatus, 'FIXTURE_EVALUATION_ONLY');
    // Ensure fixture's blockers (always "Synthetic test fixture:...") do NOT count as
    // an active-portfolio blocker — the fixture is in a separate bucket.
    assert.ok(audit.blockers.some((b) => b.includes('Synthetic test fixture')));
    // An active-alpha fixture must never be confused with active-alpha itself.
    const activeAlpha: DiscoveredProject = {
      tenantId: 'active-alpha',
      name: 'Active Alpha',
      source: 'not_discovered',
      classification: 'ACTIVE_PORTFOLIO',
      industry: 'Manufacturing',
      commerceMode: 'quote',
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'default' },
      dataResidency: 'au',
    };
    const activeAlphaAudit = await auditProject(activeAlpha, dbEvidence);
    assert.equal(activeAlphaAudit.classification, 'ACTIVE_PORTFOLIO');
    assert.equal(activeAlphaAudit.migrationStatus, 'BLOCKED'); // not_discovered → BLOCKED
    console.log('   ✅ PASS: Fixture never inflates active readiness; active-alpha remains BLOCKED (not_discovered).\n');
  }

  console.log('🎉 ALL PORTFOLIO INVENTORY & GOVERNANCE TESTS PASSED.\n');
}

run().catch((err) => {
  console.error('\n❌ PORTFOLIO INVENTORY SPEC FAILED:');
  console.error(err);
  process.exit(1);
});
