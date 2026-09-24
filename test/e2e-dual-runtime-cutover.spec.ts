import assert from 'node:assert/strict';
import {
  CutoverRepository,
  signGatewayAssertion,
  verifyGatewayAssertion,
  InMemoryReplayStore,
  COLLECTION_TENANT_CUTOVERS,
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_BUSINESS_PACK_POINTERS,
  COLLECTION_CUTOVER_AUDIT_LOGS,
} from '@journeyax/database';
import {
  resolveTenantRouting,
  calculateCanaryBucket,
  computeCanaryBucket,
} from '../apps/journeyax-web/src/lib/routing/cutover';
import { CapabilityDispatcher } from '@journeyax/capability-sdk';
import { ToolDefinition, ToolBinding } from '@journeyax/business-pack';

/**
 * Agent 5: Dual-Runtime Verification & End-to-End Cutover Test Suite
 * Proves concurrent operation of legacy Caroma and modern domain-neutral Journey Runtime.
 */
async function runDualRuntimeVerificationTests() {
  console.log('🧪 Starting Agent 5: End-to-End Dual-Runtime & Cutover Verification Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      failed++;
    }
  }

  // Set up in-memory collections for end-to-end mock DB
  const cutovers: any[] = [];
  const releases: any[] = [];
  const pointers: any[] = [];
  const auditLogs: any[] = [];
  const secrets: any[] = [
    { tenantId: 'workwear_intl', secretRef: 'activepieces_crm_key', value: 'sec_ap_crm_token_999' },
  ];

  const mockDb: any = {
    collection: (name: string) => {
      if (name === COLLECTION_TENANT_CUTOVERS) {
        return {
          findOne: async (query: any) =>
            cutovers.find(
              (c) =>
                c.tenantId === query.tenantId &&
                (!query.environmentId || c.environmentId === query.environmentId)
            ) || null,
          updateOne: async (query: any, update: any) => {
            const item = cutovers.find(
              (c) => c.tenantId === query.tenantId && c.environmentId === query.environmentId
            );
            if (!item) return { matchedCount: 0, modifiedCount: 0 };
            if (query.revision !== undefined && item.revision !== query.revision) {
              return { matchedCount: 0, modifiedCount: 0 };
            }
            if (update.$set) Object.assign(item, update.$set);
            if (update.$inc?.revision) item.revision = (item.revision || 1) + update.$inc.revision;
            return { matchedCount: 1, modifiedCount: 1 };
          },
          insertOne: async (doc: any) => {
            cutovers.push({ ...doc, revision: doc.revision || 1 });
            return { acknowledged: true };
          },
        };
      }
      if (name === COLLECTION_BUSINESS_PACK_RELEASES) {
        return {
          findOne: async (query: any) => {
            const v = query.version || query.$or?.[0]?.version || query.$or?.[1]?.['manifest.version'];
            return (
              releases.find(
                (r) =>
                  r.tenantId === query.tenantId &&
                  r.environmentId === query.environmentId &&
                  (!v || r.version === v)
              ) || null
            );
          },
        };
      }
      if (name === COLLECTION_BUSINESS_PACK_POINTERS) {
        return {
          findOne: async (query: any) =>
            pointers.find(
              (p) => p.tenantId === query.tenantId && p.environmentId === query.environmentId
            ) || null,
        };
      }
      if (name === COLLECTION_CUTOVER_AUDIT_LOGS) {
        return {
          insertOne: async (doc: any) => {
            auditLogs.push(doc);
            return { acknowledged: true };
          },
        };
      }
      if (name === 'tenant_secrets') {
        return {
          findOne: async (query: any) =>
            secrets.find((s) => s.tenantId === query.tenantId && s.secretRef === query.secretRef) ||
            null,
        };
      }
      return {
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
      };
    },
  };

  const mockDbClient: any = {
    startSession: () => ({
      withTransaction: async (fn: any) => fn(),
      endSession: async () => {},
    }),
  };

  const cutoverRepo = new CutoverRepository(async () => ({ db: mockDb, client: mockDbClient }));

  // Seed modern Business Pack release for 'workwear_intl'
  const workwearChecksum = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  releases.push({
    tenantId: 'workwear_intl',
    environmentId: 'production',
    version: '1.0.0',
    checksum: workwearChecksum,
    businessPack: {
      packId: 'workwear_pack',
      version: '1.0.0',
      tenantId: 'workwear_intl',
      environmentId: 'production',
      journeys: {
        journey_1: {
          journeyId: 'journey_1',
          name: 'Workwear Uniform Outfitter',
          initialStageId: 'select_gear',
          stages: {
            select_gear: {
              stageId: 'select_gear',
              displayName: 'Select Gear',
              allowedTools: ['catalog.search'],
              transitions: [],
            },
          },
        },
      },
    },
  });

  pointers.push({
    tenantId: 'workwear_intl',
    environmentId: 'production',
    activeReleaseVersion: '1.0.0',
    activeReleaseChecksum: workwearChecksum,
  });

  // Seed initial cutover record for 'workwear_intl' (100% migrated)
  cutovers.push({
    tenantId: 'workwear_intl',
    environmentId: 'production',
    status: 'migrated',
    approvedReleaseVersion: '1.0.0',
    approvedReleaseChecksum: workwearChecksum,
    revision: 1,
    approvedBy: 'lead_architect',
    promotedAt: new Date(),
    updatedAt: new Date(),
  });

  // Test 1: Caroma storefront request routes to legacy runtime
  await test('SCENARIO 1: Caroma (legacy tenant) routes to legacy runtime with zero disruption', async () => {
    // Intercept fetch so gateway call returns 404 for unmigrated Caroma
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (url.includes('/caroma/')) {
        return { ok: false, status: 404 } as any;
      }
      return { ok: true, status: 200 } as any;
    };

    try {
      const decision = await resolveTenantRouting('caroma', 'production', {
        workspaceId: 'caroma_ws_1',
      });
      assert.equal(decision.useRuntime, false, 'Caroma must not use journey-runtime');
      assert.equal(decision.cutoverState, 'unmigrated');
      assert.ok(decision.reason.includes('retaining legacy commerce') || decision.reason.includes('unmigrated'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Test 2: Migrated tenant storefront request routes to journey-runtime-service
  await test('SCENARIO 2: Migrated tenant (workwear_intl) routes to journey-runtime-service', async () => {
    // Intercept fetch so gateway cutover endpoint returns workwear_intl record
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (url.includes('/workwear_intl/')) {
        return {
          ok: true,
          status: 200,
          json: async () => cutovers.find((c) => c.tenantId === 'workwear_intl'),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    };

    try {
      const decision = await resolveTenantRouting('workwear_intl', 'production', {
        workspaceId: 'workspace_client_1',
      });
      assert.equal(decision.useRuntime, true, 'workwear_intl must use journey-runtime');
      assert.equal(decision.cutoverState, 'migrated');
      assert.ok(decision.reason.includes('Authoritative durable cutover record verified'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Test 3: Deterministic Canary Routing splits traffic accurately
  await test('SCENARIO 3: Canary routing splits traffic deterministically with stable workspace bucketing', async () => {
    // Single workspace calculation must be completely stable
    const bucket1 = calculateCanaryBucket('canary_tenant', 'production', 'fixed_workspace_alpha');
    const bucket2 = calculateCanaryBucket('canary_tenant', 'production', 'fixed_workspace_alpha');
    assert.equal(bucket1, bucket2, 'Canary bucket for same workspace must be 100% deterministic');

    // Across 100 different workspaces, hash values distribute across 0-99
    const buckets = new Set<number>();
    for (let i = 0; i < 100; i++) {
      buckets.add(calculateCanaryBucket('canary_tenant', 'production', `ws_id_${i}`));
    }
    assert.ok(buckets.size > 20, 'Buckets must distribute across the range 0-99');

    // Test routing decision under canary status
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tenantId: 'canary_tenant',
        environmentId: 'production',
        status: 'canary',
        canaryPercentage: 50,
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: workwearChecksum,
        revision: 1,
      }),
    } as any);

    try {
      let routedToRuntime = 0;
      let routedToLegacy = 0;
      for (let i = 0; i < 50; i++) {
        const dec = await resolveTenantRouting('canary_tenant', 'production', {
          workspaceId: `test_ws_${i}`,
        });
        if (dec.useRuntime) routedToRuntime++;
        else routedToLegacy++;
      }
      assert.ok(routedToRuntime > 0, 'Some canary workspaces must route to runtime');
      assert.ok(routedToLegacy > 0, 'Some canary workspaces must route to legacy');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Test 4: Cutover CAS flip shifts traffic immediately
  await test('SCENARIO 4: Transactional cutover CAS flip shifts traffic immediately with audit history', async () => {
    // Promote cutover from revision 1 to revision 2
    const promoted = await cutoverRepo.promoteCutover('workwear_intl', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: workwearChecksum,
      approvedBy: 'lead_architect',
      expectedRevision: 1, // must match current revision
      notes: 'Full production migration verification',
    });

    assert.equal(promoted.revision, 2);
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].newStatus, 'migrated');
    assert.equal(auditLogs[0].newRevision, 2);

    // Conflict error when revision does not match
    await assert.rejects(
      async () => {
        await cutoverRepo.promoteCutover('workwear_intl', 'production', {
          status: 'migrated',
          approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: workwearChecksum,
          approvedBy: 'stale_caller',
          expectedRevision: 1, // Stale! Revision is now 2
        });
      },
      /CutoverConflictError/
    );
  });

  // Test 5: Instant Rollback returns traffic to legacy
  await test('SCENARIO 5: Instant rollback returns traffic immediately to legacy path', async () => {
    const rolledBack = await cutoverRepo.promoteCutover('workwear_intl', 'production', {
      status: 'rollback',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: workwearChecksum,
      approvedBy: 'sre_oncall',
      rollbackTargetVersion: 'legacy',
      expectedRevision: 2,
      notes: 'Emergency rollback drill',
    });

    assert.equal(rolledBack.revision, 3);
    assert.equal(rolledBack.status, 'rollback');

    // Intercept fetch so routing resolver sees rollback record
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => rolledBack,
    } as any);

    try {
      const decision = await resolveTenantRouting('workwear_intl', 'production', {
        workspaceId: 'any_workspace',
      });
      assert.equal(decision.useRuntime, false, 'Rollback status must disable runtime');
      assert.equal(decision.cutoverState, 'rollback');
      assert.ok(decision.reason.includes('Durable rollback active'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Test 6: Capability execution resolves secret reference without leaking credentials
  await test('SCENARIO 6: Activepieces capability dispatcher resolves secretRef and executes securely', async () => {
    const dispatcher = new CapabilityDispatcher({
      activepiecesApiUrl: 'http://activepieces-flow.internal',
      activepiecesApiKey: 'mock_activepieces_master_key',
      getTenantSecret: async (tenantId: string, secretRef: string) => {
        const doc = secrets.find((s) => s.tenantId === tenantId && s.secretRef === secretRef);
        return doc ? doc.value : null;
      },
    });

    const toolDef: ToolDefinition = {
      toolId: 'catalog.search',
      version: '1.0.0',
      displayName: 'Catalog Search',
      description: 'Search product catalog',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object' },
      sideEffect: 'read',
      risk: 'low',
    };

    const binding: ToolBinding = {
      toolId: 'catalog.search',
      tenantId: 'workwear_intl',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_search_catalog',
        connectionRef: 'activepieces_crm_key',
      },
    };

    // Intercept fetch for Activepieces flow execution
    const origFetch = globalThis.fetch;
    let authHeaderValue = '';
    let connSecretValue = '';
    globalThis.fetch = async (url: any, init: any) => {
      authHeaderValue = init.headers?.['Authorization'] || init.headers?.['x-api-key'] || '';
      connSecretValue = init.headers?.['X-Connection-Secret'] || '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ products: [{ sku: 'BOOT-001', name: 'Steel Cap Boot' }] }),
      } as any;
    };

    try {
      const result = await dispatcher.dispatch(
        toolDef,
        binding,
        {
          executionId: 'exec_777',
          toolId: 'catalog.search',
          input: { query: 'boots' },
          idempotencyKey: 'idemp_key_777',
        },
        {
          tenantId: 'workwear_intl',
          environmentId: 'production',
          workspaceId: 'ws_alpha',
          correlationId: 'corr_777',
        }
      );

      assert.equal(result.status, 'success');
      assert.ok(authHeaderValue.includes('mock_activepieces_master_key'));
      assert.ok(connSecretValue.includes('sec_ap_crm_token_999'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Test 7: Gateway assertion authentication contract & replay prevention
  await test('SCENARIO 7: Gateway assertion signs contract and prevents replay attacks', async () => {
    const secret = 'super_secret_gateway_signing_key_at_least_32_chars';
    const replayStore = new InMemoryReplayStore();

    const token = signGatewayAssertion(
      {
        tenantId: 'workwear_intl',
        environmentId: 'production',
        sub: 'usr_architect_1',
        role: 'admin',
      },
      secret
    );

    // 1. First verification succeeds
    const payload = verifyGatewayAssertion(token, secret, {
      expectedTenantId: 'workwear_intl',
      expectedEnvironmentId: 'production',
    });
    assert.equal(payload.tenantId, 'workwear_intl');
    assert.equal(payload.role, 'admin');

    const firstClaim = await replayStore.claim(
      payload.jti,
      payload.tenantId,
      payload.environmentId,
      new Date(payload.exp * 1000)
    );
    assert.equal(firstClaim, 'success');

    // 2. Second verification with same jti is detected as replay attack
    const secondClaim = await replayStore.claim(
      payload.jti,
      payload.tenantId,
      payload.environmentId,
      new Date(payload.exp * 1000)
    );
    assert.equal(secondClaim, 'already_claimed');

    // 3. Verification with mismatched tenant is rejected
    assert.throws(
      () => {
        verifyGatewayAssertion(token, secret, {
          expectedTenantId: 'different_tenant',
          expectedEnvironmentId: 'production',
        });
      },
      /Tenant binding mismatch/
    );
  });

  console.log(`\n🎉 All Dual-Runtime Integration & Cutover Scenarios Passed: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runDualRuntimeVerificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
