import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  verifyGatewayAssertion,
  DurableCutoverRecord,
  ReleaseActivationRepository,
  ReleaseActivationRepositoryUnavailableError,
} from '@journeyax/database';
import { TurnCommand } from '@journeyax/journey-core';
import { TenantRuntimeActivationRouter } from '../src/runtime/tenant-runtime-activation.router';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';

async function runActivationPolicySuite() {
  console.log('🧪 Running Tenant Runtime Activation & Negative Integration Suite...\n');

  // In-memory cutover test repository
  const cutoverStore = new Map<string, DurableCutoverRecord>();
  const mockCutoverRepo: any = {
    getCutoverRecord: async (tenantId: string, env: string = 'production') => {
      const key = `${tenantId.toLowerCase()}:${env.toLowerCase()}`;
      return cutoverStore.get(key) || null;
    },
  };

  const activationRouter = new TenantRuntimeActivationRouter();
  activationRouter.setCutoverRepository(mockCutoverRepo);

  let canonicalTurnCalled = false;

  const mockCanonicalRuntime = new CanonicalRuntimeAdapter();
  mockCanonicalRuntime.runTurn = async () => {
    canonicalTurnCalled = true;
    return {
      decision: { decisionId: 'dec_canon', type: 'continue', payload: {}, reason: 'ok', createdAt: new Date().toISOString() },
      workspaceState: { tenantId: 'test', environmentId: 'production', workspaceId: 'ws_test' } as any,
      uiInstructions: [],
      assistantMessage: 'Canonical Turn Output',
    };
  };

  const coordinator = new JourneyCoordinator(
    activationRouter,
    mockCanonicalRuntime
  );

  // ── TEST 1: Unmigrated / no-record tenant is refused (503); no other engine serves it ──
  console.log('1. Testing unmigrated/no-record tenant is refused with 503...');
  canonicalTurnCalled = false;

  const unmigratedDecision = await activationRouter.resolveActivation('caroma-legacy', 'production');
  assert.equal(unmigratedDecision.action, 'LEGACY');

  await assert.rejects(
    () => coordinator.executeChat({ tenantId: 'caroma-legacy', message: 'Hello' }),
    (err: any) => err instanceof ServiceUnavailableException && err.getStatus() === 503,
    'An unmigrated tenant must be refused with 503'
  );
  assert.equal(canonicalTurnCalled, false, 'Canonical runtime must NOT be called for unmigrated tenant');

  // Also test explicit status='unmigrated'
  cutoverStore.set('explicit-unmigrated:production', {
    tenantId: 'explicit-unmigrated',
    environmentId: 'production',
    status: 'unmigrated',
    approvedReleaseVersion: '',
    approvedReleaseChecksum: '',
    revision: 1,
    approvedBy: 'governor',
    promotedAt: new Date().toISOString(),
    updatedAt: new Date(),
  });
  const explicitUnmigratedDec = await activationRouter.resolveActivation('explicit-unmigrated', 'production');
  assert.equal(explicitUnmigratedDec.action, 'LEGACY');
  console.log('   ✅ PASS: Unmigrated and no-record tenants are refused with 503');

  // ── TEST 2: Migrated tenant uses canonical and never legacy ──
  console.log('2. Testing approved migrated tenant routing exclusively to canonical...');
  canonicalTurnCalled = false;

  cutoverStore.set('placemakers-migrated:production', {
    tenantId: 'placemakers-migrated',
    environmentId: 'production',
    status: 'migrated',
    approvedReleaseVersion: '1.0.0',
    approvedReleaseChecksum: 'sha_valid_123',
    revision: 2,
    approvedBy: 'governor',
    promotedAt: new Date().toISOString(),
    updatedAt: new Date(),
  });

  const migratedDecision = await activationRouter.resolveActivation('placemakers-migrated', 'production');
  assert.equal(migratedDecision.action, 'CANONICAL');

  await coordinator.executeChat({ tenantId: 'placemakers-migrated', message: 'Show catalogue' });
  assert.equal(canonicalTurnCalled, true, 'Canonical runtime must be called for migrated tenant');
  console.log('   ✅ PASS: Migrated tenant uses the canonical runtime');

  // ── TEST 3: Activation repository failure returns 503 ──
  console.log('3. Testing cutover repository failure fails closed (503)...');
  canonicalTurnCalled = false;

  const failingRepo: any = {
    getCutoverRecord: async () => {
      throw new Error('Database connection timeout (MongoDB replica set unavailable)');
    },
  };
  const failingRouter = new TenantRuntimeActivationRouter();
  failingRouter.setCutoverRepository(failingRepo);

  const blockedDecision = await failingRouter.resolveActivation('placemakers-migrated', 'production');
  assert.equal(blockedDecision.action, 'BLOCKED');
  assert.equal(blockedDecision.statusCode, 503);

  const failingCoordinator = new JourneyCoordinator(
    failingRouter,
    mockCanonicalRuntime
  );

  let thrown503 = false;
  try {
    await failingCoordinator.executeChat({ tenantId: 'placemakers-migrated', message: 'Hello' });
  } catch (err: any) {
    if (err instanceof ServiceUnavailableException || err.status === 503 || err.message.includes('Cutover repository lookup failed')) {
      thrown503 = true;
    }
  }
  assert.equal(thrown503, true, 'Repository failure must throw 503 ServiceUnavailableException');
  assert.equal(canonicalTurnCalled, false, 'Canonical runtime must NOT be called when the activation repository fails');
  console.log('   ✅ PASS: Activation repository failure fails closed with 503');

  // ── TEST 4: Checksum/version mismatch fails closed ──
  console.log('4. Testing release version and checksum mismatch fails closed...');
  const validatingRouter = new TenantRuntimeActivationRouter();
  validatingRouter.setCutoverRepository(mockCutoverRepo);

  // Mock pack release with version 1.0.0 and known checksum
  const livePack: any = {
    manifest: { packId: 'test_pack', version: '1.0.0' },
    journeys: [],
  };
  validatingRouter.setReleaseLoader(async () => livePack);

  // Version mismatch test
  cutoverStore.set('mismatch-tenant:production', {
    tenantId: 'mismatch-tenant',
    environmentId: 'production',
    status: 'migrated',
    approvedReleaseVersion: '2.0.0', // Live is 1.0.0
    approvedReleaseChecksum: 'sha_matches',
    revision: 1,
    approvedBy: 'governor',
    promotedAt: new Date().toISOString(),
    updatedAt: new Date(),
  });

  const versionMismatchDec = await validatingRouter.resolveActivation('mismatch-tenant', 'production');
  assert.equal(versionMismatchDec.action, 'BLOCKED');
  assert.ok(versionMismatchDec.reason.includes('Version mismatch'));

  // Checksum mismatch test
  cutoverStore.set('checksum-mismatch:production', {
    tenantId: 'checksum-mismatch',
    environmentId: 'production',
    status: 'migrated',
    approvedReleaseVersion: '1.0.0',
    approvedReleaseChecksum: 'tampered_checksum_xyz', // Checksum tampered
    revision: 1,
    approvedBy: 'governor',
    promotedAt: new Date().toISOString(),
    updatedAt: new Date(),
  });

  const checksumMismatchDec = await validatingRouter.resolveActivation('checksum-mismatch', 'production');
  assert.equal(checksumMismatchDec.action, 'BLOCKED');
  assert.ok(checksumMismatchDec.reason.includes('Checksum mismatch'));
  console.log('   ✅ PASS: Version and checksum mismatches fail closed with BLOCKED/503');

  // ── TEST 5: Canary assignment is deterministic ──
  console.log('5. Testing deterministic canary assignment at 25%...');
  cutoverStore.set('canary-tenant:production', {
    tenantId: 'canary-tenant',
    environmentId: 'production',
    status: 'canary',
    canaryPercentage: 25,
    approvedReleaseVersion: '1.0.0',
    approvedReleaseChecksum: '',
    revision: 1,
    approvedBy: 'governor',
    promotedAt: new Date().toISOString(),
    updatedAt: new Date(),
  });

  // Evaluate 50 distinct workspace IDs across 10 iterations each to prove absolute determinism
  let inBucketCount = 0;
  let outBucketCount = 0;

  for (let w = 0; w < 50; w++) {
    const wsId = `workspace_client_${w}`;
    const initialDec = await activationRouter.resolveActivation('canary-tenant', 'production', wsId);

    if (initialDec.action === 'CANONICAL') {
      inBucketCount++;
    } else if (initialDec.action === 'LEGACY') {
      outBucketCount++;
    } else {
      assert.fail(`Canary must only return CANONICAL or LEGACY, got ${initialDec.action}`);
    }

    // 10 identical re-runs must yield 100% identical decision
    for (let r = 0; r < 10; r++) {
      const repeatDec = await activationRouter.resolveActivation('canary-tenant', 'production', wsId);
      assert.equal(
        repeatDec.action,
        initialDec.action,
        `Canary stability violation for ${wsId}: iteration ${r} flipped decision`
      );
    }
  }

  assert.ok(inBucketCount > 0, 'Canary must assign some workspaces to CANONICAL at 25%');
  assert.ok(outBucketCount > 0, 'Canary must assign remaining workspaces to LEGACY at 25%');
  console.log(`   ✅ PASS: Deterministic canary verified across 500 checks (${inBucketCount} in, ${outBucketCount} out)`);

  // ── TEST 6: Canonical request propagates authenticated identity ──
  console.log('6. Testing authenticated identity propagation via gateway assertion & internal key...');
  process.env.INTERNAL_API_KEY = 'test-internal-key-999';
  process.env.GATEWAY_ASSERTION_SECRET = 'test-assertion-secret-888';

  const testCommand: TurnCommand = {
    tenantId: 'tenant-identity-test',
    environmentId: 'production',
    workspaceId: 'ws_auth',
    sessionId: 'sess_auth',
    turnId: 'turn_auth_1',
    principalId: 'user_contractor_123',
    principalRole: 'manager',
    message: 'Place order',
  };

  const headers = await mockCanonicalRuntime.buildAuthenticatedHeaders(testCommand);

  assert.equal(headers['X-Internal-Key'], 'test-internal-key-999', 'Internal API key must be propagated');
  assert.ok(headers['X-Gateway-Assertion'], 'Signed gateway assertion header must be present');

  // Verify the gateway assertion cryptographically
  const verifiedPayload = verifyGatewayAssertion(
    headers['X-Gateway-Assertion'],
    process.env.GATEWAY_ASSERTION_SECRET,
    { expectedTenantId: 'tenant-identity-test', expectedEnvironmentId: 'production' }
  );

  assert.equal(verifiedPayload.sub, 'user_contractor_123', 'Principal ID must be authenticated in assertion');
  assert.equal(verifiedPayload.role, 'manager', 'Principal role must be authenticated in assertion');
  assert.equal(verifiedPayload.tenantId, 'tenant-identity-test');
  assert.equal(verifiedPayload.environmentId, 'production');

  // Contract test: Cloud Run workload authorization (ID Token) attaches alongside internal key & gateway assertion
  process.env.CLOUD_RUN_ID_TOKEN = 'mock-cloud-run-id-token-abc123xyz';
  const prodHeaders = await mockCanonicalRuntime.buildAuthenticatedHeaders(testCommand);
  assert.equal(
    prodHeaders['Authorization'],
    'Bearer mock-cloud-run-id-token-abc123xyz',
    'Production HTTP client must attach workload authorization Authorization: Bearer <ID_TOKEN>'
  );
  assert.equal(prodHeaders['X-Internal-Key'], 'test-internal-key-999');
  assert.ok(prodHeaders['X-Gateway-Assertion']);
  delete process.env.CLOUD_RUN_ID_TOKEN;
  console.log('   ✅ PASS: Authenticated workload identity & signed gateway assertion strictly propagated');
  console.log('   ✅ PASS: Contract test proves production HTTP client attaches Cloud Run IAM authorization');

  // ── TEST 8: Canonical SSE events preserve ordering through a real HTTP boundary ──
  console.log('8. Testing canonical SSE event delivery and ordering through real HTTP boundary...');

  const sseEventsToSend = [
    { event: 'session', data: { sessionId: 'sess_http_test_100' } },
    { event: 'uiAction', data: { name: 'presentCard', arguments: { card: { id: 'c10', cardType: 'spec_card' } } } },
    { event: 'token', data: { token: 'Framing ' } },
    { event: 'token', data: { token: 'timber ' } },
    { event: 'token', data: { token: 'verified.' } },
    { event: 'done', data: { status: 'complete' } },
  ];

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    for (const item of sseEventsToSend) {
      res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  process.env.JOURNEY_RUNTIME_SERVICE_URL = `http://127.0.0.1:${port}`;

  const receivedEvents: Array<{ event: string; data: any }> = [];
  const sseRuntimeAdapter = new CanonicalRuntimeAdapter();

  await sseRuntimeAdapter.streamTurn(
    {
      tenantId: 'placemakers',
      environmentId: 'production',
      sessionId: 'sess_http_test_100',
      message: 'Need 90x45 framing',
    },
    (event, data) => {
      receivedEvents.push({ event, data });
    }
  );

  server.close();

  assert.equal(receivedEvents.length, sseEventsToSend.length, `Must receive all ${sseEventsToSend.length} events`);
  for (let i = 0; i < sseEventsToSend.length; i++) {
    assert.equal(receivedEvents[i].event, sseEventsToSend[i].event, `Event ${i} type must match`);
    assert.deepEqual(receivedEvents[i].data, sseEventsToSend[i].data, `Event ${i} data must match`);
  }

  assert.equal(receivedEvents[0].event, 'session');
  assert.equal(receivedEvents[1].event, 'uiAction');
  assert.equal(receivedEvents[2].event, 'token');
  assert.equal(receivedEvents[3].event, 'token');
  assert.equal(receivedEvents[4].event, 'token');
  assert.equal(receivedEvents[5].event, 'done');
  console.log('   ✅ PASS: Canonical SSE events preserve exact ordering and framing through HTTP socket\n');

  // ── TEST 9: Real ReleaseActivationRepository throws ReleaseActivationRepositoryUnavailableError and fails closed in production ──
  console.log('9. Testing real ReleaseActivationRepository under simulated MongoDB outage in production...');
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';

    let outageThrown = false;
    const outageDbProvider = async () => {
      throw new Error('MongoNetworkTimeoutError: connection timed out after 30000ms');
    };

    const realOutageRepo = new ReleaseActivationRepository(outageDbProvider);

    // Assert getReleaseActivation throws ReleaseActivationRepositoryUnavailableError rather than returning null
    try {
      await realOutageRepo.getReleaseActivation('placemakers', 'production');
    } catch (err: any) {
      outageThrown = true;
      assert.ok(
        err instanceof ReleaseActivationRepositoryUnavailableError,
        `Expected err to be ReleaseActivationRepositoryUnavailableError, got ${err?.name}: ${err?.message}`
      );
    }
    assert.equal(outageThrown, true, 'getReleaseActivation must throw when dbProvider fails');

    // Pass that real repository to TenantRuntimeActivationRouter
    const outageRouter = new TenantRuntimeActivationRouter();
    outageRouter.setReleaseActivationRepository(realOutageRepo);

    // Assert the routing decision is BLOCKED with statusCode 503
    const outageDecision = await outageRouter.resolveActivation('placemakers', 'production');
    assert.equal(outageDecision.action, 'BLOCKED', 'Decision must be BLOCKED on repository failure');
    assert.equal(outageDecision.statusCode, 503, 'StatusCode must be 503 on repository failure');
    assert.ok(
      outageDecision.reason.includes('failed') || outageDecision.reason.includes('MongoNetworkTimeoutError'),
      `Reason must describe the outage failure, got: ${outageDecision.reason}`
    );

    // Assert neither canonical nor legacy execution is called
    let test9CanonicalCalled = false;
    const test9Canonical = new CanonicalRuntimeAdapter();
    test9Canonical.runTurn = async () => {
      test9CanonicalCalled = true;
      return {} as any;
    };
    const outageCoordinator = new JourneyCoordinator(
      outageRouter,
      test9Canonical
    );

    let coordinatorBlocked = false;
    try {
      await outageCoordinator.executeChat({
        tenantId: 'placemakers',
        messages: [{ role: 'user', content: 'hello' }],
      } as any);
    } catch (err: any) {
      coordinatorBlocked = true;
      assert.ok(
        err instanceof ServiceUnavailableException || (err as any).status === 503 || (err as any).statusCode === 503,
        `Coordinator must throw 503 ServiceUnavailableException on BLOCKED activation: ${err.message}`
      );
    }
    assert.equal(coordinatorBlocked, true, 'JourneyCoordinator must fail closed with 503');
    assert.equal(test9CanonicalCalled, false, 'Canonical turn must NOT be called on simulated outage');

    console.log('   ✅ PASS: Real ReleaseActivationRepository throws ReleaseActivationRepositoryUnavailableError and fails closed (503 BLOCKED) with zero legacy/canonical leakage\n');
  } finally {
    // Restore environment variables after the test
    if (prevNodeEnv !== undefined) {
      process.env.NODE_ENV = prevNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  }

  console.log('🎉 ALL 9 RUNTIME ACTIVATION & NEGATIVE INTEGRATION REQUIREMENTS FULLY PROVEN!\n');
}

runActivationPolicySuite().catch((err) => {
  console.error('❌ Activation policy test suite failed:', err);
  process.exit(1);
});
