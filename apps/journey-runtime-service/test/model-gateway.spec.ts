import assert from 'node:assert/strict';
import {
  ModelGateway,
  ModelGatewayError,
  ModelMissingCredentialsError,
  ModelTimeoutError,
  ModelProviderHttpError,
  ModelMalformedResponseError,
  ModelResidencyViolationError,
} from '../src/kernel/model.gateway';
import { ModelRouter } from '../src/model/model-router';
import { AgentRouter } from '../src/kernel/agent.router';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState, TurnCommand } from '@journeyax/journey-core';

// Test Business Pack for Model Gateway & Agent Engine
const mockModelEnginePack: BusinessPackRelease = {
  manifest: {
    packId: 'enterprise-logistics-pack',
    tenantId: 'tenant-enterprise-logistics',
    environmentId: 'test',
    version: '1.2.0',
    name: 'Enterprise Logistics & Safety Operating Pack',
    description: 'Testing model routing, residency, and specialist agent execution',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'system',
    checksum: 'checksum-model-test-123',
  },
  profile: {
    companyName: 'Logistics Safety Systems',
    industry: 'Logistics & Aviation Safety',
    primaryCurrency: 'AUD',
    supportedCurrencies: ['AUD'],
    primaryLocale: 'en-AU',
    supportedLocales: ['en-AU'],
  },
  vocabulary: {
    version: '1.0.0',
    terms: [],
    acronyms: {},
    slotSynonyms: {},
    slotMappings: {},
    prohibitedTerms: [],
  },
  entities: {
    version: '1.0.0',
    entities: [],
  },
  conversationPolicy: {
    fencingRules: [],
    prohibitedTopics: [],
    escalationThresholds: {
      sentimentFloor: -0.6,
      maxTurnsWithoutProgress: 4,
    },
  },
  journeys: [
    {
      journeyId: 'logistics_journey',
      version: '1.0.0',
      goals: ['Safe and compliant drone route authorization'],
      initialStage: 'stage_route_planning',
      stages: {
        stage_route_planning: {
          stageId: 'stage_route_planning',
          displayName: 'Route Planning',
          requiredFacts: [],
          allowedCapabilities: ['airspace.check'],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [],
          handoffPolicy: {
            allowed: true,
            targetRole: 'route_architect',
          },
        },
        stage_safety_audit: {
          stageId: 'stage_safety_audit',
          displayName: 'Safety Audit',
          requiredFacts: [],
          allowedCapabilities: ['safety.certify'],
          nextDecisionPolicy: 'dependency-first',
          exitConditions: [],
          handoffPolicy: {
            allowed: true,
            targetRole: 'compliance_officer',
          },
        },
      },
    },
  ],
  agents: [
    {
      agentId: 'agent_route_planner',
      name: 'Airspace Route Architect',
      purpose: 'Optimizes flight paths and verifies airspace clearance.',
      systemPromptTemplate: 'You are the primary flight path architect. Prioritize civil aviation regulations.',
      modelPolicyRef: 'fast_intent',
      allowedTools: ['airspace.check', 'weather.query'],
      maxTurns: 3,
      handoffConditions: ['airspace_breach'],
      inputSchema: {},
      outputSchema: {},
    },
    {
      agentId: 'agent_safety_officer',
      name: 'Chief Safety & Compliance Officer',
      purpose: 'Audits hazardous payload and airspace approvals for compliance officer review.',
      systemPromptTemplate: 'You are the Chief Safety Officer. Maintain zero-tolerance for safety violations.',
      modelPolicyRef: 'strict_au_audit',
      allowedTools: ['safety.certify'],
      maxTurns: 2,
      handoffConditions: [],
      inputSchema: {},
      outputSchema: {},
    },
  ],
  rules: [],
  modelPolicy: {
    version: '1.0.0',
    defaultPolicy: 'standard_turn',
    policies: [
      {
        policyId: 'standard_turn',
        description: 'General conversational turn',
        candidates: [
          { provider: 'open-model', model: 'llama-3.3-70b-instruct', priority: 1, temperature: 0.1 },
        ],
        dataResidency: 'au',
        maxInputTokens: 8000,
        maxOutputTokens: 1500,
        fallbackAllowed: true,
        timeoutMs: 5000,
      },
      {
        policyId: 'fast_intent',
        description: 'High-throughput intent and slot extraction',
        candidates: [
          { provider: 'open-model', model: 'mistral-nemo-12b', priority: 1, temperature: 0.0 },
        ],
        dataResidency: 'au',
        maxInputTokens: 4000,
        maxOutputTokens: 800,
        fallbackAllowed: true,
        timeoutMs: 3000,
      },
      {
        policyId: 'strict_au_audit',
        description: 'Sovereign Australian data residency strict audit',
        candidates: [
          { provider: 'openai', model: 'gpt-4o-au', priority: 1, temperature: 0.0 },
        ],
        dataResidency: 'au',
        maxInputTokens: 12000,
        maxOutputTokens: 2500,
        fallbackAllowed: true,
        timeoutMs: 8000,
      },
      {
        policyId: 'us_restricted_policy',
        description: 'US-based data processing policy',
        candidates: [
          { provider: 'custom', model: 'us-model-v2', priority: 1, temperature: 0.2 },
        ],
        dataResidency: 'us',
        maxInputTokens: 8000,
        maxOutputTokens: 1000,
        fallbackAllowed: false,
        timeoutMs: 5000,
      },
    ],
  },
  capabilities: {
    version: '1.0.0',
    toolDefinitions: [],
    toolBindings: [],
    stageBindings: [],
  },
  experience: {
    version: '1.0.0',
    theme: {
      primaryColor: '#0F172A',
      accentColor: '#3B82F6',
      fontFamily: 'Inter, sans-serif',
      borderRadius: '8px',
      customCssVars: {},
    },
    cards: {
      allowedCardTypes: [
        'bundle',
        'products',
        'productDetail',
        'quote',
        'comparison',
        'plan',
        'cart',
        'orderStatus',
        'guide',
      ],
      defaultCardRenderer: '@journeyax/ui-cards',
    },
  },
  evaluations: [],
};

async function runTests() {
  console.log('=== Running Model Gateway & Agent Engine Tests (PR 7 / Blocker 1) ===\n');

  const router = new ModelRouter();
  const agentRouter = new AgentRouter();
  const gateway = new ModelGateway(router, agentRouter);

  // Test 1: Task Type Routing
  {
    console.log('Test 1: Model route resolution by taskType');
    const fastRoute = router.resolveModel('fast_intent', mockModelEnginePack);
    assert.equal(fastRoute.policyId, 'fast_intent');
    assert.equal(fastRoute.model, 'mistral-nemo-12b');
    assert.equal(fastRoute.dataResidency, 'au');

    const defaultRoute = router.resolveModel('complex_reasoning', mockModelEnginePack);
    assert.equal(defaultRoute.policyId, 'standard_turn');
    assert.equal(defaultRoute.model, 'llama-3.3-70b-instruct');
    console.log('✓ Task types resolved correctly according to pack policy\n');
  }

  // Test 2: Explicit Specialist Agent Policy Binding via policyRef
  {
    console.log('Test 2: Explicit specialist agent policy resolution via policyRef');
    process.env.OPENAI_API_KEY = 'mock-key-for-test';
    const strictRoute = router.resolveModel('complex_reasoning', mockModelEnginePack, {
      policyRef: 'strict_au_audit',
    });
    assert.equal(strictRoute.policyId, 'strict_au_audit');
    assert.equal(strictRoute.model, 'gpt-4o-au');
    assert.equal(strictRoute.dataResidency, 'au');
    delete process.env.OPENAI_API_KEY;
    console.log('✓ policyRef explicitly binds specialist agent policy\n');
  }

  // Test 3: Evidenced Data Residency Verification (Fail Closed on Label without Evidence)
  {
    console.log('Test 3: Evidenced data residency validation fails closed on unproven endpoint');

    process.env.OPENAI_API_KEY = 'mock-key-for-test';
    // Default OpenAI endpoint without OPENAI_DATA_RESIDENCY defaults to US processing
    delete process.env.OPENAI_DATA_RESIDENCY;
    delete process.env.OPENAI_BASE_URL;

    // strict_au_audit route requires 'au', but endpoint is https://api.openai.com/v1 (evidenced as US)
    await assert.rejects(
      async () => {
        await gateway.execute(mockModelEnginePack, {
          taskType: 'complex_reasoning',
          prompt: 'Audit flight plan',
          policyRef: 'strict_au_audit',
        });
      },
      (err: any) => {
        assert(err instanceof ModelResidencyViolationError, 'Must throw ModelResidencyViolationError');
        assert.equal(err.code, 'RESIDENCY_VIOLATION');
        assert.equal(err.requiredResidency, 'au');
        assert.equal(err.actualResidency, 'us');
        return true;
      },
      'ModelGateway must reject execution when endpoint cannot evidence required residency'
    );

    delete process.env.OPENAI_API_KEY;

    // Now configure explicit evidenced residency for AU (e.g. Australian regional gateway)
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    const evidenced = gateway.determineEndpointResidency('openai', 'https://api.openai.com/v1/chat/completions');
    assert.equal(evidenced.residency, 'au');
    assert.equal(evidenced.evidence, 'env:OPENAI_DATA_RESIDENCY=au');

    delete process.env.OPENAI_DATA_RESIDENCY;
    console.log('✓ Evidenced data residency strictly enforced against endpoint/config\n');
  }

  // Test 4: Negative Test: Missing Credentials (Fail Closed)
  {
    console.log('Test 4 (Negative): Missing API credentials throws typed fail-closed error');
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
      async () => {
        await gateway.execute(mockModelEnginePack, {
          taskType: 'complex_reasoning',
          prompt: 'Execute plan',
          policyRef: 'strict_au_audit',
        });
      },
      (err: any) => {
        assert(err instanceof ModelMissingCredentialsError, 'Must throw ModelMissingCredentialsError');
        assert.equal(err.code, 'MISSING_CREDENTIALS');
        assert.equal(err.provider, 'openai');
        return true;
      },
      'Missing API credentials must throw ModelMissingCredentialsError'
    );

    delete process.env.OPENAI_DATA_RESIDENCY;
    console.log('✓ Missing credentials rejected with ModelMissingCredentialsError\n');
  }

  // Test 5: Negative Test: Request Timeout (Fail Closed)
  {
    console.log('Test 5 (Negative): Provider timeout throws ModelTimeoutError');
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    process.env.OPENAI_API_KEY = 'mock-key-for-test';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };

    try {
      await assert.rejects(
        async () => {
          await gateway.execute(mockModelEnginePack, {
            taskType: 'complex_reasoning',
            prompt: 'Heavy analysis',
            policyRef: 'strict_au_audit',
          });
        },
        (err: any) => {
          assert(err instanceof ModelTimeoutError, 'Must throw ModelTimeoutError');
          assert.equal(err.code, 'TIMEOUT');
          assert.equal(err.provider, 'openai');
          return true;
        },
        'Timeout must throw ModelTimeoutError'
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_DATA_RESIDENCY;
      delete process.env.OPENAI_API_KEY;
    }

    console.log('✓ Timeout rejected with ModelTimeoutError\n');
  }

  // Test 6: Negative Test: Provider Non-2xx HTTP Status (Fail Closed)
  {
    console.log('Test 6 (Negative): Provider non-2xx status throws ModelProviderHttpError');
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    process.env.OPENAI_API_KEY = 'mock-key-for-test';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), {
        status: 429,
        statusText: 'Too Many Requests',
      });
    };

    try {
      await assert.rejects(
        async () => {
          await gateway.execute(mockModelEnginePack, {
            taskType: 'complex_reasoning',
            prompt: 'Test request',
            policyRef: 'strict_au_audit',
          });
        },
        (err: any) => {
          assert(err instanceof ModelProviderHttpError, 'Must throw ModelProviderHttpError');
          assert.equal(err.code, 'PROVIDER_HTTP_ERROR');
          assert.equal(err.status, 429);
          assert.match(err.responseBody, /Rate limit reached/);
          return true;
        },
        'HTTP 429 must throw ModelProviderHttpError'
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_DATA_RESIDENCY;
      delete process.env.OPENAI_API_KEY;
    }

    console.log('✓ Provider non-2xx rejected with ModelProviderHttpError\n');
  }

  // Test 7: Negative Test: Malformed or Empty Provider Response (Fail Closed)
  {
    console.log('Test 7 (Negative): Malformed/empty provider response throws ModelMalformedResponseError');
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    process.env.OPENAI_API_KEY = 'mock-key-for-test';

    const originalFetch = globalThis.fetch;
    // Case 1: Empty choices
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    };

    try {
      await assert.rejects(
        async () => {
          await gateway.execute(mockModelEnginePack, {
            taskType: 'complex_reasoning',
            prompt: 'Test request',
            policyRef: 'strict_au_audit',
          });
        },
        (err: any) => {
          assert(err instanceof ModelMalformedResponseError, 'Must throw ModelMalformedResponseError');
          assert.equal(err.code, 'MALFORMED_RESPONSE');
          return true;
        },
        'Empty choices must throw ModelMalformedResponseError'
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_DATA_RESIDENCY;
      delete process.env.OPENAI_API_KEY;
    }

    console.log('✓ Empty/malformed response rejected with ModelMalformedResponseError\n');
  }

  // Test 8: Successful Evidenced Execution (Zero Fallback / Genuine Provenance)
  {
    console.log('Test 8: Successful provider execution returns verified content and residency evidence');
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    process.env.OPENAI_API_KEY = 'mock-key-for-test';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Flight path verified through waypoint SYD-W4 with zero airspace incursions.',
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const response = await gateway.execute(mockModelEnginePack, {
        taskType: 'complex_reasoning',
        prompt: 'Check airspace clearance',
        policyRef: 'strict_au_audit',
      });

      assert.equal(
        response.content,
        'Flight path verified through waypoint SYD-W4 with zero airspace incursions.'
      );
      assert.equal(response.residencyProven, true);
      assert.equal(response.residencyEvidence, 'env:OPENAI_DATA_RESIDENCY=au');
      assert.ok(response.latencyMs >= 0);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_DATA_RESIDENCY;
      delete process.env.OPENAI_API_KEY;
    }

    console.log('✓ Successful execution returns genuine response and residency proof\n');
  }

  // Test 9: Specialist Agent Resolution & Token-Budgeted Prompt Composition
  {
    console.log('Test 9: Specialist agent resolution and prompt composition');
    const mockWs: WorkspaceState = {
      tenantId: 'tenant-enterprise-logistics',
      environmentId: 'test',
      workspaceId: 'ws-prompt-1',
      packVersionId: '1.2.0',
      journeyId: 'logistics_journey',
      currentStage: 'stage_route_planning',
      goal: 'Safe route planning',
      facts: {
        flight_origin: { value: 'SYD-Terminal-3', source: 'customer', confidence: 1.0 },
      },
      decisions: [],
      selectedObjects: [],
      openQuestions: [],
      status: 'active',
      stateVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const resolved = agentRouter.resolveAgent(mockModelEnginePack, mockWs);
    assert.equal(resolved.agent.agentId, 'agent_route_planner');

    const { systemPrompt, userPrompt } = agentRouter.composePrompt(resolved, mockWs, 'Verify clearance');
    assert.match(systemPrompt, /Airspace Route Architect/);
    assert.match(userPrompt, /SYD-Terminal-3/);
    console.log('✓ Specialist agents and prompts cleanly formatted\n');
  }

  // Test 10: High-Level executeWithAgent Propagates Fail-Closed Errors
  {
    console.log('Test 10: executeWithAgent propagates typed errors without fabricating success');
    const mockWs: WorkspaceState = {
      tenantId: 'tenant-enterprise-logistics',
      environmentId: 'test',
      workspaceId: 'ws-exec-fail-1',
      packVersionId: '1.2.0',
      journeyId: 'logistics_journey',
      currentStage: 'stage_safety_audit',
      goal: 'Safety verification',
      facts: {},
      decisions: [],
      selectedObjects: [],
      openQuestions: [],
      status: 'active',
      stateVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // When credentials missing, executeWithAgent must propagate ModelMissingCredentialsError
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
      async () => {
        await gateway.executeWithAgent(mockModelEnginePack, mockWs, 'Audit sortie #109');
      },
      (err: any) => {
        assert(err instanceof ModelMissingCredentialsError);
        return true;
      },
      'executeWithAgent must not fabricate success when credentials are missing'
    );

    delete process.env.OPENAI_DATA_RESIDENCY;
    console.log('✓ executeWithAgent propagates fail-closed errors without fabrication\n');
  }

  // Test 11: TurnApplicationService Tracing
  {
    console.log('Test 11: TurnApplicationService traces model route metadata');
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

    const appService = new TurnApplicationService();
    appService.packRepo.loadActivePack = async () => mockModelEnginePack;

    const command: TurnCommand = {
      tenantId: 'tenant-enterprise-logistics',
      environmentId: 'test',
      workspaceId: 'ws-turn-model-trace-1',
      sessionId: 'sess-model-1',
      correlationId: 'corr-model-trace-1',
      message: 'Plan route from Sydney to Canberra',
    };

    const result = await appService.executeTurn(command);
    assert.ok(result.trace);
    assert.ok(result.trace.modelRoute);
    assert.equal(result.trace.modelRoute?.policyId, 'fast_intent');
    assert.equal(result.trace.modelRoute?.dataResidency, 'au');
    console.log('✓ TurnApplicationService trace accurately records model route and residency\n');
  }

  // Test 12: Multi-candidate fallback when candidate 1 fails/times out
  {
    console.log('Test 12: Multi-candidate fallback when primary candidate times out');
    const multiCandidatePack: BusinessPackRelease = {
      ...mockModelEnginePack,
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'fast_intent',
        policies: [
          {
            policyId: 'fast_intent',
            dataResidency: 'au',
            acceptedResidencies: ['au'],
            candidates: [
              { provider: 'google', model: 'gemini-2.5-flash', priority: 1 },
              { provider: 'openai', model: 'gpt-4o-mini', priority: 2 },
            ],
            fallbackAllowed: true,
            timeoutMs: 1000,
            maxInputTokens: 8000,
            maxOutputTokens: 1000,
          },
        ],
      },
    };

    process.env.OPENAI_API_KEY = 'mock-openai-key';
    process.env.OPENAI_DATA_RESIDENCY = 'au';
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    process.env.GOOGLE_DATA_RESIDENCY = 'au';

    const originalFetch = globalThis.fetch;
    let googleCalled = false;
    let openaiCalled = false;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        googleCalled = true;
        // Simulate Google timing out / failing
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      if (urlStr.includes('api.openai.com')) {
        openaiCalled = true;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"intent":"fallback_success"}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const response = await gateway.execute(multiCandidatePack, {
        taskType: 'fast_intent',
        prompt: 'test prompt',
      });
      assert.equal(googleCalled, true, 'Primary candidate (Google) must be attempted first');
      assert.equal(openaiCalled, true, 'Secondary candidate (OpenAI) must be called upon primary failure');
      assert.equal(response.content, '{"intent":"fallback_success"}');
      assert.equal(response.route.provider, 'openai');
      console.log('✓ Seamless fallback to Candidate 2 when Candidate 1 times out\n');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_DATA_RESIDENCY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_DATA_RESIDENCY;
    }
  }

  console.log('====================================================');
  console.log('✓ All 12 Model Gateway Tests PASSED!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
