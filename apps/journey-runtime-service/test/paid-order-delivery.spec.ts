import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackLoader, publishBusinessPack, getVerifiedBusinessPackMetadata, validateBusinessPack } from '@journeyax/business-pack';
import { CheckoutQuoteRepository, OutboxRepository } from '@journeyax/database';
import { CapabilityDispatcher, InProcessMcpTransport, McpClient } from '@journeyax/capability-sdk';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { RealConnectorServer } from '../../../packages/connectors-real/src/server';
import { MongoActionLedger } from '../src/infrastructure/mongo-action-ledger';
import { PaidOrderDelivery } from '../src/commerce/paid-order-delivery';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';
import { OutboxWorker } from '../src/kernel/outbox.worker';

const secret = 'offline-delivery-authority-'.repeat(3);
async function fixture(paymentLink = false) {
  const db = new MemoryDb({ transactional: true });
  const content: any = structuredClone(rawLegacyFixture);
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  content.extensions = { ...content.extensions, payment: { collectShipping: true, shippingCountries: ['NZ'], delivery: { contract: 'paid-order-v1', connectorId: 'commerce', writeTool: 'place_order', receiptTool: 'get_order_receipt', taxCountry: 'NZ', taxLabel: 'GST' } },
    connectors: { connectors: [{ connectorId: 'commerce', displayName: 'Commerce', description: 'Paid delivery', owner: 'Sales', mcpServerName: 'commerce', connectionRef: 'fixture-commerce', tools: [{ name: 'place_order', sideEffect: 'write' }, { name: 'get_order_receipt', sideEffect: 'read' }] }], policy: [] } };
  if (paymentLink) {
    Object.assign(content.extensions.payment.delivery, { paymentWriteTool: 'record_order_payment', paymentReceiptTool: 'get_order_payment_receipt' });
    content.extensions.connectors.connectors[0].tools.push({ name: 'record_order_payment', sideEffect: 'write' }, { name: 'get_order_payment_receipt', sideEffect: 'read' });
  }
  await publishBusinessPack(db as any, content);
  await db.collection('outbox_events').deleteMany({}); // Discard publication fixture events; this case exercises paid delivery only.
  const packs = new BusinessPackLoader({ db });
  const pack = await packs.loadPublished('placemakers', 'production');
  const verified = getVerifiedBusinessPackMetadata(pack)!;
  const pin = { version: verified.version, checksum: verified.checksum };
  const order: any = { tenantId: 'placemakers', environmentId: 'production', principalId: 'customer-a', workspaceId: 'chat-a', orderId: 'ord_delivery-fixture', quoteId: 'quote-a', quoteVersion: 1, stripeSessionId: 'cs-fixture', paymentMode: 'test', currency: 'NZD', total: 42, taxRate: 0.05, discount: 0, lines: [{ sku: 'SKU-A', name: 'Catalogued item', quantity: 2, unitPrice: 20 }], release: pin, status: 'pending_payment' };
  order.shipping = { name: 'Offline customer', address: { line1: '1 Fixture Street', city: 'Fixture city', country: 'NZ' } };
  if (paymentLink) order.paymentReceipt = { provider: 'stripe', mode: 'test', transactionId: 'pi_offline-source', amountMinor: 4200, currency: 'NZD' };
  await db.collection('orders').insertOne(order);
  await db.collection('quotes').insertOne({ tenantId: order.tenantId, environmentId: order.environmentId, principalId: order.principalId, quoteId: order.quoteId, version: 1, status: 'draft', checkoutOrderId: order.orderId, total: order.total, currency: order.currency, release: pin });
  await new CheckoutQuoteRepository(db).settle(order, 'paid');
  const event = db.dump('outbox_events')[0];
  const vendor = { writes: 0, created: 0, reads: 0, receipt: null as any, payment: null as any, paymentWrites: 0, loseWriteResponse: false, failBeforePaid: false, failBeforeCreate: false, losePaymentResponse: false };
  const source = new RealConnectorServer({ tenants: ['placemakers'], environmentId: 'production', connectionRef: 'fixture-commerce', iqScopeSecret: secret, commandScopeSecret: secret, apiKey: 'fixture-key', connectors: [{ connectorId: 'commerce', title: 'Commerce', description: 'Offline source boundary', required: [], missing: () => [], tools: [
    { name: 'get_order_receipt', readOnly: true, description: 'Receipt', inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] }, run: async () => { vendor.reads++; return { record: vendor.receipt }; } },
    { name: 'place_order', readOnly: false, requiresPaymentReceipt: true, description: 'Deliver', inputSchema: { type: 'object', properties: { orderNumber: { type: 'string' }, existingOrderId: { type: 'string' }, currency: { type: 'string' }, expectedTotal: { type: 'number' }, taxRate: { type: 'number' }, taxCountry: { type: 'string' }, taxName: { type: 'string' }, discount: { type: 'number' }, paid: { type: 'boolean' }, lines: { type: 'array' }, shipping: { type: 'object' } } }, run: async (args) => {
      vendor.writes++;
      if (vendor.failBeforeCreate) { vendor.failBeforeCreate = false; throw new Error('source unavailable before creation'); }
      if (args.existingOrderId) assert.equal(vendor.receipt?.orderId, args.existingOrderId);
      if (!vendor.receipt) vendor.created++;
      vendor.receipt = { orderId: 'vendor-order-a', orderNumber: args.orderNumber, total: 42, currency: 'NZD', lineCount: 1, paymentState: vendor.failBeforePaid ? 'BalanceDue' : 'Paid', lines: [{ sku: 'SKU-A', quantity: 2 }] };
      if (vendor.failBeforePaid) { vendor.failBeforePaid = false; throw new Error('interrupted after order creation'); }
      if (vendor.loseWriteResponse) throw new Error('response lost after source commit');
      return { record: vendor.receipt };
    } },
    ...(paymentLink ? [
      { name: 'get_order_payment_receipt', readOnly: true, description: 'Payment receipt', inputSchema: { type: 'object', properties: { orderNumber: { type: 'string' }, transactionId: { type: 'string' } } }, run: async () => ({ record: vendor.payment }) },
      { name: 'record_order_payment', readOnly: false, requiresPaymentReceipt: true, description: 'Payment link', inputSchema: { type: 'object', properties: { orderNumber: { type: 'string' }, transactionId: { type: 'string' }, amountMinor: { type: 'number' }, currency: { type: 'string' }, paymentInterface: { type: 'string' } } }, run: async (args: any) => {
        vendor.paymentWrites++;
        vendor.payment = { orderId: 'vendor-order-a', orderNumber: args.orderNumber, paymentId: 'payment-a', transactionId: args.transactionId, amountMinor: args.amountMinor, currency: args.currency, linked: true, chargeSucceeded: true };
        if (vendor.losePaymentResponse) throw new Error('payment response lost'); return { record: vendor.payment };
      } },
    ] : []),
  ] }] });
  const client = new McpClient(new InProcessMcpTransport(async (message, meta) => {
    let payload: any;
    const req: any = { method: 'POST', url: '/mcp/commerce', headers: { authorization: 'Bearer fixture-key', 'x-tenant-id': meta.tenantId, 'x-environment-id': meta.environmentId, 'x-principal-id': meta.principalId, 'x-connection-ref': meta.connectionRef, 'x-caller-scope': meta.callerScope }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(message)); } };
    await (source as any).onRequest(req, { writeHead: () => {}, end: (value: string) => { payload = value ? JSON.parse(value) : undefined; } });
    return payload;
  }), 'commerce');
  const actualDispatcher = new CapabilityDispatcher({ mcpClients: { getClient: async () => client }, actionLedger: new MongoActionLedger(async () => db), validateConnectionOwnership: (tenant, env, ref) => tenant === order.tenantId && env === order.environmentId && ref === 'fixture-commerce' });
  const responses: any[] = [];
  const dispatcher: any = { dispatch: async (...args: any[]) => { const response = await (actualDispatcher.dispatch as any)(...args); responses.push(response); return response; } };
  return { db, event, order, vendor, content, packs, dispatcher, responses, delivery: new PaidOrderDelivery(db, dispatcher, packs) };
}

async function withAuthority(run: () => Promise<void>) {
  const previous = [process.env.JAX_COMMAND_SIGNING_SECRET, process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET];
  process.env.JAX_COMMAND_SIGNING_SECRET = secret; process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET = secret;
  try { await run(); } finally { for (const [index, key] of ['JAX_COMMAND_SIGNING_SECRET', 'JAX_IQ_CONNECTOR_SIGNING_SECRET'].entries()) { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; } }
}

test('the existing outbox dispatches a pinned paid order through signed source gates and durable action receipts', () => withAuthority(async () => {
  const f = await fixture();
  const service = new OutboxWorkerService(); service.configureHandlers({ db: f.db, capabilityDispatcher: f.dispatcher, paymentPackLoader: f.packs });
  const worker = new OutboxWorker(new OutboxRepository(f.db as any) as any, { dispatcher: event => service.dispatchEvent(event), workerId: 'offline-worker' });
  assert.deepEqual(await worker.processNextBatch(), { processed: 1, succeeded: 1, failed: 0 });
  assert.equal(f.vendor.writes, 1);
  assert.equal(f.db.dump('orders')[0].commerceSync.status, 'ready');
  assert.equal(f.db.dump('orders')[0].externalOrder.orderId, 'vendor-order-a');
  assert.equal(f.db.dump('action_receipts')[0].status, 'succeeded');
  assert.equal(f.db.dump('outbox_events')[0].status, 'published');
  await f.delivery.deliver(f.event); assert.equal(f.vendor.writes, 1);
}));

test('a lost source response is reconciled by reading the same full order id, without a second write', () => withAuthority(async () => {
  const f = await fixture(); f.vendor.loseWriteResponse = true;
  await assert.rejects(() => f.delivery.deliver(f.event), /retry|reconciliation/);
  assert.equal(f.db.dump('orders')[0].commerceSync.status, 'pending');
  assert.ok(f.db.dump('action_receipts')[0], JSON.stringify(f.responses));
  assert.equal(f.db.dump('action_receipts')[0].status, 'uncertain');
  const restarted = new PaidOrderDelivery(f.db, f.dispatcher, new BusinessPackLoader({ db: f.db }));
  await restarted.deliver(f.event);
  assert.equal(f.vendor.writes, 1); assert.equal(f.db.dump('orders')[0].commerceSync.status, 'ready');
  assert.equal(f.db.dump('action_receipts')[0].status, 'succeeded');
}));

test('cross-tenant envelopes, pending payment, invalid release pins and mismatched commerce receipts never deliver', () => withAuthority(async () => {
  const f = await fixture();
  await assert.rejects(() => f.delivery.deliver({ ...f.event, tenantId: 'another-tenant' }), /receipt/);
  await f.db.collection('orders').updateOne({ orderId: f.order.orderId }, { $set: { status: 'pending_payment' } });
  await assert.rejects(() => f.delivery.deliver(f.event), /receipt/);
  await f.db.collection('orders').updateOne({ orderId: f.order.orderId }, { $set: { status: 'paid', 'release.checksum': 'bad' } });
  await assert.rejects(() => f.delivery.deliver(f.event), /match|checksum|invalid/);
  await f.db.collection('orders').updateOne({ orderId: f.order.orderId }, { $set: { release: f.order.release } });
  f.vendor.receipt = { orderId: 'wrong', orderNumber: f.order.orderId, total: 1, currency: 'NZD', lineCount: 1, paymentState: 'Paid' };
  await assert.rejects(() => f.delivery.deliver(f.event), /receipt/);
  assert.equal(f.vendor.writes, 0); assert.equal(f.db.dump('orders')[0].commerceSync.status, 'pending');
}));

test('an interrupted delivery resumes payment acknowledgement on the exact existing order, without another order creation', () => withAuthority(async () => {
  const f = await fixture(); f.vendor.failBeforePaid = true;
  await assert.rejects(() => f.delivery.deliver(f.event), /reconciliation|retry/);
  assert.equal(f.vendor.receipt.paymentState, 'BalanceDue'); assert.equal(f.vendor.created, 1);
  await new PaidOrderDelivery(f.db, f.dispatcher, f.packs).deliver(f.event);
  assert.equal(f.vendor.created, 1); assert.equal(f.vendor.writes, 2);
  assert.equal(f.vendor.receipt.paymentState, 'Paid');
  assert.equal(f.db.dump('orders')[0].commerceSync.status, 'ready');
  assert.equal(f.db.dump('action_receipts').length, 2);
  assert.equal(f.db.dump('action_receipts').every(row => row.status === 'succeeded'), true);
}));

test('publication refuses sample, missing and misclassified paid delivery bindings', async () => {
  const f = await fixture();
  for (const change of [(c: any) => { c.enabled = false; }, (c: any) => { c.sample = true; }, (c: any) => { c.connectionRef = undefined; }, (c: any) => { c.tools[0].sideEffect = 'read'; }]) {
    const content = structuredClone(f.content); change(content.extensions.connectors.connectors[0]);
    assert.equal(validateBusinessPack(content).valid, false);
  }
});

test('a source outage before order creation can resume only after an authoritative absence receipt', () => withAuthority(async () => {
  const f = await fixture(); f.vendor.failBeforeCreate = true;
  await assert.rejects(() => f.delivery.deliver(f.event), /retry|reconciliation/);
  assert.equal(f.db.dump('action_receipts')[0].status, 'uncertain'); assert.equal(f.vendor.created, 0);
  await f.delivery.deliver(f.event);
  assert.equal(f.vendor.created, 1); assert.equal(f.db.dump('action_receipts')[0].status, 'succeeded');
  assert.equal(f.db.dump('action_receipts')[0].reconciledRetries, 1);
}));

test('configured payment linkage requires a provider receipt and recovers an interrupted source response without another payment', () => withAuthority(async () => {
  const f = await fixture(true); f.vendor.losePaymentResponse = true;
  await assert.rejects(() => f.delivery.deliver(f.event), /retry|reconciliation/);
  assert.equal(f.db.dump('orders')[0].commerceSync.status, 'pending');
  await f.delivery.deliver(f.event);
  assert.equal(f.vendor.created, 1); assert.equal(f.vendor.paymentWrites, 1);
  assert.equal(f.db.dump('orders')[0].externalPayment.paymentId, 'payment-a');
  assert.equal(f.db.dump('orders')[0].commerceSync.status, 'ready');
  assert.equal(f.db.dump('action_receipts').every(row => row.status === 'succeeded'), true);
}));

test('operator payment reconciliation preserves the original order pin and cannot create a missing historical order', () => withAuthority(async () => {
  const f = await fixture(true);
  await f.db.collection('orders').updateOne({ orderId: f.order.orderId }, { $set: { 'commerceSync.status': 'ready', externalOrder: { orderId: 'vendor-order-a' } } });
  await assert.rejects(() => f.delivery.reconcilePaymentLink(f.event, f.order.release), /existing paid commerce order/);
  assert.equal(f.vendor.created, 0);
  f.vendor.receipt = { orderId: 'vendor-order-a', orderNumber: f.order.orderId, total: 42, currency: 'NZD', lineCount: 1, paymentState: 'Paid', lines: [{ sku: 'SKU-A', quantity: 2 }] };
  await f.delivery.reconcilePaymentLink(f.event, f.order.release);
  assert.equal(f.vendor.created, 0); assert.equal(f.vendor.paymentWrites, 1);
  assert.deepEqual(f.db.dump('orders')[0].release, f.order.release);
  assert.deepEqual(f.db.dump('orders')[0].paymentLinkRelease, f.order.release);
}));
