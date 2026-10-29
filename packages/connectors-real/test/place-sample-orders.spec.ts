import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { placeSampleOrders, planOrders, problemsWith, requestFor, sampleOrderNumbers, statesFor, STATES, TRIAL } from '../scripts/loaders/place-sample-orders';
import { leaks, mockVendor, realDeps, suite, type Seen } from './helpers';

const t = suite('connectors-real: placing the sample orders in commercetools (the trial pair and the 36)');
const deps = realDeps(() => Date.UTC(2026, 9, 28, 12, 0, 0));
const SECRET = 'ct-loader-secret-never-printed-31c7';

/** The trial pair exactly as the approved spec shows them (the buyer id is read at run time). */
const SPEC_TRADE = {
  orderNumber: 'ORD-100034', customerId: 'cust-buyer-0004', businessUnit: { typeId: 'business-unit', key: 'acc-0004' }, store: { typeId: 'store', key: 'placemakers-nz' }, country: 'NZ', origin: 'Customer', inventoryMode: 'None',
  completedAt: '2026-08-11T09:00:00.000Z', orderState: 'Complete', shipmentState: 'Shipped', totalPrice: { currencyCode: 'NZD', centAmount: 131330 },
  lineItems: [
    { name: { 'en-NZ': 'Bitufoam Roof Seal 25 x 50mm x 2m A82PBIT5025' }, variant: { sku: '3433067' }, quantity: 19, price: { value: { currencyCode: 'NZD', centAmount: 2270 } } },
    { name: { 'en-NZ': 'Rusticated Weatherboard H3.2 Gisborne Profile No.2 Clears Pre-Primed 215 x 19mm' }, variant: { sku: '1357686' }, quantity: 36, price: { value: { currencyCode: 'NZD', centAmount: 2450 } } },
  ],
};
const SPEC_GUEST = {
  orderNumber: 'ORD-100004', customerEmail: 'guest-ord-100004@example.test', store: { typeId: 'store', key: 'placemakers-nz' }, country: 'NZ', origin: 'Customer', inventoryMode: 'None',
  completedAt: '2026-08-06T07:02:00.000Z', orderState: 'Complete', shipmentState: 'Shipped', totalPrice: { currencyCode: 'NZD', centAmount: 4647 },
  lineItems: [{ name: { 'en-NZ': '5-56 Industrial Lubricant 420ml 1751842' }, variant: { sku: '4080410' }, quantity: 3, price: { value: { currencyCode: 'NZD', centAmount: 1549 } } }],
};

/** A pretend commercetools that refuses what the real one refuses: an unknown unit or store, a repeated order number, no total. */
function commercetoolsShop(options: { refuseUnit?: boolean; dropCompletedAt?: boolean; withBuyerOrder?: boolean } = {}) {
  const orders = new Map<string, any>();
  const units = new Set(['acc-0004']);
  const stores = new Set(['placemakers-nz']);
  const imports: any[] = [];
  const refuse = (message: string, code = 'InvalidInput') => ({ status: 400, json: { statusCode: 400, message, errors: [{ code, message }] } });
  const answer = (request: Seen) => {
    const p = request.path.replace(/^\/shop/, '');
    if (request.path === '/oauth/token') return { json: { access_token: 'tok', expires_in: 3600 } };
    if (p === `/stores/key=placemakers-nz`) return stores.has('placemakers-nz') ? { json: { id: 's1' } } : { status: 404, json: { message: 'nope' } };
    const unit = /^\/business-units\/key=(.+)$/.exec(p);
    if (unit) return units.has(unit[1]) ? { json: { id: 'u1' } } : { status: 404, json: { message: 'nope' } };
    if (p === '/orders' && request.method === 'GET') {
      const key = /businessUnit\(key="([^"]+)"\)/.exec(request.query.get('where') ?? '')?.[1];
      return { json: { results: options.withBuyerOrder && key === 'acc-0004' ? [{ id: 'demo-order', customerId: 'cust-buyer-0004' }] : [] } };
    }
    if (p === '/customers/key=acc-0004-buyer') return { json: { id: 'cust-buyer-0004' } };
    const byNumber = /^\/orders\/order-number=(.+)$/.exec(p);
    if (byNumber) return orders.has(byNumber[1]) ? { json: orders.get(byNumber[1]) } : { status: 404, json: { message: 'nope' } };
    if (p === '/orders/import' && request.method === 'POST') {
      const body = request.body;
      imports.push(body);
      if (orders.has(body.orderNumber)) return refuse('duplicate order number', 'DuplicateField');
      if (!body.totalPrice) return refuse('totalPrice is required');
      if (body.businessUnit && (options.refuseUnit || !units.has(body.businessUnit.key))) return refuse(`The referenced object of type 'business-unit' was not found. Key: ${body.businessUnit.key}.`, 'ReferencedResourceNotFound');
      if (!stores.has(body.store.key)) return refuse('store not found', 'ReferencedResourceNotFound');
      const order = {
        id: `order-${orders.size + 1}`, version: 1, createdAt: '2026-10-28T12:00:00.000Z', ...body,
        ...(options.dropCompletedAt ? { completedAt: '2026-10-28T12:00:00.000Z' } : {}),
        lineItems: body.lineItems.map((line: any) => ({ ...line, price: line.price, totalPrice: { currencyCode: 'NZD', centAmount: line.price.value.centAmount * line.quantity } })),
      };
      orders.set(body.orderNumber, order);
      return { status: 201, json: order };
    }
    return undefined;
  };
  return { answer, orders, units, imports };
}

const envFor = (url: string, extra: Record<string, string> = {}) => ({
  COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: url, COMMERCETOOLS_AUTH_URL: url, COMMERCETOOLS_LOADER_CLIENT_ID: 'loader-id', COMMERCETOOLS_LOADER_CLIENT_SECRET: SECRET, ...extra,
});
const scratch = () => mkdtempSync(path.join(tmpdir(), 'place-sample-orders-'));

async function main() {
  await t.test('the 36 are the orders an ERP delivery or a Salesforce case names: 27 trade, 9 guest, 28 delivered by truck and 8 collected, 84 lines of 62 products', () => {
    const numbers = sampleOrderNumbers();
    assert.equal(numbers.length, 36);
    assert.equal(new Set(numbers).size, 36);
    const orders = planOrders(numbers);
    assert.equal(orders.filter((order) => order.kind === 'trade').length, 27);
    assert.equal(orders.filter((order) => order.kind === 'guest').length, 9);
    assert.equal(orders.filter((order) => order.deliveryType === 'delivery').length, 28);
    assert.equal(orders.filter((order) => order.deliveryType === 'click_and_collect').length, 8);
    assert.equal(orders.reduce((sum, order) => sum + order.lines.length, 0), 84);
    assert.equal(new Set(orders.flatMap((order) => order.lines.map((line) => line.sku))).size, 62);
    assert.ok(TRIAL.every((number) => numbers.includes(number)), 'the trial is two of the 36, not extra orders');
  });

  await t.test('prices: a trade order is placed at its account\'s tier price, a guest order at retail; the totals are the ones the review document shows', () => {
    const orders = planOrders(sampleOrderNumbers());
    assert.equal(orders.reduce((sum, order) => sum + order.retailCents, 0), 34684027, 'the sample, every line at retail: 346,840.27');
    assert.equal(orders.reduce((sum, order) => sum + order.totalCents, 0), 32703911, 'tier price for the trade orders, retail for the guests: 327,039.11');
    for (const order of orders) {
      if (order.kind === 'guest') assert.equal(order.totalCents, order.retailCents, `${order.orderNumber} is a guest order, so retail`);
      else assert.ok(order.totalCents < order.retailCents, `${order.orderNumber} is cheaper than retail at the ${order.tier} tier`);
      assert.equal(order.lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0), order.totalCents, `${order.orderNumber} lines add up to the total`);
    }
    const trade = orders.find((order) => order.orderNumber === 'ORD-100034')!;
    assert.deepEqual([trade.tier, trade.retailCents, trade.totalCents], ['bronze', 138235, 131330]);
  });

  await t.test('states: every one of the 36 gets a state from the table (nothing guessed), and a combination the table does not have is an error', () => {
    const orders = planOrders(sampleOrderNumbers());
    const count = (state: string) => orders.filter((order) => `${order.orderState}/${order.shipmentState ?? '-'}`.startsWith(state)).length;
    assert.equal(count('Complete/Shipped'), 13);
    assert.equal(count('Cancelled/-'), 1);
    assert.equal(count('Confirmed/Ready'), 10);
    assert.equal(count('Confirmed/Shipped'), 4);
    assert.equal(count('Open/Pending'), 4);
    assert.deepEqual(statesFor('delivered', 'delivered'), { orderState: 'Complete', shipmentState: 'Shipped' });
    assert.deepEqual(statesFor('cancelled'), { orderState: 'Cancelled' }, 'a cancelled order has no shipment state');
    assert.deepEqual(statesFor('confirmed', 'failed_attempt'), { orderState: 'Confirmed', shipmentState: 'Delayed' });
    assert.throws(() => statesFor('placed'), /No state is set for a sample order that is "placed" with no delivery/);
    assert.throws(() => statesFor('delivered', 'scheduled'), /"delivered" with a "scheduled" delivery/);
    assert.equal(Object.keys(STATES).length, 13);
  });

  await t.test('the two trial requests are exactly the ones in the approved spec', () => {
    const [trade, guest] = planOrders(TRIAL);
    assert.deepEqual(requestFor(trade, 'cust-buyer-0004'), SPEC_TRADE);
    assert.deepEqual(requestFor(guest), SPEC_GUEST);
    assert.match(String(requestFor(trade).customerId), /^<read at run time: the buyer of acc-0004>$/, 'a dry run says where the buyer comes from instead of inventing an id');
    assert.equal(TRIAL.join(','), 'ORD-100034,ORD-100004');
    assert.ok(planOrders(sampleOrderNumbers()).filter((order) => order.kind === 'guest').every((order) => /^guest-ord-1000\d\d@example\.test$/.test(requestFor(order).customerEmail)), 'every guest address is clearly fake');
  });

  await t.test('a dry run prints both requests and sends nothing, with or without credentials', async () => {
    const shop = commercetoolsShop();
    const ct = await mockVendor(shop.answer);
    const logs: string[] = [];
    const out = await placeSampleOrders({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: ct.url }, deps, apply: false, orders: TRIAL, log: (line) => logs.push(line) });
    assert.equal(ct.seen.length, 0, 'not even a sign-in');
    assert.deepEqual(out.results.map((result) => result.status), ['planned', 'planned']);
    const said = logs.join('\n');
    assert.match(said, /Dry run\. Would place 2 sample orders[\s\S]*1 trade at the account's tier price, 1 guest at retail/);
    assert.match(said, /ORD-100034 would be sent to POST \/orders\/import as:/);
    assert.match(said, /"centAmount": 131330/);
    assert.match(said, /Nothing was sent to be placed/);
    await ct.close();
  });

  await t.test('--check only reads: it signs in, looks at the number, the store, the unit and the buyer, fills in the buyer\'s id, and still places nothing', async () => {
    const shop = commercetoolsShop({ withBuyerOrder: true });
    const ct = await mockVendor(shop.answer);
    const logs: string[] = [];
    await placeSampleOrders({ env: envFor(ct.url), deps, apply: false, check: true, orders: TRIAL, log: (line) => logs.push(line) });
    assert.ok(ct.seen.length > 0);
    assert.ok(ct.seen.every((request) => request.method === 'GET' || request.path === '/oauth/token'), 'reads, and the sign-in');
    assert.equal(shop.imports.length, 0);
    const said = logs.join('\n');
    assert.match(said, /read: the buyer of acc-0004 is cust-buyer-0004/);
    assert.match(said, /read: business unit acc-0004 exists/);
    assert.match(said, /"customerId": "cust-buyer-0004"/);
    assert.ok(!leaks(logs, SECRET), 'the secret is never printed');
    await ct.close();
  });

  await t.test('a placement needs the loader\'s credentials, an order list, and for now only the trial pair', async () => {
    await assert.rejects(placeSampleOrders({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r' }, deps, apply: true, orders: TRIAL }), /COMMERCETOOLS_LOADER_CLIENT_ID, COMMERCETOOLS_LOADER_CLIENT_SECRET/);
    await assert.rejects(placeSampleOrders({ env: envFor('http://127.0.0.1:9'), deps, apply: false, orders: [] }), /Say which orders/);
    const ct = await mockVendor(commercetoolsShop().answer);
    await assert.rejects(placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: sampleOrderNumbers() }), /Only the trial pair \(ORD-100034, ORD-100004\) may be placed for now.*ORD-100002/);
    await assert.rejects(placeSampleOrders({ env: envFor(ct.url), deps, apply: false, orders: ['ORD-999999'] }), /ORD-999999 is not in the sample commerce data/);
    assert.equal(ct.seen.length, 0, 'refused before anything was sent');
    const all = await placeSampleOrders({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r' }, deps, apply: false, orders: sampleOrderNumbers() });
    assert.equal(all.results.length, 36, 'the whole batch can be looked at as a dry run');
    await ct.close();
  });

  await t.test('a placement imports the two orders, reads each back exactly as sent, and writes a manifest before the first and after every order; the buyer comes from the unit\'s existing order', async () => {
    const shop = commercetoolsShop({ withBuyerOrder: true });
    const ct = await mockVendor(shop.answer);
    const manifest = path.join(scratch(), 'm.json');
    const logs: string[] = [];
    const out = await placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: TRIAL, manifest, log: (line) => logs.push(line) });
    assert.deepEqual(out.results.map((result) => [result.orderNumber, result.status, result.readBack]), [['ORD-100034', 'placed', 'exactly as sent'], ['ORD-100004', 'placed', 'exactly as sent']]);
    assert.deepEqual(shop.imports, [SPEC_TRADE, SPEC_GUEST], 'what was sent is the spec');
    const written = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(written.finished, true);
    assert.deepEqual(written.orders.map((order: any) => [order.orderNumber, order.status, order.id, order.version]), [['ORD-100034', 'placed', 'order-1', 1], ['ORD-100004', 'placed', 'order-2', 1]]);
    assert.equal(written.orders[0].totalCents, 131330);
    assert.ok(ct.seen.filter((request) => request.method !== 'GET' && request.path !== '/oauth/token').every((request) => request.path === '/shop/orders/import'), 'the only write is the import');
    assert.match(logs.join('\n'), /Done: 2 placed, 0 already there\./);
    assert.ok(!leaks({ logs, written }, SECRET));
    await ct.close();
  });

  await t.test('without an existing order for the unit, the buyer is the customer the B2B loader made; running it again places nothing twice', async () => {
    const shop = commercetoolsShop();
    const ct = await mockVendor(shop.answer);
    const manifest = path.join(scratch(), 'again.json');
    await placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: TRIAL, manifest });
    assert.equal(shop.imports[0].customerId, 'cust-buyer-0004');
    const second = await placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: TRIAL, manifest });
    assert.deepEqual(second.results.map((result) => result.status), ['already there', 'already there']);
    assert.equal(shop.imports.length, 2, 'the second run imported nothing');
    await ct.close();
  });

  await t.test('when commercetools refuses the business unit, it stops at once, says why in the vendor\'s words, records the failure and places nothing else', async () => {
    const shop = commercetoolsShop({ refuseUnit: true });
    const ct = await mockVendor(shop.answer);
    const manifest = path.join(scratch(), 'refused.json');
    const logs: string[] = [];
    await assert.rejects(placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: TRIAL, manifest, log: (line) => logs.push(line) }), /business-unit.*not found/);
    assert.equal(shop.imports.length, 1, 'the guest order was not tried after the failure');
    assert.equal(shop.orders.size, 0);
    const written = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(written.finished, false);
    assert.deepEqual(written.orders.map((order: any) => order.status), ['failed', 'planned']);
    assert.match(written.orders[0].error, /business-unit/);
    assert.ok(!leaks({ logs, written }, SECRET));
    await ct.close();
  });

  await t.test('a trade order whose buyer cannot be found is not placed', async () => {
    const shop = commercetoolsShop();
    const ct = await mockVendor((request) => (request.path === '/shop/customers/key=acc-0004-buyer' ? { status: 404, json: { message: 'nope' } } : shop.answer(request)));
    await assert.rejects(placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: ['ORD-100034'], manifest: path.join(scratch(), 'nobuyer.json') }), /Could not find the buyer of acc-0004/);
    assert.equal(shop.imports.length, 0);
    await ct.close();
  });

  await t.test('the read-back catches what the import did not keep: a completed date of today, a wrong total, a missing unit, a missing line', async () => {
    const [trade] = planOrders(['ORD-100034']);
    const sent = requestFor(trade, 'cust-buyer-0004');
    const held = { ...sent, id: 'o1', version: 1, lineItems: sent.lineItems.map((line: any) => ({ ...line })) };
    assert.deepEqual(problemsWith(sent, held), []);
    assert.deepEqual(problemsWith(sent, { ...held, completedAt: '2026-10-28T12:00:00.000Z' }), ['completed date: sent 2026-08-11T09:00:00.000Z, held 2026-10-28T12:00:00.000Z']);
    assert.deepEqual(problemsWith(sent, { ...held, completedAt: '2026-08-11T21:00:00+12:00' }), [], 'the same instant in another notation is the same date');
    assert.deepEqual(problemsWith(sent, { ...held, totalPrice: { currencyCode: 'NZD', centAmount: 138235 } }), ['total: sent 131330, held 138235']);
    assert.deepEqual(problemsWith(sent, { ...held, businessUnit: undefined }), ['business unit: sent acc-0004, held (none)']);
    assert.deepEqual(problemsWith(sent, { ...held, orderState: 'Open' }), ['order state: sent Complete, held Open']);
    assert.deepEqual(problemsWith(sent, { ...held, lineItems: held.lineItems.slice(0, 1) }), ['number of lines: sent 2, held 1', 'line 1357686: not held']);
    const shop = commercetoolsShop({ dropCompletedAt: true });
    const ct = await mockVendor(shop.answer);
    const out = await placeSampleOrders({ env: envFor(ct.url), deps, apply: true, orders: ['ORD-100004'], manifest: path.join(scratch(), 'differs.json') });
    assert.match(String((out.results[0].readBack as string[])[0]), /^completed date: sent 2026-08-06T07:02:00.000Z, held 2026-10-28/, 'a store that ignores completedAt is reported, not hidden');
    await ct.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
