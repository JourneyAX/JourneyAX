// Enforce offline mode BEFORE any module imports
process.env.JOURNEYAX_OFFLINE_HARNESS = 'true';
process.env.NODE_ENV = 'test';
delete process.env.TEST_MONGODB_URI;
delete process.env.MONGODB_URI;

/**
 * architecture-closure.spec.ts
 *
 * Focused test proving:
 * - No filesystem/static fallback after canonical activation (activated tenants fail closed on config load failure).
 */
import assert from 'node:assert/strict';
import { handleConfigFailure } from '../apps/journeyax-web/src/lib/config/configFailure';

console.log('🧪 Running Architecture Closure Spec...\n');

async function run(): Promise<void> {
  // ── No Filesystem / Static Fallback After Canonical Activation ────────────
  console.log('1. Testing no filesystem/static fallback after canonical activation...');
  {
    // Scenario a: Tenant is canonically activated (migrated)
    // Cutover repository / environment marks tenant as migrated
    const activatedTenant = 'placemakers';
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'migrated';

    const failClosedResponse = await handleConfigFailure(activatedTenant);
    assert.equal(
      failClosedResponse.status,
      503,
      'Activated tenant MUST return HTTP 503 when config load fails'
    );

    const failClosedBody = await failClosedResponse.json();
    assert.equal(failClosedBody.error, 'CanonicalConfigurationUnavailable');
    assert.ok(
      failClosedBody.message.includes('Legacy fallback is prohibited after canonical activation'),
      'Must state that legacy fallback is prohibited after activation'
    );
    assert.equal(failClosedBody.cutoverState, 'migrated');
    // Ensure it did NOT return PlaceMakers static companyName or fallback values
    assert.equal(failClosedBody.companyName, undefined);
    assert.equal(failClosedBody.theme, undefined);

    // Scenario b: Tenant is explicitly UNMIGRATED
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'unmigrated';

    const unmigratedResponse = await handleConfigFailure(activatedTenant);
    assert.equal(
      unmigratedResponse.status,
      200,
      'Unmigrated tenant is permitted legacy fallback'
    );
    const unmigratedBody = await unmigratedResponse.json();
    assert.equal(unmigratedBody.projectId, 'placemakers');
    assert.equal(unmigratedBody.companyName, 'PlaceMakers (Fletcher Building)');

    // Cleanup env override
    delete process.env.TENANT_CUTOVER_PLACEMAKERS;

    console.log('   ✅ PASS: Canonical activation strictly fails closed with 503; legacy fallback prohibited.\n');
  }

  console.log('🎉 ALL ARCHITECTURE CLOSURE TESTS PASSED.\n');
}

run().catch((err) => {
  console.error('\n❌ ARCHITECTURE CLOSURE SPEC FAILED:');
  console.error(err);
  process.exit(1);
});
