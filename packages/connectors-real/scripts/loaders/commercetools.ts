/**
 * Puts PlaceMakers-style demo data into a commercetools project (a trial): the product catalogue (from the sample data, which was built
 * from the real PlaceMakers product master), a few customers (the same trade accounts the Salesforce loader creates), and for each customer
 * one order and one open cart, so every commercetools tool has something to read.
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/commercetools.ts [--products 100] [--customers 6] [--apply]
 *
 * It needs its OWN API client (the chat's client is read-mostly and must stay so). In the Merchant Center make a second API client with the
 * scopes manage_products, manage_customers and manage_orders, and set:
 *   COMMERCETOOLS_LOADER_CLIENT_ID, COMMERCETOOLS_LOADER_CLIENT_SECRET
 * next to the same COMMERCETOOLS_PROJECT_KEY and COMMERCETOOLS_REGION the connector uses. Delete that client when the loading is done.
 *
 * A dry run (the default) says what it would do and sends nothing. Running it again changes nothing that already exists.
 * It creates test data only: customers get random passwords that are never shown, and the e-mail addresses end in example.test.
 */
import { randomBytes } from 'node:crypto';
import { setting } from '../../src/http';
import type { Deps, Env, Rec } from '../../src/types';
import { cents, must, readFlags, required, sampleCollection, slug } from './shared';

const SYSTEM = 'commercetools';
const TOWNS = [['Hamilton', '3204'], ['Tauranga', '3110'], ['Auckland', '1010'], ['Wellington', '6011'], ['Christchurch', '8013'], ['Dunedin', '9016']];
const pad = (n: number, width = 4) => String(n).padStart(width, '0');

export interface LoadSummary {
  productType: 'created' | 'existing' | 'would create';
  products: { created: number; existing: number };
  customers: { created: number; existing: number };
  carts: { created: number; existing: number };
  orders: { created: number; existing: number };
  ids: Array<{ accountId: string; customerId?: string; openCartId?: string; orderNumber: string }>;
}

export async function loadCommercetools(options: { env: Env; deps: Deps; apply: boolean; products?: number; customers?: number; log?: (line: string) => void }): Promise<LoadSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  required(env, ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_REGION', ...(apply ? ['COMMERCETOOLS_LOADER_CLIENT_ID', 'COMMERCETOOLS_LOADER_CLIENT_SECRET'] : [])]);
  const secrets = [setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET') ?? ''];
  const region = setting(env, 'COMMERCETOOLS_REGION')!;
  const api = `${(setting(env, 'COMMERCETOOLS_API_URL') || `https://api.${region}.commercetools.com`).replace(/\/$/, '')}/${setting(env, 'COMMERCETOOLS_PROJECT_KEY')}`;
  const auth = (setting(env, 'COMMERCETOOLS_AUTH_URL') || `https://auth.${region}.commercetools.com`).replace(/\/$/, '');

  const sampleProducts = sampleCollection('sap-commerce', 'products').slice(0, options.products ?? 100);
  const sampleAccounts = sampleCollection('salesforce', 'accounts').slice(0, options.customers ?? 6);
  const summary: LoadSummary = {
    productType: apply ? 'existing' : 'would create',
    products: { created: 0, existing: 0 }, customers: { created: 0, existing: 0 }, carts: { created: 0, existing: 0 }, orders: { created: 0, existing: 0 }, ids: [],
  };
  log(`${apply ? 'Loading' : 'Dry run. Would load'}: 1 product type, ${sampleProducts.length} products, ${sampleAccounts.length} customers, each with 1 order and 1 open cart.`);
  if (!apply) return summary;

  const basic = Buffer.from(`${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_ID')}:${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET')}`).toString('base64');
  const login = await must(deps, SYSTEM, secrets, 'POST', `${auth}/oauth/token`, { form: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${basic}` } });
  const headers = { authorization: `Bearer ${login.json?.access_token}` };
  const call = (method: string, path: string, body?: unknown, accept: number[] = []) => must(deps, SYSTEM, secrets, method, `${api}${path}`, { headers, ...(body !== undefined ? { body } : {}) }, accept);
  const isDuplicate = (answer: { status: number; json: any }) => answer.status === 400 && Array.isArray(answer.json?.errors) && answer.json.errors.some((error: Rec) => error.code === 'DuplicateField');

  // The product type: the attributes the chat reads (brand) and the ones a shopper filters on.
  const type = await call('GET', '/product-types/key=placemakers-product', undefined, [404]);
  if (type.status === 404) {
    const text = (name: string, label: string) => ({ name, label: { en: label }, isRequired: false, isSearchable: true, inputHint: 'SingleLine', type: { name: 'text' } });
    await call('POST', '/product-types', { key: 'placemakers-product', name: 'PlaceMakers product', description: 'A PlaceMakers product with its brand and department.', attributes: [text('brand', 'Brand'), text('department', 'Department'), text('unitOfMeasure', 'Unit of measure')] });
    summary.productType = 'created';
  }

  for (const product of sampleProducts) {
    const draft = {
      key: `pm-${product.sku}`,
      productType: { typeId: 'product-type', key: 'placemakers-product' },
      name: { en: String(product.title) },
      slug: { en: `${slug(String(product.title))}-${product.sku}` },
      description: { en: String(product.description ?? '') },
      masterVariant: {
        sku: String(product.sku),
        prices: [{ value: { currencyCode: String(product.currency || 'NZD'), centAmount: cents(product.price) } }],
        ...(typeof product.imageUrl === 'string' && /^https?:\/\//.test(product.imageUrl) ? { images: [{ url: product.imageUrl, dimensions: { w: 800, h: 800 } }] } : {}),
        attributes: [
          { name: 'brand', value: String(product.brand ?? '') },
          { name: 'department', value: String(product.department ?? '') },
          { name: 'unitOfMeasure', value: String(product.unitOfMeasure ?? '') },
        ],
      },
      publish: true,
    };
    const answer = await call('POST', '/products', draft, [400]);
    if (answer.status === 400) {
      if (!isDuplicate(answer)) await call('POST', '/products', draft); // anything but "already there" is a real error: say it
      summary.products.existing++;
    } else summary.products.created++;
  }
  log(`Products: ${summary.products.created} created, ${summary.products.existing} already there.`);

  for (const [index, account] of sampleAccounts.entries()) {
    const orderNumber = `DEMO-ORD-${pad(index + 1)}`;
    const found = await call('GET', `/customers?where=${encodeURIComponent(`customerNumber="${account.accountId}"`)}&limit=1`);
    let customerId: string | undefined = found.json?.results?.[0]?.id;
    if (customerId) summary.customers.existing++;
    else {
      const [firstName, ...rest] = String(account.contactName ?? account.name).split(' ');
      const created = await call('POST', '/customers', {
        customerNumber: account.accountId, key: String(account.accountId).toLowerCase(), email: String(account.contactEmail ?? `${slug(String(account.name))}@example.test`),
        password: randomBytes(18).toString('base64url'), firstName, lastName: rest.join(' ') || 'Trade', companyName: account.name, isEmailVerified: true,
      });
      customerId = created.json?.customer?.id;
      summary.customers.created++;
    }
    const [city, postalCode] = TOWNS[index % TOWNS.length];
    const lines = (n: number) => [0, 1].slice(0, n).map((offset) => ({ sku: String(sampleProducts[(index * 2 + offset) % sampleProducts.length].sku), quantity: 1 + ((index + offset) % 4) }));
    const newCart = (n: number) => call('POST', '/carts', { currency: 'NZD', country: 'NZ', customerId, taxMode: 'Disabled', lineItems: lines(n), shippingAddress: { country: 'NZ', city, postalCode, streetName: '12 Demo Street' } });

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
    summary.ids.push({ accountId: String(account.accountId), customerId, openCartId, orderNumber });
  }
  log(`Customers: ${summary.customers.created} created, ${summary.customers.existing} already there. Orders: ${summary.orders.created} created, ${summary.orders.existing} already there. Open carts: ${summary.carts.created} created, ${summary.carts.existing} already there.`);
  return summary;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), ['products', 'customers']);
  const summary = await loadCommercetools({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, products: flags.limit.products, customers: flags.limit.customers, log: console.log });
  if (!flags.apply) { console.log('Nothing was sent. Add --apply to load.'); return; }
  const first = summary.ids[0];
  if (first) {
    console.log('\nTo try the live check with this data, set:');
    console.log(`  CHECK_COMMERCETOOLS_ACCOUNT_ID=${first.customerId}`);
    console.log(`  CHECK_COMMERCETOOLS_CART_ID=${first.openCartId}`);
    console.log(`  CHECK_COMMERCETOOLS_ORDER_ID=${first.orderNumber}`);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
