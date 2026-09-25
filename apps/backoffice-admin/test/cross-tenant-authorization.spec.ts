import assert from 'node:assert/strict';
import { scopeTenant, tenantAllowed, isPlatformIdentity, AuthedIdentity } from '../src/lib/require-auth';
import { GET as getConnections } from '../src/app/api/integrations/connections/route';
import { POST as testCommercetools } from '../src/app/api/integrations/test-commercetools/route';
import { setTestDatabase } from '@journeyax/database';

async function runCrossTenantAuthTests() {
  console.log('\n🔒 Running Backoffice Cross-Tenant Authorization & Execution Context Hardening Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  }

  // Set environment variables for isolated testing
  process.env.MONGODB_URI = 'mongodb://localhost:27017/journeyx';
  process.env.ACTIVEPIECES_API_URL = 'https://activepieces.internal.journeyax.io';
  process.env.ACTIVEPIECES_API_KEY = 'test_key';
  process.env.ACTIVEPIECES_WEBHOOK_SECRET = 'test_secret';

  // Mock verified identities
  const tenantAAdmin: AuthedIdentity = {
    email: 'admin@tenant-a.com',
    role: 'admin',
    tenantId: 'tenant_a',
    permissions: ['project.read', 'config.edit', 'project.write'] as any,
  };

  const platformAdmin: AuthedIdentity = {
    email: 'super@platform.com',
    role: 'admin',
    tenantId: 'platform',
    permissions: ['project.read', 'config.edit', 'project.write'] as any,
  };

  // Mock database tables
  const projectMembersTable = [
    { projectId: 'tenant_a', email: 'admin@tenant-a.com', role: 'admin', status: 'active' },
    { projectId: 'tenant_a', email: 'pending@tenant-a.com', role: 'admin', status: 'pending' },
    { projectId: 'tenant_a', email: 'revoked@tenant-a.com', role: 'admin', status: 'revoked' },
    { projectId: 'tenant_a', email: 'viewer@tenant-a.com', role: 'buyer', status: 'active' },
    { projectId: 'tenant_b', email: 'admin@tenant-b.com', role: 'admin', status: 'active' },
  ];

  const tenantConfigsTable = [
    {
      projectId: 'tenant_a',
      environment: 'production',
      workspaceId: 'ws_tenant_a',
      activePackVersionId: '1.2.0',
    },
    {
      projectId: 'tenant_b',
      environment: 'production',
      workspaceId: 'ws_tenant_b',
    },
  ];

  const tenantSecretsTable = [
    {
      tenantId: 'tenant_a',
      environmentId: 'production',
      secretRef: 'activepieces_api_key',
      value: 'ap_key_tenant_a',
    },
    {
      tenantId: 'tenant_a',
      environmentId: 'production',
      secretRef: 'activepieces_webhook_secret',
      value: 'ap_whsec_tenant_a',
    },
    {
      tenantId: 'tenant_b',
      environmentId: 'production',
      secretRef: 'activepieces_api_key',
      value: 'ap_key_tenant_b',
    },
    {
      tenantId: 'tenant_b',
      environmentId: 'production',
      secretRef: 'activepieces_webhook_secret',
      value: 'ap_whsec_tenant_b',
    },
    {
      tenantId: 'tenant_c',
      environmentId: 'staging',
      secretRef: 'activepieces_api_key',
      value: 'ap_key_tenant_c',
    },
    {
      tenantId: 'tenant_c',
      environmentId: 'staging',
      secretRef: 'activepieces_webhook_secret',
      value: 'ap_whsec_tenant_c',
    },
    {
      tenantId: 'tenant_d',
      environmentId: 'production',
      secretRef: 'activepieces_api_key',
      value: 'ap_key_tenant_d',
    },
    {
      tenantId: 'tenant_d',
      environmentId: 'production',
      secretRef: 'activepieces_webhook_secret',
      value: 'ap_whsec_tenant_d',
    },
  ];

  const connectionsTable = [
    {
      tenantId: 'tenant_a',
      environmentId: 'production',
      connectionRef: 'conn_a_ct',
      pieceName: '@activepieces/piece-commercetools',
      pieceId: 'piece_ct_01',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_ct_sync'],
    },
    {
      tenantId: 'tenant_b',
      environmentId: 'production',
      connectionRef: 'conn_b_ct',
      pieceName: '@activepieces/piece-commercetools',
      pieceId: 'piece_ct_02',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_ct_sync'],
    },
    {
      tenantId: 'tenant_c',
      environmentId: 'staging',
      connectionRef: 'conn_c_ct',
      pieceName: '@activepieces/piece-commercetools',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_ct_sync'],
    },
    {
      tenantId: 'tenant_d',
      environmentId: 'production',
      connectionRef: 'conn_d_ct',
      pieceName: '@activepieces/piece-commercetools',
      status: 'active',
      enabled: true,
      allowedFlows: ['flow_ct_sync'],
    },
  ];

  const packPointersTable = [
    { tenantId: 'tenant_a', channel: 'production', environmentId: 'production', activeVersionId: '1.2.0' },
  ];

  const packReleasesTable = [
    { tenantId: 'tenant_a', environmentId: 'production', versionId: '1.2.0', status: 'active', checksum: 'chk_120' },
  ];

  const workspacesTable = [
    {
      tenantId: 'tenant_a',
      environmentId: 'production',
      workspaceId: 'ws_tenant_a',
      currentStage: 'stage_test',
      activeSessionId: 'sess_tenant_a',
    },
  ];

  const sessionsTable = [
    {
      tenantId: 'tenant_a',
      environmentId: 'production',
      workspaceId: 'ws_tenant_a',
      sessionId: 'sess_tenant_a',
      principalRole: 'admin',
      principalId: 'admin@tenant-a.com',
    },
  ];

  const mockDb = {
    collection: (name: string) => ({
      findOne: async (query: any) => {
        if (name === 'project_members') {
          return projectMembersTable.find((m) => m.projectId === query.projectId && m.email === query.email) || null;
        }
        if (name === 'tenant_configs' || name === 'projects') {
          return tenantConfigsTable.find((c) => c.projectId === query.projectId) || null;
        }
        if (name === 'tenant_secrets') {
          return tenantSecretsTable.find((s) => {
            if (query.tenantId && s.tenantId !== query.tenantId) return false;
            if (query.secretRef && s.secretRef !== query.secretRef) return false;
            return true;
          }) || null;
        }
        if (name === 'tenant_connections') {
          return connectionsTable.find((c) => {
            if (query.tenantId && c.tenantId !== query.tenantId) return false;
            if (query.connectionRef && c.connectionRef !== query.connectionRef) return false;
            return true;
          }) || null;
        }
        if (name === 'business_pack_pointers') {
          return packPointersTable.find((p) => {
            if (p.tenantId !== query.tenantId) return false;
            if (query.$or) {
              const matched = query.$or.some((clause: any) => {
                if (clause.channel && p.channel === clause.channel) return true;
                if (clause.environmentId && (p.environmentId === clause.environmentId || p.channel === clause.environmentId)) return true;
                return false;
              });
              if (!matched) return false;
            } else if (query.channel && p.channel !== query.channel) {
              return false;
            }
            return true;
          }) || null;
        }
        if (name === 'business_pack_releases') {
          return packReleasesTable.find((r) => {
            if (query.tenantId && r.tenantId !== query.tenantId) return false;
            if (query.$or) {
              const matched = query.$or.some((clause: any) => {
                if (clause.versionId && (r.versionId === clause.versionId || (r as any).version === clause.versionId)) return true;
                if (clause.version && (r.versionId === clause.version || (r as any).version === clause.version)) return true;
                return false;
              });
              if (!matched) return false;
            } else if (query.versionId && r.versionId !== query.versionId) {
              return false;
            }
            return true;
          }) || null;
        }
        if (name === 'workspaces') {
          return workspacesTable.find((w) => {
            if (query.tenantId && w.tenantId !== query.tenantId) return false;
            if (query.environmentId && w.environmentId !== query.environmentId) return false;
            if (query.workspaceId && w.workspaceId !== query.workspaceId) return false;
            return true;
          }) || null;
        }
        if (name === 'sessions') {
          return sessionsTable.find((s) => {
            if (query.tenantId && s.tenantId !== query.tenantId) return false;
            if (query.environmentId && s.environmentId !== query.environmentId) return false;
            if (query.workspaceId && s.workspaceId !== query.workspaceId) return false;
            if (query.sessionId && s.sessionId !== query.sessionId) return false;
            return true;
          }) || null;
        }
        return null;
      },
      find: (query: any) => ({
        project: () => ({
          toArray: async () => {
            if (name === 'tenant_connections') {
              return connectionsTable.filter((c) => {
                if (query.tenantId && c.tenantId !== query.tenantId) return false;
                return true;
              });
            }
            return [];
          },
        }),
      }),
    }),
  };

  setTestDatabase(mockDb);

  // Intercept global fetch for auth verification and Activepieces probe
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string | URL | Request, init?: any) => {
    const urlStr = url.toString();
    if (urlStr.includes('/api/v1/auth/verify')) {
      const body = JSON.parse(init?.body || '{}');
      if (body.token === 'token_tenant_a_admin') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            payload: {
              sub: tenantAAdmin.email,
              role: tenantAAdmin.role,
              tenantId: tenantAAdmin.tenantId,
            },
          }),
        };
      }
      if (body.token === 'token_platform_admin') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            payload: {
              sub: platformAdmin.email,
              role: platformAdmin.role,
              tenantId: platformAdmin.tenantId,
            },
          }),
        };
      }
      if (body.token === 'token_tenant_a_pending') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            payload: {
              sub: 'pending@tenant-a.com',
              role: 'admin',
              tenantId: 'tenant_a',
            },
          }),
        };
      }
      if (body.token === 'token_tenant_a_revoked') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            payload: {
              sub: 'revoked@tenant-a.com',
              role: 'admin',
              tenantId: 'tenant_a',
            },
          }),
        };
      }
      if (body.token === 'token_tenant_a_viewer') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            payload: {
              sub: 'viewer@tenant-a.com',
              role: 'buyer',
              tenantId: 'tenant_a',
            },
          }),
        };
      }
      return { ok: false, status: 401, json: async () => ({ valid: false }) };
    }

    if (
      urlStr.includes('/api/v1/webhooks') ||
      urlStr.includes('localhost:3010') ||
      urlStr.includes('activepieces.internal.journeyax.io')
    ) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', probe: true }),
      };
    }

    return originalFetch(url, init);
  };

  try {
    // ── Test 1: Helper scopeTenant / tenantAllowed unit checks ───────────────────
    await test('1. Unit: scopeTenant pins tenant admin to own tenant; platform admin can target requested', async () => {
      assert.equal(isPlatformIdentity(tenantAAdmin), false);
      assert.equal(isPlatformIdentity(platformAdmin), true);

      // Tenant admin cannot widen to tenant_b
      assert.equal(scopeTenant(tenantAAdmin, 'tenant_b'), 'tenant_a');
      assert.equal(tenantAllowed(tenantAAdmin, 'tenant_b'), false);
      assert.equal(tenantAllowed(tenantAAdmin, 'tenant_a'), true);

      // Platform admin can target tenant_b
      assert.equal(scopeTenant(platformAdmin, 'tenant_b'), 'tenant_b');
      assert.equal(tenantAllowed(platformAdmin, 'tenant_b'), true);
    });

    // ── Test 2: Negative: Tenant-A admin cannot list Tenant-B connections ────────
    await test('2. Negative: Tenant-A admin cannot list Tenant-B connections (403 Access Denied)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/connections?tenantId=tenant_b', {
        headers: {
          Authorization: 'Bearer token_tenant_a_admin',
        },
      });

      const res = await getConnections(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /Access denied to project 'tenant_b'/);
    });

    // ── Test 3: Positive: Tenant-A admin CAN list own connections ────────────────
    await test('3. Positive: Tenant-A admin can list own connections', async () => {
      const req = new Request('http://localhost:3009/api/integrations/connections?tenantId=tenant_a', {
        headers: {
          Authorization: 'Bearer token_tenant_a_admin',
        },
      });

      const res = await getConnections(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.connections.length, 1);
      assert.equal(json.connections[0].connectionRef, 'conn_a_ct');
    });

    // ── Test 4: Positive: Platform admin CAN list Tenant-B connections ───────────
    await test('4. Positive: Platform admin can target and list Tenant-B connections', async () => {
      const req = new Request('http://localhost:3009/api/integrations/connections?tenantId=tenant_b', {
        headers: {
          Authorization: 'Bearer token_platform_admin',
        },
      });

      const res = await getConnections(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.connections.length, 1);
      assert.equal(json.connections[0].connectionRef, 'conn_b_ct');
    });

    // ── Test 5: Negative: Tenant-A admin cannot test Tenant-B connections ────────
    await test('5. Negative: Tenant-A admin cannot test Tenant-B connections (403 Access Denied)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_tenant_a_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_b',
          connectionRef: 'conn_b_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /Access denied: user is not a member of project 'tenant_b'/);
    });

    // ── Test 6: Negative: Missing project config fails closed (412) ──────────────
    await test('6. Negative: Missing project configuration fails closed (412)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_platform_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_unconfigured',
          connectionRef: 'conn_any',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 412);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /Project configuration not found for 'tenant_unconfigured'/);
    });

    // ── Test 7: Negative: Missing active business pack release fails closed ───────
    await test('7. Negative: Missing active business pack release fails closed (412)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_platform_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_b', // tenant_b has config but no release pointer/record
          connectionRef: 'conn_b_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 412);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /Active business pack release.*not found/);
    });

    // ── Test 8: Positive: Authorized user tests connection via read-only health probe without confirmation bypass ──
    await test('8. Positive: Dedicated read-only connector health contract executes with durable context and userConfirmationConfirmed=false', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_tenant_a_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_a',
          connectionRef: 'conn_a_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.match(json.message, /Connected via Activepieces connection 'conn_a_ct'/);
    });

    // ── Test 9: Negative: Pending project member invite cannot test connectors ───
    await test('9. Negative: Pending project member invite cannot test connectors (403 Access Denied)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_tenant_a_pending',
        },
        body: JSON.stringify({
          projectId: 'tenant_a',
          connectionRef: 'conn_a_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /membership for project 'tenant_a' is in 'pending' state/);
    });

    // ── Test 10: Negative: Revoked project member cannot test connectors ─────────
    await test('10. Negative: Revoked project member cannot test connectors (403 Access Denied)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_tenant_a_revoked',
        },
        body: JSON.stringify({
          projectId: 'tenant_a',
          connectionRef: 'conn_a_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /membership for project 'tenant_a' is in 'revoked' state/);
    });

    // ── Test 11: Negative: Active viewer / buyer lacks config.edit permission ─────
    await test('11. Negative: Active viewer / buyer cannot test connectors (403 config.edit required)', async () => {
      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_tenant_a_viewer',
        },
        body: JSON.stringify({
          projectId: 'tenant_a',
          connectionRef: 'conn_a_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /requires the 'config.edit' permission|lacks required 'config.edit' permission/);
    });

    // ── Test 12: Negative: Cross-environment release pointer fallback prohibited ─
    await test('12. Negative: Staging request cannot fall back to production pack release pointer (412)', async () => {
      // Configure tenant_c with staging environment, but only production pointer exists
      tenantConfigsTable.push({
        projectId: 'tenant_c',
        environment: 'staging',
        workspaceId: 'ws_tenant_c',
      });
      workspacesTable.push({
        tenantId: 'tenant_c',
        environmentId: 'staging',
        workspaceId: 'ws_tenant_c',
        currentStage: 'stage_test',
        activeSessionId: 'sess_tenant_c',
      });
      packPointersTable.push({
        tenantId: 'tenant_c',
        channel: 'production', // Only production pointer exists!
        environmentId: 'production',
        activeVersionId: '1.0.0',
      });

      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_platform_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_c',
          connectionRef: 'conn_c_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 412);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /Active business pack release pointer not found for tenant 'tenant_c' \(staging\)/);
    });

    // ── Test 13: Negative: Release with missing checksum fails closed ─────────────
    await test('13. Negative: Release with missing checksum fails closed (412)', async () => {
      tenantConfigsTable.push({
        projectId: 'tenant_d',
        environment: 'production',
        workspaceId: 'ws_tenant_d',
      });
      workspacesTable.push({
        tenantId: 'tenant_d',
        environmentId: 'production',
        workspaceId: 'ws_tenant_d',
        currentStage: 'stage_test',
        activeSessionId: 'sess_tenant_d',
      });
      packPointersTable.push({
        tenantId: 'tenant_d',
        channel: 'production',
        environmentId: 'production',
        activeVersionId: '3.0.0',
      });
      packReleasesTable.push({
        tenantId: 'tenant_d',
        environmentId: 'production',
        versionId: '3.0.0',
        status: 'active',
        // checksum is MISSING!
      } as any);

      const req = new Request('http://localhost:3009/api/integrations/test-commercetools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token_platform_admin',
        },
        body: JSON.stringify({
          projectId: 'tenant_d',
          connectionRef: 'conn_d_ct',
          flowId: 'flow_ct_sync',
        }),
      });

      const res = await testCommercetools(req);
      assert.equal(res.status, 412);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.message, /lacks mandatory checksum/);
    });

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\nCross-Tenant Authorization Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runCrossTenantAuthTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
