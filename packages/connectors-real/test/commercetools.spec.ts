import assert from 'node:assert/strict';
import { commercetools } from '../src/connectors/commercetools';
import { callTool, listTools, leaks, mockVendor, realDeps, serverFor, suite } from './helpers';

const SECRET = 'ct-client-secret-very-private-123';
const PROJECT = 'placemakers-trial';
const CART = '3f2a8c1e-0b7d-4c59-9d6e-5a1b2c3d4e5f';
const ORDER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const product = (id: string, sku: string, name: string, cents: number, extra: any = {}) => ({
  id, name: { en: name }, description: { en: `<p>${name} for the trade</p>` },
  masterVariant: { id: 1, sku, prices: [{ value: { type: 'centPrecision', currencyCode: 'NZD', centAmount: cents, fractionDigits: 2 } }], images: [{ url: `https://img.example/${sku}.jpg` }], attributes: [{ name: 'brand', value: 'Makita' }], availability: { isOnStock: true }, ...extra },
  variants: [],
});

const cart = (version = 3, state = 'Active') => ({
  id: CART, version, cartState: state, customerId: 'cust-1',
  lineItems: [{ id: 'li-1', name: { en: 'Combo kit' }, quantity: 2, variant: { sku: '5009059' }, price: { value: { currencyCode: 'NZD', centAmount: 60901, fractionDigits: 2 } }, totalPrice: { currencyCode: 'NZD', centAmount: 121802, fractionDigits: 2 } }],
  totalPrice: { currencyCode: 'NZD', centAmount: 121802, fractionDigits: 2 },
});

async function setup(answer: Parameters<typeof mockVendor>[0], extraEnv: Record<string, string> = {}) {
  const vendor = await mockVendor((request, count) => {
    if (request.path === '/oauth/token') return { json: { access_token: 'tok-1', expires_in: 172800, token_type: 'Bearer' } };
    return answer(request, count);
  });
  const env = {
    COMMERCETOOLS_PROJECT_KEY: PROJECT, COMMERCETOOLS_CLIENT_ID: 'client-id-1', COMMERCETOOLS_CLIENT_SECRET: SECRET, COMMERCETOOLS_REGION: 'australia-southeast1.gcp',
    COMMERCETOOLS_API_URL: vendor.url, COMMERCETOOLS_AUTH_URL: vendor.url, ...extraEnv,
  };
  const server = serverFor(commercetools(env, realDeps()));
  return { vendor, server, env, call: (name: string, args: any = {}) => callTool(server, 'commercetools', name, args) };
}

const t = suite('connectors-real: commercetools');

async function main() {
  await t.test('without its settings it is served but offers no tools and says it is not connected', async () => {
    const server = serverFor(commercetools({}, realDeps()));
    assert.deepEqual(await listTools(server, 'commercetools'), []);
    const result: any = await callTool(server, 'commercetools', 'find_product', { query: 'drill' });
    assert.equal(result.isError, true);
    assert.equal(result.payload.error.code, 'not_connected');
    assert.deepEqual(server.health().connectors[0].missing, ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_CLIENT_ID', 'COMMERCETOOLS_CLIENT_SECRET', 'COMMERCETOOLS_REGION']);
  });

  await t.test('it offers the same six tools as the sample SAP connector, and only add_to_cart changes anything', async () => {
    const { server, vendor } = await setup(() => undefined);
    const tools = await listTools(server, 'commercetools');
    assert.deepEqual(tools.map((tool) => tool.name), ['find_product', 'get_product', 'get_cart', 'add_to_cart', 'get_order', 'order_history']);
    assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name), ['add_to_cart']);
    await vendor.close();
  });

  await t.test('it signs in once with the API client (basic auth, client credentials) and reuses the token', async () => {
    const { vendor, call } = await setup(() => ({ json: { results: [], total: 0, count: 0 } }));
    await call('find_product', { query: 'drill' });
    await call('find_product', { query: 'saw' });
    const logins = vendor.seen.filter((request) => request.path === '/oauth/token');
    assert.equal(logins.length, 1);
    assert.equal(logins[0].method, 'POST');
    assert.equal(logins[0].headers.authorization, `Basic ${Buffer.from(`client-id-1:${SECRET}`).toString('base64')}`);
    assert.equal(logins[0].body.grant_type, 'client_credentials');
    assert.equal(logins[0].body.scope, undefined, 'no scope asked for unless one is set: the client keeps the scopes it was given');
    assert.equal(vendor.seen.filter((request) => request.path !== '/oauth/token').every((request) => request.headers.authorization === 'Bearer tok-1'), true);
    await vendor.close();
  });

  await t.test('find_product searches the published products by text and shapes the answer', async () => {
    const { vendor, call } = await setup(() => ({ json: { total: 41, count: 2, results: [product('p1', '5009059', 'Cordless combo kit', 60901), product('p2', '5009060', 'Impact driver', 25900)] } }));
    const { payload } = (await call('find_product', { query: 'cordless drill', brand: 'Makita', limit: 2 })) as any;
    const request = vendor.seen.find((r) => r.path.endsWith('/product-projections/search'))!;
    assert.equal(request.path, `/${PROJECT}/product-projections/search`);
    assert.equal(request.query.get('text.en'), 'cordless drill Makita');
    assert.equal(request.query.get('fuzzy'), 'true');
    assert.equal(request.query.get('staged'), 'false');
    assert.equal(request.query.get('limit'), '2');
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 41);
    assert.equal(payload.returned, 2);
    assert.deepEqual(payload.records[0], { productId: 'p1', sku: '5009059', name: 'Cordless combo kit', description: 'Cordless combo kit for the trade', brand: 'Makita', price: 609.01, currency: 'NZD', inStock: true, image: 'https://img.example/5009059.jpg', variantCount: 1 });
    await vendor.close();
  });

  await t.test('find_product with no words lists the most recently changed products, and the locale can be set', async () => {
    const { vendor, call } = await setup(() => ({ json: { results: [], total: 0, count: 0 } }), { COMMERCETOOLS_LOCALE: 'en-NZ' });
    await call('find_product', {});
    const request = vendor.seen.find((r) => r.path.endsWith('/product-projections/search'))!;
    assert.equal(request.query.get('sort'), 'lastModifiedAt desc');
    assert.equal(request.query.get('text.en-NZ'), null);
    await call('find_product', { query: 'hose' });
    assert.ok(vendor.seen.some((r) => r.query.get('text.en-NZ') === 'hose'));
    await vendor.close();
  });

  await t.test('get_product finds the product by sku, picks that variant, and says not found when there is none', async () => {
    const found = { ...product('p9', 'A-1', 'Hose reel', 4900), variants: [{ id: 2, sku: 'A-2', prices: [{ value: { currencyCode: 'NZD', centAmount: 5900, fractionDigits: 2 } }], attributes: [{ name: 'colour', value: { key: 'g', label: { en: 'Green' } } }] }] };
    const { vendor, call } = await setup((request) => (request.query.get('filter') === 'variants.sku:"A-2"' ? { json: { results: [found], total: 1, count: 1 } } : { json: { results: [], total: 0, count: 0 } }));
    const { payload } = (await call('get_product', { sku: 'A-2' })) as any;
    assert.equal(payload.record.matchedSku, 'A-2');
    assert.equal(payload.record.variant.price, 59);
    assert.deepEqual(payload.record.variant.attributes, { colour: 'Green' });
    const missing: any = await call('get_product', { sku: 'NOPE-1' });
    assert.equal(missing.payload.error.code, 'not_found');
    await vendor.close();
  });

  await t.test('a sku or id that could break out of the query is refused before anything is sent', async () => {
    const { vendor, call } = await setup(() => ({ json: {} }));
    for (const [tool, args] of [['get_product', { sku: 'x" or masterVariant.sku:"y' }], ['get_cart', { cartId: '../orders' }], ['order_history', { accountId: 'a" or customerId is defined' }], ['get_order', { orderId: 'a/b' }]] as const) {
      const result: any = await call(tool, args);
      assert.equal(result.payload.error.code, 'invalid_arguments', `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(vendor.seen.filter((request) => request.path !== '/oauth/token').length, 0);
    await vendor.close();
  });

  await t.test('get_cart shapes the lines and totals', async () => {
    const { vendor, call } = await setup((request) => (request.path === `/${PROJECT}/carts/${CART}` ? { json: cart() } : undefined));
    const { payload } = (await call('get_cart', { cartId: CART })) as any;
    assert.deepEqual(payload.record, { cartId: CART, version: 3, state: 'Active', customerId: 'cust-1', lineCount: 1, lines: [{ lineItemId: 'li-1', sku: '5009059', name: 'Combo kit', quantity: 2, unitPrice: 609.01, total: 1218.02 }], total: 1218.02, currency: 'NZD' });
    await vendor.close();
  });

  await t.test('add_to_cart reads the cart, adds the line against that version, and retries once if the cart changed meanwhile', async () => {
    let posts = 0;
    const { vendor, call } = await setup((request) => {
      if (request.method === 'GET') return { json: cart(posts === 0 ? 3 : 4) };
      posts++;
      return posts === 1 ? { status: 409, json: { message: 'Object has a different version than expected.' } } : { json: cart(5) };
    });
    const { payload } = (await call('add_to_cart', { cartId: CART, sku: '5009059', quantity: 2 })) as any;
    const writes = vendor.seen.filter((request) => request.method === 'POST' && request.path.startsWith(`/${PROJECT}/carts/`));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, { version: 3, actions: [{ action: 'addLineItem', sku: '5009059', quantity: 2 }] });
    assert.equal(writes[1].body.version, 4, 'the retry uses the fresh version');
    assert.equal(payload.updated, true);
    assert.equal(payload.record.version, 5);
    await vendor.close();
  });

  await t.test('add_to_cart refuses a cart that is not active, and a persistent conflict is reported, not looped on', async () => {
    const closed = await setup(() => ({ json: cart(3, 'Ordered') }));
    const refused: any = await closed.call('add_to_cart', { cartId: CART, sku: 'A-1', quantity: 1 });
    assert.equal(refused.payload.error.code, 'rejected');
    assert.equal(closed.vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token').length, 0);
    await closed.vendor.close();

    const busy = await setup((request) => (request.method === 'GET' ? { json: cart() } : { status: 409, json: { message: 'different version' } }));
    const result: any = await busy.call('add_to_cart', { cartId: CART, sku: 'A-1', quantity: 1 });
    assert.equal(result.payload.error.code, 'conflict');
    assert.equal(busy.vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token').length, 2);
    await busy.vendor.close();
  });

  await t.test('get_order takes an id or an order number, and shows only the town and postcode of the delivery', async () => {
    const order = { id: ORDER, orderNumber: 'PM-10042', orderState: 'Confirmed', shipmentState: 'Pending', customerId: 'cust-1', createdAt: '2026-10-20T01:02:03.000Z', totalPrice: { currencyCode: 'NZD', centAmount: 125000, fractionDigits: 2 }, shippingAddress: { streetName: '12 Private Lane', city: 'Hamilton', postalCode: '3200', country: 'NZ' }, lineItems: [{ name: { en: 'Combo kit' }, quantity: 2, variant: { sku: '5009059' }, totalPrice: { currencyCode: 'NZD', centAmount: 121802, fractionDigits: 2 } }] };
    const { vendor, call } = await setup((request) => (request.path === `/${PROJECT}/orders/${ORDER}` || request.path === `/${PROJECT}/orders/order-number=PM-10042` ? { json: order } : undefined));
    const byId = (await call('get_order', { orderId: ORDER })) as any;
    const byNumber = (await call('get_order', { orderId: 'PM-10042' })) as any;
    assert.deepEqual(byId.payload.record, byNumber.payload.record);
    assert.equal(byId.payload.record.orderNumber, 'PM-10042');
    assert.equal(byId.payload.record.itemCount, 2);
    assert.deepEqual(byId.payload.record.shipTo, { city: 'Hamilton', postalCode: '3200', country: 'NZ' });
    assert.equal(leaks(byId.payload, 'Private Lane'), false, 'a street address is never copied into the chat');
    await vendor.close();
  });

  await t.test('order_history asks for the account\'s orders, newest first, by state, and can use a business unit instead', async () => {
    const { vendor, call } = await setup(() => ({ json: { total: 2, count: 2, results: [{ id: ORDER, orderNumber: 'PM-1', orderState: 'Open', createdAt: '2026-10-21T00:00:00Z', totalPrice: { currencyCode: 'NZD', centAmount: 1000, fractionDigits: 2 }, lineItems: [{ quantity: 3 }] }] } }));
    const { payload } = (await call('order_history', { accountId: 'cust-0001', status: 'open', limit: 5 })) as any;
    const request = vendor.seen.find((r) => r.path === `/${PROJECT}/orders`)!;
    assert.equal(request.query.get('where'), 'customerId="cust-0001" and orderState="Open"');
    assert.equal(request.query.get('sort'), 'createdAt desc');
    assert.equal(request.query.get('limit'), '5');
    assert.deepEqual(payload.records[0], { orderId: ORDER, orderNumber: 'PM-1', state: 'Open', created: '2026-10-21T00:00:00Z', total: 10, currency: 'NZD', itemCount: 3 });
    await vendor.close();

    const unit = await setup(() => ({ json: { results: [], total: 0, count: 0 } }), { COMMERCETOOLS_ACCOUNT_KIND: 'businessUnit' });
    await unit.call('order_history', { accountId: 'unit-0001' });
    assert.equal(unit.vendor.seen.find((r) => r.path === `/${PROJECT}/orders`)!.query.get('where'), 'businessUnit(key="unit-0001")');
    await unit.vendor.close();
  });

  await t.test('an expired token is replaced once and the call is repeated; a refused sign-in is reported as such', async () => {
    let apiCalls = 0, logins = 0;
    const vendor = await mockVendor((request) => {
      if (request.path === '/oauth/token') { logins++; return { json: { access_token: `tok-${logins}`, expires_in: 172800 } }; }
      apiCalls++;
      return request.headers.authorization === 'Bearer tok-1' ? { status: 401, json: { message: 'invalid_token' } } : { json: { results: [], total: 0, count: 0 } };
    });
    const env = { COMMERCETOOLS_PROJECT_KEY: PROJECT, COMMERCETOOLS_CLIENT_ID: 'c', COMMERCETOOLS_CLIENT_SECRET: SECRET, COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: vendor.url, COMMERCETOOLS_AUTH_URL: vendor.url };
    const result: any = await callTool(serverFor(commercetools(env, realDeps())), 'commercetools', 'find_product', { query: 'x' });
    assert.equal(result.payload.ok, true);
    assert.equal(logins, 2);
    assert.equal(apiCalls, 2);
    await vendor.close();

    const refusing = await mockVendor((request) => (request.path === '/oauth/token' ? { status: 401, json: { error: 'invalid_client', error_description: `Client with id c and secret ${SECRET} not found` } } : undefined));
    const refused: any = await callTool(serverFor(commercetools({ ...env, COMMERCETOOLS_API_URL: refusing.url, COMMERCETOOLS_AUTH_URL: refusing.url }, realDeps())), 'commercetools', 'find_product', { query: 'x' });
    assert.equal(refused.payload.error.code, 'not_authorised');
    assert.equal(leaks(refused.payload, SECRET), false, 'the secret is hidden even when the vendor repeats it');
    await refusing.close();
  });

  await t.test('vendor failures become plain messages: 404, 429, 5xx, timeouts and an unreachable host', async () => {
    for (const [status, code] of [[404, 'not_found'], [429, 'rate_limited'], [503, 'unavailable'], [403, 'not_authorised'], [400, 'rejected']] as const) {
      const { vendor, call } = await setup(() => ({ status, json: { message: 'vendor says no' } }));
      const result: any = await call('get_cart', { cartId: CART });
      assert.equal(result.payload.error.code, code, String(status));
      assert.ok(result.payload.error.message.includes('commercetools'));
      await vendor.close();
    }
    const down = serverFor(commercetools({ COMMERCETOOLS_PROJECT_KEY: 'p', COMMERCETOOLS_CLIENT_ID: 'c', COMMERCETOOLS_CLIENT_SECRET: SECRET, COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: 'http://127.0.0.1:9', COMMERCETOOLS_AUTH_URL: 'http://127.0.0.1:9' }, realDeps()));
    const unreachable: any = await callTool(down, 'commercetools', 'find_product', { query: 'x' });
    assert.equal(unreachable.payload.error.code, 'unavailable');
    assert.equal(leaks(unreachable.payload, SECRET), false);
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
