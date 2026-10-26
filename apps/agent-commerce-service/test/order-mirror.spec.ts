import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { OrderService, type OrderDoc } from '../src/commerce/order.service';
import { mirrorPaidOrder, mirrorSettings, placeOrderArguments, shownOrderNumber } from '../src/commerce/order-mirror';

/**
 * A paid order is recorded in the business's commerce system under the number the customer saw. It is off unless switched on, it never
 * touches the order when it fails, and asking twice does not make two.
 */
const suite = createSuite('commerce: recording a paid order in commercetools');

const ON = { ORDER_MIRROR: 'commercetools', ORDER_MIRROR_URL: 'http://connectors.test/mcp/commercetools', ORDER_MIRROR_KEY: 'key-1' };

const paid = (extra: Partial<OrderDoc> = {}): OrderDoc => ({
  orderId: 'ord_0123456789abcdef0123456789abcdef', tenantId: 'placemakers', quoteId: 'q1', idempotencyKey: 'k1', status: 'paid', currency: 'nzd', total: 1033.86,
  subtotal: 899.01, discount: 0, tax: 134.85, taxRate: 0.15,
  lines: [
    { sku: '7603471', name: 'Boston Wall Hung Vanity', quantity: 1, unitPrice: 815.01, lineTotal: 815.01 },
    { sku: '7636725', name: 'Pop Up Waste', quantity: 2, unitPrice: 42, lineTotal: 84 },
  ],
  customer: { email: 'customer@example.test' },
  billing: { name: 'Sam Shopper', email: 'sam@example.test' },
  shipping: { name: 'Sam Shopper', address: { line1: '1 Queen St', city: 'Auckland', postalCode: '1010', country: 'NZ' } },
  createdAt: '2026-10-26T20:00:00.000Z', updatedAt: '2026-10-26T20:00:00.000Z',
  ...extra,
});

/** A connector server that answers like the real one: a JSON-RPC result whose text is the tool's payload. */
const answering = (payload: any, opts: { status?: number; rpcError?: string; isError?: boolean } = {}) => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const body = opts.rpcError ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: opts.rpcError } } : { jsonrpc: '2.0', id: 1, result: { isError: opts.isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } };
    return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => body } as any;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

function fakeCollection(first: OrderDoc) {
  const docs: OrderDoc[] = [first];
  return {
    docs,
    findOne: async (filter: any) => docs.find((d: any) => Object.entries(filter).every(([k, v]) => d[k] === v)) || null,
    insertOne: async (doc: OrderDoc) => { docs.push(doc); },
    updateOne: async (filter: any, update: any) => { const d: any = docs.find((x: any) => Object.entries(filter).every(([k, v]) => x[k] === v)); if (d) Object.assign(d, update.$set); },
    createIndex: async () => 'ok',
  };
}

async function main() {
  await suite.test('it is off unless ORDER_MIRROR=commercetools, and also off without an address or a key; the address and key fall back to the connectors\' own', () => {
    assert.equal(mirrorSettings({}), null);
    assert.equal(mirrorSettings({ ORDER_MIRROR_URL: 'http://x', ORDER_MIRROR_KEY: 'k' }), null, 'not switched on');
    assert.equal(mirrorSettings({ ORDER_MIRROR: 'commercetools', ORDER_MIRROR_URL: 'http://x' }), null, 'no key');
    assert.deepEqual(mirrorSettings(ON), { url: ON.ORDER_MIRROR_URL, key: 'key-1' });
    assert.deepEqual(
      mirrorSettings({ ORDER_MIRROR: 'commercetools', CONNECTOR_MCP_SERVERS: JSON.stringify({ commercetools: 'http://127.0.0.1:4020/mcp/commercetools' }), CONNECTOR_SECRET_REAL_CONNECTORS_KEY: 'real-key' }),
      { url: 'http://127.0.0.1:4020/mcp/commercetools', key: 'real-key' },
    );
    assert.equal(mirrorSettings({ ORDER_MIRROR: 'commercetools', CONNECTOR_MCP_SERVERS: '{not json', ORDER_MIRROR_KEY: 'k' }), null);
  });

  await suite.test('the customer\'s number is the last eight characters of the order id, upper case', () => {
    assert.equal(shownOrderNumber('ord_0123456789abcdef0123456789abcdef'), '89ABCDEF');
    assert.equal(shownOrderNumber(''), '');
  });

  await suite.test('what is sent: the number, currency in capitals, tax rate, lines before tax, who and where', () => {
    const args: any = placeOrderArguments(paid());
    assert.equal(args.orderNumber, '89ABCDEF');
    assert.equal(args.currency, 'NZD');
    assert.equal(args.taxRate, 0.15);
    assert.equal(args.customerEmail, 'sam@example.test', 'the billing e-mail wins');
    assert.equal(args.paid, true);
    assert.deepEqual(args.lines[1], { sku: '7636725', name: 'Pop Up Waste', quantity: 2, unitPrice: 42 });
    assert.deepEqual(args.shipping, { name: 'Sam Shopper', line1: '1 Queen St', line2: undefined, city: 'Auckland', state: undefined, postalCode: '1010', country: 'NZ' });
    assert.equal('discount' in args, false, 'no discount, none sent');
    assert.equal(placeOrderArguments(paid({ discount: 12.5 })).discount, 12.5);
    const noPrice: any = placeOrderArguments(paid({ lines: [{ sku: 'A-1', name: 'Gift', quantity: 4, unitPrice: null, lineTotal: 10 }] }));
    assert.equal(noPrice.lines[0].unitPrice, 2.5, 'a line with no unit price is priced from its total');
  });

  await suite.test('it asks the connector server\'s place_order with the key and the shop\'s name, and returns the number it was given', async () => {
    const server = answering({ ok: true, created: true, record: { orderNumber: '89ABCDEF', orderId: 'ct-order-1', paymentState: 'Paid' } });
    const result = await mirrorPaidOrder(paid(), { env: ON, fetchImpl: server.fetchImpl, now: () => new Date('2026-10-26T21:00:00.000Z') });
    assert.deepEqual(result, { ok: true, mirrored: { system: 'commercetools', orderNumber: '89ABCDEF', orderId: 'ct-order-1', at: '2026-10-26T21:00:00.000Z' } });
    const call = server.calls[0];
    assert.equal(call.url, ON.ORDER_MIRROR_URL);
    assert.equal(call.headers.authorization, 'Bearer key-1');
    assert.equal(call.headers['x-tenant-id'], 'placemakers');
    assert.equal(call.body.method, 'tools/call');
    assert.equal(call.body.params.name, 'place_order');
    assert.equal(call.body.params.arguments.orderNumber, '89ABCDEF');
  });

  await suite.test('it says nothing was tried when it is off, and gives a plain reason when it fails; an order that is not paid or has no lines is never sent', async () => {
    const server = answering({ ok: true, record: {} });
    assert.equal(await mirrorPaidOrder(paid(), { env: {}, fetchImpl: server.fetchImpl }), null);
    assert.equal(server.calls.length, 0);
    assert.deepEqual(await mirrorPaidOrder(paid({ status: 'pending_payment' }), { env: ON, fetchImpl: server.fetchImpl }), { ok: false, reason: 'The order is not paid.' });
    assert.deepEqual(await mirrorPaidOrder(paid({ lines: [] }), { env: ON, fetchImpl: server.fetchImpl }), { ok: false, reason: 'The order has no lines to record.' });
    assert.deepEqual(await mirrorPaidOrder(paid({ currency: '' }), { env: ON, fetchImpl: server.fetchImpl }), { ok: false, reason: 'The order has no currency.' });
    assert.equal(server.calls.length, 0);
    const down: any = await mirrorPaidOrder(paid(), { env: ON, fetchImpl: answering({}, { status: 502 }).fetchImpl });
    assert.match(down.reason, /answered 502/);
    const refused: any = await mirrorPaidOrder(paid(), { env: ON, fetchImpl: answering({}, { rpcError: 'Unknown tool' }).fetchImpl });
    assert.equal(refused.reason, 'Unknown tool');
    const vendor: any = await mirrorPaidOrder(paid(), { env: ON, fetchImpl: answering({ ok: false, error: { code: 'rejected', message: 'commercetools rejected the request.' } }, { isError: true }).fetchImpl });
    assert.equal(vendor.reason, 'commercetools rejected the request.');
    const broken: any = await mirrorPaidOrder(paid(), { env: ON, fetchImpl: (async () => { throw new Error('socket hang up'); }) as any });
    assert.equal(broken.reason, 'socket hang up');
  });

  await suite.test('a paid order is recorded once: the number is kept on the order, and a second call asks nobody', async () => {
    const col = fakeCollection(paid());
    const orders = new OrderService();
    (orders as any).getCol = async () => col;
    const server = answering({ ok: true, created: true, record: { orderNumber: '89ABCDEF', orderId: 'ct-order-1' } });
    orders.mirrorDeps = { env: ON, fetchImpl: server.fetchImpl, now: () => new Date('2026-10-26T21:00:00.000Z') };
    await orders.mirror('ord_0123456789abcdef0123456789abcdef');
    assert.equal(col.docs[0].externalOrder?.orderNumber, '89ABCDEF');
    assert.equal(col.docs[0].mirrorError, '');
    assert.equal(col.docs[0].status, 'paid');
    await orders.mirror('ord_0123456789abcdef0123456789abcdef');
    assert.equal(server.calls.length, 1, 'already recorded');
  });

  await suite.test('a failure is written on the order and changes nothing else; it is tried again when the order is next opened after half a minute', async () => {
    const col = fakeCollection(paid());
    const orders = new OrderService();
    (orders as any).getCol = async () => col;
    let now = new Date('2026-10-26T21:00:00.000Z');
    const down = answering({}, { status: 503 });
    orders.mirrorDeps = { env: ON, fetchImpl: down.fetchImpl, now: () => now };
    await orders.mirror('ord_0123456789abcdef0123456789abcdef');
    assert.match(col.docs[0].mirrorError || '', /503/);
    assert.equal(col.docs[0].externalOrder, undefined);
    assert.equal(col.docs[0].status, 'paid', 'the customer\'s order is untouched');
    assert.equal(col.docs[0].total, 1033.86);
    // Later, the server is back: opening the order tries again (the retry runs in the background, so wait for it).
    const up = answering({ ok: true, created: true, record: { orderNumber: '89ABCDEF', orderId: 'ct-order-1' } });
    now = new Date('2026-10-26T21:05:00.000Z');
    orders.mirrorDeps = { env: ON, fetchImpl: up.fetchImpl, now: () => now };
    col.docs[0].mirrorTriedAt = '2026-10-26T20:00:00.000Z';
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      await orders.get('ord_0123456789abcdef0123456789abcdef');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally { Date.now = realNow; }
    assert.equal(col.docs[0].externalOrder?.orderNumber, '89ABCDEF');
    assert.equal(up.calls.length, 1);
  });

  await suite.test('with the mirror off nothing is asked and nothing is written on the order', async () => {
    const col = fakeCollection(paid());
    const orders = new OrderService();
    (orders as any).getCol = async () => col;
    const server = answering({ ok: true, record: {} });
    orders.mirrorDeps = { env: {}, fetchImpl: server.fetchImpl };
    await orders.mirror('ord_0123456789abcdef0123456789abcdef');
    await orders.get('ord_0123456789abcdef0123456789abcdef');
    assert.equal(server.calls.length, 0);
    assert.equal(col.docs[0].mirrorTriedAt, undefined);
    assert.equal(col.docs[0].externalOrder, undefined);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
