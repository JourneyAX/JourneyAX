import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCommercetools } from '../scripts/loaders/commercetools';
import { loadSalesforce } from '../scripts/loaders/salesforce';
import { figuresFor, loadPowerBi } from '../scripts/loaders/power-bi';
import { planVisits, sendGoogleAnalytics } from '../scripts/loaders/google-analytics';
import { powerBi } from '../src/connectors/power-bi';
import { callTool, mockVendor, realDeps, serverFor, suite, leaks } from './helpers';

const t = suite('connectors-real: the loaders that fill a trial account with PlaceMakers-style data');
const deps = realDeps();

async function main() {
  // ── commercetools ────────────────────────────────────────────────────────────────────────────
  const CT_SECRET = 'ct-loader-secret-not-for-the-chat-555';
  const ctEnvFor = (url: string, extra: Record<string, string> = {}) => ({ COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: url, COMMERCETOOLS_AUTH_URL: url, COMMERCETOOLS_LOADER_CLIENT_ID: 'loader-id', COMMERCETOOLS_LOADER_CLIENT_SECRET: CT_SECRET, COMMERCETOOLS_CLIENT_ID: 'chat-id', COMMERCETOOLS_CLIENT_SECRET: 'chat-secret', ...extra });
  function commercetoolsShop(failOnProduct?: string) {
    const state = { type: false, products: new Set<string>(), customers: new Map<string, string>(), orders: new Set<string>(), carts: new Map<string, { id: string; customerId: string; state: string }>() };
    return {
      state,
      answer: (request: any) => {
        const p = request.path.replace(/^\/shop/, '');
        if (request.path === '/oauth/token') return { json: { access_token: 'tok', expires_in: 3600 } };
        if (p === '/product-types/key=placemakers-product') return state.type ? { json: { id: 't1' } } : { status: 404, json: { message: 'not found' } };
        if (p === '/product-types' && request.method === 'POST') { state.type = true; return { status: 201, json: { id: 't1' } }; }
        if (p === '/products' && request.method === 'POST') {
          if (failOnProduct && request.body.key === failOnProduct) return { status: 500, json: { message: 'boom' } };
          if (state.products.has(request.body.key)) return { status: 400, json: { errors: [{ code: 'DuplicateField', field: 'key' }] } };
          state.products.add(request.body.key); return { status: 201, json: { id: `prod-${state.products.size}` } };
        }
        if (p === '/customers' && request.method === 'GET') { const number = /customerNumber="([^"]+)"/.exec(request.query.get('where') ?? '')?.[1] ?? ''; return { json: { results: state.customers.has(number) ? [{ id: state.customers.get(number) }] : [] } }; }
        if (p === '/customers' && request.method === 'POST') { const id = `cust-${state.customers.size + 1}`; state.customers.set(request.body.customerNumber, id); return { status: 201, json: { customer: { id } } }; }
        if (p.startsWith('/orders/order-number=')) return state.orders.has(p.split('=')[1]) ? { json: { id: 'o' } } : { status: 404, json: { message: 'nope' } };
        if (p === '/carts' && request.method === 'POST') { const id = `cart-${state.carts.size + 1}`; state.carts.set(id, { id, customerId: request.body.customerId, state: 'Active' }); return { status: 201, json: { id, version: 1 } }; }
        if (p === '/carts' && request.method === 'GET') { const customerId = /customerId="([^"]+)"/.exec(request.query.get('where') ?? '')?.[1]; return { json: { results: [...state.carts.values()].filter((cart) => cart.customerId === customerId && cart.state === 'Active').slice(0, 1) } }; }
        if (p === '/orders' && request.method === 'POST') { state.orders.add(request.body.orderNumber); state.carts.get(request.body.id)!.state = 'Ordered'; return { status: 201, json: { id: `order-${state.orders.size}` } }; }
        return undefined;
      },
    };
  }

  await t.test('commercetools: a dry run sends nothing and needs no admin credentials; a load needs them', async () => {
    const vendor = await mockVendor(() => undefined);
    const logs: string[] = [];
    const dry = await loadCommercetools({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: vendor.url }, deps, apply: false, products: 5, customers: 2, log: (line) => logs.push(line) });
    assert.equal(vendor.seen.length, 0);
    assert.equal(dry.productType, 'would create');
    assert.match(logs[0], /Dry run\. Would load: 1 product type, 5 products, 2 customers/);
    await assert.rejects(loadCommercetools({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r' }, deps, apply: true }), /COMMERCETOOLS_LOADER_CLIENT_ID, COMMERCETOOLS_LOADER_CLIENT_SECRET/);
    await vendor.close();
  });

  await t.test('commercetools: it makes the product type, the products, customers, one order and one open cart each, with the loader\'s own credentials', async () => {
    const shop = commercetoolsShop();
    const vendor = await mockVendor(shop.answer);
    const summary = await loadCommercetools({ env: ctEnvFor(vendor.url), deps, apply: true, products: 6, customers: 3 });
    assert.equal(summary.productType, 'created');
    assert.deepEqual(summary.products, { created: 6, existing: 0 });
    assert.deepEqual(summary.customers, { created: 3, existing: 0 });
    assert.deepEqual(summary.orders, { created: 3, existing: 0 });
    assert.deepEqual(summary.carts, { created: 3, existing: 0 });
    const login = vendor.seen.find((request) => request.path === '/oauth/token')!;
    assert.equal(login.headers.authorization, `Basic ${Buffer.from(`loader-id:${CT_SECRET}`).toString('base64')}`, 'it signs in as the loader, not as the chat\'s connector');
    const type = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/product-types'))!;
    assert.deepEqual(type.body.attributes.map((attribute: any) => attribute.name), ['brand', 'department', 'unitOfMeasure']);
    const product = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/products'))!.body;
    assert.equal(product.publish, true);
    assert.match(product.key, /^pm-\d+$/);
    assert.equal(product.productType.key, 'placemakers-product');
    assert.equal(product.masterVariant.prices[0].value.currencyCode, 'NZD');
    assert.ok(Number.isInteger(product.masterVariant.prices[0].value.centAmount) && product.masterVariant.prices[0].value.centAmount > 0, 'a price in whole cents');
    assert.ok(product.masterVariant.attributes.some((attribute: any) => attribute.name === 'brand' && attribute.value));
    const customer = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/customers'))!.body;
    assert.equal(customer.customerNumber, 'ACC-0001');
    assert.match(customer.email, /@example\.test$/);
    assert.ok(customer.password.length >= 20, 'a long random password');
    const passwords = vendor.seen.filter((request) => request.method === 'POST' && request.path.endsWith('/customers')).map((request) => request.body.password);
    assert.equal(new Set(passwords).size, passwords.length, 'each customer gets a different password');
    const cart = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/carts'))!.body;
    assert.deepEqual({ currency: cart.currency, country: cart.country, taxMode: cart.taxMode }, { currency: 'NZD', country: 'NZ', taxMode: 'Disabled' });
    const order = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/orders'))!.body;
    assert.deepEqual(Object.keys(order).sort(), ['id', 'orderNumber', 'version']);
    assert.equal(order.orderNumber, 'DEMO-ORD-0001');
    assert.deepEqual(summary.ids.map((entry) => entry.orderNumber), ['DEMO-ORD-0001', 'DEMO-ORD-0002', 'DEMO-ORD-0003']);
    assert.ok(summary.ids.every((entry) => entry.customerId && entry.openCartId));
    await vendor.close();
  });

  await t.test('commercetools: running it again creates nothing new (products, customers, orders and open carts are found, not duplicated)', async () => {
    const shop = commercetoolsShop();
    const vendor = await mockVendor(shop.answer);
    await loadCommercetools({ env: ctEnvFor(vendor.url), deps, apply: true, products: 6, customers: 3 });
    const writes = () => vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token').length;
    const before = writes();
    const again = await loadCommercetools({ env: ctEnvFor(vendor.url), deps, apply: true, products: 6, customers: 3 });
    assert.equal(again.productType, 'existing');
    assert.deepEqual(again.products, { created: 0, existing: 6 });
    assert.deepEqual(again.customers, { created: 0, existing: 3 });
    assert.deepEqual(again.orders, { created: 0, existing: 3 });
    assert.deepEqual(again.carts, { created: 0, existing: 3 });
    assert.equal(writes() - before, 6, 'only the six product posts that the vendor answered "already there" to');
    await vendor.close();
  });

  await t.test('commercetools: a real error is reported in plain words and the secret is not in it', async () => {
    const first = commercetoolsShop();
    const key = `pm-${JSON.parse(readFileSync(path.resolve(__dirname, '../../connectors-sample/connectors/sap-commerce/seed.json'), 'utf8')).collections.products[1].sku}`;
    const shop = commercetoolsShop(key);
    const vendor = await mockVendor(shop.answer);
    const error: any = await loadCommercetools({ env: ctEnvFor(vendor.url), deps, apply: true, products: 3, customers: 1 }).catch((e) => e);
    assert.match(error.message, /not answering properly/);
    assert.equal(leaks(error.message, CT_SECRET), false);
    void first;
    await vendor.close();
  });

  // ── Salesforce ───────────────────────────────────────────────────────────────────────────────
  const SF_TOKEN = 'sf-loader-session-token-abcdef-123';
  await t.test('Salesforce: a dry run sends nothing; it loads accounts with a contact and their cases in one tree, mapping statuses to Salesforce\'s own', async () => {
    const vendor = await mockVendor((request) => {
      if (request.path.endsWith('/query')) return { json: { totalSize: 0, records: [] } };
      if (request.path.endsWith('/composite/tree/Account')) return { status: 201, json: { hasErrors: false, results: [] } };
      return undefined;
    });
    const env = { SALESFORCE_INSTANCE_URL: vendor.url, SALESFORCE_LOADER_ACCESS_TOKEN: SF_TOKEN };
    const dry = await loadSalesforce({ env: { SALESFORCE_INSTANCE_URL: vendor.url }, deps, apply: false, accounts: 5 });
    assert.equal(vendor.seen.length, 0);
    assert.deepEqual(dry.accounts, { created: 0, existing: 0 });
    const summary = await loadSalesforce({ env, deps, apply: true, accounts: 30 });
    assert.deepEqual(summary.accounts, { created: 30, existing: 0 });
    assert.equal(summary.contacts, 30);
    assert.equal(summary.cases, 44);
    assert.ok(vendor.seen.every((request) => request.headers.authorization === `Bearer ${SF_TOKEN}`));
    const posts = vendor.seen.filter((request) => request.method === 'POST');
    assert.equal(posts.length, 1, '104 records fit in one request');
    const records = posts[0].body.records;
    assert.equal(records.length, 30);
    assert.equal(records[0].attributes.type, 'Account');
    assert.equal(records[0].Name, 'Talbot & Nguyen Concrete Ltd');
    assert.equal(records[0].Contacts.records[0].LastName, 'Thornbury');
    const statuses = new Set(records.flatMap((record: any) => (record.Cases?.records ?? []).map((entry: any) => entry.Status)));
    for (const status of statuses) assert.ok(['New', 'Working', 'Escalated', 'Closed'].includes(status as string), `${status} is a status Salesforce knows`);
    const priorities = new Set(records.flatMap((record: any) => (record.Cases?.records ?? []).map((entry: any) => entry.Priority)));
    for (const priority of priorities) assert.ok(['Low', 'Medium', 'High'].includes(priority as string));
    assert.ok(records.every((record: any) => new Set((record.Cases?.records ?? []).map((entry: any) => entry.attributes.referenceId)).size === (record.Cases?.records ?? []).length), 'every record has its own reference id');
    await vendor.close();
  });

  await t.test('Salesforce: accounts already there are left alone, a refusal is explained, and custom tier and branch fields are filled when named', async () => {
    const existing = await mockVendor((request) => (request.path.endsWith('/query') ? { json: { totalSize: 1, records: [{ Name: 'Talbot & Nguyen Concrete Ltd' }] } } : { status: 201, json: { hasErrors: false, results: [] } }));
    const summary = await loadSalesforce({ env: { SALESFORCE_INSTANCE_URL: existing.url, SALESFORCE_LOADER_ACCESS_TOKEN: SF_TOKEN, SALESFORCE_TIER_FIELD: 'Customer_Tier__c', SALESFORCE_BRANCH_FIELD: 'Home_Branch__c' }, deps, apply: true, accounts: 4 });
    assert.deepEqual(summary.accounts, { created: 3, existing: 1 });
    const tree = existing.seen.find((request) => request.method === 'POST')!.body.records;
    assert.ok(!tree.some((record: any) => record.Name === 'Talbot & Nguyen Concrete Ltd'));
    assert.ok(tree.every((record: any) => record.Customer_Tier__c && record.Home_Branch__c));
    const soql = existing.seen.find((request) => request.path.endsWith('/query'))!.query.get('q')!;
    assert.match(soql, /SELECT Name FROM Account WHERE Name IN \('Talbot & Nguyen Concrete Ltd'/);
    await existing.close();

    const refusing = await mockVendor((request) => (request.path.endsWith('/query') ? { json: { records: [] } } : { status: 400, json: { hasErrors: true, results: [{ referenceId: 'acc0', errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]' }] }] } }));
    await assert.rejects(loadSalesforce({ env: { SALESFORCE_INSTANCE_URL: refusing.url, SALESFORCE_LOADER_ACCESS_TOKEN: SF_TOKEN }, deps, apply: true, accounts: 2 }), /Required fields are missing/);
    await refusing.close();
    await assert.rejects(loadSalesforce({ env: { SALESFORCE_INSTANCE_URL: 'http://x' }, deps, apply: true }), /SALESFORCE_LOADER_ACCESS_TOKEN/);
  });

  // ── Power BI ─────────────────────────────────────────────────────────────────────────────────
  await t.test('Power BI: it makes the dataset once, replaces its rows each time, and writes a figures file the connector accepts', async () => {
    const WORKSPACE = '11111111-2222-3333-4444-555555555555';
    const DATASET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const state = { created: 0, rows: new Map<string, number>(), deleted: [] as string[] };
    const vendor = await mockVendor((request) => {
      if (request.path === '/token') return { json: { access_token: 'pbi', expires_in: 3600 } };
      if (request.path === `/v1.0/myorg/groups/${WORKSPACE}/datasets` && request.method === 'GET') return { json: { value: state.created ? [{ id: DATASET, name: 'PlaceMakers demo' }] : [] } };
      if (request.path === `/v1.0/myorg/groups/${WORKSPACE}/datasets` && request.method === 'POST') { state.created++; return { status: 201, json: { id: DATASET } }; }
      const rows = new RegExp(`/datasets/${DATASET}/tables/(\\w+)/rows$`).exec(request.path);
      if (rows && request.method === 'DELETE') { state.deleted.push(rows[1]); return { json: {} }; }
      if (rows && request.method === 'POST') { state.rows.set(rows[1], (state.rows.get(rows[1]) ?? 0) + request.body.rows.length); return { json: {} }; }
      return undefined;
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'pbi-load-'));
    const figuresFile = path.join(dir, 'figures.json');
    const env = { POWERBI_TENANT_ID: 'contoso.onmicrosoft.com', POWERBI_WORKSPACE_ID: WORKSPACE, POWERBI_LOADER_CLIENT_ID: 'loader', POWERBI_LOADER_CLIENT_SECRET: 'pbi-loader-secret-999999', POWERBI_API_URL: `${vendor.url}/v1.0/myorg`, POWERBI_TOKEN_URL: `${vendor.url}/token` };
    const dry = await loadPowerBi({ env: { POWERBI_TENANT_ID: 'x', POWERBI_WORKSPACE_ID: WORKSPACE }, deps, apply: false });
    assert.equal(dry.figures.length, 3);
    assert.equal(vendor.seen.length, 0, 'a dry run sends nothing');

    const first = await loadPowerBi({ env, deps, apply: true, figuresFile });
    assert.equal(first.dataset, 'created');
    const create = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/datasets'))!;
    assert.equal(create.body.defaultMode, 'Push');
    assert.deepEqual(create.body.tables.map((table: any) => table.name), ['Orders', 'Cases']);
    assert.equal(state.rows.get('Orders'), 48);
    assert.equal(state.rows.get('Cases'), 44);
    const second = await loadPowerBi({ env, deps, apply: true, figuresFile });
    assert.equal(second.dataset, 'existing');
    assert.equal(state.created, 1, 'the dataset is made once');
    assert.deepEqual(state.deleted.sort(), ['Cases', 'Cases', 'Orders', 'Orders'].sort(), 'the rows are cleared before each reload');
    assert.equal(state.rows.get('Orders'), 96, 'replaced, not appended: 48 cleared then 48 loaded each time (the mock only counts loads)');

    // The file it wrote is one the connector reads without complaint, and it names the dataset that was made.
    const written = JSON.parse(readFileSync(figuresFile, 'utf8'));
    assert.ok(written.every((entry: any) => entry.datasetId === DATASET));
    assert.deepEqual(written, figuresFor(DATASET));
    const connector = serverFor(powerBi({ ...env, POWERBI_CLIENT_ID: 'chat', POWERBI_CLIENT_SECRET: 'chat-secret-1234567', POWERBI_REPORTS_FILE: figuresFile }, deps));
    const listed: any = await callTool(connector, 'power-bi', 'list_reports', {});
    assert.deepEqual(listed.payload.records.filter((record: any) => record.hasFigures).map((record: any) => record.reportId), ['sales-by-branch', 'orders-by-status', 'cases-by-priority']);
    await vendor.close();
  });

  // ── Google Analytics ─────────────────────────────────────────────────────────────────────────
  await t.test('Google Analytics: the visits are repeatable, recent enough for Google to accept, and shaped like real page views, searches and key events', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0) * 1000;
    const plan = planVisits({ sessionsPerDay: 20, nowMicros: now });
    assert.equal(plan.sessions, 60);
    assert.deepEqual(planVisits({ sessionsPerDay: 20, nowMicros: now }), plan, 'the same run makes the same traffic');
    const oldest = Math.min(...plan.visits.map((visit) => visit.startedMicros));
    assert.ok(now - oldest < 72 * 3600 * 1_000_000, 'nothing is older than the 72 hours Google accepts');
    assert.ok(plan.visits.every((visit) => visit.startedMicros < now));
    const names = new Set(plan.visits.flatMap((visit) => visit.events.map((event) => event.name)));
    assert.deepEqual([...names].sort(), ['generate_lead', 'page_view', 'view_search_results']);
    const view = plan.visits[0].events[0];
    assert.match(String(view.params.page_location), /^https:\/\/demo\.placemakers\.example\//);
    assert.ok(Number(view.params.engagement_time_msec) > 0, 'an engaged visit, so it counts as an active user');
    assert.ok(plan.visits.every((visit) => visit.events.every((event) => event.params.session_id === visit.sessionId)));
  });

  await t.test('Google Analytics: it sends in small requests with the secret in the query only, can be checked by Google without recording, and a dry run sends nothing', async () => {
    const GA_SECRET = 'ga-api-secret-xyz-123456';
    const vendor = await mockVendor((request) => (request.path === '/debug/mp/collect' ? { json: { validationMessages: [{ description: 'Event param "x" is not valid.' }] } } : { status: 204, text: '' }));
    const env = { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: GA_SECRET, GA4_MP_URL: vendor.url };
    await sendGoogleAnalytics({ env: {}, deps, apply: false, sessions: 2 });
    assert.equal(vendor.seen.length, 0);
    const sent = await sendGoogleAnalytics({ env, deps, apply: true, sessions: 4 });
    assert.equal(sent.sent, sent.events);
    assert.ok(vendor.seen.every((request) => request.path === '/mp/collect' && request.query.get('measurement_id') === 'G-TEST123' && request.query.get('api_secret') === GA_SECRET));
    assert.ok(vendor.seen.every((request) => !request.raw.includes(GA_SECRET)), 'the secret is not in a request body');
    assert.ok(vendor.seen.every((request) => request.body.events.length <= 25 && /^\d+$/.test(request.body.timestamp_micros) && request.body.client_id));
    const before = vendor.seen.length;
    const checked = await sendGoogleAnalytics({ env, deps, apply: true, debug: true, sessions: 1 });
    assert.ok(vendor.seen.slice(before).every((request) => request.path === '/debug/mp/collect'), 'debug goes to Google\'s checking endpoint, which records nothing');
    assert.match(checked.problems[0], /not valid/);
    await assert.rejects(sendGoogleAnalytics({ env: {}, deps, apply: true }), /GA4_MEASUREMENT_ID, GA4_API_SECRET/);
    await vendor.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
