/**
 * Sets up a commercetools B2B project the way PlaceMakers trades: a catalogue with categories, a retail price and the Bronze / Silver / Gold
 * trade prices on every product, stock at each branch, and the B2B structure that goes with the trade accounts in Salesforce: associate roles,
 * one business unit per trade account (with a few divisions for the biggest), the people who work for each (an account administrator, a buyer,
 * sometimes an accounts-payable clerk), and for each unit one order and one open cart. Every unit also records its Salesforce account id.
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/commercetools-b2b.ts [--products 100] [--accounts 30] [--no-salesforce] [--apply]
 *
 * It signs in with COMMERCETOOLS_LOADER_CLIENT_ID / _SECRET, or with the CTP_CLIENT_ID / CTP_CLIENT_SECRET lines the Merchant Center gives out
 * (the client needs write access to the whole project: manage_project). The chat's own connection should NOT use that client; give it a
 * narrow one of its own in COMMERCETOOLS_CLIENT_ID / _SECRET.
 *
 * The first thing it does is add what a New Zealand shop needs to the project's settings: the NZD currency, the NZ country and the en-NZ
 * language. It only ever adds to those lists. A dry run (the default) says what it would do and sends nothing. Running it again changes nothing
 * that is already there. Everything it creates is sample data: the people have example.test addresses and random passwords that are never shown.
 *
 * With Salesforce settings present it looks each account up by name in Salesforce, stores the Salesforce id on the business unit, and writes the
 * sample account number into the account's description (this Salesforce org has no field for it). Pass --no-salesforce to leave Salesforce alone.
 */
import { randomBytes } from 'node:crypto';
import { errorFor, redact, send, setting, vendorMessage } from '../../src/http';
import type { Deps, Env, Rec } from '../../src/types';
import { linkSalesforceAccounts, type SalesforceLink } from './salesforce';
import { cents, readFlags, required, sampleCollection, sleep, slug } from './shared';

const SYSTEM = 'commercetools';
const LOCALE = 'en-NZ';
const CURRENCY = 'NZD';
const COUNTRY = 'NZ';
const TIERS = ['bronze', 'silver', 'gold'] as const;
const PRODUCT_TYPE = 'placemakers-product';
const ACCOUNT_TYPE = 'placemakers-account';
const STORE = 'placemakers-nz';
const loc = (text: string): Rec => ({ [LOCALE]: text });

/** What each kind of person at a trade account may do. Admins run the account; buyers order for themselves; site managers see and place orders for the site. */
export const ROLES: Array<{ key: string; name: string; buyerAssignable: boolean; permissions: string[] }> = [
  { key: 'account-admin', name: 'Account administrator', buyerAssignable: false, permissions: ['AddChildUnits', 'UpdateAssociates', 'UpdateBusinessUnitDetails', 'CreateMyCarts', 'CreateOthersCarts', 'ViewMyCarts', 'ViewOthersCarts', 'UpdateMyCarts', 'UpdateOthersCarts', 'CreateMyOrdersFromMyCarts', 'CreateOrdersFromOthersCarts', 'ViewMyOrders', 'ViewOthersOrders'] },
  { key: 'buyer', name: 'Buyer', buyerAssignable: true, permissions: ['CreateMyCarts', 'ViewMyCarts', 'UpdateMyCarts', 'CreateMyOrdersFromMyCarts', 'ViewMyOrders'] },
  { key: 'site-manager', name: 'Site manager', buyerAssignable: false, permissions: ['CreateMyCarts', 'ViewMyCarts', 'UpdateMyCarts', 'ViewOthersCarts', 'CreateMyOrdersFromMyCarts', 'CreateOrdersFromOthersCarts', 'ViewMyOrders', 'ViewOthersOrders'] },
  { key: 'accounts-payable', name: 'Accounts payable', buyerAssignable: true, permissions: ['ViewMyOrders', 'ViewOthersOrders'] },
];

const FIRST = ['Aroha', 'Wiremu', 'Mereana', 'Tane', 'Hana', 'Ngaio', 'Rawiri', 'Kiri', 'Jack', 'Priya', 'Sione', 'Mele', 'Liam', 'Emma', 'Hemi', 'Anika'];
const LAST = ['Walker', 'Singh', 'Parata', 'Henare', 'Fraser', 'Ngata', 'Cooper', 'Tamati', 'Wilson', 'Kumar', 'Brown', 'Taylor'];
const DIVISIONS = ['Yard and deliveries', 'Projects'];
const pad = (n: number, width = 4) => String(n).padStart(width, '0');

export interface Tally { created: number; existing: number }
const tally = (): Tally => ({ created: 0, existing: 0 });

export interface B2bSummary {
  project: string[];
  customerGroups: Tally; categories: Tally; products: Tally; branches: Tally; inventory: Tally; roles: Tally;
  customers: Tally; companies: Tally; divisions: Tally; carts: Tally; orders: Tally;
  salesforce: { found: number; missing: number; noted: number } | 'not used';
  ids: Array<{ accountId: string; unit: string; customerId?: string; openCartId?: string; orderNumber: string; salesforceId?: string }>;
}

interface Person { key: string; customerNumber: string; email: string; firstName: string; lastName: string; group: string; companyName: string }
interface Unit { key: string; account: Rec; parent?: string; name: string; associates: Array<{ person: Person; role: string }> }

/** Who works where. Pure and deterministic, so a dry run, a load and a second load all agree. */
export function plan(products: number, accounts: number) {
  const sampleProducts = sampleCollection('sap-commerce', 'products').slice(0, products);
  const skus = new Set(sampleProducts.map((product) => String(product.sku)));
  const priceList = new Map(sampleCollection('ace-erp', 'price_list').map((row) => [String(row.sku), row]));
  const stock = sampleCollection('ace-erp', 'stock').filter((row) => skus.has(String(row.sku)));
  const branches = new Map(sampleCollection('ace-erp', 'branches').map((row) => [String(row.code), row]));
  const used = [...new Set(stock.map((row) => String(row.branchCode)))].sort();

  const categories = new Map<string, { key: string; name: string; parent?: string }>();
  const leafOf = new Map<string, string>();
  for (const product of sampleProducts) {
    const parts = String(product.categoryPath ?? '').split('>').map((part) => part.trim()).filter(Boolean);
    let parent: string | undefined;
    parts.forEach((name, depth) => {
      const key = slug(parts.slice(0, depth + 1).join(' '));
      if (!categories.has(key)) categories.set(key, { key, name, parent });
      parent = key;
    });
    if (parent) leafOf.set(String(product.sku), parent);
  }

  const sampleAccounts = sampleCollection('salesforce', 'accounts').slice(0, accounts);
  const biggest = new Set([...sampleAccounts].sort((a, b) => Number(b.creditLimit) - Number(a.creditLimit)).slice(0, 6).map((account) => account.accountId));
  const units: Unit[] = [];
  let n = 0;
  const someone = (account: Rec, suffix: string, firstSeed: number): Person => {
    const first = FIRST[firstSeed % FIRST.length];
    const last = LAST[(firstSeed * 7 + 3) % LAST.length];
    const id = String(account.accountId).toLowerCase();
    return { key: `${id}-${suffix}`, customerNumber: `${account.accountId}-${suffix.toUpperCase()}`, email: `${first}.${last}.${id}@example.test`.toLowerCase(), firstName: first, lastName: last, group: String(account.tier), companyName: String(account.name) };
  };
  sampleAccounts.forEach((account, index) => {
    const id = String(account.accountId).toLowerCase();
    const [firstName, ...rest] = String(account.contactName ?? account.name).split(' ');
    const admin: Person = { key: id, customerNumber: String(account.accountId), email: String(account.contactEmail ?? `${slug(String(account.name))}@example.test`), firstName, lastName: rest.join(' ') || 'Trade', group: String(account.tier), companyName: String(account.name) };
    const associates: Unit['associates'] = [{ person: admin, role: 'account-admin' }, { person: someone(account, 'buyer', ++n), role: 'buyer' }];
    if (index % 3 === 0) associates.push({ person: someone(account, 'ap', ++n), role: 'accounts-payable' });
    units.push({ key: id, account, name: String(account.name), associates });
    if (biggest.has(account.accountId)) {
      DIVISIONS.forEach((division, d) => units.push({ key: `${id}-div${d + 1}`, account, parent: id, name: `${account.name} - ${division}`, associates: [{ person: someone(account, `site${d + 1}`, ++n), role: 'site-manager' }] }));
    }
  });
  const people = units.flatMap((unit) => unit.associates.map((associate) => associate.person));
  return { sampleProducts, priceList, stock, branches, usedBranches: used, categories: [...categories.values()], leafOf, accounts: sampleAccounts, units, people };
}

export async function loadCommercetoolsB2b(options: { env: Env; deps: Deps; apply: boolean; products?: number; accounts?: number; salesforce?: boolean; log?: (line: string) => void }): Promise<B2bSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  required(env, ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_REGION', ...(apply ? ['COMMERCETOOLS_LOADER_CLIENT_ID', 'COMMERCETOOLS_LOADER_CLIENT_SECRET'] : [])]);
  const secrets = [setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET') ?? ''];
  const region = setting(env, 'COMMERCETOOLS_REGION')!;
  const api = `${(setting(env, 'COMMERCETOOLS_API_URL') || `https://api.${region}.commercetools.com`).replace(/\/$/, '')}/${setting(env, 'COMMERCETOOLS_PROJECT_KEY')}`;
  const auth = (setting(env, 'COMMERCETOOLS_AUTH_URL') || `https://auth.${region}.commercetools.com`).replace(/\/$/, '');

  const data = plan(options.products ?? 100, options.accounts ?? 30);
  const stockPlanned = data.stock.length;
  const companies = data.units.filter((unit) => !unit.parent);
  const useSalesforce = options.salesforce !== false && Boolean(setting(env, 'SALESFORCE_INSTANCE_URL')) && Boolean((setting(env, 'SALESFORCE_CLIENT_ID') && setting(env, 'SALESFORCE_CLIENT_SECRET')) || setting(env, 'SALESFORCE_LOADER_ACCESS_TOKEN'));
  const summary: B2bSummary = {
    project: [], customerGroups: tally(), categories: tally(), products: tally(), branches: tally(), inventory: tally(), roles: tally(),
    customers: tally(), companies: tally(), divisions: tally(), carts: tally(), orders: tally(), salesforce: 'not used', ids: [],
  };
  log(`${apply ? 'Loading' : 'Dry run. Would load'} into commercetools:`);
  log(`  project settings: add the ${CURRENCY} currency, the ${COUNTRY} country and the ${LOCALE} language if they are missing (nothing is removed)`);
  log(`  ${TIERS.length} customer groups (${TIERS.join(', ')}), 1 store, 1 product type, ${data.categories.length} categories`);
  log(`  ${data.sampleProducts.length} products, each with a retail price and the ${TIERS.length} trade-tier prices where the price list has them`);
  log(`  ${data.usedBranches.length} branch channels with ${stockPlanned} stock entries`);
  log(`  ${ROLES.length} associate roles (${ROLES.map((role) => role.key).join(', ')}) and 1 account type for business units`);
  log(`  ${companies.length} business units (companies) + ${data.units.length - companies.length} divisions, with ${data.people.length} people, and 1 order and 1 open cart for each company`);
  log(`  Salesforce: ${useSalesforce ? `would look the ${data.accounts.length} accounts up by name, record each id on its unit, and write the account number into each account's description` : 'not used (no Salesforce settings, or --no-salesforce)'}`);
  if (!apply) return summary;

  const basic = Buffer.from(`${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_ID')}:${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET')}`).toString('base64');
  const login = await send(deps, SYSTEM, 'POST', `${auth}/oauth/token`, { form: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${basic}` } });
  if (!login.ok || typeof login.json?.access_token !== 'string') throw errorFor(SYSTEM, login.status === 400 ? 401 : login.status || 500, redact(vendorMessage(login.json, login.text), secrets));
  const headers = { authorization: `Bearer ${login.json.access_token}` };

  const call = async (method: string, path: string, body?: unknown, accept: number[] = []) => {
    for (let attempt = 0; ; attempt++) {
      const answer = await send(deps, SYSTEM, method, `${api}${path}`, { headers, ...(body !== undefined ? { body } : {}) });
      if (answer.ok || accept.includes(answer.status)) return answer;
      if ((answer.status === 429 || answer.status === 503) && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
      throw errorFor(SYSTEM, answer.status, redact(vendorMessage(answer.json, answer.text), secrets));
    }
  };
  const isDuplicate = (answer: { status: number; json: any }) => answer.status === 400 && Array.isArray(answer.json?.errors) && answer.json.errors.some((error: Rec) => String(error.code).startsWith('Duplicate'));
  /** Creates it, or finds it was already there. Anything else is a real error and is said in plain words. */
  const createOnce = async (path: string, body: Rec, into: Tally): Promise<Rec | undefined> => {
    const answer = await call('POST', path, body, [400]);
    if (answer.ok) { into.created++; return answer.json; }
    if (isDuplicate(answer)) { into.existing++; return undefined; }
    throw errorFor(SYSTEM, answer.status, redact(vendorMessage(answer.json, answer.text), secrets));
  };

  // 1. The project's own settings: only ever added to.
  const project = (await call('GET', '')).json;
  const actions: Rec[] = [];
  if (!(project.currencies ?? []).includes(CURRENCY)) { actions.push({ action: 'changeCurrencies', currencies: [...(project.currencies ?? []), CURRENCY] }); summary.project.push(`currency ${CURRENCY}`); }
  if (!(project.countries ?? []).includes(COUNTRY)) { actions.push({ action: 'changeCountries', countries: [...(project.countries ?? []), COUNTRY] }); summary.project.push(`country ${COUNTRY}`); }
  if (!(project.languages ?? []).includes(LOCALE)) { actions.push({ action: 'changeLanguages', languages: [...(project.languages ?? []), LOCALE] }); summary.project.push(`language ${LOCALE}`); }
  if (actions.length) await call('POST', '', { version: project.version, actions });
  log(`Project settings: ${summary.project.length ? `added ${summary.project.join(', ')}` : 'already right'}.`);

  // 2. The pieces everything else points at.
  for (const tier of TIERS) await createOnce('/customer-groups', { key: tier, groupName: `${tier[0].toUpperCase()}${tier.slice(1)} trade` }, summary.customerGroups);
  await createOnce('/stores', { key: STORE, name: loc('PlaceMakers trade online'), languages: [LOCALE], countries: [{ code: COUNTRY }] }, tally());
  const text = (name: string, label: string) => ({ name, label: loc(label), isRequired: false, isSearchable: true, inputHint: 'SingleLine', type: { name: 'text' } });
  await createOnce('/product-types', { key: PRODUCT_TYPE, name: 'PlaceMakers product', description: 'A PlaceMakers product with its brand and department.', attributes: [text('brand', 'Brand'), text('department', 'Department'), text('unitOfMeasure', 'Unit of measure')] }, tally());
  for (const category of data.categories) await createOnce('/categories', { key: category.key, name: loc(category.name), slug: loc(category.key), ...(category.parent ? { parent: { typeId: 'category', key: category.parent } } : {}) }, summary.categories);
  log(`Customer groups, store, product type and categories: ${summary.categories.created} categories created, ${summary.categories.existing} already there.`);

  // 3. The catalogue: a retail price and a price for each trade tier.
  for (const product of data.sampleProducts) {
    const sku = String(product.sku);
    const tiers = data.priceList.get(sku);
    const leaf = data.leafOf.get(sku);
    const prices: Rec[] = [{ value: { currencyCode: CURRENCY, centAmount: cents(product.price) } }];
    if (tiers) for (const tier of TIERS) if (tiers[`${tier}Price`] !== undefined) prices.push({ value: { currencyCode: CURRENCY, centAmount: cents(tiers[`${tier}Price`]) }, customerGroup: { typeId: 'customer-group', key: tier } });
    await createOnce('/products', {
      key: `pm-${sku}`,
      productType: { typeId: 'product-type', key: PRODUCT_TYPE },
      name: loc(String(product.title)),
      slug: loc(`${slug(String(product.title))}-${sku}`),
      description: loc(String(product.description ?? '')),
      ...(leaf ? { categories: [{ typeId: 'category', key: leaf }] } : {}),
      masterVariant: {
        sku, prices,
        ...(typeof product.imageUrl === 'string' && /^https?:\/\//.test(product.imageUrl) ? { images: [{ url: product.imageUrl, dimensions: { w: 800, h: 800 } }] } : {}),
        attributes: [{ name: 'brand', value: String(product.brand ?? '') }, { name: 'department', value: String(product.department ?? '') }, { name: 'unitOfMeasure', value: String(product.unitOfMeasure ?? '') }],
      },
      publish: true,
    }, summary.products);
  }
  log(`Products: ${summary.products.created} created, ${summary.products.existing} already there.`);

  // 4. Stock at each branch: one channel per branch, one inventory entry per product and branch.
  for (const code of data.usedBranches) {
    const branch = data.branches.get(code);
    await createOnce('/channels', { key: `branch-${code}`, roles: ['InventorySupply'], name: loc(String(branch?.name ?? `Branch ${code}`)), ...(branch && typeof branch.lat === 'number' && typeof branch.lng === 'number' ? { geoLocation: { type: 'Point', coordinates: [branch.lng, branch.lat] } } : {}) }, summary.branches);
  }
  for (const row of data.stock) {
    await createOnce('/inventory', { sku: String(row.sku), supplyChannel: { typeId: 'channel', key: `branch-${row.branchCode}` }, quantityOnStock: Math.max(0, Math.trunc(Number(row.onHand))) }, summary.inventory);
  }
  log(`Branches: ${summary.branches.created} channels created, ${summary.branches.existing} already there. Stock entries: ${summary.inventory.created} created, ${summary.inventory.existing} already there.`);

  // 5. The B2B structure.
  for (const role of ROLES) await createOnce('/associate-roles', { key: role.key, name: role.name, buyerAssignable: role.buyerAssignable, permissions: role.permissions }, summary.roles);
  const field = (name: string, label: string, type: Rec = { name: 'String' }) => ({ name, label: loc(label), required: false, type, inputHint: 'SingleLine' });
  await createOnce('/types', {
    key: ACCOUNT_TYPE, name: loc('PlaceMakers trade account'), resourceTypeIds: ['business-unit'],
    fieldDefinitions: [field('accountNumber', 'Account number'), field('salesforceAccountId', 'Salesforce account id'), field('tradeType', 'Trade type'), field('tier', 'Tier'), field('homeBranchCode', 'Home branch'), field('accountManager', 'Account manager'), field('paymentTerms', 'Payment terms'), field('creditLimit', 'Credit limit', { name: 'Money' })],
  }, tally());
  log(`Roles: ${summary.roles.created} created, ${summary.roles.existing} already there.`);

  // 6. Salesforce: find each account's id so the unit can say which Salesforce account it is.
  let link: SalesforceLink | undefined;
  if (useSalesforce) {
    try {
      link = await linkSalesforceAccounts({ env, deps, accounts: data.accounts, note: true });
      summary.salesforce = { found: link.found, missing: link.missing.length, noted: link.noted };
      log(`Salesforce: ${link.found} of ${data.accounts.length} accounts found${link.missing.length ? ` (not found: ${link.missing.join(', ')})` : ''}; account number written into ${link.noted} descriptions.`);
    } catch (error: any) {
      log(`Salesforce could not be used (${error?.message ?? error}); the units are made without the Salesforce id. Run this again after fixing it and they will be linked.`);
    }
  }

  // 7. The people, then the units that gather them.
  const customerIds = new Map<string, string>();
  for (const person of data.people) {
    const made = await createOnce('/customers', {
      key: person.key, customerNumber: person.customerNumber, email: person.email, password: randomBytes(18).toString('base64url'),
      firstName: person.firstName, lastName: person.lastName, companyName: person.companyName, isEmailVerified: true, customerGroup: { typeId: 'customer-group', key: person.group },
    }, summary.customers);
    const id = made?.customer?.id ?? (await call('GET', `/customers/key=${encodeURIComponent(person.key)}`)).json?.id;
    customerIds.set(person.key, String(id));
  }
  log(`Customers: ${summary.customers.created} created, ${summary.customers.existing} already there.`);

  const branchCity = (code: string) => String(data.branches.get(code)?.name ?? 'Auckland');
  for (const unit of data.units) {
    const account = unit.account;
    const address = { key: 'site', country: COUNTRY, city: branchCity(String(account.homeBranchCode)), streetName: '12 Trade Street', email: String(account.contactEmail ?? '') };
    const associates = unit.associates.map(({ person, role }) => ({ customer: { typeId: 'customer', key: person.key }, associateRoleAssignments: [{ associateRole: { typeId: 'associate-role', key: role }, inheritance: 'Enabled' }] }));
    const salesforceId = link?.ids.get(String(account.name));
    const custom = {
      type: { typeId: 'type', key: ACCOUNT_TYPE },
      fields: {
        accountNumber: String(account.accountId), tradeType: String(account.tradeType ?? ''), tier: String(account.tier ?? ''), homeBranchCode: String(account.homeBranchCode ?? ''),
        accountManager: String(account.accountManager ?? ''), paymentTerms: String(account.paymentTerms ?? ''),
        creditLimit: { type: 'centPrecision', currencyCode: CURRENCY, centAmount: cents(account.creditLimit ?? 0), fractionDigits: 2 },
        ...(salesforceId ? { salesforceAccountId: salesforceId } : {}),
      },
    };
    const base = {
      key: unit.key, name: unit.name, status: 'Active', contactEmail: String(account.contactEmail ?? ''), addresses: [address], shippingAddresses: [0], defaultShippingAddress: 0, billingAddresses: [0], defaultBillingAddress: 0, custom,
    };
    if (unit.parent) {
      await createOnce('/business-units', { ...base, unitType: 'Division', parentUnit: { typeId: 'business-unit', key: unit.parent }, associateMode: 'ExplicitAndFromParent', storeMode: 'FromParent', associates }, summary.divisions);
    } else {
      await createOnce('/business-units', { ...base, unitType: 'Company', associateMode: 'Explicit', storeMode: 'Explicit', stores: [{ typeId: 'store', key: STORE }], associates }, summary.companies);
    }
  }
  log(`Business units: ${summary.companies.created} companies and ${summary.divisions.created} divisions created, ${summary.companies.existing + summary.divisions.existing} already there.`);

  // 8. One order and one open cart for each company, placed by its buyer, so every commercetools tool has something to read.
  for (const [index, unit] of companies.entries()) {
    const buyer = unit.associates.find((associate) => associate.role === 'buyer')!.person;
    const customerId = customerIds.get(buyer.key)!;
    const orderNumber = `DEMO-ORD-${pad(index + 1)}`;
    const lines = (n: number) => [0, 1].slice(0, n).map((offset) => ({ sku: String(data.sampleProducts[(index * 2 + offset) % data.sampleProducts.length].sku), quantity: 1 + ((index + offset) % 4) }));
    const newCart = (n: number) => call('POST', '/carts', {
      currency: CURRENCY, country: COUNTRY, customerId, businessUnit: { typeId: 'business-unit', key: unit.key }, store: { typeId: 'store', key: STORE }, taxMode: 'Disabled', lineItems: lines(n),
      shippingAddress: { country: COUNTRY, city: branchCity(String(unit.account.homeBranchCode)), streetName: '12 Trade Street' },
    });
    const order = await call('GET', `/orders/order-number=${orderNumber}`, undefined, [404]);
    if (order.status === 404) {
      const cart = (await newCart(2)).json;
      await call('POST', '/orders', { id: cart.id, version: cart.version, orderNumber });
      summary.orders.created++;
    } else summary.orders.existing++;
    const open = await call('GET', `/carts?where=${encodeURIComponent(`customerId="${customerId}" and cartState="Active"`)}&limit=1`);
    let openCartId: string | undefined = open.json?.results?.[0]?.id;
    if (openCartId) summary.carts.existing++;
    else { openCartId = (await newCart(1)).json?.id; summary.carts.created++; }
    summary.ids.push({ accountId: String(unit.account.accountId), unit: unit.key, customerId, openCartId, orderNumber, salesforceId: link?.ids.get(String(unit.account.name)) });
  }
  log(`Orders: ${summary.orders.created} created, ${summary.orders.existing} already there. Open carts: ${summary.carts.created} created, ${summary.carts.existing} already there.`);
  return summary;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), ['products', 'accounts']);
  const summary = await loadCommercetoolsB2b({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, products: flags.limit.products, accounts: flags.limit.accounts, salesforce: !flags.rest.includes('--no-salesforce'), log: console.log });
  if (!flags.apply) { console.log('Nothing was sent. Add --apply to load.'); return; }
  const first = summary.ids[0];
  if (first) {
    console.log('\nFor the chat connector, set these in .env.connectors (they are not secrets):');
    console.log('  COMMERCETOOLS_CURRENCY=NZD');
    console.log('  COMMERCETOOLS_ACCOUNT_KIND=businessUnit');
    console.log('To try the live check with this data, set:');
    console.log(`  CHECK_COMMERCETOOLS_ACCOUNT_ID=${first.unit}`);
    console.log(`  CHECK_COMMERCETOOLS_CART_ID=${first.openCartId}`);
    console.log(`  CHECK_COMMERCETOOLS_ORDER_ID=${first.orderNumber}`);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
