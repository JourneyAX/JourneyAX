import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';

async function runTests() {
  console.log('🧪 Running JourneyCoordinator Boundary Test Suite...');

  const canonicalActivation: any = { resolveActivation: async () => ({ action: 'CANONICAL' }) };

  // Test 1: Missing tenantId fails closed
  const coordinator = new JourneyCoordinator(canonicalActivation, { runTurn: async () => ({}), streamTurn: async () => {} } as any);
  try {
    await coordinator.executeChat({ message: 'Hello' });
    throw new Error('Test 1 failed: missing tenantId must throw');
  } catch (err: any) {
    if (!err.message.includes('tenantId is required')) {
      throw err;
    }
  }
  console.log('  ✅ PASS: Missing tenantId fails closed');

  // Test 2: The old ReAct rollback flag is retired: setting it changes nothing, the turn still goes to the canonical runtime
  const previousEnv = process.env.ENABLE_REACT_AGENT;
  process.env.ENABLE_REACT_AGENT = 'true';
  try {
    let canonicalCalled = false;
    const canonical: any = {
      runTurn: async () => {
        canonicalCalled = true;
        return { assistantMessage: 'canonical', trace: { engine: 'agent', agentId: 'a1' } };
      },
      streamTurn: async (cmd: any, emit: any) => {
        canonicalCalled = true;
        emit('done', { sessionId: cmd.sessionId, engine: 'agent' });
      },
    };
    const flagged = new JourneyCoordinator(canonicalActivation, canonical);
    const res = await flagged.executeChat({ tenantId: 'test-tenant', message: 'Hi' });
    let streamedDone: any = null;
    await flagged.executeChatStream({ tenantId: 'test-tenant', message: 'Hi' }, (ev, data) => { if (ev === 'done') streamedDone = data; });
    if (!canonicalCalled || (res as any).engine !== 'agent' || streamedDone?.engine !== 'agent') {
      throw new Error('Test 2 failed: ENABLE_REACT_AGENT=true must not reroute the turn away from the canonical runtime');
    }
  } finally {
    if (previousEnv !== undefined) process.env.ENABLE_REACT_AGENT = previousEnv;
    else delete process.env.ENABLE_REACT_AGENT;
  }
  console.log('  ✅ PASS: The retired ReAct flag changes nothing; the canonical runtime serves the turn');

  // Test 3: Migrated tenants with agent mode report engine=agent and agentId across fixture tenants
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

    const fixtureCoordinator = new JourneyCoordinator(canonicalActivation, fixtureCanonical);

    // Test buffered executeChat
    const turnRes = await fixtureCoordinator.executeChat({ tenantId: fixture.tenantId, message: 'Looking for items' });
    if ((turnRes as any).engine !== 'agent') {
      throw new Error(`Test 3 failed for ${fixture.type} (${fixture.tenantId}): Expected engine="agent", got "${(turnRes as any).engine}"`);
    }
    if ((turnRes as any).agentId !== fixture.agentId) {
      throw new Error(`Test 3 failed for ${fixture.type}: Expected agentId="${fixture.agentId}", got "${(turnRes as any).agentId}"`);
    }

    // Test executeChatStream
    await fixtureCoordinator.executeChatStream(
      { tenantId: fixture.tenantId, message: 'Streaming query' },
      (ev, data) => {
        if (ev === 'done') streamedDone = data;
      }
    );

    if (!streamedDone || streamedDone.engine !== 'agent') {
      throw new Error(`Test 3 streaming failed for ${fixture.type}: Expected done.engine="agent", got "${streamedDone?.engine}"`);
    }
    if (streamedDone.agentId !== fixture.agentId) {
      throw new Error(`Test 3 streaming failed for ${fixture.type}: Expected done.agentId="${fixture.agentId}", got "${streamedDone?.agentId}"`);
    }
    console.log(`  ✅ PASS: Fixture tenant ${fixture.tenantId} (${fixture.type}) correctly reports engine=agent and agentId=${fixture.agentId}`);
  }

  console.log('🎉 ALL JOURNEY COORDINATOR TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ JourneyCoordinator tests failed:', err);
  process.exit(1);
});
