/**
 * The person's staff role and groups have to reach the runtime, or staff-only things (connectors, staff agents) can never show for
 * anyone. The gateway signs them; this service verifies that signature, tells the runtime the same, and passes on which connectors the
 * person switched off for the chat. A call without a valid signature is a shopper.
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { signGatewayAssertion, verifyGatewayAssertion } from '@journeyax/database';
import { cleanDisabledConnectors, principalIdFor, verifiedIdentity } from '../src/identity';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { LegacyJourneyAdapter } from '../src/legacy/legacy-journey-adapter';
import { ConfigLoader } from '../src/pipeline/config-loader';

const SECRET = 'test-secret-for-identity';
process.env.GATEWAY_ASSERTION_SECRET = SECRET;

const sign = (claims: Partial<Parameters<typeof signGatewayAssertion>[0]> & { sub: string; role: any }, tenantId = 'placemakers') =>
  signGatewayAssertion({ tenantId, environmentId: 'production', ...claims } as any, SECRET);

async function main() {
  // ── 1. Reading the gateway's signed identity ────────────────────────────────────────────────────────────────────────────────────────────
  const staff = sign({ sub: 'sam@placemakers.example', role: 'consultant', groups: ['customer-service'] });
  assert.deepEqual(verifiedIdentity(staff, 'placemakers'), { sub: 'sam@placemakers.example', role: 'consultant', groups: ['customer-service'] });
  assert.deepEqual(verifiedIdentity(sign({ sub: 'jo', role: 'customer' }), 'placemakers'), { sub: 'jo', role: 'customer', groups: [] }, 'a shopper has no groups');
  assert.equal(verifiedIdentity(staff, 'another-tenant'), undefined, 'an assertion for another tenant is no identity');
  assert.equal(verifiedIdentity(staff + 'x', 'placemakers'), undefined, 'a changed signature is no identity');
  assert.equal(verifiedIdentity('not-an-assertion', 'placemakers'), undefined);
  assert.equal(verifiedIdentity(undefined, 'placemakers'), undefined);
  assert.equal(verifiedIdentity(staff, 'placemakers', ''), undefined, 'with no signing secret nobody is verified');
  assert.deepEqual(cleanDisabledConnectors(['sap-commerce', 'sap-commerce', 'bad id!', 7, 'ace-erp']), ['sap-commerce', 'ace-erp']);
  assert.equal(cleanDisabledConnectors('sap-commerce'), undefined);
  assert.equal(cleanDisabledConnectors([]), undefined);

  // The principal the runtime is told: a verified login wins, and a guest cannot pass as one.
  const hemi = { sub: 'hemi@harlow.example', role: 'customer', groups: [] as string[] };
  assert.equal(principalIdFor(hemi, 'someone-else@example.com'), 'hemi@harlow.example', 'the verified login wins over what the page sends');
  assert.equal(principalIdFor(hemi, undefined), 'hemi@harlow.example');
  assert.equal(principalIdFor(undefined, 'hemi@harlow.example'), 'anonymous', 'a guest who sends a login as an id is anonymous');
  assert.equal(principalIdFor({ sub: 'guest@anonymous', role: 'customer', groups: [] }, 'hemi@harlow.example'), 'anonymous');
  assert.equal(principalIdFor({ sub: 'anonymous', role: 'customer', groups: [] }, 'hemi@harlow.example'), 'anonymous');
  assert.equal(principalIdFor(undefined, 'sess_42'), 'sess_42', 'a plain session or demo id is still carried');
  assert.equal(principalIdFor(undefined, undefined), 'anonymous');
  assert.equal(principalIdFor(undefined, 42), 'anonymous');

  // ── 2. A stand-in runtime that checks what it is told, as the real one's guard does ─────────────────────────────────────────────────────
  const seen: Array<{ method: string; url: string; identity: any; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const identity = verifyGatewayAssertion(String(req.headers['x-gateway-assertion']), SECRET, { expectedTenantId: 'placemakers' });
      seen.push({ method: req.method || '', url: req.url || '', identity, body: raw ? JSON.parse(raw) : undefined });
      if ((req.url || '').endsWith('/connectors')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connectors: identity.groups?.includes('customer-service') ? [{ connector: 'salesforce', name: 'Salesforce' }] : [], packVersion: '9.9.9' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: done\ndata: {"response":"ok"}\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.JOURNEY_RUNTIME_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const adapter = new CanonicalRuntimeAdapter();

    // the connector list is asked of the runtime as the person
    const list = await adapter.listConnectors('placemakers', { sub: 'sam@placemakers.example', role: 'consultant', groups: ['customer-service'] });
    assert.deepEqual(list, { connectors: [{ connector: 'salesforce', name: 'Salesforce' }], packVersion: '9.9.9' });
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/api/v1/placemakers/production/runtime/connectors');
    assert.deepEqual({ role: seen[0].identity.role, groups: seen[0].identity.groups }, { role: 'consultant', groups: ['customer-service'] }, 'the runtime is told the same role and groups');
    const shopper = await adapter.listConnectors('placemakers', undefined);
    assert.deepEqual(shopper.connectors, [], 'no identity is a shopper, who gets none');
    assert.equal(seen[1].identity.role, 'customer');
    assert.equal((seen[1].identity.groups ?? []).length, 0);

    // a turn through the coordinator carries the verified role, groups and switched-off connectors to the runtime
    const coordinator = new JourneyCoordinator({ resolveActivation: async () => ({ action: 'CANONICAL' }) } as any, adapter, new LegacyJourneyAdapter(), new ConfigLoader(), undefined as any);
    await coordinator.executeChatStream({
      tenantId: 'placemakers', message: 'stock at Hamilton?', turnId: 't1', sessionId: 's1',
      verifiedIdentity: { sub: 'sam@placemakers.example', role: 'consultant', groups: ['customer-service'] }, disabledConnectors: ['ace-erp'],
    } as any, () => {});
    const turn = seen[seen.length - 1];
    assert.equal(turn.url, '/api/v1/placemakers/production/runtime/chat/stream');
    assert.deepEqual({ role: turn.identity.role, groups: turn.identity.groups }, { role: 'consultant', groups: ['customer-service'] });
    assert.deepEqual(turn.body.disabledConnectors, ['ace-erp']);

    await coordinator.executeChatStream({ tenantId: 'placemakers', message: 'hello', turnId: 't2', sessionId: 's1' } as any, () => {});
    const plain = seen[seen.length - 1];
    assert.equal(plain.identity.role, 'customer', 'a request with no verified identity is answered as a shopper');
    assert.ok(!('disabledConnectors' in plain.body) || plain.body.disabledConnectors === undefined);
  } finally {
    server.close();
  }
  console.log('✅ commerce service: the gateway-signed role and groups reach the runtime; the connector list and switched-off connectors pass through');
}

main().catch((error) => { console.error(error); process.exit(1); });
