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

  await t.test('it offers the shop tools, three more for stock and trade accounts and place_order for the shop, and only add_to_cart and place_order change anything', async () => {
    const { server, vendor } = await setup(() => undefined);
    const tools = await listTools(server, 'commercetools');
    assert.deepEqual(tools.map((tool) => tool.name), ['find_product', 'get_product', 'get_cart', 'add_to_cart', 'place_order', 'get_order', 'order_history', 'list_orders', 'stock_by_branch', 'find_account', 'get_account']);
    assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name), ['add_to_cart', 'place_order']);
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

  const hit = (found: any) => ({ id: found.id, productProjection: found });
  const groups = { results: [{ id: 'g-gold', key: 'gold' }, { id: 'g-silver', key: 'silver' }] };
  const withTiers = (found: any, prices: Array<[string | undefined, number]>) => ({
    ...found,
    masterVariant: { ...found.masterVariant, prices: prices.map(([group, cents]) => ({ value: { type: 'centPrecision', currencyCode: 'NZD', centAmount: cents, fractionDigits: 2 }, ...(group ? { customerGroup: { typeId: 'customer-group', id: group } } : {}) })) },
  });
  const searchBodies = (vendor: Awaited<ReturnType<typeof mockVendor>>) => vendor.seen.filter((r) => r.path.endsWith('/products/search')).map((r) => r.body);

  await t.test('find_product uses Product Search: every word in the name, the brand by part of its value, and the answer carries the retail price and each tier\'s price', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.path.endsWith('/products/search')) return { json: { total: 41, results: [hit(withTiers(product('p1', '5009059', 'Cordless combo kit', 60901), [[undefined, 60901], ['g-gold', 54811], ['g-silver', 57856]])), hit(product('p2', '5009060', 'Impact driver', 25900))] } };
      if (request.path.endsWith('/customer-groups')) return { json: groups };
      return undefined;
    });
    const { payload } = (await call('find_product', { query: 'cordless drill', brand: 'Makita', limit: 2 })) as any;
    const request = vendor.seen.find((r) => r.path.endsWith('/products/search'))!;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/${PROJECT}/products/search`);
    assert.deepEqual(request.body, {
      limit: 2,
      query: { and: [{ fullText: { field: 'name', language: 'en', value: 'cordless drill', mustMatch: 'all' } }, { wildcard: { field: 'variants.attributes.brand', fieldType: 'text', value: '*Makita*', caseInsensitive: true } }] },
      productProjectionParameters: { staged: false },
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 41);
    assert.equal(payload.returned, 2);
    assert.deepEqual(payload.records[0], { productId: 'p1', sku: '5009059', name: 'Cordless combo kit', description: 'Cordless combo kit for the trade', brand: 'Makita', price: 609.01, currency: 'NZD', tierPrices: { gold: 548.11, silver: 578.56 }, inStock: true, image: 'https://img.example/5009059.jpg', variantCount: 1 });
    assert.equal(payload.records[1].tierPrices, undefined, 'a product with no tier prices says nothing about tiers');
    await vendor.close();
  });

  await t.test('find_product falls back to any word when no product has them all, lists the newest with no words, searches in the set language, and never lets a wildcard through', async () => {
    const { vendor, call } = await setup((request) => (request.path.endsWith('/products/search') ? { json: { total: 0, results: [] } } : { json: groups }), { COMMERCETOOLS_LOCALE: 'en-NZ', COMMERCETOOLS_CURRENCY: 'NZD' });
    await call('find_product', { query: 'hose reel' });
    let bodies = searchBodies(vendor);
    assert.deepEqual(bodies.map((body) => body.query.fullText.mustMatch), ['all', 'any'], 'all the words first, then any of them');
    assert.equal(bodies[0].query.fullText.language, 'en-NZ');
    assert.deepEqual(bodies[0].productProjectionParameters, { staged: false, priceCurrency: 'NZD' });
    await call('find_product', {});
    bodies = searchBodies(vendor);
    assert.deepEqual(bodies.at(-1).sort, [{ field: 'lastModifiedAt', order: 'desc' }]);
    assert.equal(bodies.at(-1).query, undefined);
    await call('find_product', { department: 'clad*?\\' });
    assert.equal(searchBodies(vendor).at(-1).query.wildcard.value, '*clad*', 'wildcard characters in what the model sends are dropped');
    assert.equal(vendor.seen.filter((r) => r.path.endsWith('/customer-groups')).length, 0, 'nothing found, so no need to look up the tiers');
    await vendor.close();
  });

  await t.test('get_product finds the product by sku, picks that variant, shows its tier prices, and says not found when there is none', async () => {
    const found = { ...product('p9', 'A-1', 'Hose reel', 4900), variants: [{ id: 2, sku: 'A-2', prices: [{ value: { currencyCode: 'NZD', centAmount: 5900, fractionDigits: 2 } }, { value: { currencyCode: 'NZD', centAmount: 5310, fractionDigits: 2 }, customerGroup: { typeId: 'customer-group', id: 'g-gold' } }], attributes: [{ name: 'colour', value: { key: 'g', label: { en: 'Green' } } }] }] };
    const { vendor, call } = await setup((request) => {
      if (request.path.endsWith('/customer-groups')) return { json: groups };
      return request.body?.query?.exact?.value === 'A-2' ? { json: { results: [hit(found)], total: 1 } } : { json: { results: [], total: 0 } };
    });
    const { payload } = (await call('get_product', { sku: 'A-2' })) as any;
    assert.deepEqual(searchBodies(vendor)[0].query, { exact: { field: 'variants.sku', value: 'A-2' } });
    assert.equal(payload.record.matchedSku, 'A-2');
    assert.equal(payload.record.variant.price, 59, 'the retail price, not the tier price');
    assert.deepEqual(payload.record.variant.tierPrices, { gold: 53.1 });
    assert.deepEqual(payload.record.variant.attributes, { colour: 'Green' });
    const missing: any = await call('get_product', { sku: 'NOPE-1' });
    assert.equal(missing.payload.error.code, 'not_found');
    await vendor.close();
  });

  await t.test('stock_by_branch lists the branches holding a product, most first, can look at one branch, and says when a branch has none', async () => {
    const stock = (quantity: number, code: string, name: string, available = quantity) => ({ quantityOnStock: quantity, availableQuantity: available, supplyChannel: { obj: { key: `branch-${code}`, name: { 'en-NZ': name } } } });
    const { vendor, call } = await setup((request) => (request.path.endsWith('/inventory') ? { json: { results: request.query.get('where') === 'sku="A-1"' ? [stock(10, '224', 'Hamilton', 8), stock(0, '385', 'Tauranga'), stock(55, '146', 'Wanaka')] : [] } } : undefined));
    const all = ((await call('stock_by_branch', { sku: 'A-1' })) as any).payload;
    assert.equal(vendor.seen.find((r) => r.path.endsWith('/inventory'))!.query.get('expand'), 'supplyChannel');
    assert.deepEqual(all.records, [{ branch: 'Wanaka', branchCode: '146', onHand: 55, available: 55 }, { branch: 'Hamilton', branchCode: '224', onHand: 10, available: 8 }, { branch: 'Tauranga', branchCode: '385', onHand: 0, available: 0 }]);
    assert.equal(all.totalOnHand, 65);
    assert.equal(all.branchesHolding, 2, 'a branch with none on hand does not count as holding it');
    const one = ((await call('stock_by_branch', { sku: 'A-1', branch: 'ham' })) as any).payload;
    assert.deepEqual(one.records.map((row: any) => row.branch), ['Hamilton']);
    assert.equal(one.matching, 1);
    const none = ((await call('stock_by_branch', { sku: 'A-1', branch: 'dunedin' })) as any).payload;
    assert.equal(none.matching, 0);
    assert.match(none.note, /No stock entry for a branch matching "dunedin"\. This product is held at 3 other branches/);
    const unknown: any = await call('stock_by_branch', { sku: 'NOPE-1' });
    assert.equal(unknown.payload.error.code, 'not_found');
    const bad: any = await call('stock_by_branch', { sku: 'x" or sku="y' });
    assert.equal(bad.payload.error.code, 'invalid_arguments');
    await vendor.close();
  });

  const unit = (key: string, name: string, fields: Record<string, any>, extra: any = {}) => ({
    key, name, unitType: 'Company', status: 'Active', contactEmail: 'admin@example.test', addresses: [{ city: 'Hamilton' }],
    custom: { fields: { accountNumber: key.toUpperCase(), tier: 'silver', tradeType: 'concreter', homeBranchCode: '224', accountManager: 'Hemi A', paymentTerms: '20th of the month', creditLimit: { type: 'centPrecision', currencyCode: 'NZD', centAmount: 1000000, fractionDigits: 2 }, ...fields } }, ...extra,
  });
  const CUSTOMER = '1b2c3d4e-0000-4000-8000-000000000001';
  const SF_ID = '001i8000008Uu8HAAS';

  await t.test('find_account finds trade accounts by part of the name, the number or the key, by tier, and says when it searched only part of them', async () => {
    const units = [unit('acc-0001', 'Talbot & Nguyen Concrete Ltd', { salesforceAccountId: SF_ID }), unit('acc-0002', 'Harlow & Talbot Landscapes Ltd', { tier: 'gold' }), unit('acc-0003', 'Dunmore Ltd', { tier: 'gold' })];
    const { vendor, call } = await setup((request) => (request.path.endsWith('/business-units') ? { json: { total: units.length, results: units } } : undefined));
    const byName = ((await call('find_account', { query: 'talbot' })) as any).payload;
    assert.deepEqual(byName.records.map((r: any) => r.unitKey), ['acc-0001', 'acc-0002']);
    assert.deepEqual(byName.records[0], { unitKey: 'acc-0001', name: 'Talbot & Nguyen Concrete Ltd', kind: 'Company', status: 'Active', accountNumber: 'ACC-0001', tier: 'silver', tradeType: 'concreter', homeBranchCode: '224', accountManager: 'Hemi A', paymentTerms: '20th of the month', creditLimit: 10000, currency: 'NZD', salesforceAccountId: SF_ID, contactEmail: 'admin@example.test', city: 'Hamilton' });
    assert.deepEqual(((await call('find_account', { query: 'acc-0003' })) as any).payload.records.map((r: any) => r.unitKey), ['acc-0003']);
    assert.deepEqual(((await call('find_account', { tier: 'gold' })) as any).payload.records.map((r: any) => r.unitKey), ['acc-0002', 'acc-0003']);
    assert.deepEqual(((await call('find_account', { query: 'talbot', tier: 'gold' })) as any).payload.records.map((r: any) => r.unitKey), ['acc-0002']);
    const part = await setup((request) => (request.path.endsWith('/business-units') ? { json: { total: 900, results: units } } : undefined));
    assert.match((((await part.call('find_account', {})) as any).payload.note), /Only the first 3 of 900 units were searched/);
    await vendor.close(); await part.vendor.close();
  });

  await t.test('get_account takes a unit key, an account number or a Salesforce id, and shows the terms, the people with their roles, the divisions and the order count', async () => {
    const acc = unit('acc-0001', 'Talbot & Nguyen Concrete Ltd', { salesforceAccountId: SF_ID }, { associates: [{ customer: { typeId: 'customer', id: CUSTOMER }, associateRoleAssignments: [{ associateRole: { typeId: 'associate-role', key: 'account-admin' } }] }] });
    const { vendor, call } = await setup((request) => {
      if (request.path.endsWith('/business-units/key=acc-0001')) return { json: acc };
      if (request.path.includes('/business-units/key=')) return { status: 404, json: { message: 'not found' } };
      if (request.path.endsWith('/business-units')) return request.query.get('where')?.startsWith('parentUnit') ? { json: { results: [{ key: 'acc-0001-div1', name: 'Talbot - Projects' }] } } : { json: { total: 1, results: [acc] } };
      if (request.path.endsWith('/customers')) return { json: { results: [{ id: CUSTOMER, firstName: 'Tessa', lastName: 'Thornbury', email: 'tessa@example.test' }] } };
      if (request.path.endsWith('/orders')) return { json: { total: 4, results: [] } };
      return undefined;
    });
    const direct = ((await call('get_account', { accountId: 'acc-0001' })) as any).payload.record;
    assert.equal(direct.name, 'Talbot & Nguyen Concrete Ltd');
    assert.deepEqual(direct.people, [{ name: 'Tessa Thornbury', email: 'tessa@example.test', roles: ['account-admin'] }]);
    assert.deepEqual(direct.divisions, [{ unitKey: 'acc-0001-div1', name: 'Talbot - Projects' }]);
    assert.equal(direct.orderCount, 4);
    assert.equal(direct.salesforceAccountId, SF_ID);
    assert.match(vendor.seen.find((r) => r.path.endsWith('/customers'))!.query.get('where')!, new RegExp(`^id in \\("${CUSTOMER}"\\)$`));
    assert.equal(((await call('get_account', { accountId: 'ACC-0001' })) as any).payload.record.unitKey, 'acc-0001', 'the account number (any case) finds it too');
    assert.equal(((await call('get_account', { accountId: SF_ID })) as any).payload.record.unitKey, 'acc-0001', 'and so does the Salesforce id');
    const missing: any = await call('get_account', { accountId: 'acc-9999' });
    assert.equal(missing.payload.error.code, 'not_found');
    assert.match(missing.payload.error.message, /no account acc-9999/);
    const bad: any = await call('get_account', { accountId: 'a" or key is defined' });
    assert.equal(bad.payload.error.code, 'invalid_arguments');
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

  await t.test('list_orders asks for the newest orders of every account, by state, shipment and how recent, and says when there are more', async () => {
    const order = { id: ORDER, orderNumber: 'PM-2', orderState: 'Open', shipmentState: 'Pending', createdAt: '2026-10-26T01:00:00Z', totalPrice: { currencyCode: 'NZD', centAmount: 325375, fractionDigits: 2 }, lineItems: [{ quantity: 5 }], shippingAddress: { city: 'Oamaru', country: 'NZ', streetName: '1 Secret Street' } };
    const { vendor, call } = await setup(() => ({ json: { total: 9, count: 1, results: [order] } }));
    const { payload } = (await call('list_orders', { status: 'open', shipment: 'pending', sinceHours: 48, limit: 1 })) as any;
    const request = vendor.seen.find((r) => r.path === `/${PROJECT}/orders`)!;
    assert.match(request.query.get('where')!, /^orderState="Open" and shipmentState="Pending" and createdAt >= "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/);
    const since = Date.parse(/createdAt >= "([^"]+)"/.exec(request.query.get('where')!)![1]);
    assert.ok(Math.abs(Date.now() - 48 * 3_600_000 - since) < 60_000, 'forty-eight hours back from now');
    assert.equal(request.query.get('sort'), 'createdAt desc');
    assert.equal(request.query.get('limit'), '1');
    assert.equal(payload.total, 9);
    assert.equal(payload.more, true, '1 of 9 returned');
    assert.equal(payload.records[0].shipmentState, 'Pending');
    assert.deepEqual(payload.records[0].shipTo, { city: 'Oamaru', country: 'NZ' }, 'only the town, never the street');
    assert.ok(!JSON.stringify(payload).includes('Secret Street'));
    await call('list_orders', {});
    assert.equal(vendor.seen.filter((r) => r.path === `/${PROJECT}/orders`).pop()!.query.get('where'), null, 'no filter, no where');
    await vendor.close();
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

  await t.test('get_order shows the custom lines of an order the shop recorded, with the tax-inclusive total and the tax', async () => {
    const { vendor, call } = await setup(() => ({ json: {
      id: ORDER, orderNumber: 'A1B2C3D4', orderState: 'Open', paymentState: 'Paid',
      customLineItems: [{ name: { en: 'Boston Wall Hung Vanity' }, slug: '7603471', quantity: 1, totalPrice: { currencyCode: 'NZD', centAmount: 81501, fractionDigits: 2 } }, { name: { en: 'Pop Up Waste' }, slug: '7636725', quantity: 2, totalPrice: { currencyCode: 'NZD', centAmount: 8400, fractionDigits: 2 } }],
      totalPrice: { currencyCode: 'NZD', centAmount: 89901, fractionDigits: 2 },
      taxedPrice: { totalGross: { currencyCode: 'NZD', centAmount: 103386, fractionDigits: 2 }, totalTax: { currencyCode: 'NZD', centAmount: 13485, fractionDigits: 2 } },
    } }));
    const { payload } = (await call('get_order', { orderId: 'A1B2C3D4' })) as any;
    assert.equal(payload.record.total, 1033.86);
    assert.equal(payload.record.tax, 134.85);
    assert.equal(payload.record.itemCount, 3);
    assert.deepEqual(payload.record.lines.map((line: any) => [line.sku, line.quantity, line.total]), [['7603471', 1, 815.01], ['7636725', 2, 84]]);
    await vendor.close();
  });
  await t.test('place_order makes one cart of custom lines with external tax, turns it into the order with the customer\'s number, and marks it paid', async () => {
    const placed = (version: number, extra: any = {}) => ({
      id: ORDER, version, orderNumber: 'A1B2C3D4', orderState: 'Open', paymentState: extra.paymentState, createdAt: '2026-10-26T20:00:00.000Z',
      customLineItems: [{ name: { en: 'Boston Wall Hung Vanity' }, slug: '7603471', quantity: 1, totalPrice: { currencyCode: 'NZD', centAmount: 81501, fractionDigits: 2 } }, { name: { en: 'Pop Up Waste' }, slug: '7636725', quantity: 2, totalPrice: { currencyCode: 'NZD', centAmount: 8400, fractionDigits: 2 } }],
      taxedPrice: { totalNet: { currencyCode: 'NZD', centAmount: 89901 }, totalGross: { currencyCode: 'NZD', centAmount: 103386, fractionDigits: 2 }, totalTax: { currencyCode: 'NZD', centAmount: 13485, fractionDigits: 2 } },
      totalPrice: { currencyCode: 'NZD', centAmount: 89901, fractionDigits: 2 },
    });
    const { vendor, call } = await setup((request) => {
      if (request.method === 'GET' && request.path.includes('/orders/order-number=')) return { status: 404, json: { message: 'not found' } };
      if (request.method === 'POST' && request.path === `/${PROJECT}/carts`) return { json: { id: CART, version: 1 } };
      if (request.method === 'POST' && request.path === `/${PROJECT}/orders`) return { json: placed(1) };
      if (request.method === 'POST' && request.path === `/${PROJECT}/orders/${ORDER}`) return { json: placed(2, { paymentState: 'Paid' }) };
      return undefined;
    });
    const { payload } = (await call('place_order', {
      orderNumber: 'A1B2C3D4', currency: 'NZD', taxRate: 0.15, customerEmail: 'shopper@example.test', discount: 0,
      lines: [{ sku: '7603471', name: 'Boston Wall Hung Vanity', quantity: 1, unitPrice: 815.01 }, { sku: '7636725', name: 'Pop Up Waste', quantity: 2, unitPrice: 42 }],
      shipping: { name: 'Sam Shopper', line1: '1 Queen St', city: 'Auckland', postalCode: '1010', country: 'NZ' },
    })) as any;
    const posts = vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token');
    assert.deepEqual(posts.map((request) => request.path), [`/${PROJECT}/carts`, `/${PROJECT}/orders`, `/${PROJECT}/orders/${ORDER}`]);
    const body = posts[0].body;
    assert.equal(body.taxMode, 'External');
    assert.equal(body.currency, 'NZD');
    assert.equal(body.customLineItems.length, 2);
    assert.deepEqual(body.customLineItems[0].money, { type: 'centPrecision', currencyCode: 'NZD', centAmount: 81501 });
    assert.deepEqual(body.customLineItems[1].externalTaxRate, { name: 'GST', amount: 0.15, country: 'NZ' });
    assert.equal(body.customLineItems[1].quantity, 2);
    assert.equal(body.shippingAddress.city, 'Auckland');
    assert.deepEqual(posts[1].body, { id: CART, version: 1, orderNumber: 'A1B2C3D4' });
    assert.deepEqual(posts[2].body.actions, [{ action: 'changePaymentState', paymentState: 'Paid' }]);
    assert.equal(payload.created, true);
    assert.equal(payload.record.orderNumber, 'A1B2C3D4');
    assert.equal(payload.record.paymentState, 'Paid');
    assert.equal(payload.record.lineCount, 2);
    assert.equal(payload.record.total, 1033.86);
    await vendor.close();
  });
  await t.test('place_order spreads a discount over the lines before tax, and asking again for the same order number returns that order without making another', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.method === 'GET' && request.path.includes('/orders/order-number=')) return { json: { id: ORDER, version: 2, orderNumber: 'A1B2C3D4', orderState: 'Open', paymentState: 'Paid', customLineItems: [], totalPrice: { currencyCode: 'NZD', centAmount: 100 } } };
      return undefined;
    });
    const again = (await call('place_order', { orderNumber: 'A1B2C3D4', currency: 'NZD', lines: [{ sku: 'A-1', name: 'One', quantity: 1, unitPrice: 10 }] })) as any;
    assert.equal(again.payload.created, false);
    assert.equal(again.payload.record.orderNumber, 'A1B2C3D4');
    assert.equal(vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token').length, 0, 'nothing was made');
    await vendor.close();
    const discounted = await setup((request) => {
      if (request.method === 'GET') return { status: 404, json: {} };
      if (request.path === `/${PROJECT}/carts`) return { json: { id: CART, version: 1 } };
      return { json: { id: ORDER, version: 1, orderNumber: 'X1', customLineItems: [], totalPrice: { currencyCode: 'NZD', centAmount: 0 } } };
    });
    await discounted.call('place_order', { orderNumber: 'X1', currency: 'NZD', taxRate: 0.15, discount: 10, paid: false, lines: [{ sku: 'A-1', name: 'One', quantity: 1, unitPrice: 60 }, { sku: 'B-2', name: 'Two', quantity: 1, unitPrice: 40 }] });
    const cartBody = discounted.vendor.seen.find((request) => request.path === `/${PROJECT}/carts` && request.method === 'POST')!.body;
    assert.deepEqual(cartBody.customLineItems.map((line: any) => line.money.centAmount), [5400, 3600], '10 off 100 is 10% off each line');
    assert.equal(discounted.vendor.seen.filter((request) => request.method === 'POST' && request.path.startsWith(`/${PROJECT}/orders/`)).length, 0, 'paid: false leaves the payment state alone');
    await discounted.vendor.close();
  });
  await t.test('place_order refuses bad lines before the vendor is asked anything', async () => {
    const { vendor, call } = await setup(() => undefined);
    for (const lines of [[], [{ sku: 'A-1', name: 'One', quantity: 0, unitPrice: 5 }], [{ sku: 'A-1', name: '', quantity: 1, unitPrice: 5 }], [{ sku: 'A-1', name: 'One', quantity: 1, unitPrice: -1 }], [{ sku: '??', name: 'One', quantity: 1, unitPrice: 5 }]]) {
      const answer: any = await call('place_order', { orderNumber: 'N1', currency: 'NZD', lines });
      assert.ok(answer.isError, JSON.stringify(lines));
    }
    const noCurrency: any = await call('place_order', { orderNumber: 'N1', currency: 'dollars', lines: [{ sku: 'A-1', name: 'One', quantity: 1, unitPrice: 5 }] });
    assert.ok(noCurrency.isError);
    assert.equal(vendor.seen.filter((request) => request.path !== '/oauth/token').length, 0, 'the vendor was never asked');
    await vendor.close();
  });
  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
