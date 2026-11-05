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
 * Make the API client with the smallest scopes that work: `view_products`, `view_customer_groups` (for the trade-tier prices), `view_business_units`
 * and `view_customers` (for the trade accounts and their people), `view_orders` and `manage_orders` (commercetools keeps carts under the orders
 * scopes). Nothing here can delete anything. The only changes a tool makes are adding a line to a cart and, for the shop after a payment, recording
 * the paid order (`place_order`: one cart of custom lines, made into one order; asking again for the same order number returns that order).
 *
 * The product tools use Product Search, so the project's "products search" indexing must be on (the B2B loader switches it on). Set
 * COMMERCETOOLS_LOCALE to the language the names were written in (en-NZ for the PlaceMakers data), or a name search finds nothing.
 * With COMMERCETOOLS_ACCOUNT_KIND=businessUnit the account in order_history is a unit key such as acc-0001.
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { orderContactCorrection } from './commercetools-order-contact';
import { commerceAccountContact } from './account-contact';
import { commerceOrderPayment } from './commercetools-payment';
import { commerceCustomerProfile } from './customer-profile';
import { commerceOrderMoney, preparePaidCommerceCart } from './commercetools-money';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, settingsMissing, vendorMessage } from '../http';

const SYSTEM = 'commercetools';
const REQUIRED = ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_CLIENT_ID', 'COMMERCETOOLS_CLIENT_SECRET', 'COMMERCETOOLS_REGION'];
const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,99}$/;
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const ORDER_NUMBER = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ORDER_STATES: Record<string, string> = { open: 'Open', confirmed: 'Confirmed', complete: 'Complete', cancelled: 'Cancelled' };
const SHIPMENT_STATES: Record<string, string> = { pending: 'Pending', ready: 'Ready', partial: 'Partial', shipped: 'Shipped', delayed: 'Delayed', backorder: 'Backorder' };

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

  /** The shop's own price: the one that is not for a customer group or a channel, in the wanted currency (any currency if it has none there). */
  const pickPrice = (prices: any[] | undefined) => {
    const wanted = setting(env, 'COMMERCETOOLS_CURRENCY');
    const all = Array.isArray(prices) ? prices : [];
    const inCurrency = wanted ? all.filter((price) => price?.value?.currencyCode === wanted) : all;
    const list = inCurrency.length ? inCurrency : all;
    const chosen = list.find((price) => !price?.customerGroup && !price?.channel) ?? list[0];
    return money(chosen?.discounted?.value ?? chosen?.value);
  };

  // The trade-tier prices say which customer group they are for by id; the group list says which key (gold, silver...) that is.
  let groupCache: { at: number; byId: Map<string, string> } | undefined;
  const groupKeys = async (): Promise<Map<string, string>> => {
    if (groupCache && deps.now() - groupCache.at < 10 * 60 * 1000) return groupCache.byId;
    const byId = new Map<string, string>();
    try {
      const answer = await api('GET', '/customer-groups', { query: { limit: 100 } });
      for (const group of Array.isArray(answer.results) ? answer.results : []) if (group?.id && group?.key) byId.set(String(group.id), String(group.key));
    } catch {
      // Without the list (the client may not be allowed to read it) the tier prices are left out; nothing else changes.
    }
    groupCache = { at: deps.now(), byId };
    return byId;
  };
  const tierPricesOf = (prices: any[] | undefined, byId: Map<string, string>): Rec | undefined => {
    const wanted = setting(env, 'COMMERCETOOLS_CURRENCY');
    const out: Rec = {};
    for (const price of Array.isArray(prices) ? prices : []) {
      const key = price?.customerGroup?.obj?.key ?? byId.get(String(price?.customerGroup?.id));
      const amount = money(price?.value);
      if (key && amount && !price.channel && (!wanted || amount.currency === wanted)) out[String(key)] = amount.amount;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const brandOf = (variant: any) => {
    const name = setting(env, 'COMMERCETOOLS_BRAND_ATTRIBUTE') ?? 'brand';
    return attributeText((variant?.attributes ?? []).find((attribute: any) => attribute?.name === name)?.value, locale());
  };

  const productRecord = (product: any, byId: Map<string, string> = new Map()): Rec => {
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
      tierPrices: tierPricesOf(variant.prices, byId),
      inStock: typeof variant.availability?.isOnStock === 'boolean' ? variant.availability.isOnStock : undefined,
      image: variant.images?.[0]?.url,
      variantCount: (product?.variants?.length ?? 0) + 1,
    });
  };

  const customLineSku = (line: any): string => {
    const key = String(line.key ?? line.slug ?? '');
    const decoded = key.startsWith('jax_') ? Buffer.from(key.slice(4), 'base64url').toString('utf8') : '';
    return decoded && `jax_${Buffer.from(decoded).toString('base64url')}` === key ? decoded : line.slug;
  };

  /** What a paid shop order looks like once recorded: its number, states, custom lines and money. */
  const placedRecord = (order: any): Rec => {
    const lines: any[] = Array.isArray(order?.customLineItems) ? order.customLineItems : [];
    return compact({
      orderNumber: order?.orderNumber,
      orderId: order?.id,
      state: order?.orderState,
      paymentState: order?.paymentState,
      lineCount: lines.length,
      lines: lines.slice(0, 50).map((line) => {
        return compact({ name: localised(line.name, locale()), sku: customLineSku(line), quantity: line.quantity, total: money(line.totalPrice)?.amount });
      }),
      tax: money(order?.taxedPrice?.totalTax)?.amount,
      total: money(order?.taxedPrice?.totalGross ?? order?.totalPrice)?.amount,
      currency: order?.totalPrice?.currencyCode,
      createdAt: order?.createdAt,
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
    // An order made by the shop after payment carries its lines as custom lines (name, code, price), so both kinds are shown.
    const products: any[] = Array.isArray(order?.lineItems) ? order.lineItems : [];
    const customs: any[] = Array.isArray(order?.customLineItems) ? order.customLineItems : [];
    const lines = [...products.map((line) => ({ line, sku: line.variant?.sku })), ...customs.map((line) => ({ line, sku: customLineSku(line) }))];
    const address = order?.shippingAddress;
    const gross = order?.taxedPrice?.totalGross ?? order?.totalPrice;
    return compact({
      orderId: order?.id,
      version: order?.version,
      orderNumber: order?.orderNumber,
      state: order?.orderState,
      paymentState: order?.paymentState,
      shipmentState: order?.shipmentState,
      customerId: order?.customerId,
      created: order?.createdAt,
      total: money(gross)?.amount,
      tax: money(order?.taxedPrice?.totalTax)?.amount,
      currency: order?.totalPrice?.currencyCode,
      itemCount: lines.reduce((sum, entry) => sum + (Number(entry.line.quantity) || 0), 0),
      // Only the town and postcode: enough to talk about a delivery without copying a street address into a chat.
      shipTo: address ? compact({ city: address.city, postalCode: address.postalCode, country: address.country }) : undefined,
      lines: withLines ? lines.slice(0, 50).map(({ line, sku }) => compact({
        sku,
        name: localised(line.name, locale()),
        quantity: line.quantity,
        total: money(line.totalPrice)?.amount,
      })) : undefined,
    });
  };

  /**
   * Product Search, the search commercetools gives projects made after 2026-09-01 (the older Product Projection Search cannot be switched on
   * for them). Needs the project's "products search" indexing to be on, which the B2B loader does. Each hit carries the product as the shop shows it.
   */
  const searchProducts = async (query: Rec | undefined, limit: number): Promise<{ total: number; results: any[] }> => {
    const currency = setting(env, 'COMMERCETOOLS_CURRENCY');
    const answer = await api('POST', '/products/search', {
      body: {
        limit,
        ...(query ? { query } : { sort: [{ field: 'lastModifiedAt', order: 'desc' }] }),
        productProjectionParameters: { staged: false, ...(currency ? { priceCurrency: currency } : {}) },
      },
    });
    const hits: any[] = Array.isArray(answer.results) ? answer.results : [];
    return { total: Number(answer.total ?? hits.length), results: hits.map((hit) => hit?.productProjection).filter(Boolean) };
  };

  // ── Business units: the trade accounts. ────────────────────────────────────────────────────
  const unitRecord = (unit: any): Rec => {
    const fields = unit?.custom?.fields ?? {};
    const limit = money(fields.creditLimit);
    return compact({
      unitKey: unit?.key,
      name: unit?.name,
      kind: unit?.unitType,
      status: unit?.status,
      parentUnit: unit?.parentUnit?.key,
      accountNumber: fields.accountNumber,
      tier: fields.tier,
      tradeType: fields.tradeType,
      homeBranchCode: fields.homeBranchCode,
      accountManager: fields.accountManager,
      paymentTerms: fields.paymentTerms,
      creditLimit: limit?.amount,
      currency: limit?.currency,
      salesforceAccountId: fields.salesforceAccountId,
      contactEmail: unit?.contactEmail,
      city: unit?.addresses?.[0]?.city,
    });
  };
  const MAX_UNITS = 500;
  const allUnits = async (): Promise<{ units: any[]; total: number }> => {
    const answer = await api('GET', '/business-units', { query: { limit: MAX_UNITS, sort: 'name asc' } });
    const units: any[] = Array.isArray(answer.results) ? answer.results : [];
    return { units, total: Number(answer.total ?? units.length) };
  };
  const findUnit = async (given: string): Promise<any | undefined> => {
    try {
      return await api('GET', `/business-units/key=${encodeURIComponent(given.toLowerCase())}`);
    } catch (error) {
      if (!(error instanceof ToolError && error.code === 'not_found')) throw error;
    }
    const wanted = given.toLowerCase();
    return (await allUnits()).units.find((unit) => [unit.custom?.fields?.accountNumber, unit.custom?.fields?.salesforceAccountId].some((value) => String(value ?? '').toLowerCase() === wanted));
  };

  const tools: ToolSpec[] = [
    ...commerceCustomerProfile(api, orderRecord),
    ...commerceOrderPayment(api),
    ...commerceAccountContact(api),
    orderContactCorrection(api),
    {
      name: 'find_product',
      readOnly: true,
      description: 'Search the online store\'s products by words in the name, and by brand or department. With no words it lists the most recently changed products. Returns sku, name, the retail price, the account price for each tier (tierPrices: bronze, silver, gold) and brand. For stock use stock_by_branch.',
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
        const limit = boundedInt(args.limit, 10, 1, 25);
        const words = typeof args.query === 'string' ? args.query.trim() : '';
        // Brand and department are attributes of the product; a part of the value is enough (case does not matter).
        const filters: Rec[] = [];
        for (const [field, value] of [[setting(env, 'COMMERCETOOLS_BRAND_ATTRIBUTE') ?? 'brand', args.brand], ['department', args.department]] as const) {
          const clean = typeof value === 'string' ? value.replace(/[*?\\]/g, ' ').trim() : '';
          if (clean) filters.push({ wildcard: { field: `variants.attributes.${field}`, fieldType: 'text', value: `*${clean}*`, caseInsensitive: true } });
        }
        const search = (mustMatch: 'all' | 'any') => {
          const parts = [...(words ? [{ fullText: { field: 'name', language: locale(), value: words, mustMatch } }] : []), ...filters];
          return searchProducts(parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts }, limit);
        };
        // Every word first; if nothing has them all, any word will do, best match first.
        let found = await search('all');
        if (words.includes(' ') && found.results.length === 0) found = await search('any');
        const byId = found.results.length ? await groupKeys() : new Map<string, string>();
        return { total: found.total, returned: found.results.length, records: found.results.map((product) => productRecord(product, byId)) };
      },
    },
    {
      name: 'get_product',
      readOnly: true,
      description: 'One product by its sku, with the details of that variant (price and its main attributes).',
      inputSchema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string', maxLength: 100, pattern: SKU.source } } },
      async run(args) {
        const sku = String(args.sku);
        const found = await searchProducts({ exact: { field: 'variants.sku', value: sku } }, 1);
        const product = found.results[0];
        if (!product) throw new ToolError('not_found', `${SYSTEM} has no product with sku ${sku}.`);
        const variants: any[] = [product.masterVariant, ...(product.variants ?? [])].filter(Boolean);
        const match = variants.find((variant) => String(variant.sku).toLowerCase() === sku.toLowerCase()) ?? product.masterVariant;
        const price = pickPrice(match?.prices);
        const byId = await groupKeys();
        return {
          record: {
            ...productRecord(product, byId),
            matchedSku: match?.sku,
            variant: compact({
              sku: match?.sku,
              price: price?.amount,
              currency: price?.currency,
              tierPrices: tierPricesOf(match?.prices, byId),
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
      name: 'get_order_receipt',
      readOnly: true,
      description: 'Read a paid order delivery receipt by its stable order number. Returns record null only when the commerce system confirms it does not exist.',
      inputSchema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', maxLength: 64, pattern: ORDER_NUMBER.source } } },
      async run(args) {
        try { return { record: placedRecord(await api('GET', `/orders/order-number=${encodeURIComponent(String(args.orderId))}`)) }; }
        catch (error) { if (error instanceof ToolError && error.code === 'not_found') return { record: null }; throw error; }
      },
    },
    {
      name: 'place_order',
      readOnly: false,
      requiresPaymentReceipt: true,
      description: 'Record a paid shop order: one order with its lines (name, product code, quantity, price before tax), tax at the given rate, the delivery address and the order number the customer saw. The shop calls it after payment; asking again with the same order number returns the order already made.',
      inputSchema: {
        type: 'object',
        required: ['orderNumber', 'currency', 'lines', 'taxCountry', 'taxName'],
        properties: {
          orderNumber: { type: 'string', maxLength: 64, pattern: ORDER_NUMBER.source, description: 'The order number the customer saw.' },
          customerKey: { type: 'string', maxLength: 120, pattern: '^[A-Za-z0-9_.-]+$', description: 'Server-owned verified customer-profile reference, when registered.' },
          currency: { type: 'string', maxLength: 3, pattern: CURRENCY.source },
          taxRate: { type: 'number', minimum: 0, maximum: 1, description: 'Tax as a fraction of the price, for example 0.15.' },
          taxCountry: { type: 'string', pattern: COUNTRY.source, maxLength: 2, description: 'The merchant-configured tax jurisdiction, not inferred from currency.' },
          taxName: { type: 'string', minLength: 1, maxLength: 80 },
          expectedTotal: { type: 'number', minimum: 0, description: 'The exact paid quote total; the vendor cart must match before an order is created.' },
          existingOrderId: { type: 'string', maxLength: 64, description: 'Recovery only: acknowledge this exact existing vendor order; never create another.' },
          discount: { type: 'number', minimum: 0, description: 'The whole order discount before tax, spread over the lines.' },
          customerEmail: { type: 'string', maxLength: 320 },
          paid: { type: 'boolean', description: 'Mark the order paid (default true).' },
          lines: { type: 'array', description: 'Each line: sku, name, quantity (whole number), unitPrice (before tax, in whole currency units).' },
          shipping: { type: 'object', description: 'Optional: name, line1, line2, city, state, postalCode, country (two letters).' },
        },
      },
      async run(args) {
        const orderNumber = String(args.orderNumber);
        const currency = String(args.currency);
        const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
        if (digits === undefined || !Number.isInteger(digits) || digits > 3) throw new ToolError('invalid_arguments', 'The currency precision is not supported.');
        const raw = Array.isArray(args.lines) ? args.lines : [];
        if (raw.length < 1 || raw.length > 50) throw new ToolError('invalid_arguments', 'lines must hold between 1 and 50 lines.');
        const lines = raw.map((line: any, index: number) => {
          const sku = String(line?.sku ?? '');
          const name = String(line?.name ?? '').trim();
          const quantity = Number(line?.quantity);
          const unitPrice = Number(line?.unitPrice);
          if (!SKU.test(sku)) throw new ToolError('invalid_arguments', `line ${index + 1}: sku is not in the expected form.`);
          if (!name || name.length > 255) throw new ToolError('invalid_arguments', `line ${index + 1}: name must be between 1 and 255 characters.`);
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new ToolError('invalid_arguments', `line ${index + 1}: quantity must be a whole number from 1 to 1000.`);
          if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000) throw new ToolError('invalid_arguments', `line ${index + 1}: unitPrice must be a number from 0 to 1000000.`);
          return { sku, name, quantity, unitPrice };
        });
        const taxRate = args.taxRate === undefined ? 0 : Number(args.taxRate);
        const discount = args.discount === undefined ? 0 : Number(args.discount);
        commerceOrderMoney(lines, currency, discount, taxRate, args.expectedTotal);

        const ship: any = args.shipping && typeof args.shipping === 'object' && !Array.isArray(args.shipping) ? args.shipping : {};
        if (!COUNTRY.test(String(args.taxCountry ?? '')) || !String(args.taxName ?? '').trim()) throw new ToolError('invalid_arguments', 'The merchant tax country and label are required.');
        const country = String(args.taxCountry);
        if (Object.keys(ship).length && !COUNTRY.test(String(ship.country ?? ''))) throw new ToolError('invalid_arguments', 'A supplied shipping address requires its actual country.');
        const [firstName, ...rest] = String(ship.name ?? '').trim().split(/\s+/).filter(Boolean);
        const address = compact({
          country: ship.country, firstName, lastName: rest.join(' ') || undefined, streetName: clip(String(ship.line1 ?? ''), 120) || undefined,
          additionalStreetInfo: clip(String(ship.line2 ?? ''), 120) || undefined, city: clip(String(ship.city ?? ''), 80) || undefined,
          state: clip(String(ship.state ?? ''), 80) || undefined, postalCode: clip(String(ship.postalCode ?? ''), 20) || undefined,
          email: args.customerEmail ? String(args.customerEmail) : undefined,
        });

        // Asking again for an order number that exists returns that order: a retried payment never makes a second one.
        let existing: any;
        try { existing = await api('GET', `/orders/order-number=${encodeURIComponent(orderNumber)}`); }
        catch (error) { if (!(error instanceof ToolError && error.code === 'not_found')) throw error; }
        if (args.existingOrderId && (!existing || existing.id !== args.existingOrderId)) throw new ToolError('payment_reconciliation', 'The exact recovery order is unavailable; no new order was created.');
        if (existing) {
          if (args.paid !== false && existing.paymentState !== 'Paid') {
            const receipt = placedRecord(existing);
            const items = (value: any[]) => value.map(line => [line.sku, line.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
            if (![undefined, 'Pending', 'BalanceDue'].includes(existing.paymentState) || args.expectedTotal === undefined || receipt.total !== args.expectedTotal || receipt.currency !== currency || JSON.stringify(items(receipt.lines)) !== JSON.stringify(items(lines))) throw new ToolError('payment_reconciliation', 'The existing order cannot be acknowledged against this paid quote.');
            existing = await api('POST', `/orders/${existing.id}`, { body: { version: existing.version, actions: [{ action: 'changePaymentState', paymentState: 'Paid' }] } });
          }
          return { created: false, record: placedRecord(existing) };
        }
        if (!ship.line1 || !COUNTRY.test(String(ship.country ?? ''))) throw new ToolError('invalid_arguments', 'A genuine shipping address is required before creating an order.');

        const customer = args.customerKey ? await api('GET', `/customers/key=${encodeURIComponent(String(args.customerKey))}`) : undefined;
        if (customer && (!customer.id || String(customer.email).toLowerCase() !== String(args.customerEmail).toLowerCase())) throw new ToolError('identity_conflict', 'The registered customer does not match the order owner.');
        const { cart } = await preparePaidCommerceCart(api, { orderNumber, currency, locale: locale(), lines, discount, taxRate, taxCountry: country, taxName: String(args.taxName), expectedTotal: args.expectedTotal,
          ...(args.customerEmail ? { customerEmail: String(args.customerEmail) } : {}), ...(customer?.id ? { customerId: customer.id } : {}), ...(ship && Object.keys(address).length > 1 ? { shippingAddress: address } : {}) });
        let order = await api('POST', '/orders', { body: { id: cart.id, version: cart.version, orderNumber } });
        if (args.paid !== false) {
          order = await api('POST', `/orders/${order.id}`, { body: { version: order.version, actions: [{ action: 'changePaymentState', paymentState: 'Paid' }] } });
        }
        return { created: true, record: placedRecord(order) };
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
      description: 'The orders of one account (a commercetools customer, or a business unit when the connection is set up that way: then accountId is the unit key such as acc-0001), newest first.',
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
    {
      name: 'list_orders',
      readOnly: true,
      description: 'The newest orders from every account, newest first. Filter by order state (open, confirmed, complete, cancelled), shipment state (pending, ready, partial, shipped, delayed, backorder) or how recently placed (sinceHours: 24 is the last day). For one account use order_history, for one order get_order.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: Object.keys(ORDER_STATES) },
          shipment: { type: 'string', enum: Object.keys(SHIPMENT_STATES) },
          sinceHours: { type: 'integer', minimum: 1, maximum: 720, description: 'Only orders placed in the last this-many hours.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const clauses: string[] = [];
        if (args.status) clauses.push(`orderState="${ORDER_STATES[String(args.status)]}"`);
        if (args.shipment) clauses.push(`shipmentState="${SHIPMENT_STATES[String(args.shipment)]}"`);
        if (args.sinceHours !== undefined) clauses.push(`createdAt >= "${new Date(deps.now() - boundedInt(args.sinceHours, 24, 1, 720) * 3_600_000).toISOString()}"`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const answer = await api('GET', '/orders', { query: { ...(clauses.length ? { where: clauses.join(' and ') } : {}), sort: 'createdAt desc', limit } });
        const results: any[] = Array.isArray(answer.results) ? answer.results : [];
        return { total: answer.total ?? answer.count ?? results.length, returned: results.length, ...(results.length === limit && Number(answer.total) > results.length ? { more: true } : {}), records: results.map((order) => orderRecord(order, false)) };
      },
    },
    {
      name: 'stock_by_branch',
      readOnly: true,
      description: 'Stock of one product (by sku) at each branch that holds it, most first, with the total. Pass part of a branch name (for example Hamilton) to look at one branch.',
      inputSchema: {
        type: 'object',
        required: ['sku'],
        properties: {
          sku: { type: 'string', maxLength: 100, pattern: SKU.source },
          branch: { type: 'string', maxLength: 80, description: 'Part of a branch name, or its branch code.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many branches to list (default 10).' },
        },
      },
      async run(args) {
        const sku = String(args.sku);
        const answer = await api('GET', '/inventory', { query: { where: `sku="${sku}"`, expand: 'supplyChannel', limit: 100 } });
        const rows = (Array.isArray(answer.results) ? answer.results : []).map((entry: any) => ({
          branch: localised(entry.supplyChannel?.obj?.name, locale()) || undefined,
          branchCode: String(entry.supplyChannel?.obj?.key ?? '').replace(/^branch-/, '') || undefined,
          onHand: Number(entry.quantityOnStock) || 0,
          available: typeof entry.availableQuantity === 'number' ? entry.availableQuantity : undefined,
        }));
        if (!rows.length) throw new ToolError('not_found', `${SYSTEM} has no stock entries for sku ${sku}.`);
        const wanted = typeof args.branch === 'string' ? args.branch.trim().toLowerCase() : '';
        const shown = rows.filter((row: any) => !wanted || String(row.branch ?? '').toLowerCase().includes(wanted) || row.branchCode === wanted).sort((a: any, b: any) => b.onHand - a.onHand);
        return {
          sku,
          branchesHolding: rows.filter((row: any) => row.onHand > 0).length,
          totalOnHand: rows.reduce((sum: number, row: any) => sum + row.onHand, 0),
          ...(wanted ? { matching: shown.length } : {}),
          ...(wanted && !shown.length ? { note: `No stock entry for a branch matching "${String(args.branch).trim()}". This product is held at ${rows.length} other branch${rows.length === 1 ? '' : 'es'}; leave the branch out to list them.` } : {}),
          records: shown.slice(0, boundedInt(args.limit, 10, 1, 25)).map((row: any) => compact(row)),
        };
      },
    },
    {
      name: 'find_account',
      readOnly: true,
      description: 'Customer accounts on credit terms (business units) by part of the name, the account number or the unit key, optionally one tier as the merchant stores it. Returns the unit key, tier, home branch, account manager, payment terms, credit limit and the Salesforce account id.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 120, description: 'Part of the account name, the account number (for example ACC-0001) or the unit key.' },
          tier: { type: 'string', minLength: 1, maxLength: 60 },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const { units, total } = await allUnits();
        const words = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const matches = units.filter((unit) => {
          const fields = unit.custom?.fields ?? {};
          if (args.tier && String(fields.tier ?? '').toLowerCase() !== String(args.tier)) return false;
          return !words || [unit.name, unit.key, fields.accountNumber].some((value) => String(value ?? '').toLowerCase().includes(words));
        });
        const limit = boundedInt(args.limit, 10, 1, 25);
        return { total: matches.length, returned: Math.min(matches.length, limit), more: matches.length > limit || total > units.length, ...(total > units.length ? { note: `Only the first ${units.length} of ${total} units were searched.` } : {}), records: matches.slice(0, limit).map(unitRecord) };
      },
    },
    {
      name: 'get_account',
      readOnly: true,
      description: 'One customer account (business unit) by its unit key, account number or Salesforce account id: its terms, the people who work for it with their roles, its divisions and how many orders it has.',
      inputSchema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', maxLength: 64, pattern: ID.source, description: 'The unit key (acc-0001), the account number (ACC-0001) or the Salesforce account id.' } } },
      async run(args) {
        const unit = await findUnit(String(args.accountId).trim());
        if (!unit) throw new ToolError('not_found', `${SYSTEM} has no account ${String(args.accountId)}.`);
        const associates: any[] = Array.isArray(unit.associates) ? unit.associates : [];
        const ids = associates.map((associate) => String(associate?.customer?.id ?? '')).filter((id) => UUID.test(id));
        const people = ids.length ? await api('GET', '/customers', { query: { where: `id in (${ids.map((id) => `"${id}"`).join(', ')})`, limit: 50 } }) : { results: [] };
        const byId = new Map<string, any>((Array.isArray(people.results) ? people.results : []).map((customer: any) => [String(customer.id), customer]));
        const [divisions, orders] = await Promise.all([
          api('GET', '/business-units', { query: { where: `parentUnit(key="${String(unit.key).replace(/[^A-Za-z0-9_-]/g, '')}")`, limit: 25 } }),
          api('GET', '/orders', { query: { where: `businessUnit(key="${String(unit.key).replace(/[^A-Za-z0-9_-]/g, '')}")`, limit: 1 } }),
        ]);
        return {
          record: {
            ...unitRecord(unit),
            people: associates.map((associate) => {
              const customer = byId.get(String(associate?.customer?.id));
              return compact({
                name: customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : undefined,
                email: customer?.email,
                roles: (associate?.associateRoleAssignments ?? []).map((assignment: any) => assignment?.associateRole?.key).filter(Boolean),
              });
            }),
            divisions: (Array.isArray(divisions.results) ? divisions.results : []).map((division: any) => compact({ unitKey: division.key, name: division.name })),
            orderCount: Number(orders.total ?? 0),
          },
        };
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
