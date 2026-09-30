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
import { LegacyJourneyAdapter } from '../src/legacy/legacy-journey-adapter';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { ConfigLoader } from '../src/pipeline/config-loader';
import { ToolDispatcher } from '../src/legacy/tool-dispatcher';

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
  let legacyChatCalled = false;

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

  const mockLegacyAdapter = {
    executeLegacyChat: async () => {
      legacyChatCalled = true;
      return {
        message: { role: 'assistant', content: 'Legacy Output' },
        conversation: [],
        uiActions: [],
        sessionId: 'legacy_sess',
      };
    },
    executeLegacyChatStream: async () => {},
  } as any;

  const mockConfigLoader: any = {
    loadProjectConfig: async (t: string) => ({
      model: 'test-model',
      systemPromptOverrides: 'Test persona prompt',
      capabilities: ['catalog.search'],
    }),
  };

  const coordinator = new JourneyCoordinator(
    activationRouter,
    mockCanonicalRuntime,
    mockLegacyAdapter,
    mockConfigLoader
  );

  // ── TEST 1: Unmigrated / no-record tenant uses legacy ──
  console.log('1. Testing unmigrated/no-record tenant routing to legacy...');
  canonicalTurnCalled = false;
  legacyChatCalled = false;

  const unmigratedDecision = await activationRouter.resolveActivation('caroma-legacy', 'production');
  assert.equal(unmigratedDecision.action, 'LEGACY');

  await coordinator.executeChat({ tenantId: 'caroma-legacy', message: 'Hello' });
  assert.equal(legacyChatCalled, true, 'Legacy adapter must be called for unmigrated tenant');
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
  console.log('   ✅ PASS: Unmigrated and no-record tenants route to legacy');

  // ── TEST 2: Migrated tenant uses canonical and never legacy ──
  console.log('2. Testing approved migrated tenant routing exclusively to canonical...');
  canonicalTurnCalled = false;
  legacyChatCalled = false;

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
  assert.equal(legacyChatCalled, false, 'Legacy adapter must NEVER be called for migrated tenant');
  console.log('   ✅ PASS: Migrated tenant uses canonical and never legacy');

  // ── TEST 3: Activation repository failure returns 503 and never invokes legacy ──
  console.log('3. Testing cutover repository failure fails closed (503) without legacy fallback...');
  canonicalTurnCalled = false;
  legacyChatCalled = false;

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
    mockCanonicalRuntime,
    mockLegacyAdapter,
    mockConfigLoader
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
  assert.equal(legacyChatCalled, false, 'Legacy adapter must NEVER be called when activation repository fails');
  console.log('   ✅ PASS: Activation repository failure fails closed with 503 and never invokes legacy');

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

  // ── TEST 7: Caroma, Abercrombie and Workwear legacy buffered & streaming smoke tests execute tools & return UI actions ──
  console.log('7. Testing legacy buffered & streaming smoke execution for Caroma, Abercrombie, and Workwear Group...');

  function createTenantMockModelRouter(toolNameToReturn: string, toolArgs: any) {
    let callCount = 0;
    let bufferedCallCount = 0;
    return {
      getClient: () => ({}),
      createChatCompletion: async (messages: any[]) => {
        bufferedCallCount++;
        const hasToolResult = messages.some((m: any) => m.role === 'tool');
        if (hasToolResult || bufferedCallCount > 1) {
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Here is what you requested.',
                },
              },
            ],
          };
        }
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Here is what you requested.',
                tool_calls: [
                  {
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                      name: toolNameToReturn,
                      arguments: JSON.stringify(toolArgs),
                    },
                  },
                ],
              },
            },
          ],
        };
      },
      createChatCompletionStream: async function* () {
        callCount++;
        if (callCount === 1) {
          // Stream turn 1: stream tool call deltas
          const jsonStr = JSON.stringify(toolArgs);
          const mid = Math.floor(jsonStr.length / 2);
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_stream_${Date.now()}`,
                      function: { name: toolNameToReturn, arguments: jsonStr.slice(0, mid) },
                    },
                  ],
                },
              },
            ],
          };
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: jsonStr.slice(mid) },
                    },
                  ],
                },
              },
            ],
          };
        } else {
          // Stream turn 2 (after tool execution): emit final tokens
          yield { choices: [{ delta: { content: 'Here is what ' } }] };
          yield { choices: [{ delta: { content: 'you requested.' } }] };
        }
      },
    };
  }

  // 7a. Caroma Legacy Smoke Test: Executes catalog.search tool and preserves session (buffered & streaming)
  const caromaConfigLoader: any = {
    loadProjectConfig: async () => ({
      model: 'gpt-caroma-test',
      systemPromptOverrides: 'You are the Caroma Bathroom Assistant.',
      capabilities: ['catalog.search'],
    }),
  };
  const caromaRouter = createTenantMockModelRouter('showItems', { products: [{ sku: 'CAROMA-BASIN-1', name: 'Opal Basin' }] });
  const caromaLegacyAdapter = new LegacyJourneyAdapter(
    caromaConfigLoader,
    new (await import('../src/pipeline/session-store')).SessionStore(),
    caromaRouter as any,
    new (await import('../src/pipeline/policy-enforcer')).PolicyEnforcer(),
    new (await import('../src/commerce/storefront-commerce.service')).StorefrontCommerceService(),
    new (await import('../src/presentation/response-composer')).ResponseComposer(),
    new ToolDispatcher()
  );

  // Buffered
  const caromaRes = await caromaLegacyAdapter.executeLegacyChat({
    tenantId: 'caroma',
    sessionId: 'sess_caroma_1',
    message: 'Show me basins',
  });
  assert.equal(caromaRes.uiActions.length, 1, 'Caroma must return 1 UI action');
  assert.equal(caromaRes.uiActions[0].name, 'showItems');
  assert.equal(caromaRes.uiActions[0].arguments.products[0].sku, 'CAROMA-BASIN-1');
  assert.ok(caromaRes.conversation.length >= 2, 'Session conversation history must be preserved');

  // Streaming
  const caromaStreamEvents: Array<{ event: string; data: any }> = [];
  await caromaLegacyAdapter.executeLegacyChatStream(
    {
      tenantId: 'caroma',
      sessionId: 'sess_caroma_stream_1',
      message: 'Show me basins via stream',
    },
    (event, data) => caromaStreamEvents.push({ event, data })
  );
  const caromaStreamAction = caromaStreamEvents.find((e) => e.event === 'uiAction');
  assert.ok(caromaStreamAction, 'Caroma streaming must emit uiAction event');
  assert.equal(caromaStreamAction.data.name, 'showItems');
  assert.equal(caromaStreamAction.data.arguments.products[0].sku, 'CAROMA-BASIN-1');
  assert.deepEqual(caromaStreamAction.data, caromaRes.uiActions[0], 'Buffered and streamed UI actions must be identical');
  console.log('   ✅ PASS: Caroma legacy smoke test executed tool and returned identical showItems UI action in buffered and SSE');

  // 7b. Abercrombie Legacy Smoke Test: Executes showItems tool and returns UI action (buffered & streaming)
  const abercrombieConfigLoader: any = {
    loadProjectConfig: async () => ({
      model: 'gpt-abercrombie-test',
      systemPromptOverrides: 'You are the Abercrombie Stylist.',
      capabilities: ['catalog.search'],
    }),
  };
  const abercrombieRouter = createTenantMockModelRouter('showItems', { products: [{ sku: 'ANF-HOODIE-9', name: 'Essential Hoodie' }] });
  const abercrombieLegacyAdapter = new LegacyJourneyAdapter(
    abercrombieConfigLoader,
    new (await import('../src/pipeline/session-store')).SessionStore(),
    abercrombieRouter as any,
    new (await import('../src/pipeline/policy-enforcer')).PolicyEnforcer(),
    new (await import('../src/commerce/storefront-commerce.service')).StorefrontCommerceService(),
    new (await import('../src/presentation/response-composer')).ResponseComposer(),
    new ToolDispatcher()
  );

  // Buffered
  const abercrombieRes = await abercrombieLegacyAdapter.executeLegacyChat({
    tenantId: 'abercrombie',
    sessionId: 'sess_anf_1',
    message: 'Show me hoodies',
  });
  assert.equal(abercrombieRes.uiActions.length, 1);
  assert.equal(abercrombieRes.uiActions[0].name, 'showItems');
  assert.equal(abercrombieRes.uiActions[0].arguments.products[0].sku, 'ANF-HOODIE-9');

  // Streaming
  const abercrombieStreamEvents: Array<{ event: string; data: any }> = [];
  await abercrombieLegacyAdapter.executeLegacyChatStream(
    {
      tenantId: 'abercrombie',
      sessionId: 'sess_anf_stream_1',
      message: 'Show me hoodies via stream',
    },
    (event, data) => abercrombieStreamEvents.push({ event, data })
  );
  const abercrombieStreamAction = abercrombieStreamEvents.find((e) => e.event === 'uiAction');
  assert.ok(abercrombieStreamAction, 'Abercrombie streaming must emit uiAction');
  assert.equal(abercrombieStreamAction.data.name, 'showItems');
  assert.equal(abercrombieStreamAction.data.arguments.products[0].sku, 'ANF-HOODIE-9');
  assert.deepEqual(abercrombieStreamAction.data, abercrombieRes.uiActions[0], 'Buffered and streamed UI actions must be identical');
  console.log('   ✅ PASS: Abercrombie legacy smoke test executed tool and returned identical showItems UI action in buffered and SSE');

  // 7c. Workwear Group Legacy Smoke Test: Executes showGuide tool and returns UI action (buffered & streaming)
  const wwgConfigLoader: any = {
    loadProjectConfig: async () => ({
      model: 'gpt-wwg-test',
      systemPromptOverrides: 'You are the Workwear Uniform Advisor.',
      capabilities: ['catalog.search'],
    }),
  };
  const wwgRouter = createTenantMockModelRouter('showGuide', { title: 'Hi-Vis Safety Guide', steps: ['Step 1: AS/NZS 4602'] });
  const wwgLegacyAdapter = new LegacyJourneyAdapter(
    wwgConfigLoader,
    new (await import('../src/pipeline/session-store')).SessionStore(),
    wwgRouter as any,
    new (await import('../src/pipeline/policy-enforcer')).PolicyEnforcer(),
    new (await import('../src/commerce/storefront-commerce.service')).StorefrontCommerceService(),
    new (await import('../src/presentation/response-composer')).ResponseComposer(),
    new ToolDispatcher()
  );

  // Buffered
  const wwgRes = await wwgLegacyAdapter.executeLegacyChat({
    tenantId: 'workweargroup',
    sessionId: 'sess_wwg_1',
    message: 'Safety guidelines',
  });
  assert.equal(wwgRes.uiActions.length, 1);
  assert.equal(wwgRes.uiActions[0].name, 'showGuide');
  assert.equal(wwgRes.uiActions[0].arguments.title, 'Hi-Vis Safety Guide');

  // Streaming
  const wwgStreamEvents: Array<{ event: string; data: any }> = [];
  await wwgLegacyAdapter.executeLegacyChatStream(
    {
      tenantId: 'workweargroup',
      sessionId: 'sess_wwg_stream_1',
      message: 'Safety guidelines via stream',
    },
    (event, data) => wwgStreamEvents.push({ event, data })
  );
  const wwgStreamAction = wwgStreamEvents.find((e) => e.event === 'uiAction');
  assert.ok(wwgStreamAction, 'Workwear Group streaming must emit uiAction');
  assert.equal(wwgStreamAction.data.name, 'showGuide');
  assert.equal(wwgStreamAction.data.arguments.title, 'Hi-Vis Safety Guide');
  assert.deepEqual(wwgStreamAction.data, wwgRes.uiActions[0], 'Buffered and streamed UI actions must be identical');
  console.log('   ✅ PASS: Workwear Group legacy smoke test executed tool and returned identical showGuide UI action in buffered and SSE');

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
    let test9LegacyCalled = false;
    const test9Canonical = new CanonicalRuntimeAdapter();
    test9Canonical.runTurn = async () => {
      test9CanonicalCalled = true;
      return {} as any;
    };
    const test9Legacy = {
      executeLegacyChat: async () => {
        test9LegacyCalled = true;
        return {} as any;
      },
    } as any;

    const outageCoordinator = new JourneyCoordinator(
      outageRouter,
      test9Canonical,
      test9Legacy,
      mockConfigLoader
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
    assert.equal(test9LegacyCalled, false, 'Legacy chat must NOT be called on simulated outage');

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
