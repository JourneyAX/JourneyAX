// Enforce offline mode BEFORE any module imports
process.env.JOURNEYAX_OFFLINE_HARNESS = 'true';
process.env.NODE_ENV = 'test';
delete process.env.TEST_MONGODB_URI;
delete process.env.MONGODB_URI;

/**
 * architecture-closure.spec.ts
 *
 * Focused tests proving:
 * 1. Dynamic CRM connector selection across tenants without hardcoded tenant conditionals.
 * 2. Strict tenant isolation (tenants cannot cross-access connector bindings; unconfigured tenants fail closed).
 * 3. No filesystem/static fallback after canonical activation (activated tenants fail closed on config load failure).
 */
import assert from 'node:assert/strict';
import { CrmConnectorBindingResolver } from '../apps/lead-service/src/crm-binding-resolver';
import { LeadController } from '../apps/lead-service/src/lead.controller';
import { handleConfigFailure } from '../apps/journeyax-web/src/app/api/config/route';
import { BusinessPackLoader } from '@journeyax/business-pack';

console.log('🧪 Running Architecture Closure Spec...\n');

async function run(): Promise<void> {
  // ── Part 1: Dynamic CRM Connector Selection & Tenant Isolation ────────────
  console.log('1. Testing dynamic CRM connector selection & tenant isolation...');
  {
    // Mock DB with isolated tenant connections
    const mockConnections = [
      {
        tenantId: 'tenant-hubspot-corp',
        provider: 'hubspot',
        pieceName: 'hubspot',
        status: 'active',
        enabled: true,
        connectionRef: 'conn_hs_123',
      },
      {
        tenantId: 'tenant-salesforce-ent',
        provider: 'salesforce',
        pieceName: 'salesforce',
        status: 'active',
        enabled: true,
        connectionRef: 'conn_sf_456',
      },
      {
        tenantId: 'tenant-zoho-intl',
        provider: 'zoho',
        pieceName: 'zoho',
        status: 'active',
        enabled: true,
        connectionRef: 'conn_zh_789',
      },
    ];

    const mockDb = {
      collection: (name: string) => {
        if (name === 'tenant_connections') {
          return {
            findOne: async (query: any) => {
              const tenantId = query.tenantId;
              return mockConnections.find((c) => c.tenantId === tenantId) || null;
            },
          };
        }
        return {
          findOne: async () => null,
        };
      },
    };

    const resolver = new CrmConnectorBindingResolver(() => mockDb);
    const controller = new LeadController(resolver);

    // 1a: Tenant A resolves HubSpot dynamically
    const resA = await controller.pushLead({
      tenantId: 'tenant-hubspot-corp',
      quoteId: 'q-101',
      customerName: 'Alice Johnson',
      customerEmail: 'alice@example.com',
      bom: [],
      totals: { subtotal: 1000, discount: 0, gst: 100, total: 1100 },
    });
    assert.equal(resA.success, true);
    assert.ok(resA.crmUrl.includes('app.hubspot.com'), `Must use HubSpot URL, got ${resA.crmUrl}`);
    assert.ok(resA.message.includes('HUBSPOT CRM'), `Message must name HUBSPOT, got ${resA.message}`);
    assert.equal(resA.bindingSource, 'tenant_connections');

    // 1b: Tenant B resolves Salesforce dynamically
    const resB = await controller.pushLead({
      tenantId: 'tenant-salesforce-ent',
      quoteId: 'q-102',
      customerName: 'Bob Smith',
      customerEmail: 'bob@example.com',
      bom: [],
      totals: { subtotal: 2000, discount: 0, gst: 200, total: 2200 },
    });
    assert.equal(resB.success, true);
    assert.ok(resB.crmUrl.includes('app.salesforce.com'), `Must use Salesforce URL, got ${resB.crmUrl}`);
    assert.ok(resB.message.includes('SALESFORCE CRM'), `Message must name SALESFORCE, got ${resB.message}`);
    assert.equal(resB.bindingSource, 'tenant_connections');

    // 1c: Tenant C resolves Zoho dynamically
    const resC = await controller.pushLead({
      tenantId: 'tenant-zoho-intl',
      quoteId: 'q-103',
      customerName: 'Carol White',
      customerEmail: 'carol@example.com',
      bom: [],
      totals: { subtotal: 3000, discount: 0, gst: 300, total: 3300 },
    });
    assert.equal(resC.success, true);
    assert.ok(resC.crmUrl.includes('app.zoho.com'), `Must use Zoho URL, got ${resC.crmUrl}`);
    assert.ok(resC.message.includes('ZOHO CRM'), `Message must name ZOHO, got ${resC.message}`);

    // 1d: Tenant Isolation — Unconfigured tenant fails closed
    await assert.rejects(
      async () => {
        await controller.pushLead({
          tenantId: 'unconfigured-isolated-tenant',
          quoteId: 'q-999',
          customerName: 'Eve Rogue',
          customerEmail: 'eve@example.com',
          bom: [],
          totals: { subtotal: 500, discount: 0, gst: 50, total: 550 },
        });
      },
      /No CRM connector or capability binding configured for tenant 'unconfigured-isolated-tenant'/i,
      'Unconfigured tenant must fail closed with 400 BadRequestException'
    );

    // 1e: Tenant Isolation — Tenant A cannot access Tenant B's credentials/binding
    const resolvedForA = await resolver.resolveCrmBinding('tenant-hubspot-corp');
    assert.equal(resolvedForA.crmDomain, 'hubspot');
    assert.notEqual(resolvedForA.crmDomain, 'salesforce');

    console.log('   ✅ PASS: Dynamic CRM connector selection works correctly across tenants with strict isolation.\n');
  }

  // ── Part 2: Pack-Based Capability Tool Binding Lookup ────────────────────
  console.log('2. Testing Business Pack capability tool binding CRM lookup...');
  {
    // Mock pack loader that returns toolBindings for royalcyber
    const mockLoader = {
      loadFromMongo: async () => null,
      loadFromDisk: async (tenantId: string) => {
        if (tenantId === 'royalcyber-pack-tenant') {
          return {
            manifest: { tenantId, version: '1.0.0' },
            capabilities: {
              toolBindings: [
                {
                  toolId: 'hubspot.create_deal',
                  executor: { type: 'activepieces_flow', connectionRef: 'conn_hubspot' },
                },
              ],
            },
          };
        }
        return null;
      },
    } as unknown as BusinessPackLoader;

    const packResolver = new CrmConnectorBindingResolver(undefined, mockLoader);
    const result = await packResolver.resolveCrmBinding('royalcyber-pack-tenant');
    assert.equal(result.provider, 'hubspot');
    assert.equal(result.crmDomain, 'hubspot');
    assert.equal(result.source, 'business_pack_binding');

    console.log('   ✅ PASS: Resolved CRM provider via Business Pack capability bindings.\n');
  }

  // ── Part 3: No Filesystem / Static Fallback After Canonical Activation ────
  console.log('3. Testing no filesystem/static fallback after canonical activation...');
  {
    // Scenario 3a: Tenant is canonically activated (migrated)
    // Cutover repository / environment marks tenant as migrated
    const activatedTenant = 'placemakers';
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'migrated';

    const failClosedResponse = await handleConfigFailure(activatedTenant);
    assert.equal(
      failClosedResponse.status,
      503,
      'Activated tenant MUST return HTTP 503 when config load fails'
    );

    const failClosedBody = await failClosedResponse.json();
    assert.equal(failClosedBody.error, 'CanonicalConfigurationUnavailable');
    assert.ok(
      failClosedBody.message.includes('Legacy fallback is prohibited after canonical activation'),
      'Must state that legacy fallback is prohibited after activation'
    );
    assert.equal(failClosedBody.cutoverState, 'migrated');
    // Ensure it did NOT return PlaceMakers static companyName or fallback values
    assert.equal(failClosedBody.companyName, undefined);
    assert.equal(failClosedBody.theme, undefined);

    // Scenario 3b: Tenant is explicitly UNMIGRATED
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'unmigrated';

    const unmigratedResponse = await handleConfigFailure(activatedTenant);
    assert.equal(
      unmigratedResponse.status,
      200,
      'Unmigrated tenant is permitted legacy fallback'
    );
    const unmigratedBody = await unmigratedResponse.json();
    assert.equal(unmigratedBody.projectId, 'placemakers');
    assert.equal(unmigratedBody.companyName, 'PlaceMakers (Fletcher Building)');

    // Cleanup env override
    delete process.env.TENANT_CUTOVER_PLACEMAKERS;

    console.log('   ✅ PASS: Canonical activation strictly fails closed with 503; legacy fallback prohibited.\n');
  }

  console.log('🎉 ALL ARCHITECTURE CLOSURE TESTS PASSED.\n');
}

run().catch((err) => {
  console.error('\n❌ ARCHITECTURE CLOSURE SPEC FAILED:');
  console.error(err);
  process.exit(1);
});
