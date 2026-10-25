import assert from 'node:assert/strict';
import { loadCommercetoolsB2b, plan, ROLES } from '../scripts/loaders/commercetools-b2b';
import { setting } from '../src/http';
import { plan as launch } from '../scripts/loaders/story';
import { mockVendor, realDeps, suite, leaks, type Seen } from './helpers';

const t = suite('connectors-real: the B2B loader that sets up commercetools like a trade business');
const deps = realDeps();
const SECRET = 'ct-admin-secret-never-printed-9d41';
const SF_SECRET = 'sf-client-secret-never-printed-62aa';

/** A pretend commercetools that refuses what the real one refuses: a missing reference, a duplicate key, a currency the project does not have. */
function commercetoolsShop(options: { failOnProduct?: string } = {}) {
  const project = { version: 1, currencies: ['EUR', 'USD'], countries: ['DE', 'US'], languages: ['de-DE', 'en-US'] };
  const things = new Map<string, Map<string, any>>();
  const of = (collection: string) => { if (!things.has(collection)) things.set(collection, new Map()); return things.get(collection)!; };
  const has = (collection: string, key: string) => of(collection).has(key);
  const missing = (what: string) => ({ status: 400, json: { errors: [{ code: 'ReferencedResourceNotFound', message: `The referenced object of type '${what}' was not found.` }] } });
  const carts = new Map<string, any>();
  const orders = new Set<string>();
  const customersByEmail = new Set<string>();
  const collections = ['customer-groups', 'stores', 'product-types', 'categories', 'products', 'channels', 'inventory', 'associate-roles', 'types', 'business-units'];
  const identity = (collection: string, body: any) => (collection === 'inventory' ? `${body.sku}|${body.supplyChannel?.key}` : body.key);

  const answer = (request: Seen) => {
    const p = request.path.replace(/^\/shop/, '');
    if (request.path === '/oauth/token') return { json: { access_token: 'tok', expires_in: 3600 } };
    if (p === '' && request.method === 'GET') return { json: project };
    if (p === '' && request.method === 'POST') {
      for (const action of request.body.actions) {
        if (action.action === 'changeCurrencies') project.currencies = action.currencies;
        if (action.action === 'changeCountries') project.countries = action.countries;
        if (action.action === 'changeLanguages') project.languages = action.languages;
      }
      project.version++;
      return { json: project };
    }
    const collection = collections.find((name) => p === `/${name}`);
    if (collection && request.method === 'POST') {
      const body = request.body;
      const id = identity(collection, body);
      if (collection === 'products' && options.failOnProduct && body.key === options.failOnProduct) return { status: 500, json: { message: 'boom' } };
      if (of(collection).has(id)) return { status: 400, json: { errors: [{ code: 'DuplicateField', field: 'key' }] } };
      // The references the real API checks.
      if (collection === 'categories' && body.parent && !has('categories', body.parent.key)) return missing('category');
      if (collection === 'products') {
        if (!has('product-types', body.productType.key)) return missing('product-type');
        for (const category of body.categories ?? []) if (!has('categories', category.key)) return missing('category');
        for (const price of body.masterVariant.prices) {
          if (!project.currencies.includes(price.value.currencyCode)) return { status: 400, json: { errors: [{ code: 'InvalidField', message: `currency ${price.value.currencyCode} is not allowed in this project` }] } };
          if (price.customerGroup && !has('customer-groups', price.customerGroup.key)) return missing('customer-group');
        }
        if (!body.name[project.languages.find((language) => body.name[language])!]) return { status: 400, json: { errors: [{ code: 'InvalidField', message: 'no language of the project' }] } };
      }
      if (collection === 'inventory' && !has('channels', body.supplyChannel.key)) return missing('channel');
      if (collection === 'business-units') {
        for (const associate of body.associates ?? []) {
          if (!has('customers', associate.customer.key)) return missing('customer');
          for (const assignment of associate.associateRoleAssignments) if (!has('associate-roles', assignment.associateRole.key)) return missing('associate-role');
        }
        if (body.custom && !has('types', body.custom.type.key)) return missing('type');
        if (body.parentUnit && !has('business-units', body.parentUnit.key)) return missing('business-unit');
        for (const store of body.stores ?? []) if (!has('stores', store.key)) return missing('store');
      }
      of(collection).set(id, body);
      return { status: 201, json: { id: `${collection}-${of(collection).size}` } };
    }
    if (p === '/customers' && request.method === 'POST') {
      const body = request.body;
      if (has('customers', body.key) || customersByEmail.has(body.email)) return { status: 400, json: { errors: [{ code: 'DuplicateField', field: 'email' }] } };
      if (body.customerGroup && !has('customer-groups', body.customerGroup.key)) return missing('customer-group');
      of('customers').set(body.key, { ...body, id: `cust-${of('customers').size + 1}` });
      customersByEmail.add(body.email);
      return { status: 201, json: { customer: { id: of('customers').get(body.key).id } } };
    }
    const unitByKey = /^\/business-units\/key=(.+)$/.exec(p);
    if (unitByKey) {
      const unit = of('business-units').get(decodeURIComponent(unitByKey[1]));
      if (!unit) return { status: 404, json: { message: 'no such unit' } };
      if (request.method === 'GET') return { json: { ...unit, version: unit.version ?? 1 } };
      for (const action of request.body.actions) if (action.action === 'setCustomField') unit.custom.fields[action.name] = action.value;
      unit.version = (unit.version ?? 1) + 1;
      return { json: unit };
    }
    if (p.startsWith('/customers/key=')) { const found = of('customers').get(decodeURIComponent(p.split('=')[1])); return found ? { json: { id: found.id } } : { status: 404, json: { message: 'nope' } }; }
    if (p.startsWith('/orders/order-number=')) return orders.has(p.split('=')[1]) ? { json: { id: 'o' } } : { status: 404, json: { message: 'nope' } };
    if (p === '/carts' && request.method === 'POST') {
      const body = request.body;
      if (!has('business-units', body.businessUnit.key) || !has('stores', body.store.key)) return missing('business-unit or store');
      const id = `cart-${carts.size + 1}`;
      // Priced the way the shop prices it: the customer's tier price where the product has one, else the retail price.
      const group = [...of('customers').values()].find((customer) => customer.id === body.customerId)?.customerGroup?.key;
      let total = 0;
      for (const line of body.lineItems) {
        const product = [...of('products').values()].find((entry) => entry.masterVariant.sku === line.sku);
        if (!product) return missing('product');
        const prices = product.masterVariant.prices;
        const price = prices.find((entry: any) => group && entry.customerGroup?.key === group) ?? prices.find((entry: any) => !entry.customerGroup);
        total += price.value.centAmount * line.quantity;
      }
      const cart = { id, version: 1, totalPrice: { centAmount: total, currencyCode: 'NZD' } };
      carts.set(id, { id, customerId: body.customerId, state: 'Active', body, cart });
      return { status: 201, json: cart };
    }
    if (p === '/carts' && request.method === 'GET') {
      const customerId = /customerId="([^"]+)"/.exec(request.query.get('where') ?? '')?.[1];
      return { json: { results: [...carts.values()].filter((cart) => cart.customerId === customerId && cart.state === 'Active').map((cart) => ({ id: cart.id })) } };
    }
    if (p === '/orders' && request.method === 'POST') { orders.add(request.body.orderNumber); const held = carts.get(request.body.id)!; held.state = 'Ordered'; held.orderNumber = request.body.orderNumber; return { status: 201, json: { id: `order-${orders.size}`, totalPrice: held.cart.totalPrice } }; }
    return undefined;
  };
  return { answer, project, things, of, carts, orders };
}

/** A pretend Salesforce that knows the sample accounts by name, and remembers what is written into their descriptions. */
function salesforceOrg() {
  const descriptions = new Map<string, string>();
  const ids = new Map<string, string>();
  const answer = (request: Seen) => {
    if (request.path === '/services/oauth2/token') return { json: { access_token: 'sf-tok' } };
    if (request.path.endsWith('/query')) {
      const q = request.query.get('q') ?? '';
      const names = [...q.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1].replace(/\\(.)/g, '$1'));
      return { json: { records: names.map((name) => { if (!ids.has(name)) ids.set(name, `001SF${String(ids.size + 1).padStart(4, '0')}`); return { Id: ids.get(name), Name: name, Description: descriptions.get(ids.get(name)!) ?? 'Trade type: sample.' }; }) } };
    }
    const patch = /\/sobjects\/Account\/(001SF\d+)$/.exec(request.path);
    if (patch && request.method === 'PATCH') { descriptions.set(patch[1], request.body.Description); return { status: 204, text: '' }; }
    return undefined;
  };
  return { answer, descriptions, ids };
}

const envFor = (ct: string, sf: string, extra: Record<string, string> = {}) => ({
  COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: ct, COMMERCETOOLS_AUTH_URL: ct, COMMERCETOOLS_LOADER_CLIENT_ID: 'loader-id', COMMERCETOOLS_LOADER_CLIENT_SECRET: SECRET,
  SALESFORCE_INSTANCE_URL: sf, SALESFORCE_CLIENT_ID: 'sf-id', SALESFORCE_CLIENT_SECRET: SF_SECRET, ...extra,
});

async function main() {
  await t.test('the Merchant Center\'s CTP_* block is accepted as it comes, and the region is read from its host; the COMMERCETOOLS_ name wins when both are set', () => {
    const block = { CTP_PROJECT_KEY: 'placemaker', CTP_CLIENT_ID: 'id-1', CTP_CLIENT_SECRET: 'sec-1', CTP_API_URL: 'https://api.us-central1.gcp.commercetools.com', CTP_AUTH_URL: 'https://auth.us-central1.gcp.commercetools.com', CTP_SCOPES: 'manage_project:placemaker' };
    assert.equal(setting(block, 'COMMERCETOOLS_PROJECT_KEY'), 'placemaker');
    assert.equal(setting(block, 'COMMERCETOOLS_REGION'), 'us-central1.gcp');
    assert.equal(setting(block, 'COMMERCETOOLS_CLIENT_SECRET'), 'sec-1');
    assert.equal(setting(block, 'COMMERCETOOLS_LOADER_CLIENT_ID'), 'id-1', 'the one wide client does the loading when no other is given');
    const narrow = { ...block, COMMERCETOOLS_CLIENT_ID: 'chat-id', COMMERCETOOLS_CLIENT_SECRET: 'chat-sec' };
    assert.equal(setting(narrow, 'COMMERCETOOLS_CLIENT_ID'), 'chat-id', 'a narrow client set for the chat replaces the pasted one there');
    assert.equal(setting(narrow, 'COMMERCETOOLS_LOADER_CLIENT_ID'), 'id-1', 'while the loader keeps the wide one');
    assert.equal(setting({ COMMERCETOOLS_API_URL: 'http://127.0.0.1:9' }, 'COMMERCETOOLS_REGION'), undefined, 'no region is guessed from a host that is not commercetools');
  });

  await t.test('the plan is the same every time and fits together: every product is in a category, every unit has people, the biggest accounts have divisions', () => {
    const a = plan(100, 30);
    const b = plan(100, 30);
    assert.deepEqual(a.units.map((unit) => unit.key), b.units.map((unit) => unit.key));
    assert.equal(a.sampleProducts.length, 100);
    assert.ok(a.sampleProducts.every((product) => a.leafOf.has(String(product.sku))), 'every product has a category');
    for (const category of a.categories) if (category.parent) assert.ok(a.categories.some((other) => other.key === category.parent), `${category.key} has its parent`);
    assert.equal(a.units.filter((unit) => !unit.parent).length, 30);
    assert.equal(a.units.filter((unit) => unit.parent).length, 12, 'six big accounts, two divisions each');
    assert.equal(new Set(a.people.map((person) => person.key)).size, a.people.length, 'no two people share a key');
    assert.equal(new Set(a.people.map((person) => person.email)).size, a.people.length, 'no two people share an e-mail address');
    assert.ok(a.people.every((person) => /@example\.test$/.test(person.email)), 'all sample addresses');
    assert.ok(a.units.every((unit) => unit.associates.length >= 1));
    assert.ok(a.units.filter((unit) => !unit.parent).every((unit) => unit.associates.some((associate) => associate.role === 'account-admin') && unit.associates.some((associate) => associate.role === 'buyer')));
    assert.ok(ROLES.every((role) => role.permissions.length > 0));
  });

  await t.test('a dry run sends nothing to either system; a load needs the loader\'s credentials', async () => {
    const ct = await mockVendor(() => undefined);
    const sf = await mockVendor(() => undefined);
    const logs: string[] = [];
    const dry = await loadCommercetoolsB2b({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: ct.url, SALESFORCE_INSTANCE_URL: sf.url, SALESFORCE_CLIENT_ID: 'x', SALESFORCE_CLIENT_SECRET: 'y' }, deps, apply: false, products: 5, accounts: 3, log: (line) => logs.push(line) });
    assert.equal(ct.seen.length + sf.seen.length, 0);
    assert.equal(dry.products.created, 0);
    assert.match(logs.join('\n'), /Dry run\. Would load into commercetools:[\s\S]*add the NZD currency, the NZ country and the en-NZ language/);
    assert.match(logs.join('\n'), /5 products, each with a retail price and the 3 trade-tier prices/);
    assert.match(logs.join('\n'), /Salesforce: would look the 3 accounts up by name/);
    await assert.rejects(loadCommercetoolsB2b({ env: { COMMERCETOOLS_PROJECT_KEY: 'shop', COMMERCETOOLS_REGION: 'r' }, deps, apply: true }), /COMMERCETOOLS_LOADER_CLIENT_ID, COMMERCETOOLS_LOADER_CLIENT_SECRET/);
    await ct.close(); await sf.close();
  });

  await t.test('a load adds NZ money, country and language to the project (and removes nothing), then builds the catalogue, stock, roles, units, people, orders and carts in an order the vendor accepts', async () => {
    const shop = commercetoolsShop();
    const org = salesforceOrg();
    const ct = await mockVendor(shop.answer);
    const sf = await mockVendor(org.answer);
    const summary = await loadCommercetoolsB2b({ env: envFor(ct.url, sf.url), deps, apply: true, products: 8, accounts: 4 });
    const planned = plan(8, 4);

    assert.deepEqual(shop.project.currencies, ['EUR', 'USD', 'NZD']);
    assert.deepEqual(shop.project.countries, ['DE', 'US', 'NZ']);
    assert.deepEqual(shop.project.languages, ['de-DE', 'en-US', 'en-NZ']);
    assert.deepEqual(summary.project, ['currency NZD', 'country NZ', 'language en-NZ']);
    assert.deepEqual([...shop.of('customer-groups').keys()], ['bronze', 'silver', 'gold']);
    assert.equal(summary.categories.created, planned.categories.length);
    assert.deepEqual(summary.products, { created: 8, existing: 0 });
    const product = [...shop.of('products').values()][0];
    assert.equal(product.masterVariant.prices.length, 4, 'a retail price and a price for each trade tier');
    assert.deepEqual(product.masterVariant.prices.slice(1).map((price: any) => price.customerGroup.key), ['bronze', 'silver', 'gold']);
    const [retail, bronze, silver, gold] = product.masterVariant.prices.map((price: any) => price.value.centAmount);
    assert.ok(gold <= silver && silver <= bronze && bronze <= retail, 'the better the tier, the lower the price');
    assert.equal(summary.branches.created, planned.usedBranches.length);
    assert.equal(summary.inventory.created, planned.stock.length);
    assert.ok([...shop.of('inventory').values()].every((entry) => Number.isInteger(entry.quantityOnStock) && entry.quantityOnStock >= 0), 'whole, non-negative stock');
    assert.equal(summary.roles.created, ROLES.length);

    assert.equal(summary.customers.created, planned.people.length);
    assert.equal(summary.companies.created, 4);
    assert.equal(summary.divisions.created, 8, 'the four accounts are all among the six biggest, so each has two divisions');
    const company = shop.of('business-units').get('acc-0001');
    assert.equal(company.unitType, 'Company');
    assert.deepEqual(company.stores, [{ typeId: 'store', key: 'placemakers-nz' }]);
    assert.equal(company.addresses[0].country, 'NZ');
    assert.equal(company.associates[0].associateRoleAssignments[0].associateRole.key, 'account-admin');
    assert.equal(company.custom.fields.accountNumber, 'ACC-0001');
    assert.equal(company.custom.fields.salesforceAccountId, org.ids.get(company.name), 'the unit says which Salesforce account it is');
    assert.deepEqual(company.custom.fields.creditLimit.currencyCode, 'NZD');
    const division = shop.of('business-units').get('acc-0001-div1');
    assert.equal(division.unitType, 'Division');
    assert.equal(division.parentUnit.key, 'acc-0001');
    assert.equal(division.associateMode, 'ExplicitAndFromParent');
    const person = [...shop.of('customers').values()][0];
    assert.match(person.email, /@example\.test$/);
    assert.ok(person.password.length >= 20);
    assert.equal(new Set([...shop.of('customers').values()].map((entry) => entry.password)).size, planned.people.length, 'each person gets a different password');
    assert.ok(['bronze', 'silver', 'gold'].includes(person.customerGroup.key));
    assert.deepEqual(summary.orders, { created: 4, existing: 0 });
    assert.deepEqual(summary.carts, { created: 4, existing: 0 });
    const cart = [...shop.carts.values()][0].body;
    assert.deepEqual({ currency: cart.currency, country: cart.country, taxMode: cart.taxMode, store: cart.store.key, unit: cart.businessUnit.key }, { currency: 'NZD', country: 'NZ', taxMode: 'Disabled', store: 'placemakers-nz', unit: 'acc-0001' });
    assert.deepEqual(summary.ids.map((entry) => entry.orderNumber), ['DEMO-ORD-0001', 'DEMO-ORD-0002', 'DEMO-ORD-0003', 'DEMO-ORD-0004']);

    assert.deepEqual(summary.salesforce, { found: 4, missing: 0, noted: 4 });
    const note = [...org.descriptions.values()][0];
    assert.match(note, /Trade type: sample\. Account number ACC-0001\. commercetools unit acc-0001\./);
    const login = ct.seen.find((request) => request.path === '/oauth/token')!;
    assert.equal(login.headers.authorization, `Basic ${Buffer.from(`loader-id:${SECRET}`).toString('base64')}`, 'it signs in as the loader');
    await ct.close(); await sf.close();
  });

  await t.test('the deals Salesforce shows as won become orders here with the same products at the same prices, and each unit names its Salesforce rep, also for units made before the reps were chosen', async () => {
    const shop = commercetoolsShop();
    const ct = await mockVendor(shop.answer);
    const summary = await loadCommercetoolsB2b({ env: envFor(ct.url, 'http://127.0.0.1:9'), deps, apply: true, salesforce: false });
    const won = launch().opportunities.filter((deal) => deal.stage === 'Closed Won');
    assert.equal(won.length, 6);
    assert.deepEqual(summary.launchOrders, { created: 6, existing: 0 });
    assert.deepEqual(summary.launchTotals.map((entry) => entry.order).sort(), won.map((deal) => deal.orderNumber).sort());
    assert.ok(summary.launchTotals.every((entry) => Math.abs(entry.commercetools - entry.salesforce) < 0.005), 'each order totals what the Salesforce deal does');
    for (const deal of won) {
      const placed = [...shop.carts.values()].find((cart) => cart.orderNumber === deal.orderNumber)!;
      assert.equal(placed.body.businessUnit.key, deal.accountId.toLowerCase());
      assert.deepEqual(placed.body.lineItems, deal.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })));
      const buyer = [...shop.of('customers').values()].find((customer) => customer.id === placed.customerId)!;
      assert.equal(buyer.customerGroup.key, deal.tier, 'the buyer is in the account\'s tier, which is what makes the prices match');
    }
    // The account manager is the Salesforce rep. Make one unit wrong, as an earlier load would have left it, and run again.
    const unit = shop.of('business-units').get('acc-0001')!;
    assert.equal(unit.custom.fields.accountManager, 'Hemi Ashworth');
    unit.custom.fields.accountManager = 'Someone Else';
    const again = await loadCommercetoolsB2b({ env: envFor(ct.url, 'http://127.0.0.1:9'), deps, apply: true, salesforce: false });
    assert.equal(again.managersChanged, 1);
    assert.equal(shop.of('business-units').get('acc-0001')!.custom.fields.accountManager, 'Hemi Ashworth');
    assert.deepEqual(again.launchOrders, { created: 0, existing: 6 }, 'the orders are not made twice');
    await ct.close();
  });

  await t.test('running it again creates nothing in either system', async () => {
    const shop = commercetoolsShop();
    const org = salesforceOrg();
    const ct = await mockVendor(shop.answer);
    const sf = await mockVendor(org.answer);
    const options = { env: envFor(ct.url, sf.url), deps, apply: true as const, products: 6, accounts: 3 };
    await loadCommercetoolsB2b(options);
    const counts = () => [...shop.things.entries()].map(([name, map]) => `${name}:${map.size}`).join(',');
    const before = counts();
    const sfWrites = sf.seen.filter((request) => request.method === 'PATCH').length;
    const again = await loadCommercetoolsB2b(options);
    assert.equal(counts(), before, 'the vendor holds exactly what it held');
    assert.equal(sf.seen.filter((request) => request.method === 'PATCH').length, sfWrites, 'no Salesforce account is written to twice');
    assert.deepEqual(again.project, [], 'the project settings are already right');
    assert.equal(again.products.created + again.inventory.created + again.customers.created + again.companies.created + again.divisions.created + again.orders.created + again.carts.created, 0);
    assert.equal(again.products.existing, 6);
    assert.equal(again.customers.existing, plan(6, 3).people.length);
    assert.deepEqual(again.salesforce, { found: 3, missing: 0, noted: 0 });
    await ct.close(); await sf.close();
  });

  await t.test('with --no-salesforce, or when Salesforce cannot be reached, the units are still made, just without the Salesforce id', async () => {
    const shop = commercetoolsShop();
    const ct = await mockVendor(shop.answer);
    const sf = await mockVendor((request) => (request.path === '/services/oauth2/token' ? { status: 400, json: { error: 'invalid_client', error_description: `bad secret ${SF_SECRET}` } } : undefined));
    const logs: string[] = [];
    const skipped = await loadCommercetoolsB2b({ env: envFor(ct.url, sf.url), deps, apply: true, products: 3, accounts: 2, salesforce: false, log: (line) => logs.push(line) });
    assert.equal(skipped.salesforce, 'not used');
    assert.equal(sf.seen.length, 0, 'Salesforce is not touched');
    const down = commercetoolsShop();
    const ct2 = await mockVendor(down.answer);
    const downLogs: string[] = [];
    const summary = await loadCommercetoolsB2b({ env: envFor(ct2.url, sf.url), deps, apply: true, products: 3, accounts: 2, log: (line) => downLogs.push(line) });
    assert.equal(summary.companies.created, 2);
    assert.equal(down.of('business-units').get('acc-0001').custom.fields.salesforceAccountId, undefined);
    assert.match(downLogs.join('\n'), /Salesforce could not be used/);
    assert.ok(!leaks(downLogs, SF_SECRET), 'the Salesforce secret is not in what is said');
    await ct.close(); await ct2.close(); await sf.close();
  });

  await t.test('a real error is said in plain words with no secret in it, and the NZ currency is added to the project before any price is sent', async () => {
    const shop = commercetoolsShop({ failOnProduct: `pm-${plan(3, 1).sampleProducts[1].sku}` });
    const ct = await mockVendor(shop.answer);
    const logs: string[] = [];
    await assert.rejects(loadCommercetoolsB2b({ env: envFor(ct.url, 'http://127.0.0.1:9'), deps, apply: true, products: 3, accounts: 1, salesforce: false, log: (line) => logs.push(line) }), (error: any) => {
      assert.match(String(error.message), /commercetools/i);
      assert.ok(!leaks({ message: error.message, logs }, SECRET), 'the secret is not in the error or the log');
      return true;
    });
    assert.ok(shop.project.currencies.includes('NZD'), 'the currency was added before any price was sent');
    await ct.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
