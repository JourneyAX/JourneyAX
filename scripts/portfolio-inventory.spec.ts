// Enforce offline mode BEFORE any module imports so that .env is never loaded
process.env.JOURNEYAX_OFFLINE_HARNESS = 'true';
process.env.NODE_ENV = 'test';
delete process.env.TEST_MONGODB_URI;
delete process.env.MONGODB_URI;

/**
 * portfolio-inventory.spec.ts
 *
 * Negative and isolation tests for the portfolio governance architecture.
 *
 * Guarantees:
 * 1. A parked tenant does not affect active-portfolio readiness.
 * 2. An unknown/unregistered requested tenant fails closed (UNREGISTERED, BLOCKED, governance failure).
 * 3. Synthetic fixtures (_fixture suffix or declared in syntheticFixtures) never count as customer packs.
 * 4. Schema enforcement: required fields, allowed commerce modes, unique tenant IDs, zero overlap.
 * 5. Inventory and dry-run evaluator both invoked against arbitrary temporary manifest (file and object).
 * 6. Evaluator is read-only by default; report writing requires --write.
 * 7. Offline mode strictly prevents loading .env.
 * 8. Distinguish configured tenants from discovered packs for consistent counts.
 * 9. Truthful four-project readiness matrix produced with correct statuses.
 */
import assert from 'node:assert/strict';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadPortfolioManifest,
  validatePortfolioManifest,
  classifyTenant,
  discoverProjects,
  auditProject,
  runTenantConnectorInventory,
  PortfolioManifest,
  DiscoveredProject,
  DEFAULT_PORTFOLIO_MANIFEST_PATH,
} from './inventory-tenant-connectors';

import {
  evaluateSeedMigrationDryRun,
} from './evaluate-seed-migration-dry-run';

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
    syntheticFixtures: [
      { tenantId: 'fixture-delta_fixture', displayName: 'Fixture Delta', industry: 'Testing', commerceMode: 'quote', dataResidency: 'nz' },
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
  // ── Test 1: classifyTenant correctness & UNREGISTERED classification ──────
  console.log('1. Testing classifyTenant correctness & explicit UNREGISTERED classification...');
  {
    const manifest = makeTestManifest();
    assert.equal(classifyTenant('active-alpha', manifest), 'ACTIVE_PORTFOLIO', 'Active tenant must be ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('active-beta', manifest), 'ACTIVE_PORTFOLIO', 'Active tenant must be ACTIVE_PORTFOLIO');
    assert.equal(classifyTenant('parked-gamma', manifest), 'PARKED', 'Parked tenant must be PARKED');
    assert.equal(classifyTenant('fixture-delta_fixture', manifest), 'SYNTHETIC_FIXTURE', 'Fixture declared in syntheticFixtures is SYNTHETIC_FIXTURE');
    assert.equal(classifyTenant('unknown_fixture', manifest), 'SYNTHETIC_FIXTURE', 'Unknown tenantId with _fixture suffix is SYNTHETIC_FIXTURE');

    // Finding 2: Unknown tenants absent from manifest MUST be UNREGISTERED (not silently PARKED)
    assert.equal(
      classifyTenant('completely-unknown', manifest),
      'UNREGISTERED',
      'Unknown tenantId absent from manifest must be classified UNREGISTERED'
    );
    console.log('   ✅ PASS: classifyTenant returns ACTIVE_PORTFOLIO, PARKED, SYNTHETIC_FIXTURE, and explicit UNREGISTERED.\n');
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
    assert.ok(!activeAudits.some((r) => r.tenantId === 'parked-gamma'), 'Parked tenant must not appear in active-portfolio readiness results');
    assert.equal(activeReadinessCount, 0, 'No active tenant is ready (not discovered) — parked result must not inflate readiness');
    console.log('   ✅ PASS: Parked tenant excluded from active readiness; active count unaffected.\n');
  }

  // ── Test 3: UNREGISTERED tenant fails closed and counts as governance failure ─
  console.log('3. Proving UNREGISTERED tenant fails closed as BLOCKED and records governance failure...');
  {
    const manifest = makeTestManifest();

    // Tenant absent from manifest
    const unregisteredClassification = classifyTenant('unauthorized-rogue-tenant', manifest);
    assert.equal(unregisteredClassification, 'UNREGISTERED');

    const unregisteredProject: DiscoveredProject = {
      tenantId: 'unauthorized-rogue-tenant',
      name: 'Unauthorized Rogue Tenant',
      source: 'filesystem_pack',
      classification: unregisteredClassification,
      industry: 'Unknown',
      commerceMode: 'quote',
      externalConnectors: [],
      activepiecesFlows: [],
      model: { provider: 'custom', model: 'unknown' },
      dataResidency: 'au',
    };

    const audit = await auditProject(unregisteredProject, emptyDbEvidence());
    assert.equal(audit.classification, 'UNREGISTERED');
    assert.equal(audit.migrationStatus, 'BLOCKED', 'Unregistered tenant must be BLOCKED');
    assert.equal(audit.immutableReleaseReadiness, 'NOT_READY', 'Unregistered tenant must be NOT_READY');
    assert.ok(
      audit.blockers.some((b) => b.includes('UNREGISTERED_TENANT')),
      'Must contain explicit UNREGISTERED_TENANT governance violation blocker'
    );

    // Also test undiscovered unregistered project
    const undiscoveredUnregistered: DiscoveredProject = {
      ...unregisteredProject,
      source: 'not_discovered',
    };
    const auditUndiscovered = await auditProject(undiscoveredUnregistered, emptyDbEvidence());
    assert.equal(auditUndiscovered.classification, 'UNREGISTERED');
    assert.equal(auditUndiscovered.migrationStatus, 'BLOCKED');
    assert.equal(auditUndiscovered.immutableReleaseReadiness, 'NOT_READY');
    assert.ok(auditUndiscovered.blockers.some((b) => b.includes('UNREGISTERED_TENANT')));

    console.log('   ✅ PASS: UNREGISTERED tenant fails closed as BLOCKED with governance violation blocker.\n');
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
    assert.equal(audit.migrationStatus, 'FIXTURE_EVALUATION_ONLY', 'Fixture audit must be FIXTURE_EVALUATION_ONLY');
    assert.notEqual(audit.migrationStatus, 'CANDIDATE_PACK_VALIDATED');
    console.log('   ✅ PASS: Synthetic fixture classified as FIXTURE_EVALUATION_ONLY — never a customer pack.\n');
  }

  // ── Test 5: Real Dual Invocation of Inventory & Evaluator against Arbitrary Manifest ──
  console.log('5. Invoking both inventory and evaluator against an arbitrary temporary manifest (Finding 4)...');
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-manifest-test-'));
    const tempManifestPath = path.join(tempDir, 'portfolio-manifest.json');

    const arbitraryManifest: PortfolioManifest = {
      version: '4.2.0-arbitrary',
      description: 'Arbitrary temporary manifest for real inventory and evaluator invocation',
      activePortfolio: [
        {
          tenantId: 'arb-tenant-alpha',
          displayName: 'Arbitrary Tenant Alpha',
          industry: 'Aerospace Engineering',
          commerceMode: 'quote',
          dataResidency: 'us',
          notes: 'Arbitrary active customer',
        },
      ],
      parked: [
        {
          tenantId: 'arb-tenant-beta',
          displayName: 'Arbitrary Tenant Beta',
          industry: 'Maritime Logistics',
          commerceMode: 'cart',
          dataResidency: 'au',
          reason: 'Parked in arbitrary manifest',
        },
      ],
      syntheticFixtures: [
        {
          tenantId: 'arb-fixture_fixture',
          displayName: 'Arbitrary Topology Fixture',
          industry: 'Industrial Automation',
          commerceMode: 'quote',
          dataResidency: 'nz',
        },
      ],
      syntheticFixtureSuffix: '_fixture',
      packsRoot: 'packs',
    };

    fs.writeFileSync(tempManifestPath, JSON.stringify(arbitraryManifest, null, 2), 'utf8');

    try {
      // 5a. Invoke inventory via manifestPath (read-only)
      const invFromPath = await runTenantConnectorInventory({
        manifestPath: tempManifestPath,
        writeReport: false,
      });

      // 5b. Invoke evaluator via manifestPath (read-only)
      const evalFromPath = await evaluateSeedMigrationDryRun({
        manifestPath: tempManifestPath,
        writeReport: false,
      });

      // 5c. Invoke inventory via manifest object
      const invFromObj = await runTenantConnectorInventory({
        manifest: arbitraryManifest,
        writeReport: false,
      });

      // 5d. Invoke evaluator via manifest object
      const evalFromObj = await evaluateSeedMigrationDryRun({
        manifest: arbitraryManifest,
        writeReport: false,
      });

      // Assertions on arbitrary active tenant
      const invActiveAlpha = invFromPath.find((r) => r.tenantId === 'arb-tenant-alpha');
      assert.ok(invActiveAlpha, 'Inventory must contain arb-tenant-alpha');
      assert.equal(invActiveAlpha!.classification, 'ACTIVE_PORTFOLIO');
      assert.equal(invActiveAlpha!.source, 'not_discovered');
      assert.equal(invActiveAlpha!.migrationStatus, 'BLOCKED');

      const evalActiveAlpha = evalFromPath.activePacks.find((p) => p.tenantId === 'arb-tenant-alpha');
      assert.ok(evalActiveAlpha, 'Evaluator must contain arb-tenant-alpha in activePacks');
      assert.equal(evalActiveAlpha!.classification, 'ACTIVE_PORTFOLIO');
      assert.equal(evalActiveAlpha!.source, 'not_discovered');

      // Assertions on arbitrary parked tenant
      const invParkedBeta = invFromPath.find((r) => r.tenantId === 'arb-tenant-beta');
      assert.ok(invParkedBeta, 'Inventory must contain arb-tenant-beta');
      assert.equal(invParkedBeta!.classification, 'PARKED');
      assert.equal(invParkedBeta!.migrationStatus, 'PARKED');

      const evalParkedBeta = evalFromPath.parkedPacks.find((p) => p.tenantId === 'arb-tenant-beta');
      assert.ok(evalParkedBeta, 'Evaluator must contain arb-tenant-beta in parkedPacks');
      assert.equal(evalParkedBeta!.classification, 'PARKED');

      // Assertions on packs discovered on disk that are NOT in arbitrary manifest (e.g. placemakers, workweargroup, royalcyber):
      // BOTH inventory and evaluator MUST classify them as UNREGISTERED!
      const diskTenants = ['placemakers', 'workweargroup', 'royalcyber'];
      for (const diskId of diskTenants) {
        const invDisk = invFromPath.find((r) => r.tenantId === diskId);
        assert.ok(invDisk, `Inventory must discover disk pack '${diskId}'`);
        assert.equal(
          invDisk!.classification,
          'UNREGISTERED',
          `Disk pack '${diskId}' not in arbitrary manifest must be UNREGISTERED in inventory`
        );
        assert.equal(
          invDisk!.migrationStatus,
          'BLOCKED',
          `Unregistered disk pack '${diskId}' must have migrationStatus BLOCKED`
        );
        assert.equal(
          invDisk!.immutableReleaseReadiness,
          'NOT_READY',
          `Unregistered disk pack '${diskId}' must have immutableReleaseReadiness NOT_READY`
        );
        assert.ok(
          invDisk!.blockers.some((b) => b.includes('UNREGISTERED_TENANT')),
          `Unregistered disk pack '${diskId}' must record UNREGISTERED_TENANT blocker`
        );

        const evalDisk = evalFromPath.unregisteredPacks.find((p) => p.tenantId === diskId);
        assert.ok(
          evalDisk,
          `Evaluator must discover disk pack '${diskId}' as unregisteredPack`
        );
        assert.equal(evalDisk!.classification, 'UNREGISTERED');
        assert.ok(
          evalDisk!.issues.some((iss) => iss.includes('UNREGISTERED_TENANT')),
          `Evaluator must flag UNREGISTERED_TENANT for '${diskId}'`
        );
      }

      // Assert counts consistency between inventory and evaluator
      assert.equal(invFromPath.filter((r) => r.classification === 'UNREGISTERED').length, evalFromPath.unregisteredCount);
      assert.equal(evalFromPath.configuredActiveCount, 1);
      assert.equal(evalFromPath.configuredParkedCount, 1);
      assert.equal(evalFromPath.configuredFixtureCount, 1);

      // Verify object-based invocation matches path-based invocation
      assert.equal(invFromObj.length, invFromPath.length);
      assert.equal(evalFromObj.allPacks.length, evalFromPath.allPacks.length);

      // Verify read-only default: docs reports were NOT overwritten with arbitrary manifest
      const mainReport = fs.readFileSync(path.resolve(__dirname, '../docs/tenant-connector-migration-inventory.md'), 'utf8');
      assert.ok(!mainReport.includes('arb-tenant-alpha'), 'Read-only run must not modify docs report');

      console.log('   ✅ PASS: Both inventory and evaluator successfully invoked against arbitrary manifest with identical UNREGISTERED fail-closed detection.\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ── Test 6: Strict Authoritative Schema Enforcement ─────────────────────
  console.log('6. Testing portfolio manifest authoritative schema enforcement...');
  {
    // 6a: Missing required field in manifest
    assert.throws(
      () => validatePortfolioManifest({ version: '1.0.0', activePortfolio: [] } as any),
      /should have required property 'parked'/i,
      'Must throw when parked array is missing'
    );

    assert.throws(
      () => validatePortfolioManifest({ version: '1.0.0', parked: [] } as any),
      /should have required property 'activePortfolio'/i,
      'Must throw when activePortfolio array is missing'
    );

    // 6b: Missing required field in TenantEntry
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', dataResidency: 'us' } as any, // missing commerceMode
          ],
          parked: [],
        }),
      /should have required property 'commerceMode'/i,
      'Must throw when commerceMode is missing in TenantEntry'
    );

    // 6c: Disallowed commerce mode
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'subscription', dataResidency: 'us' } as any,
          ],
          parked: [],
        }),
      /should be equal to one of the allowed values/i,
      'Must throw when commerceMode is not quote or cart'
    );

    // 6d: Additional properties on root
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [],
          parked: [],
          unexpectedRootProperty: 'disallowed',
        } as any),
      /should NOT have additional properties/i,
      'Must throw on additional properties on manifest root'
    );

    // 6e: Additional properties on TenantEntry
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us', extraField: 'bad' } as any,
          ],
          parked: [],
        }),
      /should NOT have additional properties/i,
      'Must throw on additional properties on TenantEntry'
    );

    // 6f: Invalid version formats
    const invalidVersions = ['v1.0.0', 'beta', '1', '1.0', 'release-1.0.0'];
    for (const badVer of invalidVersions) {
      assert.throws(
        () =>
          validatePortfolioManifest({
            version: badVer,
            activePortfolio: [],
            parked: [],
          }),
        /should match pattern/i,
        `Must throw on invalid version format '${badVer}'`
      );
    }

    // 6g: Invalid dataResidency formats
    const invalidResidencies = ['USA', '12', '123', 'au-123456789-toolong', 'AU', 'australia'];
    for (const badRes of invalidResidencies) {
      assert.throws(
        () =>
          validatePortfolioManifest({
            version: '1.0.0',
            activePortfolio: [
              { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: badRes },
            ],
            parked: [],
          }),
        /should match pattern/i,
        `Must throw on invalid dataResidency format '${badRes}'`
      );
    }

    // 6h: Invalid migrationPriority (negative, zero, non-integer)
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'au', migrationPriority: 0 },
          ],
          parked: [],
        }),
      /should be >= 1/i,
      'Must throw when migrationPriority is 0'
    );

    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'au', migrationPriority: -5 },
          ],
          parked: [],
        }),
      /should be >= 1/i,
      'Must throw when migrationPriority is negative'
    );

    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'au', migrationPriority: 1.5 as any },
          ],
          parked: [],
        }),
      /should be integer/i,
      'Must throw when migrationPriority is a non-integer float'
    );

    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 't1', displayName: 'T1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'au', migrationPriority: 'high' as any },
          ],
          parked: [],
        }),
      /should be integer/i,
      'Must throw when migrationPriority is a string'
    );

    // 6i: Duplicate tenant ID within activePortfolio
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 'dup-id', displayName: 'D1', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
            { tenantId: 'dup-id', displayName: 'D2', industry: 'Ind', commerceMode: 'cart', dataResidency: 'us' },
          ],
          parked: [],
        }),
      /Duplicate tenantId 'dup-id' found in 'activePortfolio'/i,
      'Must throw when duplicate tenantId exists within activePortfolio'
    );

    // 6j: Overlap between activePortfolio and parked
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 'overlap-tenant', displayName: 'Active', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
          parked: [
            { tenantId: 'overlap-tenant', displayName: 'Parked', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
        }),
      /overlap violation.*'overlap-tenant'.*defined in both 'activePortfolio' and 'parked'/i,
      'Must throw on overlap between activePortfolio and parked'
    );

    // 6k: Overlap between activePortfolio and syntheticFixtures
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [
            { tenantId: 'clash-fixture', displayName: 'Active', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
          parked: [],
          syntheticFixtures: [
            { tenantId: 'clash-fixture', displayName: 'Fixture', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
        }),
      /overlap violation.*'clash-fixture'.*defined in both 'activePortfolio' and 'syntheticFixtures'/i,
      'Must throw on overlap between activePortfolio and syntheticFixtures'
    );

    // 6l: Overlap between parked and syntheticFixtures
    assert.throws(
      () =>
        validatePortfolioManifest({
          version: '1.0.0',
          activePortfolio: [],
          parked: [
            { tenantId: 'parked-fixture-clash', displayName: 'Parked', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
          syntheticFixtures: [
            { tenantId: 'parked-fixture-clash', displayName: 'Fixture', industry: 'Ind', commerceMode: 'quote', dataResidency: 'us' },
          ],
        }),
      /overlap violation.*'parked-fixture-clash'.*defined in both 'parked' and 'syntheticFixtures'/i,
      'Must throw on overlap between parked and syntheticFixtures'
    );

    console.log('   ✅ PASS: Authoritative schema validation strictly enforces required fields, types, enum, additional properties, patterns, priorities, and zero overlap.\n');
  }

  // ── Test 7: No tenant name required inside runtime implementation code ───
  console.log('7. Proving no tenant name is required in runtime implementation code...');
  {
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

    // Tenants not declared in this manifest are UNREGISTERED (not silently assumed parked)
    assert.equal(classifyTenant('placemakers', randomManifest), 'UNREGISTERED');
    assert.equal(classifyTenant('workweargroup', randomManifest), 'UNREGISTERED');
    assert.equal(classifyTenant('abercrombie', randomManifest), 'UNREGISTERED');
    assert.equal(classifyTenant('caroma', randomManifest), 'UNREGISTERED');

    console.log('   ✅ PASS: Runtime implementation works with any manifest — no tenant names hardcoded.\n');
  }

  // ── Test 8: Default portfolio manifest loads cleanly ─────────────────────
  console.log('8. Verifying default portfolio manifest (config/portfolio-manifest.json) loads and validates cleanly...');
  {
    const manifest = loadPortfolioManifest(DEFAULT_PORTFOLIO_MANIFEST_PATH);
    assert.ok(manifest.version, 'Manifest must have a version');
    assert.ok(Array.isArray(manifest.activePortfolio), 'activePortfolio must be an array');
    assert.ok(Array.isArray(manifest.parked), 'parked must be an array');
    assert.equal(manifest.activePortfolio.length, 4, 'Default manifest active portfolio is exactly 4 customers');

    const activeIds = manifest.activePortfolio.map((e) => e.tenantId);
    assert.deepEqual(
      activeIds.sort(),
      ['abercrombie', 'caroma', 'placemakers', 'workweargroup'].sort(),
      'Active portfolio is exactly placemakers, workweargroup, abercrombie, caroma'
    );

    const parkedIds = manifest.parked.map((e) => e.tenantId);
    assert.ok(parkedIds.includes('royalcyber'));
    assert.ok(parkedIds.includes('dragonshield'));
    assert.ok(parkedIds.includes('momentec'));
    assert.ok(parkedIds.includes('garts'));
    assert.ok(parkedIds.includes('caroma-nz'));

    // Zero overlap
    for (const parkedId of parkedIds) {
      assert.ok(!activeIds.includes(parkedId), `Parked tenant '${parkedId}' must not appear in activePortfolio`);
    }
    console.log('   ✅ PASS: Default portfolio manifest loads and passes all validation rules.\n');
  }

  // ── Test 9: Four-project readiness matrix via real inventory (offline) ───
  console.log('9. Generating four-project active-portfolio readiness matrix (offline)...');
  {
    const results = await runTenantConnectorInventory({ writeReport: false });

    // Filter to active portfolio only
    const activeResults = results.filter((r) => r.classification === 'ACTIVE_PORTFOLIO');
    const parkedResults = results.filter((r) => r.classification === 'PARKED');
    const unregisteredResults = results.filter((r) => r.classification === 'UNREGISTERED');

    // Parked tenants must not appear in active portfolio results
    assert.ok(!activeResults.some((r) => r.tenantId === 'royalcyber'));
    assert.ok(!activeResults.some((r) => r.tenantId === 'dragonshield'));
    assert.ok(!activeResults.some((r) => r.tenantId === 'momentec'));

    // In default manifest, there should be zero unregistered tenants
    assert.equal(unregisteredResults.length, 0, 'No unregistered tenants in default manifest on disk');

    // Parked results must all have PARKED status
    for (const r of parkedResults) {
      assert.equal(r.migrationStatus, 'PARKED');
    }

    // Four active tenants must all be present
    const activeIds = activeResults.map((r) => r.tenantId);
    assert.ok(activeIds.includes('placemakers'));
    assert.ok(activeIds.includes('workweargroup'));
    assert.ok(activeIds.includes('abercrombie'));
    assert.ok(activeIds.includes('caroma'));

    // PlaceMakers: discovered (filesystem_pack)
    const pm = activeResults.find((r) => r.tenantId === 'placemakers')!;
    assert.equal(pm.source, 'filesystem_pack');
    assert.ok(pm.schemaValid);
    assert.ok(pm.groundedRetrievalIsolated);
    assert.equal(pm.cutoverRecordState, 'NO_RECORD_FOUND');

    // WorkwearGroup: discovered (filesystem_pack)
    const ww = activeResults.find((r) => r.tenantId === 'workweargroup')!;
    assert.equal(ww.source, 'filesystem_pack');
    assert.ok(ww.schemaValid);

    // Abercrombie: not_discovered
    const anf = activeResults.find((r) => r.tenantId === 'abercrombie')!;
    assert.equal(anf.source, 'not_discovered');
    assert.equal(anf.migrationStatus, 'BLOCKED');

    // Caroma: not_discovered
    const caroma = activeResults.find((r) => r.tenantId === 'caroma')!;
    assert.equal(caroma.source, 'not_discovered');
    assert.equal(caroma.migrationStatus, 'BLOCKED');

    console.log('\n   Four-Project Active Portfolio Readiness Matrix:');
    console.table(
      activeResults.map((r) => ({
        Tenant: r.tenantId,
        Source: r.source,
        Schema: r.schemaValid ? 'PASS' : 'FAIL',
        Isolated: r.groundedRetrievalIsolated ? 'YES' : 'NO',
        CutoverRecord: r.cutoverRecordState,
        Status: r.migrationStatus,
      }))
    );

    console.log('   ✅ PASS: Four-project readiness matrix generated truthfully.\n');
  }

  // ── Test 10: Evaluator read-only by default & returns structured result ───
  console.log('10. Verifying evaluator is read-only by default and distinguishes configured vs discovered...');
  {
    const evalResult = await evaluateSeedMigrationDryRun({ writeReport: false });
    assert.equal(evalResult.configuredActiveCount, 4);
    assert.equal(evalResult.discoveredActiveCount, 2);
    assert.equal(evalResult.pendingActiveCount, 2);
    assert.equal(evalResult.configuredParkedCount, 5);
    assert.equal(evalResult.discoveredParkedCount, 1);
    assert.equal(evalResult.pendingParkedCount, 4);
    assert.equal(evalResult.configuredFixtureCount, 5);
    assert.equal(evalResult.unregisteredCount, 0);
    assert.equal(evalResult.readyCount, 2);
    assert.equal(evalResult.blockedCount, 2);
    assert.equal(evalResult.reportPath, undefined, 'Read-only run must not set reportPath or write report');
    console.log('   ✅ PASS: Evaluator is read-only by default with accurate configured vs discovered breakdown.\n');
  }

  // ── Test 11: Clean Subprocess Offline Isolation Verification ────────────────
  console.log('11. Verifying offline mode in clean subprocess with database variables cleared...');
  {
    // Clean environment with MONGODB_URI, TEST_MONGODB_URI, and canary variables stripped
    const cleanEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_ENV: 'test',
      JOURNEYAX_OFFLINE_HARNESS: 'true',
    };

    const subprocessCode = `
      import assert from 'node:assert/strict';
      import { runTenantConnectorInventory } from './scripts/inventory-tenant-connectors';
      import { evaluateSeedMigrationDryRun } from './scripts/evaluate-seed-migration-dry-run';

      // 1. Assert database URIs and production/canary variables from .env were NOT loaded
      assert.equal(process.env.MONGODB_URI, undefined, 'MONGODB_URI must remain undefined');
      assert.equal(process.env.TEST_MONGODB_URI, undefined, 'TEST_MONGODB_URI must remain undefined');
      assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL must remain undefined');
      assert.equal(process.env.FABRIC_DIFFUSION_DEPLOYMENT, undefined, 'FABRIC_DIFFUSION_DEPLOYMENT from .env must remain undefined');
      assert.equal(process.env.JAX_PLACEMAKERS_MODEL_URL, undefined, 'JAX_PLACEMAKERS_MODEL_URL from .env must remain undefined');
      assert.equal(process.env.REPLICATE_API_TOKEN, undefined, 'REPLICATE_API_TOKEN from .env must remain undefined');

      // 2. Run inventory and dry-run evaluator in offline safe mode
      async function main() {
        const inv = await runTenantConnectorInventory({ writeReport: false });
        assert.ok(Array.isArray(inv), 'Inventory must return results offline');
        assert.equal(inv.filter(r => r.classification === 'ACTIVE_PORTFOLIO').length, 4, 'Must have 4 active portfolio items');
        const ev = await evaluateSeedMigrationDryRun({ writeReport: false });
        assert.equal(ev.configuredActiveCount, 4, 'Evaluator must discover 4 configured active tenants offline');
        console.log('SUBPROCESS_OFFLINE_ISOLATION_OK');
      }
      main().catch((err) => {
        console.error('Subprocess execution error:', err);
        process.exit(1);
      });
    `;

    const sub = child_process.spawnSync('npx', ['tsx', '-e', subprocessCode], {
      cwd: path.resolve(__dirname, '..'),
      env: cleanEnv,
      encoding: 'utf8',
    });

    if (sub.status !== 0) {
      console.error('Subprocess stdout:', sub.stdout);
      console.error('Subprocess stderr:', sub.stderr);
      assert.fail(`Subprocess offline harness failed with exit code ${sub.status}: ${sub.stderr || sub.stdout}`);
    }

    assert.ok(sub.stdout.includes('SUBPROCESS_OFFLINE_ISOLATION_OK'), 'Subprocess must output confirmation token');
    console.log('   ✅ PASS: Clean subprocess executed with cleared database variables and verified no transitive import loaded .env.\n');
  }

  console.log('🎉 ALL PORTFOLIO INVENTORY & GOVERNANCE TESTS PASSED.\n');
}

run().catch((err) => {
  console.error('\n❌ PORTFOLIO INVENTORY SPEC FAILED:');
  console.error(err);
  process.exit(1);
});
