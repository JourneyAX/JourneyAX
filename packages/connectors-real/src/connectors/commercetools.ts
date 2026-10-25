/**
 * commercetools: products, carts and orders (what the sample `sap-commerce` connector stood in for).
 *
 * Settings (names only here; the values live in the server's environment):
 *   COMMERCETOOLS_PROJECT_KEY, COMMERCETOOLS_CLIENT_ID, COMMERCETOOLS_CLIENT_SECRET   the project and an API client made in the Merchant Center
 *   COMMERCETOOLS_REGION        for example `australia-southeast1.gcp` (the host region of the project)
 *   optional: COMMERCETOOLS_SCOPE (default: every scope the API client has), COMMERCETOOLS_LOCALE (default `en`), COMMERCETOOLS_CURRENCY,
 *             COMMERCETOOLS_BRAND_ATTRIBUTE (default `brand`), COMMERCETOOLS_ACCOUNT_KIND (`customer`, the default, or `businessUnit`),
 *             COMMERCETOOLS_API_URL / COMMERCETOOLS_AUTH_URL (override the hosts, for a private proxy or a test)
 *
 * Make the API client with the smallest scopes that work: `view_products`, `view_orders` and `manage_orders` (commercetools keeps carts
 * under the orders scopes). Nothing here can delete anything. The only change a tool makes is adding a line to a cart.
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, settingsMissing, vendorMessage } from '../http';

const SYSTEM = 'commercetools';
const REQUIRED = ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_CLIENT_ID', 'COMMERCETOOLS_CLIENT_SECRET', 'COMMERCETOOLS_REGION'];
const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,99}$/;
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const ORDER_NUMBER = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ORDER_STATES: Record<string, string> = { open: 'Open', confirmed: 'Confirmed', complete: 'Complete', cancelled: 'Cancelled' };

/** A localised string ({"en": "...", "en-NZ": "..."}) in the wanted locale, else the same language, else the first one there is. */
const localised = (value: any, locale: string): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const lang = locale.split('-')[0];
  const sameLanguage = Object.keys(value).find((key) => key.split('-')[0] === lang);
  return String(value[locale] ?? (sameLanguage ? value[sameLanguage] : undefined) ?? Object.values(value)[0] ?? '');
};

const money = (value: any): { amount: number; currency: string } | undefined =>
  value && typeof value.centAmount === 'number' ? { amount: value.centAmount / 10 ** (value.fractionDigits ?? 2), currency: String(value.currencyCode ?? '') } : undefined;

const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const attributeText = (value: any, locale: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if ('label' in value) return localised(value.label, locale) || String(value.key ?? '');
    if ('centAmount' in value) { const m = money(value); return m ? `${m.amount} ${m.currency}` : undefined; }
    const local = localised(value, locale);
    return local || undefined;
  }
  return undefined;
};

export function commercetools(env: Env, deps: Deps): RealConnector {
  const tokens = new TokenCache(deps.now);
  const secrets = () => [setting(env, 'COMMERCETOOLS_CLIENT_SECRET') ?? ''];
  const region = () => setting(env, 'COMMERCETOOLS_REGION') ?? '';
  const locale = () => setting(env, 'COMMERCETOOLS_LOCALE') ?? 'en';
  const apiBase = () => `${(setting(env, 'COMMERCETOOLS_API_URL') ?? `https://api.${region()}.commercetools.com`).replace(/\/$/, '')}/${setting(env, 'COMMERCETOOLS_PROJECT_KEY')}`;
  const authBase = () => (setting(env, 'COMMERCETOOLS_AUTH_URL') ?? `https://auth.${region()}.commercetools.com`).replace(/\/$/, '');

  async function fetchToken() {
    const basic = Buffer.from(`${setting(env, 'COMMERCETOOLS_CLIENT_ID')}:${setting(env, 'COMMERCETOOLS_CLIENT_SECRET')}`).toString('base64');
    const scope = setting(env, 'COMMERCETOOLS_SCOPE');
    const answer = await send(deps, SYSTEM, 'POST', `${authBase()}/oauth/token`, {
      form: { grant_type: 'client_credentials', ...(scope ? { scope } : {}) },
      headers: { authorization: `Basic ${basic}` },
    });
    if (!answer.ok || typeof answer.json?.access_token !== 'string') {
      throw errorFor(SYSTEM, answer.status === 400 || answer.status === 401 ? 401 : answer.status || 500, redact(vendorMessage(answer.json, answer.text), secrets()));
    }
    return { token: answer.json.access_token as string, expiresInSec: Number(answer.json.expires_in) || 3600 };
  }

  const client = new VendorClient({ system: SYSTEM, deps, secrets, token: () => tokens.get(fetchToken), forgetToken: () => tokens.clear() });
  const api = (method: string, path: string, request: { query?: Rec; body?: unknown } = {}) => client.json(method, `${apiBase()}${path}`, request);

  const pickPrice = (prices: any[] | undefined) => {
    const wanted = setting(env, 'COMMERCETOOLS_CURRENCY');
    const list = Array.isArray(prices) ? prices : [];
    const chosen = (wanted ? list.find((price) => price?.value?.currencyCode === wanted) : undefined) ?? list[0];
    return money(chosen?.discounted?.value ?? chosen?.value);
  };

  const brandOf = (variant: any) => {
    const name = setting(env, 'COMMERCETOOLS_BRAND_ATTRIBUTE') ?? 'brand';
    return attributeText((variant?.attributes ?? []).find((attribute: any) => attribute?.name === name)?.value, locale());
  };

  const productRecord = (product: any): Rec => {
    const variant = product?.masterVariant ?? {};
    const price = pickPrice(variant.prices);
    return compact({
      productId: product?.id,
      sku: variant.sku,
      name: localised(product?.name, locale()),
      description: clip(plain(localised(product?.description, locale())), 300),
      brand: brandOf(variant),
      price: price?.amount,
      currency: price?.currency,
      inStock: typeof variant.availability?.isOnStock === 'boolean' ? variant.availability.isOnStock : undefined,
      image: variant.images?.[0]?.url,
      variantCount: (product?.variants?.length ?? 0) + 1,
    });
  };

  const cartRecord = (cart: any): Rec => {
    const lines: any[] = Array.isArray(cart?.lineItems) ? cart.lineItems : [];
    return compact({
      cartId: cart?.id,
      version: cart?.version,
      state: cart?.cartState,
      customerId: cart?.customerId,
      lineCount: lines.length,
      lines: lines.slice(0, 50).map((line) => compact({
        lineItemId: line.id,
        sku: line.variant?.sku,
        name: localised(line.name, locale()),
        quantity: line.quantity,
        unitPrice: money(line.price?.discounted?.value ?? line.price?.value)?.amount,
        total: money(line.totalPrice)?.amount,
      })),
      total: money(cart?.totalPrice)?.amount,
      currency: cart?.totalPrice?.currencyCode,
    });
  };

  const orderRecord = (order: any, withLines: boolean): Rec => {
    const lines: any[] = Array.isArray(order?.lineItems) ? order.lineItems : [];
    const address = order?.shippingAddress;
    return compact({
      orderId: order?.id,
      orderNumber: order?.orderNumber,
      state: order?.orderState,
      paymentState: order?.paymentState,
      shipmentState: order?.shipmentState,
      customerId: order?.customerId,
      created: order?.createdAt,
      total: money(order?.totalPrice)?.amount,
      currency: order?.totalPrice?.currencyCode,
      itemCount: lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0),
      // Only the town and postcode: enough to talk about a delivery without copying a street address into a chat.
      shipTo: address ? compact({ city: address.city, postalCode: address.postalCode, country: address.country }) : undefined,
      lines: withLines ? lines.slice(0, 50).map((line) => compact({
        sku: line.variant?.sku,
        name: localised(line.name, locale()),
        quantity: line.quantity,
        total: money(line.totalPrice)?.amount,
      })) : undefined,
    });
  };

  const tools: ToolSpec[] = [
    {
      name: 'find_product',
      readOnly: true,
      description: 'Search the online store\'s products by words (name, brand, department). With no words it lists the most recently changed products. Returns sku, name, price, brand and whether it is in stock.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200, description: 'What to look for, in plain words.' },
          brand: { type: 'string', maxLength: 80 },
          department: { type: 'string', maxLength: 80 },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const text = [args.query, args.brand, args.department].filter((word) => typeof word === 'string' && word.trim()).join(' ').trim();
        const limit = boundedInt(args.limit, 10, 1, 25);
        const answer = await api('GET', '/product-projections/search', {
          query: { staged: 'false', limit, ...(text ? { [`text.${locale()}`]: text, fuzzy: 'true' } : { sort: 'lastModifiedAt desc' }) },
        });
        const results: any[] = Array.isArray(answer.results) ? answer.results : [];
        return { total: answer.total ?? answer.count ?? results.length, returned: results.length, records: results.map(productRecord) };
      },
    },
    {
      name: 'get_product',
      readOnly: true,
      description: 'One product by its sku, with the details of that variant (price and its main attributes).',
      inputSchema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string', maxLength: 100, pattern: SKU.source } } },
      async run(args) {
        const sku = String(args.sku);
        const answer = await api('GET', '/product-projections/search', { query: { staged: 'false', limit: 1, filter: `variants.sku:"${sku}"` } });
        const product = answer.results?.[0];
        if (!product) throw new ToolError('not_found', `${SYSTEM} has no product with sku ${sku}.`);
        const variants: any[] = [product.masterVariant, ...(product.variants ?? [])].filter(Boolean);
        const match = variants.find((variant) => String(variant.sku).toLowerCase() === sku.toLowerCase()) ?? product.masterVariant;
        const price = pickPrice(match?.prices);
        return {
          record: {
            ...productRecord(product),
            matchedSku: match?.sku,
            variant: compact({
              sku: match?.sku,
              price: price?.amount,
              currency: price?.currency,
              attributes: Object.fromEntries((match?.attributes ?? []).slice(0, 12).map((attribute: any) => [attribute.name, attributeText(attribute.value, locale())]).filter(([, value]: any) => value !== undefined)),
            }),
          },
        };
      },
    },
    {
      name: 'get_cart',
      readOnly: true,
      description: 'A cart with its lines, quantities and total.',
      inputSchema: { type: 'object', required: ['cartId'], properties: { cartId: { type: 'string', maxLength: 64, pattern: ID.source } } },
      async run(args) {
        return { record: cartRecord(await api('GET', `/carts/${encodeURIComponent(String(args.cartId))}`)) };
      },
    },
    {
      name: 'add_to_cart',
      readOnly: false,
      description: 'Add a quantity of a product (by sku) to an active cart. This changes the cart, so the person is asked first.',
      inputSchema: {
        type: 'object',
        required: ['cartId', 'sku', 'quantity'],
        properties: {
          cartId: { type: 'string', maxLength: 64, pattern: ID.source },
          sku: { type: 'string', maxLength: 100, pattern: SKU.source },
          quantity: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
      async run(args) {
        const path = `/carts/${encodeURIComponent(String(args.cartId))}`;
        // A cart is changed against the version we read; if someone changed it meanwhile the vendor says 409, and we read it again once.
        for (let attempt = 0; ; attempt++) {
          const cart = await api('GET', path);
          if (cart.cartState && cart.cartState !== 'Active') throw new ToolError('rejected', `That cart is ${String(cart.cartState).toLowerCase()}, so nothing can be added to it.`);
          try {
            const updated = await api('POST', path, { body: { version: cart.version, actions: [{ action: 'addLineItem', sku: String(args.sku), quantity: Number(args.quantity) }] } });
            return { updated: true, record: cartRecord(updated) };
          } catch (error) {
            if (error instanceof ToolError && error.code === 'conflict' && attempt === 0) continue;
            throw error;
          }
        }
      },
    },
    {
      name: 'get_order',
      readOnly: true,
      description: 'An order by its id or its order number, with its lines, totals and states. Only the town and postcode of the delivery address are shown.',
      inputSchema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', maxLength: 64, description: 'The order id, or the order number the customer sees.' } } },
      async run(args) {
        const given = String(args.orderId).trim();
        if (UUID.test(given)) return { record: orderRecord(await api('GET', `/orders/${given}`), true) };
        if (!ORDER_NUMBER.test(given)) throw new ToolError('invalid_arguments', 'orderId is not in the expected form.');
        return { record: orderRecord(await api('GET', `/orders/order-number=${encodeURIComponent(given)}`), true) };
      },
    },
    {
      name: 'order_history',
      readOnly: true,
      description: 'The orders of one account (a commercetools customer, or a business unit when the connection is set up that way), newest first.',
      inputSchema: {
        type: 'object',
        required: ['accountId'],
        properties: {
          accountId: { type: 'string', maxLength: 64, pattern: ID.source },
          status: { type: 'string', enum: Object.keys(ORDER_STATES) },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const account = String(args.accountId);
        const byUnit = setting(env, 'COMMERCETOOLS_ACCOUNT_KIND') === 'businessUnit';
        const clauses = [byUnit ? `businessUnit(key="${account}")` : `customerId="${account}"`];
        if (args.status) clauses.push(`orderState="${ORDER_STATES[String(args.status)]}"`);
        const answer = await api('GET', '/orders', { query: { where: clauses.join(' and '), sort: 'createdAt desc', limit: boundedInt(args.limit, 10, 1, 25) } });
        const results: any[] = Array.isArray(answer.results) ? answer.results : [];
        return { total: answer.total ?? answer.count ?? results.length, returned: results.length, records: results.map((order) => orderRecord(order, false)) };
      },
    },
  ];

  return {
    connectorId: 'commercetools',
    title: 'commercetools',
    description: 'The online store: products, carts and orders.',
    required: REQUIRED,
    missing: () => settingsMissing(env, REQUIRED),
    tools,
  };
}
