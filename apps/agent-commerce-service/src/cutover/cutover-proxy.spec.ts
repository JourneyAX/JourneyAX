import assert from 'node:assert/strict';
import * as http from 'node:http';
import { CutoverProxyService, DEFAULT_RUNTIME_SERVICE_URL } from './cutover-proxy.service';

async function runSuite() {
  console.log('🧪 Running CutoverProxyService Verification Suite...\n');

  // Test 0: Shared default port is 3012
  console.log('0. Verifying shared default runtime URL is port 3012...');
  {
    assert.equal(DEFAULT_RUNTIME_SERVICE_URL, 'http://localhost:3012');
    const proxy = new CutoverProxyService();
    // Default constructor must use 3012 unless overridden by env
    if (!process.env.JOURNEY_RUNTIME_SERVICE_URL && !process.env.JOURNEY_RUNTIME_URL && !process.env.RUNTIME_SERVICE_URL) {
      assert.equal((proxy as any).runtimeUrl, 'http://localhost:3012');
    }
    console.log('   ✅ PASS: Default runtime URL is http://localhost:3012.\n');
  }

  // Test 1: Registry down + unmigrated tenant -> legacy turn succeeds
  console.log('1. Testing registry down + unmigrated tenant -> legacy turn succeeds...');
  {
    // Use an unassigned port that is guaranteed down
    const proxy = new CutoverProxyService('http://127.0.0.1:59991');
    proxy.clearCache();

    // Call resolveCutover: must return 'legacy' and not throw
    const decision = await proxy.resolveCutover('unmigrated_brand', 'production', 'session_01', 500);
    assert.equal(decision, 'legacy', 'Unmigrated tenant must proceed on legacy when registry is unreachable');
    console.log('   ✅ PASS: Unmigrated tenant continues on legacy when registry is down.\n');
  }

  // Test 1b: Production fail closed: NODE_ENV=production + registry down + no durable repo -> throws fail-closed
  console.log('1b. Testing NODE_ENV=production + registry down + no durable repo -> throws fail-closed...');
  {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const proxy = new CutoverProxyService('http://127.0.0.1:59991');
      proxy.clearCache();
      await assert.rejects(
        () => proxy.resolveCutover('unmigrated_brand', 'production', 'session_01', 500),
        /production must fail closed/,
        'When runtime registry is down and no durable activation repository is configured, production must fail closed'
      );
      console.log('   ✅ PASS: Production strictly fails closed when registry is down without durable repo.\n');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  }

  // Test 2: Registry down + tenant cached as migrated -> throws fail-closed
  console.log('2. Testing registry down + tenant cached as migrated -> throws fail-closed...');
  {
    let currentServerResponse: { status: number; body: string } = {
      status: 200,
      body: JSON.stringify({
        status: 'migrated',
        tenantId: 'placemakers',
        approvedReleaseChecksum: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6',
      }),
    };

    const server = http.createServer((_req, res) => {
      res.writeHead(currentServerResponse.status, { 'Content-Type': 'application/json' });
      res.end(currentServerResponse.body);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    const proxy = new CutoverProxyService(serverUrl);
    proxy.clearCache();
    proxy.setCacheTtl(50); // 50ms TTL for testing

    // Turn 1: Registry is up -> returns canonical and records status='migrated'
    const turn1Decision = await proxy.resolveCutover('placemakers', 'production', 'session_01');
    assert.equal(turn1Decision, 'canonical', 'Must resolve to canonical when migrated record is active');

    // Close the server (registry goes DOWN)
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Wait for in-memory cache TTL to expire
    await new Promise((r) => setTimeout(r, 60));

    // Turn 2: Registry is now down, but tenant is last-known as 'migrated' -> MUST THROW FAIL-CLOSED!
    await assert.rejects(
      () => proxy.resolveCutover('placemakers', 'production', 'session_01', 500),
      (err: any) => {
        assert.ok(
          err.message.includes('failing closed'),
          `Error message must indicate fail-closed: got "${err.message}"`
        );
        assert.ok(
          err.message.includes('placemakers'),
          `Error message must name the tenant: got "${err.message}"`
        );
        return true;
      },
      'Known migrated tenant must fail closed when registry is unreachable'
    );
    console.log('   ✅ PASS: Known migrated tenant fails closed when registry is unreachable.\n');
  }

  // Test 3: Wrong service returning a Next.js 404 -> rejected as malformed
  console.log('3. Testing wrong service returning a Next.js 404 (HTML / non-runtime JSON) -> rejected...');
  {
    // Case 3a: HTML 404 from Next.js backoffice-admin
    const htmlServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>404 - This page could not be found</h1></body></html>');
    });

    await new Promise<void>((resolve) => htmlServer.listen(0, '127.0.0.1', () => resolve()));
    const htmlPort = (htmlServer.address() as any).port;
    const htmlProxy = new CutoverProxyService(`http://127.0.0.1:${htmlPort}`);
    htmlProxy.clearCache();

    await assert.rejects(
      () => htmlProxy.resolveCutover('caroma', 'production', 'session_02'),
      (err: any) => {
        assert.ok(
          err.message.includes('Malformed 404 response from non-runtime service') ||
          err.message.includes('expected JSON'),
          `Must reject HTML 404 as malformed: got "${err.message}"`
        );
        return true;
      },
      'HTML 404 must be rejected as malformed'
    );
    await new Promise<void>((resolve) => htmlServer.close(() => resolve()));

    // Case 3b: JSON 404 from wrong service without runtime cutover marker
    const genericJsonServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', path: '/api/v1/caroma/production/runtime/cutover' }));
    });

    await new Promise<void>((resolve) => genericJsonServer.listen(0, '127.0.0.1', () => resolve()));
    const jsonPort = (genericJsonServer.address() as any).port;
    const jsonProxy = new CutoverProxyService(`http://127.0.0.1:${jsonPort}`);
    jsonProxy.clearCache();

    await assert.rejects(
      () => jsonProxy.resolveCutover('caroma', 'production', 'session_03'),
      (err: any) => {
        assert.ok(
          err.message.includes('missing runtime cutover marker') ||
          err.message.includes('Rejected 404 from unexpected service'),
          `Must reject JSON 404 without runtime marker: got "${err.message}"`
        );
        return true;
      },
      'JSON 404 without runtime marker must be rejected'
    );
    await new Promise<void>((resolve) => genericJsonServer.close(() => resolve()));

    console.log('   ✅ PASS: Foreign/Next.js 404 responses are strictly rejected as malformed.\n');
  }

  // Test 4: Genuine runtime 404 -> resolves to legacy and caches result
  console.log('4. Testing genuine runtime 404 -> resolves to legacy and caches answer...');
  {
    let callCount = 0;
    const runtimeServer = http.createServer((_req, res) => {
      callCount++;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        statusCode: 404,
        message: "No durable cutover record found for tenant 'new_client' in environment 'production'",
        error: 'Not Found',
      }));
    });

    await new Promise<void>((resolve) => runtimeServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (runtimeServer.address() as any).port;
    const proxy = new CutoverProxyService(`http://127.0.0.1:${port}`);
    proxy.clearCache();
    proxy.setCacheTtl(5000);

    const decision1 = await proxy.resolveCutover('new_client', 'production', 'sess_01');
    assert.equal(decision1, 'legacy');
    assert.equal(callCount, 1);

    // Call 2: Must be served from cache
    const decision2 = await proxy.resolveCutover('new_client', 'production', 'sess_01');
    assert.equal(decision2, 'legacy');
    assert.equal(callCount, 1, 'Second call must hit in-memory cache and not make HTTP request');

    await new Promise<void>((resolve) => runtimeServer.close(() => resolve()));
    console.log('   ✅ PASS: Genuine runtime 404 resolves to legacy and caches answer.\n');
  }

  // Test 5: Registry down + simulated restart (zero in-memory state) + durable record is 'migrated' -> throws fail-closed
  console.log('5. Testing registry down + restart + durable record is migrated -> throws fail-closed...');
  {
    const mockRepo: any = {
      getCutoverRecord: async (t: string, e: string) => {
        if (t === 'placemakers') {
          return {
            tenantId: 'placemakers',
            environmentId: 'production',
            status: 'migrated',
            approvedReleaseChecksum: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6',
            approvedReleaseVersion: '1.0.0',
            revision: 1,
            approvedBy: 'security-admin',
            promotedAt: new Date().toISOString(),
          };
        }
        return null;
      },
    };

    // Fresh instance pointing to unreachable port (simulates service restart)
    const restartedProxy = new CutoverProxyService('http://127.0.0.1:59992', mockRepo);

    // Turn for activated tenant must fail closed: never route to legacy!
    await assert.rejects(
      () => restartedProxy.resolveCutover('placemakers', 'production', 'sess_post_restart', 500),
      (err: any) => {
        assert.ok(
          err.message.includes('failing closed'),
          `Must fail closed: got "${err.message}"`
        );
        assert.ok(
          err.message.includes('authoritative status=\'migrated\''),
          `Must report authoritative status: got "${err.message}"`
        );
        return true;
      },
      'Activated tenant must fail closed after restart when registry is unreachable'
    );

    // Turn for unmigrated tenant on same restarted proxy can continue to legacy
    const unmigratedDecision = await restartedProxy.resolveCutover('brand_unmigrated', 'production', 'sess_02', 500);
    assert.equal(unmigratedDecision, 'legacy', 'Unmigrated tenant without durable record continues on legacy');

    console.log('   ✅ PASS: Post-restart activated tenant fails closed from durable authoritative state.\n');
  }

  console.log('🎉 ALL CUTOVER PROXY TESTS PASSED.\n');
}

runSuite().catch((err) => {
  console.error('❌ CUTOVER PROXY SPEC FAILED:', err);
  process.exit(1);
});
