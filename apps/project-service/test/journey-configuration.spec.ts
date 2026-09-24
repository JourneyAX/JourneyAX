import assert from 'node:assert/strict';
import { JourneyConfigurationService } from '../src/journey-configuration.service';
import { CapabilityRegistryService } from '../src/capability-registry.service';

async function runJourneyConfigTests() {
  console.log('🧪 Running Journey & Capability Registry Tests in Agent 3...\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void) {
    try {
      fn();
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
  test('CapabilityRegistryService lists standard schemas with risk and side-effect metadata', () => {
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
  test('validateAndCompileGraph rejects journey graph without trigger node', () => {
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
  test('validateAndCompileGraph compiles valid graph with trigger and action nodes', () => {
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

  console.log(`\nJourney & Capability Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runJourneyConfigTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
