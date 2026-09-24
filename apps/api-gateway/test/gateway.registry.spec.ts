import assert from 'node:assert/strict';

async function runTests() {
  console.log('=== Running API Gateway Registry & Deployment Wiring Tests ===\n');

  // Test 1: Canonical JOURNEY_RUNTIME_SERVICE_URL precedence
  {
    console.log('Test 1: Canonical JOURNEY_RUNTIME_SERVICE_URL precedence');
    // Clear and set env
    const origServiceUrl = process.env.JOURNEY_RUNTIME_SERVICE_URL;
    const origUrl = process.env.JOURNEY_RUNTIME_URL;
    const origRuntimeUrl = process.env.RUNTIME_SERVICE_URL;

    process.env.JOURNEY_RUNTIME_SERVICE_URL = 'https://journey-runtime-canonical.a.run.app';
    process.env.JOURNEY_RUNTIME_URL = 'https://journey-runtime-legacy.a.run.app';
    process.env.RUNTIME_SERVICE_URL = 'https://journey-runtime-alias.a.run.app';

    // Re-import gateway.registry
    delete require.cache[require.resolve('../src/gateway.registry')];
    const { DOMAIN_REGISTRY, resolveService, parseRoute } = require('../src/gateway.registry');

    assert.equal(
      DOMAIN_REGISTRY.runtime,
      'https://journey-runtime-canonical.a.run.app',
      'JOURNEY_RUNTIME_SERVICE_URL must take canonical precedence'
    );

    const resolved = resolveService('/api/v1/workweargroup/production/runtime/turn');
    assert.ok(resolved, 'Route should resolve to runtime service');
    assert.equal(resolved?.baseUrl, 'https://journey-runtime-canonical.a.run.app');

    console.log('✓ Canonical JOURNEY_RUNTIME_SERVICE_URL takes precedence\n');

    // Clean up
    if (origServiceUrl !== undefined) process.env.JOURNEY_RUNTIME_SERVICE_URL = origServiceUrl;
    else delete process.env.JOURNEY_RUNTIME_SERVICE_URL;
    if (origUrl !== undefined) process.env.JOURNEY_RUNTIME_URL = origUrl;
    else delete process.env.JOURNEY_RUNTIME_URL;
    if (origRuntimeUrl !== undefined) process.env.RUNTIME_SERVICE_URL = origRuntimeUrl;
    else delete process.env.RUNTIME_SERVICE_URL;
  }

  // Test 2: Fallback to JOURNEY_RUNTIME_URL when canonical is not set
  {
    console.log('Test 2: Fallback to JOURNEY_RUNTIME_URL');
    delete process.env.JOURNEY_RUNTIME_SERVICE_URL;
    process.env.JOURNEY_RUNTIME_URL = 'https://journey-runtime-legacy.a.run.app';
    delete process.env.RUNTIME_SERVICE_URL;

    delete require.cache[require.resolve('../src/gateway.registry')];
    const { DOMAIN_REGISTRY } = require('../src/gateway.registry');

    assert.equal(
      DOMAIN_REGISTRY.runtime,
      'https://journey-runtime-legacy.a.run.app',
      'Should fall back to JOURNEY_RUNTIME_URL if canonical is missing'
    );
    delete process.env.JOURNEY_RUNTIME_URL;
    console.log('✓ Legacy JOURNEY_RUNTIME_URL fallback verified\n');
  }

  // Test 3: Fallback to RUNTIME_SERVICE_URL
  {
    console.log('Test 3: Fallback to RUNTIME_SERVICE_URL');
    delete process.env.JOURNEY_RUNTIME_SERVICE_URL;
    delete process.env.JOURNEY_RUNTIME_URL;
    process.env.RUNTIME_SERVICE_URL = 'https://journey-runtime-alias.a.run.app';

    delete require.cache[require.resolve('../src/gateway.registry')];
    const { DOMAIN_REGISTRY } = require('../src/gateway.registry');

    assert.equal(
      DOMAIN_REGISTRY.runtime,
      'https://journey-runtime-alias.a.run.app',
      'Should fall back to RUNTIME_SERVICE_URL if canonical is missing'
    );
    delete process.env.RUNTIME_SERVICE_URL;
    console.log('✓ RUNTIME_SERVICE_URL fallback verified\n');
  }

  // Test 4: Default localhost:3009 when none set
  {
    console.log('Test 4: Default localhost:3009 when unconfigured');
    delete process.env.JOURNEY_RUNTIME_SERVICE_URL;
    delete process.env.JOURNEY_RUNTIME_URL;
    delete process.env.RUNTIME_SERVICE_URL;

    delete require.cache[require.resolve('../src/gateway.registry')];
    const { DOMAIN_REGISTRY } = require('../src/gateway.registry');

    assert.equal(
      DOMAIN_REGISTRY.runtime,
      'http://localhost:3009',
      'Should default to http://localhost:3009'
    );
    console.log('✓ Default localhost:3009 verified\n');
  }

  // Test 5: Route parsing for tenant + environment runtime routes
  {
    console.log('Test 5: Route parsing for runtime routes');
    delete require.cache[require.resolve('../src/gateway.registry')];
    const { parseRoute } = require('../src/gateway.registry');

    const route1 = parseRoute('/api/v1/workweargroup/production/runtime/turn');
    assert.deepEqual(route1, {
      projectId: 'workweargroup',
      environmentId: 'production',
      domain: 'runtime',
    });

    const route2 = parseRoute('/api/v1/royalcyber/staging/runtime/chat/stream');
    assert.deepEqual(route2, {
      projectId: 'royalcyber',
      environmentId: 'staging',
      domain: 'runtime',
    });

    const route3 = parseRoute('/api/v1/workweargroup/runtime/turn');
    assert.deepEqual(route3, {
      projectId: 'workweargroup',
      environmentId: 'production',
      domain: 'runtime',
    });

    console.log('✓ Route parsing accurately captures tenant, environment, and runtime domain\n');
  }

  // Test 6: Production localhost target rejection
  {
    console.log('Test 6: validateProductionRegistry rejects localhost targets in production');
    const { validateProductionRegistry } = require('../src/gateway.registry');

    const badRegistry = {
      commerce: 'https://commerce.prod.run.app',
      runtime: 'http://localhost:3009',
    };

    assert.throws(
      () => validateProductionRegistry(badRegistry, 'production'),
      /Production deployment misconfiguration: localhost service targets are forbidden/
    );

    // In development mode, localhost is permitted
    assert.doesNotThrow(() => validateProductionRegistry(badRegistry, 'development'));

    console.log('✓ Production localhost target rejection verified\n');
  }

  // Test 7: Production non-localhost targets succeed
  {
    console.log('Test 7: validateProductionRegistry passes valid Cloud Run URLs in production');
    const { validateProductionRegistry } = require('../src/gateway.registry');

    const validProdRegistry = {
      commerce: 'https://agent-commerce-service-xyz-uc.a.run.app',
      runtime: 'https://journey-runtime-service-xyz-uc.a.run.app',
      products: 'https://product-service-xyz-uc.a.run.app',
    };

    assert.doesNotThrow(() => validateProductionRegistry(validProdRegistry, 'production'));
    console.log('✓ Production valid Cloud Run targets pass verification\n');
  }

  console.log('====================================================');
  console.log('✓ All API Gateway Registry & Deployment Wiring Tests PASSED!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
