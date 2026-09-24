import assert from 'node:assert/strict';
import { CapabilityDispatcher } from '../src/dispatcher';
import { ToolDefinition, ToolBinding } from '../src/types';

async function runDispatcherTests() {
  console.log('🛡️  Running CapabilityDispatcher Negative & Fail-Closed Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }

  const toolDef: ToolDefinition = {
    toolId: 'catalog.search',
    version: '1.0.0',
    displayName: 'Catalog Search',
    description: 'Search catalog',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    sideEffect: 'read',
    risk: 'low',
  };

  const bindingWithConn: ToolBinding = {
    toolId: 'catalog.search',
    tenantId: 'tenant_acme',
    environmentId: 'production',
    executor: {
      type: 'activepieces_flow',
      flowId: 'flow_search',
      connectionRef: 'conn_secure_token_1',
    } as any,
  };

  const bindingWithoutConn: ToolBinding = {
    toolId: 'catalog.search',
    tenantId: 'tenant_acme',
    environmentId: 'test',
    executor: {
      type: 'activepieces_flow',
      flowId: 'flow_search',
    } as any,
  };

  const execCtx = {
    tenantId: 'tenant_acme',
    environmentId: 'production',
    workspaceId: 'ws_test',
    correlationId: 'corr_test',
  };

  // Mock fetch to return success when reached
  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  (globalThis as any).fetch = async () => {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    };
  };

  try {
    // ── Negative 1: Missing validateConnectionOwnership validator when connectionRef is provided ──
    await test('Negative 1: Missing validateConnectionOwnership validator fails closed when connectionRef is provided', async () => {
      fetchCalled = false;
      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'https://activepieces.internal',
        activepiecesApiKey: 'sec_api_key_valid',
        activepiecesWebhookSecret: 'whsec_secret_valid',
        // validateConnectionOwnership omitted!
      });

      const res = await dispatcher.dispatch(toolDef, bindingWithConn, { toolId: 'catalog.search', input: {} }, execCtx);
      assert.equal(res.status, 'failure');
      assert.ok(res.error?.includes('validateConnectionOwnership validator is mandatory when connectionRef is provided'));
      assert.equal(fetchCalled, false, 'Fetch must never be called on fail-closed validation');
    });

    // ── Negative 2: connectionRef validation fails when validator returns false ──
    await test('Negative 2: validateConnectionOwnership returning false fails closed', async () => {
      fetchCalled = false;
      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'https://activepieces.internal',
        activepiecesApiKey: 'sec_api_key_valid',
        activepiecesWebhookSecret: 'whsec_secret_valid',
        validateConnectionOwnership: async (_tenant, _env, _conn) => false,
      });

      const res = await dispatcher.dispatch(toolDef, bindingWithConn, { toolId: 'catalog.search', input: {} }, execCtx);
      assert.equal(res.status, 'failure');
      assert.ok(res.error?.includes('not owned by tenant'));
      assert.equal(fetchCalled, false, 'Fetch must not be called when connectionRef ownership is rejected');
    });

    // ── Negative 3: connectionRef validator throwing error fails closed ──
    await test('Negative 3: validateConnectionOwnership throwing error fails closed', async () => {
      fetchCalled = false;
      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'https://activepieces.internal',
        activepiecesApiKey: 'sec_api_key_valid',
        activepiecesWebhookSecret: 'whsec_secret_valid',
        validateConnectionOwnership: async () => {
          throw new Error('Connection repository unavailable');
        },
      });

      const res = await dispatcher.dispatch(toolDef, bindingWithConn, { toolId: 'catalog.search', input: {} }, execCtx);
      assert.equal(res.status, 'failure');
      assert.ok(res.error?.includes('connectionRef ownership validation error'));
      assert.equal(fetchCalled, false);
    });

    // ── Negative 4: Invalid connectionRef characters ──
    await test('Negative 4: Invalid connectionRef format fails closed', async () => {
      fetchCalled = false;
      const badBinding: ToolBinding = {
        ...bindingWithConn,
        executor: {
          type: 'activepieces_flow',
          flowId: 'flow_search',
          connectionRef: 'invalid spaces ref!@#$',
        } as any,
      };

      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'https://activepieces.internal',
        activepiecesApiKey: 'sec_api_key_valid',
        activepiecesWebhookSecret: 'whsec_secret_valid',
        validateConnectionOwnership: async () => true,
      });

      const res = await dispatcher.dispatch(toolDef, badBinding, { toolId: 'catalog.search', input: {} }, execCtx);
      assert.equal(res.status, 'failure');
      assert.ok(res.error?.includes('invalid connectionRef'));
      assert.equal(fetchCalled, false);
    });

    // ── Negative 5: Missing explicit Activepieces base URL in production (via environmentId) ──
    await test('Negative 5: Missing explicit Activepieces base URL fails closed when environmentId is production', async () => {
      fetchCalled = false;
      const origEnv = process.env.ACTIVEPIECES_API_URL;
      delete process.env.ACTIVEPIECES_API_URL;

      try {
        const dispatcher = new CapabilityDispatcher({
          activepiecesApiKey: 'sec_api_key_valid',
          activepiecesWebhookSecret: 'whsec_secret_valid',
          validateConnectionOwnership: async () => true,
          // activepiecesApiUrl omitted!
        });

        const res = await dispatcher.dispatch(
          toolDef,
          bindingWithConn,
          { toolId: 'catalog.search', input: {} },
          { ...execCtx, environmentId: 'production' }
        );
        assert.equal(res.status, 'failure');
        assert.ok(res.error?.includes('explicit Activepieces base URL'));
        assert.equal(fetchCalled, false);
      } finally {
        if (origEnv !== undefined) process.env.ACTIVEPIECES_API_URL = origEnv;
      }
    });

    // ── Negative 6: Missing explicit Activepieces base URL in production (via NODE_ENV) ──
    await test('Negative 6: Missing explicit Activepieces base URL fails closed when NODE_ENV is production', async () => {
      fetchCalled = false;
      const origNodeEnv = process.env.NODE_ENV;
      const origUrl = process.env.ACTIVEPIECES_API_URL;
      process.env.NODE_ENV = 'production';
      delete process.env.ACTIVEPIECES_API_URL;

      try {
        const dispatcher = new CapabilityDispatcher({
          activepiecesApiKey: 'sec_api_key_valid',
          activepiecesWebhookSecret: 'whsec_secret_valid',
          validateConnectionOwnership: async () => true,
        });

        const res = await dispatcher.dispatch(
          toolDef,
          bindingWithConn,
          { toolId: 'catalog.search', input: {} },
          { ...execCtx, environmentId: 'staging' }
        );
        assert.equal(res.status, 'failure');
        assert.ok(res.error?.includes('explicit Activepieces base URL'));
        assert.equal(fetchCalled, false);
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origUrl !== undefined) process.env.ACTIVEPIECES_API_URL = origUrl;
      }
    });

    // ── Positive 1: Production succeeds with explicit base URL and valid ownership ──
    await test('Positive 1: Production succeeds with explicit base URL and valid ownership', async () => {
      fetchCalled = false;
      const dispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: 'https://activepieces.corp.internal',
        activepiecesApiKey: 'sec_api_key_valid',
        activepiecesWebhookSecret: 'whsec_secret_valid',
        validateConnectionOwnership: async (tenant, env, conn) => {
          return tenant === 'tenant_acme' && env === 'production' && conn === 'conn_secure_token_1';
        },
      });

      const res = await dispatcher.dispatch(toolDef, bindingWithConn, { toolId: 'catalog.search', input: {} }, execCtx);
      assert.equal(res.status, 'success');
      assert.equal(fetchCalled, true);
    });

    // ── Positive 2: Non-production without connectionRef does not require validator ──
    await test('Positive 2: Non-production without connectionRef allows dispatch without validator', async () => {
      fetchCalled = false;
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        const dispatcher = new CapabilityDispatcher({
          activepiecesApiKey: 'sec_api_key_valid',
          activepiecesWebhookSecret: 'whsec_secret_valid',
          // no validateConnectionOwnership and no explicit base URL (in test env)
        });

        const res = await dispatcher.dispatch(
          toolDef,
          bindingWithoutConn,
          { toolId: 'catalog.search', input: {} },
          { ...execCtx, environmentId: 'test' }
        );
        assert.equal(res.status, 'success');
        assert.equal(fetchCalled, true);
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) process.exit(1);
}

runDispatcherTests().catch((err) => {
  console.error('Fatal dispatcher test error:', err);
  process.exit(1);
});
