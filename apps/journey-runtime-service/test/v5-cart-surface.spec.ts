import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService } from '../src/runtime.service';
import { RuntimeController } from '../src/runtime.controller';
import { CartUpdateHandler } from '../src/capabilities/handlers/cart-update.handler';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { MemoryActionLedger } from '@journeyax/capability-sdk';
import { CartRequestSchema } from '../src/commerce/cart-request';

const auth: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', principalRole: 'customer', principalGroups: [], isInternal: false };
const products = [{ projectId: 'tenant-a', sku: 'sku-a', name: 'Actual catalogue item', priceCents: 2500, currency: 'NZD' }];
function setup() {
  const gateway = new CapabilityGateway({ actionLedger: new MemoryActionLedger() });
  const handler = new CartUpdateHandler(undefined, new Map(), products);
  gateway.registerCustomAdapter('cart.update', handler);
  const pack: any = { manifest: { packId: 'pack-a', version: '1.0.0' }, extensions: { commerce: { pricing: { currency: 'NZD', taxRate: 0, discountRate: 0 } } }, capabilities: {
    toolDefinitions: [{ toolId: 'cart.update', name: 'cart.update', description: 'Owned cart', sideEffect: 'write', risk: 'low', inputSchema: { type: 'object' } }],
    toolBindings: [{ toolId: 'cart.update', executor: { type: 'native_capability', nativeCapabilityId: 'cart.update' }, policy: { requiredRole: 'customer', requiresConfirmation: false, idempotencyRequired: true } }],
  } };
  const service = new RuntimeService({ capabilityGateway: gateway } as any);
  const activations: any[] = [];
  service.assertReleaseActivationApproved = async (...args) => { activations.push(args); return pack; };
  return { controller: new RuntimeController(service), pack, gateway, activations, handler };
}

test('canvas cart and native chat cart use one checkout quote, signed owner and private workspace', async () => {
  const { controller, handler, activations } = setup();
  const req = { authContext: auth };
  const body = { sessionId: 'browser-chosen-chat', idempotencyKey: 'click-1', expectedVersion: 0, items: [{ sku: 'sku-a', quantity: 2 }] };
  const saved = await controller.updateCart(body, req);
  const loaded = await controller.cart(body.sessionId, req);
  assert.equal(saved.quote.total, 50);
  assert.equal(loaded.quote.quoteId, saved.quote.quoteId);
  assert.equal(loaded.cart.version, 1);
  assert.match(activations[0][2], /^chat_[a-f0-9]{24}_[a-f0-9]{64}$/);
  const native = await handler.read({}, { ...auth, workspaceId: activations[0][2] } as any);
  assert.equal(native?.quote.quoteId, loaded.quote.quoteId);
  for (const different of [{ principalId: 'someone-else' }, { tenantId: 'tenant-b' }, { environmentId: 'staging' }]) {
    const other = await controller.cart(body.sessionId, { authContext: { ...auth, ...different } });
    assert.equal(other.cart.items.length, 0);
  }
  const cleared = await controller.updateCart({ ...body, expectedVersion: 1, idempotencyKey: 'click-2', items: [] }, req);
  assert.equal(cleared.cart.status, 'empty');
  assert.equal((await controller.cart(body.sessionId, req)).quote, undefined);
});

test('cart transport rejects fabricated money/identity, stale revisions and forbidden pack capability', async () => {
  const { controller, pack } = setup();
  const body = { sessionId: 'chat', idempotencyKey: 'click', expectedVersion: 0, items: [{ sku: 'sku-a', quantity: 1 }] };
  for (const extras of [{ principalId: 'admin' }, { total: 0.01 }, { items: [{ sku: 'sku-a', quantity: 1, unitPrice: 0.01 }] }, { expectedVersion: '0' }]) assert.equal(CartRequestSchema.safeParse({ ...body, ...extras }).success, false);
  await controller.updateCart(body, { authContext: auth });
  await assert.rejects(() => controller.updateCart({ ...body, idempotencyKey: 'another-click' }, { authContext: auth }), /changed/);
  pack.capabilities.toolBindings[0].policy.requiredRole = 'admin';
  await assert.rejects(() => controller.updateCart({ ...body, idempotencyKey: 'denied', expectedVersion: 1 }, { authContext: auth }), /not permitted/);
});

test('the collection-backed cart saves the same quote that checkout loads, with no copy of money on its pointer', async () => {
  const { MemoryDb } = await import('@journeyax/test-support');
  const { QuoteService } = await import('../../agent-commerce-service/src/commerce/quote.service');
  const db = new MemoryDb();
  await db.collection('products').insertOne(products[0]);
  const handler = new CartUpdateHandler(undefined, undefined, undefined, async () => db);
  const scope: any = { ...auth, workspaceId: 'private-chat', sessionId: 'private-chat', idempotencyKey: 'click-a', release: { extensions: { commerce: { pricing: { currency: 'NZD', taxRate: 0, discountRate: 0 } } } } };
  const saved = await handler.execute({ items: [{ sku: 'sku-a', quantity: 2 }], expectedVersion: 0 }, scope);
  const quotes = new QuoteService(); (quotes as any).getCol = async () => db.collection('quotes');
  const payable = await quotes.get(saved.quote.quoteId, auth.tenantId, { environmentId: auth.environmentId, principalId: auth.principalId });
  assert.equal(payable?.quoteId, saved.quote.quoteId);
  assert.equal(payable?.total, 50);
  assert.equal(db.dump('customer_carts')[0].items, undefined);
  assert.equal(db.dump('customer_carts')[0].total, undefined);
  const replay = await handler.execute({ items: [{ sku: 'sku-a', quantity: 2 }], expectedVersion: 0 }, scope);
  assert.equal(replay.cart.version, 1);
  assert.equal(db.dump('quotes').length, 1);
  await handler.execute({ items: [], expectedVersion: 1 }, { ...scope, idempotencyKey: 'clear' });
  assert.equal((await handler.read({}, scope))?.quote, undefined);
  assert.equal(db.dump('quotes').length, 1, 'clearing preserves the earlier quote for history');
});


test('configured automatic draft edits do not confer payment, external-write or high-risk authority', async () => {
  const { gateway, pack } = setup();
  const context: any = { ...auth, workspaceId: 'private-chat', sessionId: 'private-chat', correlationId: 'c-a', idempotencyKey: 'draft-a', release: pack, packSettings: pack };
  const payload = { items: [{ sku: 'sku-a', quantity: 1 }], expectedVersion: 0 };
  assert.equal((await gateway.executeCapability(pack, 'cart.update', payload, context)).status, 'success');
  pack.capabilities.toolBindings[0].policy.requiresConfirmation = true;
  assert.equal((await gateway.executeCapability(pack, 'cart.update', payload, { ...context, idempotencyKey: 'ask' })).status, 'requires_approval');
  pack.capabilities.toolBindings[0].policy.requiresConfirmation = false;
  pack.capabilities.toolDefinitions[0].risk = 'high';
  assert.equal((await gateway.executeCapability(pack, 'cart.update', payload, { ...context, idempotencyKey: 'high-risk' })).status, 'requires_approval');
  let externalWrites = 0;
  pack.capabilities.toolDefinitions[0].risk = 'low';
  gateway.registerCustomAdapter('cart.update', new CartUpdateHandler({ updateCart: async () => { externalWrites++; return {}; } }));
  assert.equal((await gateway.executeCapability(pack, 'cart.update', payload, { ...context, idempotencyKey: 'external' })).status, 'requires_approval');
  assert.equal(externalWrites, 0);
});
