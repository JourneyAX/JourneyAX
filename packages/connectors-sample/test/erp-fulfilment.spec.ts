import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectorsSchema } from '../../business-pack/src/schemas/connectors.schema';
import { DEFAULT_CONNECTORS_DIR, TenantCollections, loadConnectors } from '../src/loader';
import { resolveExample } from '../src/examples';
import { SampleConnectorServer } from '../src/server';
import type { Rec, SeedFile } from '../src/types';
import { planExtension, run } from '../scripts/extend-seeds';
import { applySeedStages, stageConnectorIds } from '../scripts/seed-stages';
import {
  EVENT_TYPES, FULFILMENT_COLLECTIONS, SAMPLE_CARRIER, SAMPLE_FIRST_CONSIGNMENT_NUMBER, SAMPLE_FIRST_EVENT_NUMBER, SAMPLE_MINUTES, SAMPLE_PEOPLE,
  SHIPMENT_EVENT_TYPES, erpFulfilment, windowStart,
} from '../scripts/seed-stages/erp-fulfilment';
import { SAMPLE_AS_OF } from '../scripts/seed-stages/erp-invoices';
import { readme, seedText } from '../scripts/seed-writing';

/**
 * The sample ERP's consignments, consignment lines and tracking events, the carrier on the delivery rows, and the four tools that read them.
 * Every tool runs in the process (`handle`, never `listen`), and the stage is tested through the stage list and extend-seeds: the full build
 * (build-seeds.ts) reads a data folder outside the repository. The counts are worked out from the seeds in the test, not written down.
 */
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const TENANT = 'placemakers';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CONTRACT_SPEC = path.resolve(__dirname, 'contract.spec.ts');
const STAGE = path.resolve(__dirname, '..', 'scripts', 'seed-stages', 'erp-fulfilment.ts');
const RUNTIME_REGISTRY = path.resolve(__dirname, '..', '..', '..', 'apps', 'journey-runtime-service', 'test', 'fixtures', 'sample-connectors-registry.json');

/** SHA-256 of each ERP collection's rows as committed before this stage, one JSON line per row (the delivery rows without the carrier). */
const ROWS_BEFORE: Record<string, string> = {
  branches: '35b9b302814f8ee9dbc4087fef400ad7ab198dcc475b52a1c8c446eb0287d0cf',
  stock: '8463183738e94897d5b26df3828207248cafda90faf4d64f528e0b9c158a651e',
  price_list: 'f2600b0d6376fb1ed80ded4fea961a081a1525946bc4dbd6f701578504ff3fc7',
  deliveries: '6056e6b3859486d870d4f494ce119706a89998a5cb2d3e80b052161825ef6e41',
  account_balances: 'b47fef181381cedf9fabf8daa9dab5d546122a711f8b36b8a3a3dba1875fb805',
  invoices: '6aaae11cc398e78fb2380f5088193358aa6e3abd223b6b3d9fd8c51fcc071ce5',
};
/** SHA-256 of `JSON.stringify` of the provenance of the collections this stage does not touch, as committed before it. */
const PROVENANCE_BEFORE: Record<string, string> = {
  branches: '64010306a325655a2986cd7664715e6ab22c54ea2218226e88f4a1862f04cf14',
  stock: 'fc02b2d823f9f71e0f6574c586ba0b449916ca58fed9d5d849b373f38ca69ecd',
  price_list: '3cb9ab2bda737738b81f3b5cb5e43f616ca812e2cab0a9f13b055c3c295b7030',
  account_balances: '9aa01d9ac4e1ea5aa8f3c6cac1df733ce571958bbd4a99150dfcaa1e4c3f1b72',
  invoices: '4a12c1ef5feb469ac267f8b0c62140e9d48574533113086de8c11dbb1b857bb1',
};

/** The three failed attempts that sit on orders that were never dispatched: known sample anomalies (decision D12), left as they are. */
const KNOWN_ANOMALIES: Array<[deliveryId: string, orderId: string, orderStatus: string]> = [
  ['DEL-30004', 'ORD-100002', 'picked'],
  ['DEL-30007', 'ORD-100023', 'placed'],
  ['DEL-30012', 'ORD-100013', 'confirmed'],
];

const CONSIGNMENT_FIELDS = ['consignmentId', 'orderNumber', 'accountId', 'method', 'fromBranchCode', 'shipmentId', 'status', 'createdAt', 'sample'];
const LINE_FIELDS = ['consignmentId', 'orderNumber', 'lineKey', 'sku', 'quantity', 'sample'];
const EVENT_FIELDS = ['eventId', 'consignmentId', 'shipmentId', 'type', 'at', 'reason', 'receivedBy', 'collectedBy', 'evidenceRef', 'sample'];
const MINUTE_MS = 60_000;
const msOf = (stamp: string): number => Date.parse(stamp);
const rank = (type: string): number => (EVENT_TYPES as readonly string[]).indexOf(type);

/** The seed as it was before this stage: the three collections, their provenance, the carrier and its note taken out. */
function beforeFulfilment(seed: SeedFile): SeedFile {
  const copy = structuredClone(seed);
  for (const name of FULFILMENT_COLLECTIONS) {
    delete copy.collections[name];
    delete copy.provenance[name];
  }
  for (const row of copy.collections.deliveries) delete row.carrier;
  copy.provenance.deliveries.madeUpFields = copy.provenance.deliveries.madeUpFields.filter((entry) => !entry.startsWith('carrier'));
  return copy;
}

/** The seed as it was before the account-key and invoice stages as well. */
function beforeAllStages(seed: SeedFile): SeedFile {
  const copy = beforeFulfilment(seed);
  delete copy.collections.invoices;
  delete copy.provenance.invoices;
  for (const row of copy.collections.account_balances) for (const field of ['broughtForward', 'invoicesAsOf', 'commercetoolsUnitKey', 'salesforceAccountId', 'zendeskOrganizationId']) delete row[field];
  for (const row of copy.collections.deliveries) delete row.commercetoolsOrderNumber;
  for (const collection of ['deliveries', 'account_balances']) {
    copy.provenance[collection].madeUpFields = copy.provenance[collection].madeUpFields.filter((entry) => !/^(commercetoolsOrderNumber|commercetoolsUnitKey|salesforceAccountId|zendeskOrganizationId|account_balances: )/.test(entry));
  }
  return copy;
}

/**
 * TEST FIXTURE ONLY: an invented mini world for the cases the seed does not have (a failed attempt after a dispatch, an order placed after
 * its delivery window, the choice of the split order). None of these values is sample data, and none is a decision.
 */
interface MiniOrder { orderId: string; accountId: string | null; deliveryType: string; status: string; placedAt: string; lines: Array<[sku: string, quantity: number]> }
interface MiniDelivery { deliveryId: string; orderId: string; status: string; scheduledDate: string; window: string; note: string }
function miniWorld(orders: MiniOrder[], deliveries: MiniDelivery[]): { erp: SeedFile; shop: SeedFile } {
  const lines: Rec[] = [];
  for (const order of orders) order.lines.forEach(([sku, quantity], index) => lines.push({ lineId: `${order.orderId}-L${index + 1}`, orderId: order.orderId, sku, quantity, sample: true }));
  return {
    erp: {
      connectorId: 'ace-erp', tenantId: TENANT, builtFrom: 'TEST FIXTURE ONLY',
      collections: {
        deliveries: deliveries.map((delivery): Rec => {
          const order = orders.find((entry) => entry.orderId === delivery.orderId);
          return { ...delivery, accountId: order ? order.accountId : null, branchCode: '100', vehicle: 'Truck 0', driver: 'Test', stops: 2, sample: true };
        }),
      },
      provenance: { deliveries: { origin: 'sample', source: 'TEST FIXTURE ONLY', realFields: [], madeUpFields: ['every other field'] } },
    },
    shop: {
      connectorId: 'sap-commerce', tenantId: TENANT, builtFrom: 'TEST FIXTURE ONLY',
      collections: {
        orders: orders.map((order) => ({ orderId: order.orderId, accountId: order.accountId, deliveryType: order.deliveryType, status: order.status, branchCode: '100', placedAt: order.placedAt, sample: true })),
        order_lines: lines,
      },
      provenance: {},
    },
  };
}
const build = (world: { erp: SeedFile; shop: SeedFile }): Record<string, Rec[]> => {
  erpFulfilment.apply(world.erp, new Map([['sap-commerce', world.shop]]));
  return world.erp.collections;
};
const order = (orderId: string, status: string, placedAt: string, lines: Array<[string, number]>, extra: Partial<MiniOrder> = {}): MiniOrder => ({ orderId, accountId: 'TEST-ACC', deliveryType: 'delivery', status, placedAt, lines, ...extra });
const trip = (deliveryId: string, orderId: string, status: string, scheduledDate = '2026-03-10', window = '10am-1pm', note = ''): MiniDelivery => ({ deliveryId, orderId, status, scheduledDate, window, note });

async function main() {
  console.log('Sample ERP: consignments, consignment lines, tracking events and the carrier');
  const connectors = loadConnectors();
  const erp = connectors.get('ace-erp')!;
  const shop = connectors.get('sap-commerce')!;
  const rows = (collection: string): Rec[] => erp.seed.collections[collection];
  const consignments = rows('consignments');
  const lines = rows('consignment_lines');
  const events = rows('tracking_events');
  const orders = new Map(shop.seed.collections.orders.map((row) => [row.orderId, row]));
  const orderLines = shop.seed.collections.order_lines;
  const consignmentOf = new Map(consignments.map((row) => [row.consignmentId, row]));
  const deliveryOf = new Map(rows('deliveries').map((row) => [row.deliveryId, row]));
  const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
  const call = async (tool: string, args: Rec): Promise<Rec> => {
    const answer = await server.handle('ace-erp', TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
    return (answer!.result as Rec).structuredContent ?? JSON.parse((answer!.result as Rec).content[0].text);
  };
  const others = () => new Map<string, SeedFile>([['sap-commerce', structuredClone(shop.seed)]]);
  const eventsOf = (consignmentId: string): Rec[] => events.filter((event) => event.consignmentId === consignmentId);
  const collecting = shop.seed.collections.orders.filter((o) => o.deliveryType === 'click_and_collect' && ['picked', 'ready_for_collection', 'collected'].includes(o.status));

  // The split order, found here by the rule in the stage's header, from the shop's seed alone.
  const shareable = shop.seed.collections.orders
    .filter((o) => o.deliveryType === 'delivery' && o.accountId && rows('deliveries').some((d) => d.orderId === o.orderId && d.status === 'delivered'))
    .filter((o) => orderLines.filter((l) => l.orderId === o.orderId).length >= 2 && orderLines.some((l) => l.orderId === o.orderId && l.quantity >= 2))
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.orderId.localeCompare(b.orderId));
  const splitOrder = shareable[0].orderId;

  await check('there is one consignment for each delivery row, one for each click-and-collect order that is picked, ready or collected, and a second one for the split order: counted from the seeds', () => {
    const readyOrCollected = collecting.filter((o) => o.status !== 'picked');
    assert.ok(collecting.filter((o) => o.status === 'ready_for_collection').length > 0 && collecting.filter((o) => o.status === 'collected').length > 0 && collecting.filter((o) => o.status === 'picked').length > 0, 'the seed has all three kinds of collection');
    assert.ok(readyOrCollected.length < collecting.length);
    assert.equal(consignments.length, rows('deliveries').length + collecting.length + 1);
    assert.equal(consignments.filter((row) => row.method === 'delivery').length, rows('deliveries').length, 'one delivery consignment for each delivery row');
    assert.equal(consignments.filter((row) => row.method === 'collection').length, collecting.length + 1, 'one collection consignment for each collecting order, and the split order\'s');
    assert.deepEqual(consignments.filter((row) => row.orderNumber === splitOrder).map((row) => row.method).sort(), ['collection', 'delivery']);
    assert.equal(new Set(consignments.map((row) => row.orderNumber)).size, consignments.length - 1, 'every order has one consignment but the split order, which has two');
  });

  await check('consignment numbers are CON- and five digits, unique, from the first number on, in the order the consignments were made; a record has the fields the plan lists, in order', () => {
    assert.deepEqual(consignments.map((row) => row.consignmentId), consignments.map((_, index) => `CON-${SAMPLE_FIRST_CONSIGNMENT_NUMBER + index}`));
    const made = consignments.map((row) => row.createdAt);
    assert.deepEqual(made, [...made].sort(), 'numbered in the order they were made');
    for (const row of consignments) {
      assert.match(row.consignmentId, /^CON-\d{5}$/);
      assert.deepEqual(Object.keys(row), CONSIGNMENT_FIELDS);
      assert.ok(['delivery', 'collection'].includes(row.method));
      assert.equal(row.sample, true);
    }
  });

  await check('which orders have consignments: every delivery row\'s order, every collecting order, none for a cancelled order or an order only placed or confirmed for collection', () => {
    const byOrder = (orderId: string) => consignments.filter((row) => row.orderNumber === orderId);
    const cancelled = shop.seed.collections.orders.filter((o) => o.status === 'cancelled');
    assert.ok(cancelled.length > 0 && cancelled.some((o) => o.orderId === 'ORD-100005'));
    for (const o of cancelled) assert.deepEqual(byOrder(o.orderId), [], `${o.orderId} is cancelled: no consignment`);
    for (const o of shop.seed.collections.orders.filter((entry) => entry.deliveryType === 'click_and_collect' && ['placed', 'confirmed'].includes(entry.status))) assert.deepEqual(byOrder(o.orderId), [], `${o.orderId} has not been picked: no consignment`);
    for (const delivery of rows('deliveries')) {
      const mine = byOrder(delivery.orderId).filter((row) => row.method === 'delivery');
      assert.equal(mine.length, 1, delivery.deliveryId);
      const own = mine[0];
      assert.equal(own.shipmentId, delivery.deliveryId, 'a delivery consignment is on the trip of its delivery row');
      assert.equal(own.accountId, delivery.accountId);
      assert.equal(own.fromBranchCode, delivery.branchCode);
      assert.equal(own.accountId, orders.get(delivery.orderId)!.accountId);
    }
    for (const o of collecting) {
      const mine = byOrder(o.orderId).filter((row) => row.method === 'collection');
      assert.equal(mine.length, 1, o.orderId);
      assert.equal(mine[0].shipmentId, null, 'a collection is on no trip');
      assert.equal(mine[0].fromBranchCode, o.branchCode);
      assert.equal(mine[0].accountId, o.accountId);
    }
    assert.ok(byOrder('ORD-100003').length === 1 && byOrder('ORD-100003')[0].status === 'picked', 'ORD-100003 is picked, not ready: a collection consignment whose only event is picked');
    assert.deepEqual(eventsOf(byOrder('ORD-100003')[0].consignmentId).map((event) => event.type), ['picked']);
  });

  await check('the split order: the first delivered delivery order of a trade account with two lines and a line of two or more is shared between a delivery and a collection; half of the first such line, rounded down, is collected', () => {
    assert.equal(splitOrder, 'ORD-100042');
    const own = consignments.filter((row) => row.orderNumber === splitOrder);
    const [delivery, collection] = ['delivery', 'collection'].map((method) => own.find((row) => row.method === method)!);
    assert.equal(delivery.shipmentId, 'DEL-30002');
    assert.equal(collection.shipmentId, null);
    assert.equal(delivery.createdAt, collection.createdAt, 'both are made when the order is');
    const ordered = orderLines.filter((line) => line.orderId === splitOrder);
    const first = ordered.find((line) => line.quantity >= 2)!;
    const on = (consignmentId: string) => lines.filter((line) => line.consignmentId === consignmentId);
    assert.deepEqual(on(collection.consignmentId).map((line) => [line.lineKey, line.sku, line.quantity]), [[first.lineId, first.sku, Math.floor(first.quantity / 2)]]);
    assert.deepEqual(on(delivery.consignmentId).map((line) => [line.lineKey, line.quantity]), ordered.map((line) => [line.lineId, line.lineId === first.lineId ? first.quantity - Math.floor(first.quantity / 2) : line.quantity]));
    assert.deepEqual([first.quantity, first.quantity - Math.floor(first.quantity / 2), Math.floor(first.quantity / 2)], [7, 4, 3], 'worked by hand: 7 ordered, 3 collected, 4 delivered');
    assert.deepEqual(consignments.filter((row) => lines.filter((line) => line.consignmentId === row.consignmentId).length > 0 && row.orderNumber !== splitOrder && orderLines.filter((line) => line.orderId === row.orderNumber).length === 0), [], 'no other order is shared');
    for (const row of consignments.filter((entry) => entry.orderNumber !== splitOrder)) {
      assert.deepEqual(lines.filter((line) => line.consignmentId === row.consignmentId).map((line) => [line.lineKey, line.quantity]), orderLines.filter((line) => line.orderId === row.orderNumber).map((line) => [line.lineId, line.quantity]), `${row.consignmentId} carries its order's lines in full`);
    }
  });

  await check('every consignment line is a line of its order, no order line is sent more than ordered, and every line of an order with consignments is sent in full', () => {
    const withConsignments = new Set(consignments.map((row) => row.orderNumber));
    assert.equal(lines.length, orderLines.filter((line) => withConsignments.has(line.orderId)).length + 1, 'the lines of every order with consignments, and one more for the shared line, which stands on two consignments');
    const sent = new Map<string, number>();
    for (const line of lines) {
      assert.deepEqual(Object.keys(line), LINE_FIELDS);
      assert.equal(line.sample, true);
      assert.equal(consignmentOf.get(line.consignmentId)!.orderNumber, line.orderNumber, 'the line names the order of its consignment');
      const ordered = orderLines.find((entry) => entry.lineId === line.lineKey);
      assert.ok(ordered, `${line.lineKey} is an order line`);
      assert.equal(ordered!.orderId, line.orderNumber);
      assert.equal(ordered!.sku, line.sku);
      assert.ok(Number.isInteger(line.quantity) && line.quantity >= 1);
      sent.set(line.lineKey, (sent.get(line.lineKey) ?? 0) + line.quantity);
    }
    for (const [lineKey, quantity] of sent) assert.ok(quantity <= orderLines.find((entry) => entry.lineId === lineKey)!.quantity, `${lineKey} is not sent more than ordered`);
    for (const line of orderLines.filter((entry) => withConsignments.has(entry.orderId))) assert.equal(sent.get(line.lineId), line.quantity, `${line.lineId} is sent in full`);
    for (const line of orderLines.filter((entry) => !withConsignments.has(entry.orderId))) assert.equal(sent.has(line.lineId), false, `${line.lineId}: its order has no consignment`);
    const order = lines.map((line) => `${line.consignmentId} ${line.lineKey}`);
    assert.deepEqual(order, [...order].sort(), 'lines stand by consignment, then in the order of the order lines');
  });

  await check('event numbers are EVT- and six digits, from the first number on, in the order the events happened; each is on exactly one of a consignment or a trip, of a type from the owner\'s list', () => {
    assert.deepEqual(events.map((event) => event.eventId), events.map((_, index) => `EVT-${SAMPLE_FIRST_EVENT_NUMBER + index}`));
    const times = events.map((event) => msOf(event.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'numbered in time order');
    assert.deepEqual([...EVENT_TYPES], ['picked', 'loaded', 'dispatched', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned', 'collected']);
    for (const event of events) {
      assert.match(event.eventId, /^EVT-\d{6}$/);
      assert.deepEqual(Object.keys(event), EVENT_FIELDS);
      assert.equal(event.sample, true);
      assert.ok((EVENT_TYPES as readonly string[]).includes(event.type));
      assert.equal((event.consignmentId === null) !== (event.shipmentId === null), true, `${event.eventId}: exactly one of consignmentId and shipmentId`);
      assert.match(event.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
      if (event.consignmentId !== null) assert.ok(consignmentOf.has(event.consignmentId), `${event.eventId}: a consignment that exists`);
      else assert.ok(deliveryOf.has(event.shipmentId), `${event.eventId}: a trip that exists`);
      assert.equal(SHIPMENT_EVENT_TYPES.includes(event.type), event.shipmentId !== null, `${event.eventId}: loaded and dispatched belong to the trip, the rest to the consignment`);
    }
    assert.deepEqual([...new Set(events.map((event) => event.type))].sort(), ['collected', 'delivered', 'dispatched', 'loaded', 'out_for_delivery', 'picked'], 'the types the sample orders reach');
  });

  await check('event times are ordered within a consignment, none is before its order was placed, the consignment is made after the order and before its first event, and nothing is later than the as-of day', () => {
    const endOfAsOf = Date.parse(`${SAMPLE_AS_OF}T23:59:59.999Z`);
    for (const row of consignments) {
      const placed = msOf(orders.get(row.orderNumber)!.placedAt);
      assert.equal(msOf(row.createdAt) - placed, SAMPLE_MINUTES.created * MINUTE_MS, `${row.consignmentId}: made ${SAMPLE_MINUTES.created} minutes after the order`);
      const times = eventsOf(row.consignmentId).map((event) => msOf(event.at));
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `${row.consignmentId}: events in order`);
      assert.equal(new Set(times).size, times.length, `${row.consignmentId}: no two events at once`);
      for (const time of times) assert.ok(time >= msOf(row.createdAt) + SAMPLE_MINUTES.gap * MINUTE_MS, `${row.consignmentId}: an event before the consignment was made`);
    }
    for (const event of events) {
      const owner = event.consignmentId !== null ? consignmentOf.get(event.consignmentId)! : consignments.find((row) => row.shipmentId === event.shipmentId)!;
      assert.ok(msOf(event.at) > msOf(orders.get(owner.orderNumber)!.placedAt), `${event.eventId}: before ${owner.orderNumber} was placed`);
      assert.ok(msOf(event.at) <= endOfAsOf, `${event.eventId}: after ${SAMPLE_AS_OF}`);
    }
    for (const delivery of rows('deliveries')) {
      const mine = events.filter((event) => event.shipmentId === delivery.deliveryId);
      const own = consignments.find((row) => row.shipmentId === delivery.deliveryId)!;
      const picked = eventsOf(own.consignmentId).find((event) => event.type === 'picked');
      const out = eventsOf(own.consignmentId).find((event) => event.type === 'out_for_delivery');
      assert.deepEqual(mine.map((event) => event.type), out ? ['loaded', 'dispatched'] : [], `${delivery.deliveryId}: a trip is loaded and dispatched once it is out for delivery`);
      for (const event of mine) assert.ok(msOf(event.at) > msOf(picked!.at) && msOf(event.at) < msOf(out!.at), `${delivery.deliveryId}: loaded and dispatched fall between picked and out for delivery`);
    }
  });

  await check('the events follow the order status and the delivery status: delivered goes through every step, out for delivery stops there, picked has picked, placed and confirmed have none, a collection ends picked or collected', () => {
    const expected = (row: Rec): string[] => {
      const o = orders.get(row.orderNumber)!;
      if (row.method === 'collection') return o.status === 'collected' || row.orderNumber === splitOrder ? ['picked', 'collected'] : ['picked'];
      const delivery = deliveryOf.get(row.shipmentId)!;
      if (delivery.status === 'failed_attempt') return [];
      if (delivery.status === 'delivered') return ['picked', 'out_for_delivery', 'delivered'];
      if (delivery.status === 'out_for_delivery') return ['picked', 'out_for_delivery'];
      return o.status === 'picked' ? ['picked'] : [];
    };
    const tally = new Map<string, number>();
    for (const row of consignments) {
      assert.deepEqual(eventsOf(row.consignmentId).map((event) => event.type), expected(row), `${row.consignmentId} (${row.orderNumber})`);
      tally.set(expected(row).join(','), (tally.get(expected(row).join(',')) ?? 0) + 1);
    }
    assert.deepEqual([...tally.keys()].sort(), ['', 'picked', 'picked,collected', 'picked,out_for_delivery', 'picked,out_for_delivery,delivered'], 'every kind is in the seed');
  });

  await check('a consignment\'s status equals its newest event, or planned when it has none; the three failed attempts are known anomalies with no events and a planned consignment', () => {
    for (const row of consignments) {
      const mine = eventsOf(row.consignmentId);
      assert.equal(row.status, mine.length === 0 ? 'planned' : mine.reduce((newest, event) => (msOf(event.at) >= msOf(newest.at) ? event : newest)).type, row.consignmentId);
    }
    assert.deepEqual([...new Set(consignments.map((row) => row.status))].sort(), ['collected', 'delivered', 'out_for_delivery', 'picked', 'planned']);
    const failed = rows('deliveries').filter((delivery) => delivery.status === 'failed_attempt');
    assert.deepEqual(failed.map((delivery) => [delivery.deliveryId, delivery.orderId, orders.get(delivery.orderId)!.status]), KNOWN_ANOMALIES, 'the three, by id');
    for (const [deliveryId, orderId] of KNOWN_ANOMALIES) {
      const own = consignments.find((row) => row.shipmentId === deliveryId)!;
      assert.equal(own.orderNumber, orderId);
      assert.equal(own.status, 'planned');
      assert.deepEqual([eventsOf(own.consignmentId), events.filter((event) => event.shipmentId === deliveryId)], [[], []], `${deliveryId}: no events`);
      assert.ok(!['dispatched', 'delivered'].includes(orders.get(orderId)!.status), `${orderId} was never dispatched`);
    }
    assert.equal(events.filter((event) => event.type === 'failed_attempt').length, 0, 'so the seed has no failed attempt event');
  });

  await check('a failed attempt only follows a dispatch: on every trip with one, loaded and dispatched come first', () => {
    for (const event of events.filter((entry) => entry.type === 'failed_attempt')) {
      const own = consignmentOf.get(event.consignmentId)!;
      const dispatched = events.find((entry) => entry.shipmentId === own.shipmentId && entry.type === 'dispatched');
      assert.ok(dispatched && msOf(dispatched.at) < msOf(event.at), `${event.eventId}: failed before a dispatch`);
    }
    const world = miniWorld(
      [order('T-1', 'dispatched', '2026-03-09T09:00:00.000Z', [['SKU-1', 3]]), order('T-2', 'placed', '2026-03-09T09:00:00.000Z', [['SKU-1', 3]])],
      [trip('T-DEL-1', 'T-1', 'failed_attempt', '2026-03-10', '10am-1pm', 'TEST FIXTURE ONLY: nobody home'), trip('T-DEL-2', 'T-2', 'failed_attempt', '2026-03-10', '10am-1pm', 'TEST FIXTURE ONLY: nobody home')],
    );
    const made = build(world);
    const dispatchedOne = made.consignments.find((row) => row.orderNumber === 'T-1')!;
    const failed = made.tracking_events.filter((event) => event.consignmentId === dispatchedOne.consignmentId);
    assert.deepEqual(failed.map((event) => event.type), ['picked', 'out_for_delivery', 'failed_attempt']);
    assert.deepEqual(made.tracking_events.filter((event) => event.shipmentId === 'T-DEL-1').map((event) => event.type), ['loaded', 'dispatched']);
    assert.equal(dispatchedOne.status, 'failed_attempt');
    assert.equal(failed[2].reason, 'TEST FIXTURE ONLY: nobody home', 'the delivery row\'s note is the reason');
    assert.deepEqual([failed[2].receivedBy, failed[2].collectedBy, failed[2].evidenceRef], [null, null, null]);
    assert.ok(failed.every((event) => event.reason === null || event.type === 'failed_attempt'), 'only a failed attempt has a reason');
    const dispatched = made.tracking_events.find((event) => event.shipmentId === 'T-DEL-1' && event.type === 'dispatched')!;
    assert.ok(msOf(dispatched.at) < msOf(failed[2].at), 'dispatched before the failed attempt');
    const never = made.consignments.find((row) => row.orderNumber === 'T-2')!;
    assert.equal(never.status, 'planned', 'an order never dispatched has no events, whatever its delivery row says');
    assert.deepEqual(made.tracking_events.filter((event) => event.consignmentId === never.consignmentId || event.shipmentId === 'T-DEL-2'), []);
    const noNote = miniWorld([order('T-3', 'dispatched', '2026-03-09T09:00:00.000Z', [['SKU-1', 1]])], [trip('T-DEL-3', 'T-3', 'failed_attempt')]);
    assert.throws(() => build(noNote), /a row has no note/, 'a failed attempt without a reason stops the build');
  });

  await check('delivered and collected events carry who took the goods and a proof reference; no other event carries either; every delivered or collected consignment has exactly one', () => {
    const proofs = events.filter((event) => event.type === 'delivered' || event.type === 'collected');
    assert.ok(proofs.length > 0);
    proofs.forEach((event, index) => {
      const number = event.consignmentId.slice(4);
      assert.equal(event.evidenceRef, `${event.type === 'delivered' ? 'POD' : 'COL'}-${number}`, `${event.eventId}: a proof reference`);
      assert.equal(event[event.type === 'delivered' ? 'receivedBy' : 'collectedBy'], SAMPLE_PEOPLE[index % SAMPLE_PEOPLE.length], 'handed out in the order the events happened');
      assert.equal(event[event.type === 'delivered' ? 'collectedBy' : 'receivedBy'], null);
      assert.equal(event.reason, null);
    });
    for (const event of events.filter((entry) => entry.type !== 'delivered' && entry.type !== 'collected')) assert.deepEqual([event.receivedBy, event.collectedBy, event.evidenceRef], [null, null, null], event.eventId);
    for (const row of consignments.filter((entry) => ['delivered', 'collected'].includes(entry.status))) assert.equal(eventsOf(row.consignmentId).filter((event) => event.evidenceRef !== null).length, 1, row.consignmentId);
    assert.equal(new Set(proofs.map((event) => event.evidenceRef)).size, proofs.length, 'a reference for each proof');
    assert.ok(consignments.filter((row) => row.status === 'delivered').length > 0 && consignments.filter((row) => row.method === 'collection' && row.status === 'collected').length > 0);
  });

  await check('the number of consignments on a trip is not above its stops, and a trip is the delivery row: it keeps its DEL- number', () => {
    for (const delivery of rows('deliveries')) {
      const onTrip = consignments.filter((row) => row.shipmentId === delivery.deliveryId);
      assert.ok(onTrip.length >= 1 && onTrip.length <= delivery.stops, delivery.deliveryId);
      assert.match(delivery.deliveryId, /^DEL-\d{5}$/);
    }
    assert.equal(consignments.filter((row) => row.shipmentId !== null).length, rows('deliveries').length);
  });

  await check('worked by hand from the rules: six consignments\' events, to the minute', () => {
    const at = (id: string) => eventsOf(id).map((event) => [event.type, event.at]);
    const trip20 = (shipmentId: string) => events.filter((event) => event.shipmentId === shipmentId).map((event) => [event.type, event.at]);
    // ORD-100034 was placed 2026-08-11T09:00; the consignment is made 10 minutes on (09:10) and the goods are picked 120 minutes after that: 11:10.
    // DEL-30020 is on 2026-08-14 in the "10am-1pm" window, which opens at 10:00: loaded 60 minutes before (09:00), dispatched 30 before (09:30),
    // out for delivery at 10:00, handed over 90 after (11:30). Each is more than 10 minutes after the one before, so none moves.
    assert.equal(consignmentOf.get('CON-50027')!.orderNumber, 'ORD-100034');
    assert.deepEqual(at('CON-50027'), [['picked', '2026-08-11T11:10:00.000Z'], ['out_for_delivery', '2026-08-14T10:00:00.000Z'], ['delivered', '2026-08-14T11:30:00.000Z']]);
    assert.deepEqual(trip20('DEL-30020'), [['loaded', '2026-08-14T09:00:00.000Z'], ['dispatched', '2026-08-14T09:30:00.000Z']]);
    // ORD-100025 was placed 2026-09-01T14:31, after its "7am-10am" window had opened on the same day (the seed says so). Made 14:41, picked 16:41.
    // Loaded would be 06:00, but nothing may come before what went before it: 10 minutes after picked, 16:51. Then 17:01, 17:11 and 17:21,
    // each 10 minutes on from the last, because the window's own times (06:30, 07:00, 08:30) are long past.
    assert.deepEqual(at('CON-50040'), [['picked', '2026-09-01T16:41:00.000Z'], ['out_for_delivery', '2026-09-01T17:11:00.000Z'], ['delivered', '2026-09-01T17:21:00.000Z']]);
    assert.deepEqual(trip20('DEL-30027'), [['loaded', '2026-09-01T16:51:00.000Z'], ['dispatched', '2026-09-01T17:01:00.000Z']]);
    // ORD-100042, placed 2026-07-08T14:02: made 14:12, picked 16:12. The collected half (CON-50003) is collected 1440 minutes after it is picked.
    assert.deepEqual(at('CON-50003'), [['picked', '2026-07-08T16:12:00.000Z'], ['collected', '2026-07-09T16:12:00.000Z']]);
    // DEL-30002 is on 2026-07-10 in the "7am-10am" window: loaded 06:00, dispatched 06:30, out for delivery 07:00, delivered 08:30.
    assert.deepEqual(at('CON-50002'), [['picked', '2026-07-08T16:12:00.000Z'], ['out_for_delivery', '2026-07-10T07:00:00.000Z'], ['delivered', '2026-07-10T08:30:00.000Z']]);
    assert.deepEqual(trip20('DEL-30002'), [['loaded', '2026-07-10T06:00:00.000Z'], ['dispatched', '2026-07-10T06:30:00.000Z']]);
    // ORD-100048 (click and collect, collected), placed 2026-07-09T12:30: made 12:40, picked 14:40, collected a day later.
    assert.equal(consignmentOf.get('CON-50004')!.orderNumber, 'ORD-100048');
    assert.deepEqual(at('CON-50004'), [['picked', '2026-07-09T14:40:00.000Z'], ['collected', '2026-07-10T14:40:00.000Z']]);
    // ORD-100021 is picked with its delivery still scheduled, placed 2026-08-30T11:10: made 11:20, picked 13:20, nothing more yet.
    assert.equal(consignmentOf.get('CON-50039')!.orderNumber, 'ORD-100021');
    assert.deepEqual(at('CON-50039'), [['picked', '2026-08-30T13:20:00.000Z']]);
    assert.deepEqual(erp.seed.collections.tracking_events.filter((event) => event.type === 'collected').slice(0, 1).map((event) => [event.consignmentId, event.collectedBy, event.evidenceRef]), [['CON-50003', SAMPLE_PEOPLE[0], 'COL-50003']]);
    assert.deepEqual(SAMPLE_MINUTES, { created: 10, picked: 120, loaded: 60, dispatched: 30, handedOver: 90, collected: 1440, gap: 10 }, 'the offsets these sums use');
  });

  await check('window start: the hour a delivery window opens on its day, on the same clock as the order times', () => {
    assert.equal(windowStart('2026-07-03', '7am-10am'), Date.parse('2026-07-03T07:00:00Z'));
    assert.equal(windowStart('2026-07-03', '10am-1pm'), Date.parse('2026-07-03T10:00:00Z'));
    assert.equal(windowStart('2026-07-03', '1pm-4pm'), Date.parse('2026-07-03T13:00:00Z'));
    assert.equal(windowStart('2026-07-03', '12pm-3pm'), Date.parse('2026-07-03T12:00:00Z'));
    assert.equal(windowStart('2026-07-03', '12am-3am'), Date.parse('2026-07-03T00:00:00Z'));
    for (const window of ['', 'morning', '0am-3am', '13pm-4pm', 'am-pm']) assert.throws(() => windowStart('2026-07-03', window), /not a delivery window/, window);
    assert.throws(() => windowStart('2026-02-30', '7am-10am'), /not a date/);
  });

  await check('the delivery rows are the rows that were committed, with a carrier added last; every other collection is byte-identical, and so is the provenance of the collections that were there', () => {
    for (const [collection, expected] of Object.entries(ROWS_BEFORE)) {
      const text = rows(collection).map((row) => JSON.stringify(collection === 'deliveries' ? Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'carrier')) : row)).join('\n');
      assert.equal(sha256(text), expected, `${collection}: a row changed`);
    }
    for (const delivery of rows('deliveries')) {
      assert.equal(delivery.carrier, SAMPLE_CARRIER);
      assert.equal(Object.keys(delivery).at(-1), 'carrier', 'the carrier stands last');
      assert.equal(Object.keys(delivery).at(-2), 'commercetoolsOrderNumber');
    }
    for (const [collection, expected] of Object.entries(PROVENANCE_BEFORE)) assert.equal(sha256(JSON.stringify(erp.seed.provenance[collection])), expected, `${collection}: provenance changed`);
    const deliveries = erp.seed.provenance.deliveries;
    assert.deepEqual([deliveries.origin, deliveries.source, deliveries.realFields, deliveries.madeUpFields[0]], ['sample', 'invented over the sample orders', ['branchCode (a real code)'], 'every other field']);
    assert.equal(deliveries.madeUpFields.length, 3);
    assert.match(deliveries.madeUpFields[1], /^carrier \(a sample constant/, 'the carrier note stands straight after the generator\'s own');
    assert.equal(deliveries.madeUpFields[2], 'commercetoolsOrderNumber (equal to orderId: the ERP\'s own order number, not one commercetools has issued)', 'and the account-key note after it, as it was');
  });

  await check('the three collections come after the ones that were there, in this order, each with provenance, a minimum and sample: true, and the README says so', () => {
    const wanted = ['branches', 'stock', 'price_list', 'deliveries', 'account_balances', 'invoices', ...FULFILMENT_COLLECTIONS];
    assert.deepEqual(Object.keys(erp.seed.collections).slice(0, wanted.length), wanted, 'a later stage may add collections after these');
    assert.deepEqual(Object.keys(erp.seed.provenance), Object.keys(erp.seed.collections));
    assert.deepEqual([erp.seed.provenance.consignments.origin, erp.seed.provenance.consignment_lines.origin, erp.seed.provenance.tracking_events.origin], ['sample', 'mixed', 'sample']);
    assert.deepEqual(erp.seed.provenance.consignment_lines.realFields, ['sku']);
    assert.deepEqual(erp.seed.provenance.consignments.realFields, ['fromBranchCode (a real code)']);
    for (const name of FULFILMENT_COLLECTIONS) {
      assert.ok(erp.definition.minimums[name] > 0 && rows(name).length >= erp.definition.minimums[name], `${name} is covered by a minimum`);
      assert.ok(rows(name).every((row) => row.sample === true));
    }
    const text = readFileSync(path.join(DEFAULT_CONNECTORS_DIR, 'ace-erp', 'README.md'), 'utf8');
    assert.match(text, new RegExp(`\\| \`consignments\` \\| ${consignments.length} \\| made up \\| ${consignments.length}/${consignments.length} \\| fromBranchCode`));
    assert.match(text, new RegExp(`\\| \`consignment_lines\` \\| ${lines.length} \\| real and made up \\| ${lines.length}/${lines.length} \\| sku \\|`));
    assert.match(text, new RegExp(`\\| \`tracking_events\` \\| ${events.length} \\| made up \\| ${events.length}/${events.length} \\|`));
    assert.match(text, /carrier \(a sample constant/);
    for (const tool of ['list_consignments', 'get_consignment', 'list_consignment_lines', 'list_tracking_events']) assert.match(text, new RegExp(`- \`${tool}\`: `));
    assert.match(readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8'), /erp-fulfilment\.spec\.ts/);
  });

  await check('no randomness and no clock: the stage reads neither a random stream nor the time', () => {
    const stage = readFileSync(STAGE, 'utf8');
    assert.doesNotMatch(stage, /Math\.random|Rng|new Date\(\)|Date\.now\(\)/);
    assert.ok(SAMPLE_AS_OF === '2026-09-01');
  });

  await check('a second run changes nothing, and from the seed before this stage, or before all three stages, the stages give back the committed bytes', () => {
    const finished = structuredClone(erp.seed);
    erpFulfilment.apply(finished, others());
    assert.equal(seedText(finished), seedText(erp.seed), 'applied to the finished seed: no difference, not even in the order of the fields');

    const before = new Map<string, SeedFile>([['ace-erp', beforeFulfilment(erp.seed)], ['sap-commerce', structuredClone(shop.seed)]]);
    assert.notEqual(seedText(before.get('ace-erp')!), seedText(erp.seed));
    applySeedStages(before);
    assert.equal(seedText(before.get('ace-erp')!), seedText(erp.seed), 'a build gives the committed seed');
    applySeedStages(before);
    assert.equal(seedText(before.get('ace-erp')!), seedText(erp.seed), 'and again gives no difference');

    const fresh = new Map<string, SeedFile>([['ace-erp', beforeAllStages(erp.seed)], ['sap-commerce', structuredClone(shop.seed)]]);
    assert.deepEqual(Object.keys(fresh.get('ace-erp')!.collections), ['branches', 'stock', 'price_list', 'deliveries', 'account_balances']);
    applySeedStages(fresh);
    assert.equal(seedText(fresh.get('ace-erp')!), seedText(erp.seed), 'from the seed before all three stages');

    // What the older stage specs start from: the carrier and its note are there, the account keys, the invoices and the three collections are not.
    const carrierOnly = beforeAllStages(erp.seed);
    for (const row of carrierOnly.collections.deliveries) row.carrier = SAMPLE_CARRIER;
    carrierOnly.provenance.deliveries.madeUpFields.push(erp.seed.provenance.deliveries.madeUpFields[1]);
    const keyStageLast = new Map<string, SeedFile>([['ace-erp', carrierOnly], ['sap-commerce', structuredClone(shop.seed)]]);
    applySeedStages(keyStageLast);
    assert.equal(seedText(keyStageLast.get('ace-erp')!), seedText(erp.seed), 'the carrier note stands in the same place whether it was there before the account-key stage ran or not');

    const early = structuredClone(erp.seed);
    delete early.collections.invoices;
    early.collections.invoices = rows('invoices');
    early.provenance.invoices = erp.seed.provenance.invoices;
    assert.notEqual(seedText(early), seedText(erp.seed), 'the collections really are in another order here');
    erpFulfilment.apply(early, others());
    assert.equal(seedText(early), seedText(erp.seed), 'the stage puts its collections last, so the text does not depend on which stage ran first');

    const carrierFirst = structuredClone(erp.seed);
    for (const row of carrierFirst.collections.deliveries) {
      const carrier = row.carrier;
      delete row.carrier;
      const entries = Object.entries(row);
      for (const field of Object.keys(row)) delete row[field];
      Object.assign(row, Object.fromEntries(entries.slice(0, 11)), { carrier }, Object.fromEntries(entries.slice(11)));
    }
    assert.notEqual(seedText(carrierFirst), seedText(erp.seed));
    erpFulfilment.apply(carrierFirst, others());
    assert.equal(seedText(carrierFirst), seedText(erp.seed), 'the stage puts the carrier last, so the text does not depend on which stage ran first');
  });

  await check('a value already there is kept: a carrier on a row, and the consignments, lines and events already built, are not worked out again', () => {
    const seed = structuredClone(erp.seed);
    // TEST FIXTURE ONLY: not a carrier; it stands for a value a later hand edit or backfill would have written.
    seed.collections.deliveries[2].carrier = 'TEST FIXTURE ONLY';
    seed.collections.consignments[0].status = 'returned';
    seed.collections.tracking_events.pop();
    erpFulfilment.apply(seed, others());
    assert.equal(seed.collections.deliveries[2].carrier, 'TEST FIXTURE ONLY');
    assert.equal(Object.keys(seed.collections.deliveries[2]).at(-1), 'carrier');
    assert.equal(seed.collections.consignments[0].status, 'returned', 'existing consignments are not worked out again');
    assert.equal(seed.collections.tracking_events.length, events.length - 1, 'nor are the events');
    const partial = beforeFulfilment(erp.seed);
    partial.collections.consignments = structuredClone(consignments);
    assert.throws(() => erpFulfilment.apply(partial, others()), /has consignments but not the rest/, 'some of the three without the others stops the build');
  });

  await check('a rule that cannot be met stops the build: a missing order, a delivery for a cancelled or collecting order, two deliveries for an order, an order of another account or branch, a status that does not fit, no lines, a bad time', () => {
    const attempt = (change: (erpSeed: SeedFile, shopSeed: SeedFile) => void): void => {
      const erpSeed = beforeFulfilment(erp.seed);
      const shopSeed = structuredClone(shop.seed);
      change(erpSeed, shopSeed);
      erpFulfilment.apply(erpSeed, new Map([['sap-commerce', shopSeed]]));
    };
    const shopOrder = (shopSeed: SeedFile, orderId: string): Rec => shopSeed.collections.orders.find((row) => row.orderId === orderId)!;
    const delivery = (erpSeed: SeedFile, deliveryId: string): Rec => erpSeed.collections.deliveries.find((row) => row.deliveryId === deliveryId)!;
    assert.throws(() => attempt((_, s) => { s.collections.orders = s.collections.orders.filter((row) => row.orderId !== 'ORD-100034'); }), /DEL-30020 is for ORD-100034, which the sap-commerce seed does not have/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').status = 'cancelled'; }), /DEL-30020 is for ORD-100034, which is cancelled/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').deliveryType = 'click_and_collect'; }), /DEL-30020 is for ORD-100034, which is click_and_collect/);
    assert.throws(() => attempt((e) => { e.collections.deliveries.push({ ...delivery(e, 'DEL-30020'), deliveryId: 'DEL-39999' }); }), /ORD-100034 has more than one delivery row/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').accountId = 'ACC-0001'; }), /ORD-100034 belongs to ACC-0001, but DEL-30020 is for ACC-0004/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').branchCode = '999'; }), /ORD-100034 is at branch 999, but DEL-30020 is at 181/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').status = 'collected'; }), /ORD-100034 is a delivery order with status collected/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').status = 'picked'; }), /DEL-30020 is delivered, but its order ORD-100034 is picked/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30001').status = 'delivered'; }), /DEL-30001 is delivered, but its order ORD-100045 is placed/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30008').status = 'scheduled'; }), /DEL-30008 is scheduled, but its order ORD-100037 is dispatched/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30020').status = 'failed_attempt'; }), /DEL-30020 is failed_attempt, but its order ORD-100034 is delivered/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30020').status = 'lost'; }), /DEL-30020 has status lost/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100048').status = 'dispatched'; }), /ORD-100048 is a click-and-collect order with status dispatched/);
    assert.throws(() => attempt((_, s) => { s.collections.order_lines = s.collections.order_lines.filter((row) => row.orderId !== 'ORD-100034'); }), /ORD-100034 has no lines/);
    assert.throws(() => attempt((_, s) => { s.collections.order_lines = s.collections.order_lines.filter((row) => row.orderId !== 'ORD-100048'); }), /ORD-100048 has no lines/);
    assert.throws(() => attempt((_, s) => { shopOrder(s, 'ORD-100034').placedAt = 'yesterday'; }), /ORD-100034 placedAt 'yesterday' is not a time/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30020').window = 'afternoon'; }), /'afternoon' is not a delivery window/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30020').scheduledDate = '2026-13-01'; }), /'2026-13-01' is not a date/);
    assert.throws(() => attempt((e) => { delivery(e, 'DEL-30020').orderId = ''; }), /a row has no orderId/);
    assert.throws(() => erpFulfilment.apply(beforeFulfilment(erp.seed), new Map()), /reads the 'sap-commerce' seed/);
    assert.throws(() => erpFulfilment.apply(beforeFulfilment(erp.seed)), /reads the 'sap-commerce' seed/);
    assert.throws(() => applySeedStages(new Map([['ace-erp', beforeFulfilment(erp.seed)]])), /reads 'sap-commerce', which has no seed/);
    assert.deepEqual(stageConnectorIds(), ['ace-erp', 'sap-commerce'], 'extend-seeds loads the seed the stage reads');
  });

  await check('hand-made fixture: the split order is the first qualifying one, its first line of two or more is halved rounding down, and an odd line keeps the larger half on the delivery', () => {
    const early = '2026-03-01T08:00:00.000Z';
    const world = miniWorld(
      [
        order('T-ONELINE', 'delivered', early, [['SKU-1', 5]]),
        order('T-GUEST', 'delivered', early, [['SKU-1', 5], ['SKU-2', 5]], { accountId: null }),
        order('T-ONES', 'delivered', early, [['SKU-1', 1], ['SKU-2', 1]]),
        order('T-NOTYET', 'dispatched', early, [['SKU-1', 5], ['SKU-2', 5]]),
        order('T-SECOND', 'delivered', '2026-03-03T08:00:00.000Z', [['SKU-1', 6], ['SKU-2', 6]]),
        order('T-FIRST', 'delivered', '2026-03-02T08:00:00.000Z', [['SKU-1', 1], ['SKU-2', 5], ['SKU-3', 4]]),
      ],
      ['T-ONELINE', 'T-GUEST', 'T-ONES', 'T-SECOND', 'T-FIRST'].map((orderId, index) => trip(`T-DEL-${index}`, orderId, 'delivered')).concat(trip('T-DEL-9', 'T-NOTYET', 'out_for_delivery')),
    );
    const made = build(world);
    assert.equal(made.consignments.length, 7, 'six deliveries and the one collection');
    const split = made.consignments.filter((row) => row.orderNumber === 'T-FIRST');
    assert.deepEqual(split.map((row) => row.method), ['delivery', 'collection']);
    const on = (consignmentId: string) => made.consignment_lines.filter((line) => line.consignmentId === consignmentId).map((line) => [line.lineKey, line.quantity]);
    assert.deepEqual(on(split[1].consignmentId), [['T-FIRST-L2', 2]], 'half of 5, rounded down, is collected');
    assert.deepEqual(on(split[0].consignmentId), [['T-FIRST-L1', 1], ['T-FIRST-L2', 3], ['T-FIRST-L3', 4]], 'the larger half and the other lines stay on the delivery');
    assert.equal(made.consignments.filter((row) => row.method === 'collection').length, 1, 'no other order is split');
    assert.equal(made.consignments.every((row) => row.method === 'delivery' || row.orderNumber === 'T-FIRST'), true);
    const none = miniWorld([order('T-A', 'delivered', early, [['SKU-1', 5]])], [trip('T-DEL-A', 'T-A', 'delivered')]);
    assert.equal(build(none).consignments.length, 1, 'with no order to split, none is');
  });

  await check('hand-made fixture: an order placed after its delivery window has opened, the events come after the order and each a gap apart, and may cross midnight', () => {
    // Placed 2026-03-10T23:50: made 2026-03-11T00:00, picked 02:00, then the window\'s own times (06:00, 06:30, 07:00, 08:30 on the 10th) are long past:
    // loaded 02:10, dispatched 02:20, out for delivery 02:30, delivered 02:40, each 10 minutes on from the last.
    const world = miniWorld([order('T-LATE', 'delivered', '2026-03-10T23:50:00.000Z', [['SKU-1', 2]])], [trip('T-DEL-L', 'T-LATE', 'delivered', '2026-03-10', '7am-10am')]);
    const made = build(world);
    assert.equal(made.consignments[0].createdAt, '2026-03-11T00:00:00.000Z');
    assert.deepEqual(made.tracking_events.map((event) => [event.type, event.at]), [
      ['picked', '2026-03-11T02:00:00.000Z'], ['loaded', '2026-03-11T02:10:00.000Z'], ['dispatched', '2026-03-11T02:20:00.000Z'], ['out_for_delivery', '2026-03-11T02:30:00.000Z'], ['delivered', '2026-03-11T02:40:00.000Z'],
    ]);
    assert.equal(made.consignments[0].status, 'delivered');
    assert.equal(made.tracking_events.at(-1)!.evidenceRef, 'POD-50001');
  });

  await check('extend-seeds: from the seeds before this stage, --check names only the ERP\'s files, --write gives the committed bytes, and --check after --write is empty; the shop\'s files are read and left alone', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'erp-fulfilment-'));
    try {
      for (const id of stageConnectorIds()) cpSync(path.join(DEFAULT_CONNECTORS_DIR, id), path.join(tmp, id), { recursive: true });
      assert.deepEqual(planExtension(tmp), [], 'the committed seeds already hold what every stage adds');
      assert.equal(run(['--check'], tmp, () => {}), 0);

      const files = { seed: path.join(tmp, 'ace-erp', 'seed.json'), readme: path.join(tmp, 'ace-erp', 'README.md'), definition: path.join(tmp, 'ace-erp', 'connector.json') };
      const shopFiles = ['seed.json', 'README.md', 'connector.json'].map((name) => path.join(tmp, 'sap-commerce', name));
      const shopBytes = shopFiles.map((file) => readFileSync(file, 'utf8'));
      const old = beforeFulfilment(erp.seed);
      writeFileSync(files.seed, seedText(old));
      writeFileSync(files.readme, readme(erp.definition, old));
      const definitionBytes = readFileSync(files.definition, 'utf8');

      const changes = planExtension(tmp);
      assert.deepEqual(changes.map((change) => path.relative(tmp, change.file)).sort(), [path.join('ace-erp', 'README.md'), path.join('ace-erp', 'seed.json')]);
      const lines: string[] = [];
      assert.equal(run(['--check'], tmp, (line) => lines.push(line)), 1);
      assert.ok(lines.some((line) => /ace-erp[\\/]seed\.json: \d+ lines added/.test(line)));
      assert.equal(readFileSync(files.seed, 'utf8'), seedText(old), 'nothing written by --check');

      assert.equal(run(['--write'], tmp, () => {}), 0);
      assert.equal(readFileSync(files.seed, 'utf8'), seedText(erp.seed), 'the seed is the committed one, byte for byte');
      assert.equal(readFileSync(files.readme, 'utf8'), readme(erp.definition, erp.seed), 'and so is the README');
      assert.equal(readFileSync(files.readme, 'utf8'), readFileSync(path.join(DEFAULT_CONNECTORS_DIR, 'ace-erp', 'README.md'), 'utf8'));
      assert.equal(readFileSync(files.definition, 'utf8'), definitionBytes, 'connector.json is not touched');
      assert.deepEqual(planExtension(tmp), [], '--check after --write is empty');
      assert.equal(run(['--write'], tmp, () => {}), 0);
      assert.equal(readFileSync(files.seed, 'utf8'), seedText(erp.seed), 'a second --write changes nothing');
      assert.deepEqual(shopFiles.map((file) => readFileSync(file, 'utf8')), shopBytes, 'the shop\'s files are as they were');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('list_consignments: an order\'s or an account\'s consignments, newest first; a status narrows them; a limit is honoured; no match is an empty list', async () => {
    const split = await call('list_consignments', { orderNumber: splitOrder });
    assert.equal(split.ok, true);
    assert.equal(split.connector, 'ace-erp');
    assert.deepEqual([split.total, split.returned], [2, 2]);
    assert.deepEqual(split.records.map((record: Rec) => record.method), ['delivery', 'collection'], 'made at the same minute: in consignment order');
    for (const record of split.records) assert.deepEqual(Object.keys(record), CONSIGNMENT_FIELDS);
    assert.deepEqual((await call('list_consignments', { orderNumber: 'ord-100042' })).records.map((record: Rec) => record.consignmentId), split.records.map((record: Rec) => record.consignmentId), 'not case sensitive');

    const account = await call('list_consignments', { accountId: 'ACC-0006' });
    const expected = consignments.filter((row) => row.accountId === 'ACC-0006').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    assert.ok(expected.length >= 3);
    assert.deepEqual(account.records.map((record: Rec) => record.consignmentId), expected.map((row) => row.consignmentId), 'newest first');
    assert.deepEqual((await call('list_consignments', { accountId: 'ACC-0006', status: 'collected' })).records.map((record: Rec) => record.consignmentId), expected.filter((row) => row.status === 'collected').map((row) => row.consignmentId));
    assert.deepEqual((await call('list_consignments', { accountId: 'ACC-0006', orderNumber: expected[0].orderNumber })).records.map((record: Rec) => record.consignmentId), [expected[0].consignmentId], 'both narrow it');
    const limited = await call('list_consignments', { accountId: 'ACC-0006', limit: 2 });
    assert.deepEqual([limited.total, limited.returned], [expected.length, 2]);
    assert.equal((await call('list_consignments', { orderNumber: 'ORD-100005' })).returned, 0, 'a cancelled order has none');
    assert.equal((await call('list_consignments', { orderNumber: 'ORD-100002' })).records[0].status, 'planned');
    assert.equal((await call('list_consignments', { status: 'delivered', limit: 25 })).total, consignments.filter((row) => row.status === 'delivered').length);
  });

  await check('get_consignment: the whole record, not found for a number nobody has, and the number is required', async () => {
    const one = await call('get_consignment', { consignmentId: 'CON-50027' });
    assert.equal(one.ok, true);
    assert.deepEqual(one.record, consignmentOf.get('CON-50027')!, 'the record in the seed, nothing cut');
    assert.deepEqual([one.record.orderNumber, one.record.shipmentId, one.record.status], ['ORD-100034', 'DEL-30020', 'delivered']);
    assert.equal((await call('get_consignment', { consignmentId: 'con-50027' })).record.consignmentId, 'CON-50027', 'not case sensitive');
    const none = await call('get_consignment', { consignmentId: 'CON-99999' });
    assert.equal(none.ok, false);
    assert.equal(none.error.code, 'not_found');
    const empty = await call('get_consignment', {});
    assert.equal(empty.error.code, 'invalid_arguments');
    assert.match(empty.error.message, /consignmentId is required/);
  });

  await check('list_consignment_lines: by consignment or by order, narrowed by product, a limit honoured', async () => {
    const byOrder = await call('list_consignment_lines', { orderNumber: splitOrder });
    assert.deepEqual(byOrder.records.map((record: Rec) => [record.consignmentId, record.lineKey, record.quantity]), lines.filter((line) => line.orderNumber === splitOrder).map((line) => [line.consignmentId, line.lineKey, line.quantity]));
    assert.equal(byOrder.total, 3, 'the shared line is on two consignments, the other on one');
    for (const record of byOrder.records) assert.deepEqual(Object.keys(record), LINE_FIELDS);
    assert.deepEqual((await call('list_consignment_lines', { consignmentId: 'CON-50003' })).records.map((record: Rec) => record.quantity), [3]);
    const sku = lines.find((line) => line.consignmentId === 'CON-50002')!.sku;
    assert.deepEqual((await call('list_consignment_lines', { orderNumber: splitOrder, sku })).records.map((record: Rec) => record.consignmentId), ['CON-50002', 'CON-50003']);
    assert.deepEqual((await call('list_consignment_lines', { consignmentId: 'CON-50002', sku })).records.map((record: Rec) => record.quantity), [4]);
    const limited = await call('list_consignment_lines', { orderNumber: splitOrder, limit: 1 });
    assert.deepEqual([limited.total, limited.returned], [3, 1]);
    assert.equal((await call('list_consignment_lines', { orderNumber: 'ORD-100005' })).returned, 0);
  });

  await check('list_tracking_events: oldest first, for a consignment or for a trip, with the proof on the last event; a limit is honoured', async () => {
    const delivered = await call('list_tracking_events', { consignmentId: 'CON-50027' });
    assert.deepEqual(delivered.records.map((record: Rec) => record.type), ['picked', 'out_for_delivery', 'delivered']);
    for (const record of delivered.records) assert.deepEqual(Object.keys(record), EVENT_FIELDS);
    const proof = delivered.records.at(-1);
    assert.deepEqual([proof.evidenceRef, typeof proof.receivedBy, proof.collectedBy], ['POD-50027', 'string', null]);
    const times = delivered.records.map((record: Rec) => record.at);
    assert.deepEqual(times, [...times].sort(), 'oldest first');
    const tripEvents = await call('list_tracking_events', { shipmentId: 'DEL-30020' });
    assert.deepEqual(tripEvents.records.map((record: Rec) => [record.type, record.consignmentId]), [['loaded', null], ['dispatched', null]]);
    assert.deepEqual((await call('list_tracking_events', { shipmentId: 'del-30020' })).records.map((record: Rec) => record.eventId), tripEvents.records.map((record: Rec) => record.eventId), 'not case sensitive');
    assert.deepEqual((await call('list_tracking_events', { consignmentId: 'CON-50004' })).records.map((record: Rec) => [record.type, record.collectedBy === null ? null : 'a person']), [['picked', null], ['collected', 'a person']]);
    const limited = await call('list_tracking_events', { consignmentId: 'CON-50027', limit: 2 });
    assert.deepEqual([limited.total, limited.returned, limited.records.map((record: Rec) => record.type)], [3, 2, ['picked', 'out_for_delivery']]);
    assert.equal((await call('list_tracking_events', { consignmentId: 'CON-50001' })).returned, 0, 'a planned consignment has no events');
    const all = await call('list_tracking_events', { limit: 25 });
    assert.deepEqual(all.records.map((record: Rec) => record.eventId), events.slice(0, 25).map((record) => record.eventId), 'with no id given, the oldest events of all');
  });

  await check('the four tools sit with the delivery tools, only read, take the arguments the plan lists, run on their examples, and their descriptions leave out the words the stock and invoice queries look for', async () => {
    const tools = erp.definition.tools;
    const names = tools.map((tool) => tool.name);
    const at = names.indexOf('list_deliveries');
    assert.deepEqual(names.slice(at + 1, at + 5), ['list_consignments', 'get_consignment', 'list_consignment_lines', 'list_tracking_events']);
    assert.equal(new Set(names).size, names.length);
    const arguments_: Record<string, [required: string[], arguments: string[]]> = {
      list_consignments: [[], ['orderNumber', 'accountId', 'status', 'limit']],
      get_consignment: [['consignmentId'], ['consignmentId']],
      list_consignment_lines: [[], ['orderNumber', 'consignmentId', 'sku', 'limit']],
      list_tracking_events: [[], ['consignmentId', 'shipmentId', 'limit']],
    };
    for (const [name, [required, expected]] of Object.entries(arguments_)) {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} only reads`);
      assert.ok(tool.description.length > 20);
      assert.deepEqual(tool.inputSchema.required ?? [], required);
      assert.deepEqual(Object.keys(tool.inputSchema.properties), expected);
      const args = resolveExample(tool.example, new TenantCollections(erp.seed));
      const answer = await call(name, args);
      assert.equal(answer.ok, true, name);
      assert.ok(JSON.stringify(answer).length < 32 * 1024, `${name} fits the size cap`);
      assert.ok(answer.records?.length > 0 || answer.record, `${name} finds something for its own example`);
      assert.deepEqual(await call(name, args), answer, `${name} reads the same twice`);
    }
    // The runtime narrows a connector's tools by a query with this rule (loadTools in apps/journey-runtime-service/src/kernel/connector.runtime.ts).
    const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
    const matching = (query: string) => tools.filter((tool) => tokens(query).every((token) => tokens(`${tool.name} ${tool.description}`).some((word) => word.startsWith(token) || token.startsWith(word)))).map((tool) => tool.name);
    assert.deepEqual(matching('stock'), ['stock_by_branch'], 'a query for stock still finds the stock tool alone');
    assert.deepEqual(matching('invoice'), ['find_invoices', 'get_invoice'], 'and a query for invoice the invoice tools alone');
    assert.deepEqual(matching('consignment'), ['list_consignments', 'get_consignment', 'list_consignment_lines'].concat(['list_tracking_events']), 'a query for consignment finds the four');
  });

  await check('the contract spec\'s count: 54 tools in all, every one runs on its example in the process and answers in the shape the contract expects, and the contract spec says 54', async () => {
    const all = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
    let calls = 0;
    for (const [id, { definition, seed }] of connectors) {
      for (const tool of definition.tools) {
        const args = resolveExample(tool.example, new TenantCollections(seed));
        const answer = await all.handle(id, TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: args } });
        const result = answer!.result as Rec;
        assert.notEqual(result.isError, true, `${id}.${tool.name}: ${JSON.stringify(result.content)}`);
        const data = result.structuredContent as Rec;
        assert.equal(data.ok, true);
        assert.equal(data.connector, id);
        assert.ok(['records', 'record', 'rows'].filter((key) => key in data).length === 1 || ('valid' in data && 'suggestions' in data), `${id}.${tool.name} has one outline`);
        if (Array.isArray(data.records)) assert.ok(data.records.length > 0, `${id}.${tool.name} finds something for its own example`);
        assert.ok(JSON.stringify(data).length < 32 * 1024);
        calls++;
      }
    }
    assert.equal(calls, 54);
    assert.match(readFileSync(CONTRACT_SPEC, 'utf8'), /assert\.equal\(calls, 54\);/);
  });

  await check('the runtime\'s frozen registry lists the four tools, after the delivery tools and in the order the server offers them, as reads with no claim class; the pack schema accepts it; its summaries fit', () => {
    const registry = JSON.parse(readFileSync(RUNTIME_REGISTRY, 'utf8'));
    const parsed = ConnectorsSchema.parse(registry);
    const listed = parsed.connectors.find((connector) => connector.connectorId === 'ace-erp')!;
    assert.deepEqual(listed.tools.map((tool) => tool.name), erp.definition.tools.map((tool) => tool.name), 'the same tools in the same order');
    const at = listed.tools.findIndex((tool) => tool.name === 'list_deliveries');
    for (const name of ['list_consignments', 'get_consignment', 'list_consignment_lines', 'list_tracking_events']) {
      const tool = listed.tools.find((entry) => entry.name === name)!;
      assert.equal(listed.tools.indexOf(tool) > at && listed.tools.indexOf(tool) <= at + 4, true, `${name} sits with the delivery tools`);
      assert.equal(tool.sideEffect, 'read');
      assert.ok(tool.summary && tool.summary.length > 0 && tool.summary.length <= 200);
      assert.equal(tool.claimClasses, undefined, 'no statement class: a delivery promise or a proof is not quoted as fact on the strength of the call alone');
    }
    for (const [id, { definition }] of connectors) {
      const entry = parsed.connectors.find((connector) => connector.connectorId === id)!;
      assert.deepEqual(entry.tools.map((tool) => tool.name), definition.tools.map((tool) => tool.name), `${id} is listed as the server offers it`);
    }
    assert.deepEqual(parsed.policy.filter((row) => row.connectorId === 'ace-erp').map((row) => [row.tool, row.state]), [['*', 'allow']], 'staff may read every ERP tool, the new ones too');
  });

  console.log(`sample ERP fulfilment: ${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
