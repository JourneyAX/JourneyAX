import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackLoader, publishBusinessPack } from '@journeyax/business-pack';
import { CapabilityDispatcher, InProcessMcpTransport, McpClient, MemoryActionLedger } from '@journeyax/capability-sdk';
import { RealConnectorServer } from '../../../packages/connectors-real/src/server';
import { orderContactCorrection } from '../../../packages/connectors-real/src/connectors/commercetools-order-contact';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { ConnectorRuntime } from '../src/kernel/connector.runtime';
import { ApprovalService } from '../src/kernel/approval.service';
import { ApprovalStore } from '../src/approval/approval.store';

const secret = 'offline-order-contact-authority-'.repeat(2);
const ctx: any = { tenantId: 'placemakers', environmentId: 'production', principalId: 'staff-a', principalRole: 'csr', workspaceId: 'staff-chat-a', sessionId: 'staff-chat-a', stageId: 'agent', packVersionId: '1.0.0', correlationId: 'trace-a', idempotencyKey: 'correction-a', actionId: 'correction-a' };
const person: any = { audience: 'staff', groups: ['customer-service'] };
const args = { orderId: 'ORDER-1', expectedVersion: 4, corrections: { streetName: 'Corrected street', phone: '+64210000000' } };
async function fixture(allowShopper = false) {
  const db = new MemoryDb(); const content: any = structuredClone(rawLegacyFixture);
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  content.extensions = { ...content.extensions, connectors: { connectors: [{ connectorId: 'commercetools', displayName: 'Commerce', description: 'Order corrections', owner: 'Service', connectionRef: 'contact-fixture', tools: [{ name: 'correct_order_contact', sideEffect: 'write' }] }], policy: [{ connectorId: 'commercetools', tool: 'correct_order_contact', audience: 'staff', groups: person.groups, state: 'ask' }, ...(allowShopper ? [{ connectorId: 'commercetools', tool: 'correct_order_contact', audience: 'shopper', groups: [], state: 'allow' }] : [])] } };
  await publishBusinessPack(db as any, content);
  const pack = await new BusinessPackLoader({ db }).loadPublished(ctx.tenantId, ctx.environmentId);
  const order: any = { id: 'source-order-a', version: 4, orderNumber: 'ORDER-1', orderState: 'Open', shipmentState: 'Pending', totalPrice: { currencyCode: 'NZD', centAmount: 4000 }, shippingAddress: { country: 'NZ', city: 'Fixture city', postalCode: '0000', streetName: 'Old street', streetNumber: '1', custom: { type: { id: 'fixture-type' }, fields: { deliveryNote: 'Retain this' } } } };
  const calls: any[] = [];
  const tool = orderContactCorrection(async (method, path, options) => {
    calls.push({ method, path, options });
    if (method === 'GET') return structuredClone(order);
    assert.equal(options?.body?.version, order.version);
    order.version++; order.shippingAddress = structuredClone(options!.body!.actions[0].address);
    return structuredClone(order);
  });
  const source = new RealConnectorServer({ tenants: [ctx.tenantId], environmentId: ctx.environmentId, connectionRef: 'contact-fixture', commandScopeSecret: secret, apiKey: 'fixture-key', connectors: [{ connectorId: 'commercetools', title: 'Commerce', description: 'Offline contract source', required: [], missing: () => [], tools: [tool] }] });
  const client = new McpClient(new InProcessMcpTransport(async (message, meta) => {
    let response: any;
    const request = { method: 'POST', url: '/mcp/commercetools', headers: { authorization: 'Bearer fixture-key', 'x-tenant-id': meta.tenantId, 'x-environment-id': meta.environmentId, 'x-principal-id': meta.principalId, 'x-connection-ref': meta.connectionRef, 'x-caller-scope': meta.callerScope }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(message)); } };
    await (source as any).onRequest(request, { writeHead: () => {}, end: (body: string) => { response = body ? JSON.parse(body) : undefined; } });
    return response;
  }), 'commerce');
  const clients: any = { getClient: async () => client };
  const dispatcher = new CapabilityDispatcher({ mcpClients: clients, actionLedger: new MemoryActionLedger(), validateConnectionOwnership: (tenant, env, ref) => tenant === ctx.tenantId && env === ctx.environmentId && ref === 'contact-fixture' });
  return { order, calls, tool, pack, runtime: new ConnectorRuntime({ dispatcher, mcpClients: clients }), approvals: new ApprovalService(new ApprovalStore({ explicitMemory: true })) };
}
async function withAuthority(run: () => Promise<void>) {
  const before = process.env.JAX_COMMAND_SIGNING_SECRET; process.env.JAX_COMMAND_SIGNING_SECRET = secret;
  try { await run(); } finally { if (before === undefined) delete process.env.JAX_COMMAND_SIGNING_SECRET; else process.env.JAX_COMMAND_SIGNING_SECRET = before; }
}

test('staff correction uses exact approval, signed source authority, optimistic version and an actual privacy-minimised receipt', () => withAuthority(async () => {
  const f = await fixture(); const custom = structuredClone(f.order.shippingAddress.custom);
  const waiting: any = await f.runtime.call(f.pack, person, ctx, 'commercetools', 'correct_order_contact', args, { approvals: f.approvals });
  assert.equal(waiting.status, 'needs_approval'); assert.equal(f.calls.length, 0);
  assert.equal(await f.approvals.decide(ctx.tenantId, ctx.environmentId, ctx.workspaceId, waiting.approvalRequestId, 'approved', 'staff-approver'), true);
  const done: any = await f.runtime.call(f.pack, person, ctx, 'commercetools', 'correct_order_contact', args, { approvals: f.approvals, approvalRequestId: waiting.approvalRequestId });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.result.updated, true); assert.equal(done.result.record.version, 5);
  assert.deepEqual(done.result.record.changedFields, ['phone', 'streetName']);
  assert.equal(JSON.stringify(done.result).includes('Corrected street'), false);
  assert.equal(f.order.shippingAddress.city, 'Fixture city'); assert.deepEqual(f.order.shippingAddress.custom, custom);
  assert.equal(f.order.shippingAddress.phone, args.corrections.phone);
  await f.runtime.call(f.pack, person, ctx, 'commercetools', 'correct_order_contact', args, { approvals: f.approvals, approvalRequestId: waiting.approvalRequestId });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
}));

test('a broadly configured shopper still cannot execute a staff-only source correction', () => withAuthority(async () => {
  const f = await fixture(true);
  const result: any = await f.runtime.call(f.pack, { audience: 'shopper', groups: [] }, { ...ctx, principalId: 'buyer-a', principalRole: 'customer' }, 'commercetools', 'correct_order_contact', args);
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
}));

test('stale approvals, fulfilled orders, location/tax changes and invalid phone values cause no source write', async () => {
  const f = await fixture();
  await assert.rejects(() => f.tool.run({ ...args, expectedVersion: 3 }), /changed/);
  f.order.shipmentState = 'Shipped'; await assert.rejects(() => f.tool.run(args), /fulfilment/);
  f.order.shipmentState = 'Pending';
  for (const corrections of [{ city: 'Another city' }, { country: 'AU' }, { phone: '123' }, { streetName: 'bad\nvalue' }]) await assert.rejects(() => f.tool.run({ ...args, corrections }), /correction|phone|international|Location/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});
