import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { LegacyJourneyAdapter } from '../src/legacy/legacy-journey-adapter';
import { ConfigLoader } from '../src/pipeline/config-loader';
import { SessionStore } from '../src/pipeline/session-store';
import { ModelRouter } from '../src/llm/model-router';
import { PolicyEnforcer } from '../src/pipeline/policy-enforcer';
import { StorefrontCommerceService } from '../src/commerce/storefront-commerce.service';
import { ResponseComposer } from '../src/presentation/response-composer';
import { ToolDispatcher } from '../src/legacy/tool-dispatcher';

async function runTests() {
  console.log('🧪 Running JourneyCoordinator Boundary & Dynamic Context Test Suite...');

  const mockActivationRouter: any = {
    resolveActivation: async () => ({ action: 'LEGACY', reason: 'Unmigrated test tenant' }),
  };
  const mockCanonicalRuntime: any = {
    runTurn: async () => ({}),
    streamTurn: async () => {},
  };

  const coordinator = new JourneyCoordinator(
    mockActivationRouter,
    mockCanonicalRuntime,
    new LegacyJourneyAdapter(),
    new ConfigLoader()
  );

  // Test 1: Missing tenantId fails closed
  try {
    await coordinator.executeChat({ message: 'Hello' });
    throw new Error('Test 1 failed: missing tenantId must throw');
  } catch (err: any) {
    if (!err.message.includes('tenantId is required')) {
      throw err;
    }
  }
  console.log('  ✅ PASS: Missing tenantId fails closed');

  // Test 2: Missing / unconfigured tenant fails closed with explicit configuration error
  try {
    await coordinator.executeChat({ tenantId: 'unconfigured-tenant-abc', message: 'Hello' });
    throw new Error('Test 2 failed: unconfigured tenant must throw/fail closed');
  } catch (err: any) {
    if (!err.message.includes('No active configuration found') || !err.message.includes('failing closed')) {
      throw new Error(`Test 2 failed: Expected configuration fail closed error, got: "${err.message}"`);
    }
  }
  console.log('  ✅ PASS: Unconfigured tenant genuinely fails closed before model execution');

  // Test 3: Dynamic business context (persona, journey guidance, business rules, Brand Hub) reaches the model
  let capturedSystemPrompt = '';
  const mockConfigLoader: any = {
    loadProjectConfig: async (t: string) => ({
      model: 'test-model',
      provider: 'openai',
      systemPromptOverrides: 'Verified Persona Identity 12345',
      journeyGuidance: 'Strategic Goal: Complete Consultation with Care',
      pricing: { currency: 'NZD', symbol: '$' },
    }),
    loadActiveRules: async (t: string) => [
      {
        name: 'StrictRefundPolicy',
        scope: 'returns',
        condition: 'customer requests cash refund',
        action: 'require store manager approval and original receipt',
      },
    ],
    loadBrandHub: async (t: string) => ({
      brand: { name: 'Acme Test Brand' },
      guidelines: 'Never quote unverified pricing',
    }),
    renderRulesBlock: (rules: any[]) =>
      rules.length ? `[BUSINESS RULES]\n• StrictRefundPolicy: require store manager approval` : '',
    renderBrandHubBlock: (hub: any) =>
      hub ? `[BRAND HUB]\nBrand: Acme Test Brand` : '',
  };

  const mockSessionStore: any = {
    load: async () => null,
    save: async () => {},
  };

  const mockModelRouter: any = {
    getClient: () => ({}),
    createChatCompletion: async (messages: any[]) => {
      capturedSystemPrompt = messages.find((m) => m.role === 'system')?.content || '';
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Hello customer, I am ready to help you.',
            },
          },
        ],
      };
    },
    createChatCompletionStream: async function* () {
      yield { choices: [{ delta: { content: 'Hello ' } }] };
      yield { choices: [{ delta: { content: 'customer!' } }] };
    },
  };

  const mockPolicyEnforcer: any = {
    isTenantCutoverToRuntime: async () => false,
    requiredUiTool: () => null,
    stripCartTaboo: (t: string) => t,
  };

  const legacyAdapter = new LegacyJourneyAdapter(
    mockConfigLoader,
    mockSessionStore,
    mockModelRouter,
    mockPolicyEnforcer,
    new StorefrontCommerceService(),
    new ResponseComposer(),
    new ToolDispatcher()
  );

  const dynamicCoordinator = new JourneyCoordinator(
    mockActivationRouter,
    mockCanonicalRuntime,
    legacyAdapter,
    mockConfigLoader
  );

  const res = await dynamicCoordinator.executeChat({
    tenantId: 'test-tenant',
    message: 'What are your policies?',
  });

  if (!capturedSystemPrompt.includes('Verified Persona Identity 12345')) {
    throw new Error('Test 3 failed: Published persona did not reach system prompt');
  }
  if (!capturedSystemPrompt.includes('Strategic Goal: Complete Consultation with Care')) {
    throw new Error('Test 3 failed: Journey guidance did not reach system prompt');
  }
  if (!capturedSystemPrompt.includes('StrictRefundPolicy')) {
    throw new Error('Test 3 failed: Active business rules did not reach system prompt');
  }
  if (!capturedSystemPrompt.includes('Acme Test Brand')) {
    throw new Error('Test 3 failed: Brand Hub block did not reach system prompt');
  }
  console.log('  ✅ PASS: Persona, journey guidance, business rules, and Brand Hub context dynamically reach model');

  // Test 4: Real SSE streaming emits incremental ordered tokens followed by data and done
  const emittedEvents: Array<{ event: string; data: any }> = [];
  await dynamicCoordinator.executeChatStream(
    { tenantId: 'test-tenant', message: 'Hello stream' },
    (event, data) => {
      emittedEvents.push({ event, data });
    }
  );

  const tokenEvents = emittedEvents.filter((e) => e.event === 'token');
  if (tokenEvents.length < 2) {
    throw new Error(`Test 4 failed: Expected at least 2 incremental token events, got ${tokenEvents.length}`);
  }
  const t0 = tokenEvents[0].data?.token || tokenEvents[0].data?.delta;
  const t1 = tokenEvents[1].data?.token || tokenEvents[1].data?.delta;
  if (t0 !== 'Hello ' || t1 !== 'customer!') {
    throw new Error(`Test 4 failed: Tokens were not emitted incrementally in arrival order (got t0="${t0}", t1="${t1}")`);
  }

  const dataEvents = emittedEvents.filter((e) => e.event === 'data');
  const doneEvents = emittedEvents.filter((e) => e.event === 'done');
  if (dataEvents.length !== 1 || doneEvents.length !== 1) {
    throw new Error('Test 4 failed: Exactly one data and one done event must be emitted at termination');
  }

  // Ensure 'done' is the absolute final event
  if (emittedEvents[emittedEvents.length - 1].event !== 'done') {
    throw new Error('Test 4 failed: "done" was not the final event');
  }
  console.log('  ✅ PASS: SSE streaming emits incremental ordered token events and closes with data/done once');

  // Test 5: Injected ReactAgent is NOT bypassed by default (ENABLE_REACT_AGENT not true)
  const previousEnv = process.env.ENABLE_REACT_AGENT;
  delete process.env.ENABLE_REACT_AGENT;

  let reactAgentCalled = false;
  const dummyReactAgent: any = {
    executeAgentTurnStream: async () => {
      reactAgentCalled = true;
      return { message: { role: 'assistant', content: 'from react' } };
    },
  };

  let canonicalCalled = false;
  const canonicalForTest5: any = {
    runTurn: async () => {
      canonicalCalled = true;
      return { assistantMessage: 'from canonical', trace: { engine: 'agent', agentId: 'default-agent' } };
    },
    streamTurn: async (cmd: any, emit: any) => {
      canonicalCalled = true;
      emit('done', {
        sessionId: cmd.sessionId,
        engine: 'agent',
        agentId: 'default-agent',
        trace: { engine: 'agent', agentId: 'default-agent' },
      });
    },
  };

  const coordinatorWithReact = new JourneyCoordinator(
    { resolveActivation: async () => ({ action: 'CANONICAL' }) } as any,
    canonicalForTest5,
    new LegacyJourneyAdapter(),
    new ConfigLoader(),
    dummyReactAgent
  );

  const resChat = await coordinatorWithReact.executeChat({ tenantId: 'test-tenant', message: 'Hi' });
  if (reactAgentCalled || !canonicalCalled) {
    throw new Error('Test 5 failed: Default behavior must route to canonical runtime, not bypass to ReAct agent');
  }
  if ((resChat as any).engine !== 'agent') {
    throw new Error(`Test 5 failed: Expected engine="agent", got "${(resChat as any).engine}"`);
  }
  console.log('  ✅ PASS: Default behavior routes through canonical runtime and does not bypass to ReAct agent');

  // Test 6: Migrated tenants with agent mode report engine=agent and agentId across fixture tenants
  const fixtureTenants = [
    { tenantId: 'placemakers', agentId: 'placemakers_trade_consultant', type: 'building-materials quote tenant' },
    { tenantId: 'abercrombie', agentId: 'cart_assistant', type: 'apparel cart tenant' },
  ];

  for (const fixture of fixtureTenants) {
    let streamedDone: any = null;
    const fixtureCanonical: any = {
      runTurn: async () => ({
        assistantMessage: `Hello from ${fixture.tenantId}`,
        trace: { engine: 'agent', agentId: fixture.agentId, agentMode: true },
      }),
      streamTurn: async (cmd: any, emit: any) => {
        emit('data', { sessionId: cmd.sessionId, engine: 'agent', agentId: fixture.agentId });
        emit('done', {
          sessionId: cmd.sessionId,
          engine: 'agent',
          agentId: fixture.agentId,
          trace: { engine: 'agent', agentId: fixture.agentId },
          response: `Stream from ${fixture.tenantId}`,
        });
      },
    };

    const fixtureCoordinator = new JourneyCoordinator(
      { resolveActivation: async () => ({ action: 'CANONICAL' }) } as any,
      fixtureCanonical,
      new LegacyJourneyAdapter(),
      new ConfigLoader()
    );

    // Test buffered executeChat
    const turnRes = await fixtureCoordinator.executeChat({ tenantId: fixture.tenantId, message: 'Looking for items' });
    if ((turnRes as any).engine !== 'agent') {
      throw new Error(`Test 6 failed for ${fixture.type} (${fixture.tenantId}): Expected engine="agent", got "${(turnRes as any).engine}"`);
    }
    if ((turnRes as any).agentId !== fixture.agentId) {
      throw new Error(`Test 6 failed for ${fixture.type}: Expected agentId="${fixture.agentId}", got "${(turnRes as any).agentId}"`);
    }

    // Test executeChatStream
    await fixtureCoordinator.executeChatStream(
      { tenantId: fixture.tenantId, message: 'Streaming query' },
      (ev, data) => {
        if (ev === 'done') streamedDone = data;
      }
    );

    if (!streamedDone || streamedDone.engine !== 'agent') {
      throw new Error(`Test 6 streaming failed for ${fixture.type}: Expected done.engine="agent", got "${streamedDone?.engine}"`);
    }
    if (streamedDone.agentId !== fixture.agentId) {
      throw new Error(`Test 6 streaming failed for ${fixture.type}: Expected done.agentId="${fixture.agentId}", got "${streamedDone?.agentId}"`);
    }
    console.log(`  ✅ PASS: Fixture tenant ${fixture.tenantId} (${fixture.type}) correctly reports engine=agent and agentId=${fixture.agentId}`);
  }

  // Test 7: Rollback flag ENABLE_REACT_AGENT=true routes to react and reports engine=react
  process.env.ENABLE_REACT_AGENT = 'true';
  let rollbackReactCalled = false;
  const rollbackReactAgent: any = {
    executeAgentTurnStream: async (req: any, emit?: any) => {
      rollbackReactCalled = true;
      if (emit) {
        emit('done', { sessionId: req.sessionId, message: { content: 'from react stream' } });
      }
      return { message: { role: 'assistant', content: 'from react' } };
    },
  };

  const rollbackCoordinator = new JourneyCoordinator(
    { resolveActivation: async () => ({ action: 'CANONICAL' }) } as any,
    canonicalForTest5,
    new LegacyJourneyAdapter(),
    new ConfigLoader(),
    rollbackReactAgent
  );

  const rollbackRes = await rollbackCoordinator.executeChat({ tenantId: 'test-tenant', message: 'Hi' });
  if (!rollbackReactCalled || (rollbackRes as any).engine !== 'react') {
    throw new Error('Test 7 failed: Rollback flag ENABLE_REACT_AGENT=true must route to react engine');
  }

  let rollbackStreamDone: any = null;
  await rollbackCoordinator.executeChatStream({ tenantId: 'test-tenant', message: 'Hi' }, (ev, data) => {
    if (ev === 'done') rollbackStreamDone = data;
  });
  if (rollbackStreamDone?.engine !== 'react') {
    throw new Error(`Test 7 streaming failed: Expected engine="react", got "${rollbackStreamDone?.engine}"`);
  }
  console.log('  ✅ PASS: Rollback flag ENABLE_REACT_AGENT=true routes to react and emits engine=react');

  // Restore env
  if (previousEnv !== undefined) {
    process.env.ENABLE_REACT_AGENT = previousEnv;
  } else {
    delete process.env.ENABLE_REACT_AGENT;
  }

  console.log('🎉 ALL JOURNEY COORDINATOR TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ JourneyCoordinator tests failed:', err);
  process.exit(1);
});
