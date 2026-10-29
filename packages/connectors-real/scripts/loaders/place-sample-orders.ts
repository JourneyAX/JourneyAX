/**
 * Places the sample orders in commercetools under the order numbers the other systems already use (ORD-1000nn), so the ERP's deliveries and
 * Salesforce's cases find their order. The sample commerce data is the only source: lines, quantities, placed dates and statuses are taken from
 * it, never invented. The 36 orders are the ones an ERP delivery or a Salesforce case names (27 trade, 9 guest).
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/place-sample-orders.ts --trial [--check] [--apply] [--manifest file]
 *
 * Which orders:  --trial (ORD-100034 trade and ORD-100004 guest), or --orders ORD-100034,ORD-100004, or --all (the 36; a dry run only for now).
 * A dry run (the default) prints the exact request for each order and sends nothing. --check adds read-only calls (it signs in and reads): does the
 * number exist already, the business unit, the store, and the account's buyer, whose id goes into the printed request.
 * --apply imports the orders through commercetools' Order Import (POST /orders/import), one at a time, skipping any number that exists, and writes a
 * manifest (order number, id, version, what was read back) before the first order and after every order. It stops at the first error and says why.
 *
 * What an order looks like: a trade order is attached to the account's business unit (key = the account number in lower case, acc-0004) and its buyer,
 * priced at the account's tier price from the ERP price list; a guest order has an e-mail (guest-<number>@example.test) and no account, priced at
 * retail. The sample order status and delivery status become commercetools' order state and shipment state (STATES). The placed date becomes
 * `completedAt`, because `createdAt` cannot be set on an import.
 *
 * It signs in with the loader's own client (COMMERCETOOLS_LOADER_CLIENT_ID / _SECRET), like the other loaders; the chat's connection never places
 * orders and `place_order` stays blocked. There is no automatic fallback: if the import refuses something, it stops, and what to try instead is
 * decided after reading the vendor's message. Nothing here deletes an order.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { errorFor, redact, send, setting, vendorMessage } from '../../src/http';
import { ToolError, type Deps, type Env, type Rec } from '../../src/types';
import { cents, readFlags, required, sampleCollection, sleep } from './shared';

const SYSTEM = 'commercetools';
const LOCALE = 'en-NZ';
const CURRENCY = 'NZD';
const COUNTRY = 'NZ';
const STORE = 'placemakers-nz';
const TIERS = ['bronze', 'silver', 'gold'] as const;

/** The two orders the owner approved for the trial (28 Oct 2026): the smallest finished trade order and the smallest guest order. */
export const TRIAL = ['ORD-100034', 'ORD-100004'];
/** Placing more than the trial pair is a separate yes. Change this to true only after the trial has been read back and the owner has said so. */
const BATCH_APPROVED = false;

export type OrderState = 'Open' | 'Confirmed' | 'Complete' | 'Cancelled';
export type ShipmentState = 'Pending' | 'Ready' | 'Shipped' | 'Delayed';

/** Sample order status + sample delivery status (none when there is no ERP delivery) -> commercetools order state / shipment state. Anything else is an error: nothing is guessed. */
export const STATES: Record<string, [OrderState, ShipmentState | undefined]> = {
  'placed|scheduled': ['Open', 'Pending'],
  'placed|failed_attempt': ['Open', 'Delayed'],
  'confirmed|scheduled': ['Confirmed', 'Ready'],
  'confirmed|failed_attempt': ['Confirmed', 'Delayed'],
  'confirmed|none': ['Confirmed', 'Pending'],
  'picked|scheduled': ['Confirmed', 'Ready'],
  'picked|failed_attempt': ['Confirmed', 'Delayed'],
  'picked|none': ['Confirmed', 'Ready'],
  'dispatched|out_for_delivery': ['Confirmed', 'Shipped'],
  'delivered|delivered': ['Complete', 'Shipped'],
  'collected|none': ['Complete', 'Shipped'],
  'ready_for_collection|none': ['Confirmed', 'Ready'],
  'cancelled|none': ['Cancelled', undefined],
};

export function statesFor(orderStatus: string, deliveryStatus?: string): { orderState: OrderState; shipmentState?: ShipmentState } {
  const found = STATES[`${orderStatus}|${deliveryStatus ?? 'none'}`];
  if (!found) throw new Error(`No state is set for a sample order that is "${orderStatus}" with ${deliveryStatus ? `a "${deliveryStatus}" delivery` : 'no delivery'}.`);
  return { orderState: found[0], ...(found[1] ? { shipmentState: found[1] } : {}) };
}

export interface PlannedOrder {
  orderNumber: string;
  kind: 'trade' | 'guest';
  accountId?: string;
  accountName?: string;
  tier?: string;
  /** The business unit's key (the account number in lower case); trade orders only. */
  unitKey?: string;
  placedAt: string;
  deliveryType: string;
  orderState: OrderState;
  shipmentState?: ShipmentState;
  /** What the sample says (every line at retail). */
  retailCents: number;
  /** What is placed: the tier price for a trade order, the retail price for a guest order. */
  totalCents: number;
  lines: Array<{ sku: string; title: string; quantity: number; unitCents: number }>;
}

/** The orders an ERP delivery or a Salesforce case names: the 36. */
export function sampleOrderNumbers(): string[] {
  const named = new Set<string>();
  for (const delivery of sampleCollection('ace-erp', 'deliveries')) named.add(String(delivery.orderId));
  for (const row of sampleCollection('salesforce', 'cases')) if (row.relatedOrderId) named.add(String(row.relatedOrderId));
  return [...named].sort();
}

/** Builds the orders from the sample data. Pure and deterministic; throws on anything that does not add up rather than placing a guess. */
export function planOrders(numbers: string[]): PlannedOrder[] {
  const orders = new Map(sampleCollection('sap-commerce', 'orders').map((row) => [String(row.orderId), row]));
  const lines = sampleCollection('sap-commerce', 'order_lines');
  const deliveries = new Map(sampleCollection('ace-erp', 'deliveries').map((row) => [String(row.orderId), row]));
  const accounts = new Map(sampleCollection('salesforce', 'accounts').map((row) => [String(row.accountId), row]));
  const balances = new Map(sampleCollection('ace-erp', 'account_balances').map((row) => [String(row.accountId), row]));
  const prices = new Map(sampleCollection('ace-erp', 'price_list').map((row) => [String(row.sku), row]));

  return numbers.map((orderNumber) => {
    const order = orders.get(orderNumber);
    if (!order) throw new Error(`${orderNumber} is not in the sample commerce data.`);
    const trade = order.customerType === 'trade';
    const account = trade ? accounts.get(String(order.accountId)) : undefined;
    if (trade && !account) throw new Error(`${orderNumber} names account ${order.accountId}, which Salesforce's sample accounts do not have.`);
    const tier = account ? String(account.tier) : undefined;
    if (account && balances.get(String(account.accountId))?.tier !== tier) throw new Error(`${orderNumber}: Salesforce and the ERP disagree about the tier of ${account.accountId}.`);
    if (tier && !(TIERS as readonly string[]).includes(tier)) throw new Error(`${orderNumber}: unknown tier "${tier}".`);

    const own = lines.filter((line) => line.orderId === orderNumber);
    if (!own.length) throw new Error(`${orderNumber} has no lines in the sample data.`);
    let retailCents = 0;
    let totalCents = 0;
    const planned = own.map((line) => {
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`${orderNumber}: line ${line.lineId} has quantity ${line.quantity}.`);
      const retailUnit = cents(line.unitPrice);
      if (cents(line.lineTotal) !== quantity * retailUnit) throw new Error(`${orderNumber}: line ${line.lineId} does not add up (${quantity} x ${line.unitPrice} is not ${line.lineTotal}).`);
      let unitCents = retailUnit;
      if (tier) {
        const tierPrice = prices.get(String(line.sku))?.[`${tier}Price`];
        if (tierPrice === undefined) throw new Error(`${orderNumber}: the ERP price list has no ${tier} price for ${line.sku}.`);
        unitCents = cents(tierPrice);
      }
      retailCents += quantity * retailUnit;
      totalCents += quantity * unitCents;
      return { sku: String(line.sku), title: String(line.title), quantity, unitCents };
    });
    if (retailCents !== cents(order.total)) throw new Error(`${orderNumber}: its lines add up to ${retailCents / 100}, not the ${order.total} the order says.`);

    const delivery = deliveries.get(orderNumber);
    return {
      orderNumber,
      kind: trade ? 'trade' : 'guest',
      ...(account ? { accountId: String(account.accountId), accountName: String(account.name), tier, unitKey: String(account.accountId).toLowerCase() } : {}),
      placedAt: new Date(String(order.placedAt)).toISOString(),
      deliveryType: String(order.deliveryType),
      ...statesFor(String(order.status), delivery ? String(delivery.status) : undefined),
      retailCents,
      totalCents,
      lines: planned,
    } as PlannedOrder;
  });
}

/** The Order Import request. A trade order's buyer id is read from commercetools at run time and passed in (or a note stands in for it in a dry run). */
export function requestFor(order: PlannedOrder, customerId?: string): Rec {
  return {
    orderNumber: order.orderNumber,
    ...(order.kind === 'trade' ? { customerId: customerId ?? `<read at run time: the buyer of ${order.unitKey}>`, businessUnit: { typeId: 'business-unit', key: order.unitKey } } : { customerEmail: `guest-${order.orderNumber.toLowerCase()}@example.test` }),
    store: { typeId: 'store', key: STORE },
    country: COUNTRY,
    origin: 'Customer',
    inventoryMode: 'None',
    completedAt: order.placedAt,
    orderState: order.orderState,
    ...(order.shipmentState ? { shipmentState: order.shipmentState } : {}),
    totalPrice: { currencyCode: CURRENCY, centAmount: order.totalCents },
    lineItems: order.lines.map((line) => ({
      name: { [LOCALE]: line.title },
      variant: { sku: line.sku },
      quantity: line.quantity,
      price: { value: { currencyCode: CURRENCY, centAmount: line.unitCents } },
    })),
  };
}

/** Compares the order commercetools holds with the request that was sent. Returns what differs, in plain words; an empty list means it reads back exactly as sent. */
export function problemsWith(sent: Rec, held: Rec): string[] {
  const problems: string[] = [];
  const same = (what: string, want: unknown, got: unknown) => { if (want !== got) problems.push(`${what}: sent ${want ?? '(none)'}, held ${got ?? '(none)'}`); };
  same('order number', sent.orderNumber, held.orderNumber);
  same('total', sent.totalPrice.centAmount, held.totalPrice?.centAmount);
  same('currency', sent.totalPrice.currencyCode, held.totalPrice?.currencyCode);
  same('order state', sent.orderState, held.orderState);
  same('shipment state', sent.shipmentState, held.shipmentState);
  same('store', sent.store.key, held.store?.key);
  same('business unit', sent.businessUnit?.key, held.businessUnit?.key);
  same('buyer', sent.customerId, held.customerId);
  same('e-mail', sent.customerEmail, held.customerEmail);
  const sentAt = new Date(sent.completedAt).getTime();
  const heldAt = held.completedAt ? new Date(held.completedAt).getTime() : undefined;
  if (sentAt !== heldAt) problems.push(`completed date: sent ${sent.completedAt}, held ${held.completedAt ?? '(none)'}`);
  const lines: Rec[] = held.lineItems ?? [];
  same('number of lines', sent.lineItems.length, lines.length);
  for (const line of sent.lineItems) {
    const found = lines.find((entry) => entry.variant?.sku === line.variant.sku);
    if (!found) { problems.push(`line ${line.variant.sku}: not held`); continue; }
    same(`line ${line.variant.sku} quantity`, line.quantity, found.quantity);
    same(`line ${line.variant.sku} price`, line.price.value.centAmount, found.price?.value?.centAmount);
  }
  return problems;
}

export interface PlaceResult {
  orderNumber: string;
  status: 'planned' | 'placed' | 'already there' | 'failed';
  id?: string;
  version?: number;
  readBack?: 'exactly as sent' | string[];
  error?: string;
}

export interface PlaceSummary { results: PlaceResult[]; manifest?: string }

const money = (centAmount: number) => (centAmount / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function placeSampleOrders(options: { env: Env; deps: Deps; apply: boolean; orders: string[]; check?: boolean; manifest?: string; log?: (line: string) => void }): Promise<PlaceSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  if (!options.orders.length) throw new ToolError('invalid_input', 'Say which orders: --trial, --orders ORD-100034,ORD-100004, or --all.');
  if (apply && !BATCH_APPROVED) {
    const beyond = options.orders.filter((number) => !TRIAL.includes(number));
    if (beyond.length) throw new ToolError('invalid_input', `Only the trial pair (${TRIAL.join(', ')}) may be placed for now. Placing more is a separate yes. Not allowed yet: ${beyond.join(', ')}.`);
  }
  const planned = planOrders(options.orders);
  const needsCredentials = apply || options.check;
  required(env, ['COMMERCETOOLS_PROJECT_KEY', 'COMMERCETOOLS_REGION', ...(needsCredentials ? ['COMMERCETOOLS_LOADER_CLIENT_ID', 'COMMERCETOOLS_LOADER_CLIENT_SECRET'] : [])]);
  const secrets = [setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET') ?? ''];
  const region = setting(env, 'COMMERCETOOLS_REGION')!;
  const api = `${(setting(env, 'COMMERCETOOLS_API_URL') || `https://api.${region}.commercetools.com`).replace(/\/$/, '')}/${setting(env, 'COMMERCETOOLS_PROJECT_KEY')}`;
  const auth = (setting(env, 'COMMERCETOOLS_AUTH_URL') || `https://auth.${region}.commercetools.com`).replace(/\/$/, '');

  const trade = planned.filter((order) => order.kind === 'trade').length;
  log(`${apply ? 'Placing' : 'Dry run. Would place'} ${planned.length} sample order${planned.length === 1 ? '' : 's'} in commercetools (${trade} trade at the account's tier price, ${planned.length - trade} guest at retail), by Order Import.`);
  for (const order of planned) {
    log(`  ${order.orderNumber}  ${order.kind === 'trade' ? `${order.accountId} ${order.accountName} (${order.tier})` : 'guest'}  placed ${order.placedAt.slice(0, 10)}  ${order.lines.length} line${order.lines.length === 1 ? '' : 's'}  ${order.orderState}${order.shipmentState ? ` / ${order.shipmentState}` : ''}  NZD ${money(order.totalCents)}${order.totalCents !== order.retailCents ? ` (retail ${money(order.retailCents)})` : ''}`);
  }

  let call: ((method: string, path: string, body?: unknown, accept?: number[]) => ReturnType<typeof send>) | undefined;
  if (needsCredentials) {
    const basic = Buffer.from(`${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_ID')}:${setting(env, 'COMMERCETOOLS_LOADER_CLIENT_SECRET')}`).toString('base64');
    const login = await send(deps, SYSTEM, 'POST', `${auth}/oauth/token`, { form: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${basic}` } });
    if (!login.ok || typeof login.json?.access_token !== 'string') throw errorFor(SYSTEM, login.status === 400 ? 401 : login.status || 500, redact(vendorMessage(login.json, login.text), secrets));
    const headers = { authorization: `Bearer ${login.json.access_token}` };
    call = async (method, route, body, accept = []) => {
      for (let attempt = 0; ; attempt++) {
        const answer = await send(deps, SYSTEM, method, `${api}${route}`, { headers, ...(body !== undefined ? { body } : {}) });
        if (answer.ok || accept.includes(answer.status)) return answer;
        // Only a request the vendor refused to start (429), or a read (503), is repeated: an import that may have been processed is never sent twice.
        if ((answer.status === 429 || (answer.status === 503 && method === 'GET')) && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
        throw errorFor(SYSTEM, answer.status, redact(vendorMessage(answer.json, answer.text), secrets));
      }
    };
  }

  /** The account's buyer: the customer on the unit's existing order, else the customer the B2B loader made for it. Undefined when neither is found. */
  const buyerOf = async (unitKey: string): Promise<string | undefined> => {
    const existing = await call!('GET', `/orders?where=${encodeURIComponent(`businessUnit(key="${unitKey}")`)}&limit=1`, undefined, [400]);
    const id = existing.ok ? existing.json?.results?.[0]?.customerId : undefined;
    if (id) return String(id);
    const buyer = await call!('GET', `/customers/key=${encodeURIComponent(`${unitKey}-buyer`)}`, undefined, [404]);
    return buyer.ok && buyer.json?.id ? String(buyer.json.id) : undefined;
  };
  const exists = async (route: string) => (await call!('GET', route, undefined, [404])).ok;
  const held = async (orderNumber: string) => { const answer = await call!('GET', `/orders/order-number=${encodeURIComponent(orderNumber)}`, undefined, [404]); return answer.ok ? answer.json as Rec : undefined; };

  const results: PlaceResult[] = planned.map((order) => ({ orderNumber: order.orderNumber, status: 'planned' }));

  if (!apply) {
    for (const order of planned) {
      let customerId: string | undefined;
      if (call) {
        const there = await held(order.orderNumber);
        log(`  read: ${order.orderNumber} ${there ? 'already exists in commercetools (it would be skipped)' : 'does not exist yet'}`);
        log(`  read: store ${STORE} ${(await exists(`/stores/key=${STORE}`)) ? 'exists' : 'DOES NOT EXIST'}`);
        if (order.unitKey) {
          log(`  read: business unit ${order.unitKey} ${(await exists(`/business-units/key=${order.unitKey}`)) ? 'exists' : 'DOES NOT EXIST'}`);
          customerId = await buyerOf(order.unitKey);
          log(`  read: the buyer of ${order.unitKey} ${customerId ? `is ${customerId}` : 'WAS NOT FOUND'}`);
        }
      }
      log(`\n${order.orderNumber} would be sent to POST /orders/import as:\n${JSON.stringify(requestFor(order, customerId), null, 2)}`);
    }
    log('\nNothing was sent to be placed. Add --apply to place them.');
    return { results };
  }

  const manifestFile = path.resolve(options.manifest ?? path.join('scratch', `place-sample-orders-${new Date(deps.now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}.manifest.json`));
  const startedAt = new Date(deps.now()).toISOString();
  const save = (finished: boolean) => {
    mkdirSync(path.dirname(manifestFile), { recursive: true });
    writeFileSync(manifestFile, `${JSON.stringify({ project: setting(env, 'COMMERCETOOLS_PROJECT_KEY'), startedAt, finished, orders: results.map((result, index) => ({ ...result, placedAt: planned[index].placedAt, totalCents: planned[index].totalCents })) }, null, 2)}\n`);
  };
  save(false);
  log(`Manifest: ${manifestFile}`);

  for (const [index, order] of planned.entries()) {
    const result = results[index];
    try {
      const there = await held(order.orderNumber);
      if (there) { Object.assign(result, { status: 'already there', id: String(there.id), version: Number(there.version) }); log(`${order.orderNumber}: already there (id ${there.id}); skipped.`); save(false); continue; }
      let customerId: string | undefined;
      if (order.unitKey) {
        customerId = await buyerOf(order.unitKey);
        if (!customerId) throw new ToolError('not_found', `Could not find the buyer of ${order.unitKey} in commercetools, so ${order.orderNumber} was not placed.`);
      }
      const request = requestFor(order, customerId);
      const imported = await call!('POST', '/orders/import', request);
      Object.assign(result, { status: 'placed', id: String(imported.json?.id), version: Number(imported.json?.version) });
      const stored = await held(order.orderNumber);
      const problems = stored ? problemsWith(request, stored) : ['not found when read back'];
      result.readBack = problems.length ? problems : 'exactly as sent';
      log(`${order.orderNumber}: placed (id ${result.id}, version ${result.version}); read back ${problems.length ? `DIFFERS: ${problems.join('; ')}` : 'exactly as sent'}.`);
    } catch (error: any) {
      Object.assign(result, { status: 'failed', error: redact(String(error?.message ?? error), secrets) });
      save(false);
      log(`${order.orderNumber}: stopped. ${result.error}`);
      throw error;
    }
    save(false);
  }
  save(true);
  const placed = results.filter((result) => result.status === 'placed').length;
  const different = results.filter((result) => Array.isArray(result.readBack)).length;
  log(`Done: ${placed} placed, ${results.length - placed} already there${different ? `, ${different} read back with differences (see the manifest)` : ''}.`);
  return { results, manifest: manifestFile };
}

async function main() {
  const flags = readFlags(process.argv.slice(2), []);
  const named = flags.rest.indexOf('--orders');
  const orders = flags.rest.includes('--all') ? sampleOrderNumbers()
    : flags.rest.includes('--trial') ? TRIAL
    : named >= 0 ? String(flags.rest[named + 1] ?? '').split(',').map((number) => number.trim()).filter(Boolean) : [];
  const manifestAt = flags.rest.indexOf('--manifest');
  await placeSampleOrders({
    env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, orders, check: flags.rest.includes('--check'),
    manifest: manifestAt >= 0 ? flags.rest[manifestAt + 1] : undefined, log: console.log,
  });
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
