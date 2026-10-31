/**
 * The sample ERP learns consignments: the goods of an order that are sent or collected together, the lines on each, and the events that say
 * where each has got to. A delivery row stays the trip (it keeps its DEL- number) and learns who carries it. Nothing is drawn from a random
 * stream: every value follows from the rows the stage reads (the ERP's deliveries and the sample shop's orders and order lines) and from
 * these rules.
 *
 *  1. One delivery consignment for each delivery row, on that trip. A delivery row for a cancelled order, or for a click-and-collect order, stops the build.
 *  2. One collection consignment, on no trip, for each click-and-collect order that is picked, ready for collection or collected. An order that is
 *     only placed or confirmed has none, and neither has a cancelled order.
 *  3. One order is split: the first delivered delivery order of a trade account (by the day it was placed) with two or more lines, one of which
 *     has a quantity of two or more. Half of that line (rounded down) is collected at the branch instead, on a second consignment of the same order.
 *  4. Every other consignment carries the order's lines in full. Consignment numbers follow the order the consignments were made in.
 *  5. Events follow the order status and the delivery status, at the SAMPLE_MINUTES offsets. picked, out_for_delivery, delivered, failed_attempt and
 *     collected belong to the consignment; loaded and dispatched belong to the trip. A step is never earlier than SAMPLE_MINUTES.gap after the one
 *     before it, so nothing comes before the order was placed. A delivery that is scheduled has the events its order has reached (none for a
 *     placed or confirmed order, picked for a picked one); one that is out for delivery or delivered has them all up to there, delivered with a
 *     receivedBy and a proof reference; a collected order ends with collected, with a collectedBy and a proof reference.
 *  6. A failed attempt on an order that was never dispatched has no events at all (the three in the seed are known sample anomalies, and this
 *     stage does not change those rows). On a dispatched order it ends the events with a failed_attempt and the delivery row's note as its reason.
 *  7. A consignment's status is the type of its newest event of its own, or planned when it has none.
 *  8. The delivery rows get a carrier and nothing else. Its note in the provenance stands straight after the generator's own note.
 *
 * Reads the shop's seed as well (stageConnectorIds names it, so extend-seeds loads it) and never changes it.
 */
import type { CollectionProvenance, Rec, SeedFile } from '../../src/types';
import type { SeedStage } from './index';

/** SAMPLE ONLY: the number of the first consignment; the rest follow in the order they were made. */
export const SAMPLE_FIRST_CONSIGNMENT_NUMBER = 50001;
/** SAMPLE ONLY: the number of the first event; the rest follow in the order they happened. */
export const SAMPLE_FIRST_EVENT_NUMBER = 600001;
/** SAMPLE ONLY: who carries every sample trip. The sample trucks and drivers belong to the branch. */
export const SAMPLE_CARRIER = 'In-house fleet';
/** SAMPLE ONLY: the people named as having taken the goods, handed out in the order the events happened. */
export const SAMPLE_PEOPLE = ['Aroha', 'Ben', 'Chloe', 'Dev', 'Emma', 'Hemi', 'Isla', 'Jack'];
/** SAMPLE ONLY, not PlaceMakers decisions: how far apart the events of a consignment are, in minutes. */
export const SAMPLE_MINUTES = {
  /** After the order was placed: the consignment is made. */
  created: 10,
  /** After the consignment was made: the goods are picked. */
  picked: 120,
  /** Before the delivery window opens: the vehicle is loaded. */
  loaded: 60,
  /** Before the delivery window opens: the vehicle leaves. */
  dispatched: 30,
  /** After the delivery window opens: the goods are handed over, or nobody is there. */
  handedOver: 90,
  /** After the goods were picked: the customer collects them. */
  collected: 1440,
  /** The least time between two steps. */
  gap: 10,
};

/** The owner's list, in the order a consignment goes through them. */
export const EVENT_TYPES = ['picked', 'loaded', 'dispatched', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned', 'collected'] as const;
/** The events of the trip rather than of one consignment on it. */
export const SHIPMENT_EVENT_TYPES: readonly string[] = ['loaded', 'dispatched'];
export const FULFILMENT_COLLECTIONS = ['consignments', 'consignment_lines', 'tracking_events'] as const;

const COMMERCE = 'sap-commerce';
const NUMBER_WIDTH = 5;
const EVENT_NUMBER_WIDTH = 6;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const METHODS = ['delivery', 'collection'];

/** How far a delivery order has got: not started (placed, confirmed), picked, out for delivery, delivered. */
const DELIVERY_REACHED = new Map<string, number>([['placed', 0], ['confirmed', 0], ['picked', 1], ['dispatched', 2], ['delivered', 3]]);
/** How far the order may have got for each status of its delivery row. A failed attempt on an order that never went out is a known sample anomaly. */
const REACHED_FOR = new Map<string, number[]>([['scheduled', [0, 1]], ['out_for_delivery', [2]], ['delivered', [3]], ['failed_attempt', [0, 1, 2]]]);
const COLLECTION_ORDER_STATUSES = new Set(['picked', 'ready_for_collection', 'collected']);
const UNSTARTED_COLLECTION = new Set(['placed', 'confirmed']);

interface Step { type: string; shipment: boolean; at: number }
interface Draft {
  method: string;
  order: Rec;
  delivery: Rec | null;
  createdAt: number;
  steps: Step[];
  lines: Array<{ line: Rec; quantity: number }>;
}

const text = (row: Rec, field: string): string => {
  const value = row[field];
  if (typeof value !== 'string' || value === '') throw new Error(`erp-fulfilment: a row has no ${field}`);
  return value;
};

function parseDay(day: string): number {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw new Error(`erp-fulfilment: '${day}' is not a date`);
  return parsed.getTime();
}

function parseStamp(stamp: string, what: string): number {
  const parsed = Date.parse(stamp);
  if (Number.isNaN(parsed)) throw new Error(`erp-fulfilment: ${what} '${stamp}' is not a time`);
  return parsed;
}

/** When a delivery window opens on a day, on the same clock the order times use: "7am-10am" opens at 07:00, "1pm-4pm" at 13:00. */
export function windowStart(day: string, window: string): number {
  const opening = /^(\d{1,2})(am|pm)-/.exec(window);
  const hour = opening ? Number(opening[1]) : 0;
  if (!opening || hour < 1 || hour > 12) throw new Error(`erp-fulfilment: '${window}' is not a delivery window`);
  return parseDay(day) + ((hour % 12) + (opening[2] === 'pm' ? 12 : 0)) * HOUR_MS;
}

/** Puts steps on the clock: each at its own time, or the gap after the step before when its own time would come first. */
function onClock(from: number, wanted: Array<[type: string, shipment: boolean, at: number]>): Step[] {
  let previous = from;
  return wanted.map(([type, shipment, at]) => {
    previous = Math.max(at, previous + SAMPLE_MINUTES.gap * MINUTE_MS);
    return { type, shipment, at: previous };
  });
}

function deliverySteps(order: Rec, delivery: Rec, createdAt: number): Step[] {
  const reached = DELIVERY_REACHED.get(text(order, 'status'));
  if (reached === undefined) throw new Error(`erp-fulfilment: ${order.orderId} is a delivery order with status ${order.status}`);
  const status = text(delivery, 'status');
  const allowed = REACHED_FOR.get(status);
  if (!allowed) throw new Error(`erp-fulfilment: ${delivery.deliveryId} has status ${status}`);
  if (!allowed.includes(reached)) throw new Error(`erp-fulfilment: ${delivery.deliveryId} is ${status}, but its order ${order.orderId} is ${order.status}`);
  if (reached === 0 || (status === 'failed_attempt' && reached < 2)) return [];
  const picked: [string, boolean, number] = ['picked', false, createdAt + SAMPLE_MINUTES.picked * MINUTE_MS];
  if (reached === 1) return onClock(createdAt, [picked]);
  const opens = windowStart(text(delivery, 'scheduledDate'), text(delivery, 'window'));
  const wanted: Array<[string, boolean, number]> = [
    picked,
    ['loaded', true, opens - SAMPLE_MINUTES.loaded * MINUTE_MS],
    ['dispatched', true, opens - SAMPLE_MINUTES.dispatched * MINUTE_MS],
    ['out_for_delivery', false, opens],
  ];
  if (status === 'delivered' || status === 'failed_attempt') wanted.push([status, false, opens + SAMPLE_MINUTES.handedOver * MINUTE_MS]);
  return onClock(createdAt, wanted);
}

function collectionSteps(collected: boolean, createdAt: number): Step[] {
  const picked: [string, boolean, number] = ['picked', false, createdAt + SAMPLE_MINUTES.picked * MINUTE_MS];
  return onClock(createdAt, collected ? [picked, ['collected', false, picked[2] + SAMPLE_MINUTES.collected * MINUTE_MS]] : [picked]);
}

/** The first delivered delivery order of a trade account, by the day it was placed, that has two or more lines and a line of two or more to share. */
function splitDraft(drafts: Draft[]): Draft | undefined {
  return drafts
    .filter((draft) => draft.method === 'delivery' && draft.delivery?.status === 'delivered' && draft.order.accountId && draft.lines.length >= 2 && draft.lines.some((entry) => entry.quantity >= 2))
    .sort((a, b) => a.createdAt - b.createdAt || text(a.order, 'orderId').localeCompare(text(b.order, 'orderId')))[0];
}

function buildDrafts(erp: SeedFile, commerce: SeedFile): Draft[] {
  const orders = new Map(commerce.collections.orders.map((row) => [text(row, 'orderId'), row]));
  const linesOf = (orderId: string): Rec[] => commerce.collections.order_lines.filter((line) => line.orderId === orderId);
  const drafts: Draft[] = [];
  const sent = new Set<string>();

  for (const delivery of [...erp.collections.deliveries].sort((a, b) => text(a, 'deliveryId').localeCompare(text(b, 'deliveryId')))) {
    const order = orders.get(text(delivery, 'orderId'));
    if (!order) throw new Error(`erp-fulfilment: ${delivery.deliveryId} is for ${delivery.orderId}, which the ${COMMERCE} seed does not have`);
    if (sent.has(order.orderId)) throw new Error(`erp-fulfilment: ${order.orderId} has more than one delivery row`);
    sent.add(order.orderId);
    if (order.deliveryType !== 'delivery') throw new Error(`erp-fulfilment: ${delivery.deliveryId} is for ${order.orderId}, which is ${order.deliveryType}`);
    if (order.status === 'cancelled') throw new Error(`erp-fulfilment: ${delivery.deliveryId} is for ${order.orderId}, which is cancelled`);
    if (order.accountId !== delivery.accountId) throw new Error(`erp-fulfilment: ${order.orderId} belongs to ${order.accountId}, but ${delivery.deliveryId} is for ${delivery.accountId}`);
    if (order.branchCode !== delivery.branchCode) throw new Error(`erp-fulfilment: ${order.orderId} is at branch ${order.branchCode}, but ${delivery.deliveryId} is at ${delivery.branchCode}`);
    const lines = linesOf(order.orderId);
    if (lines.length === 0) throw new Error(`erp-fulfilment: ${order.orderId} has no lines in the ${COMMERCE} seed`);
    const createdAt = parseStamp(text(order, 'placedAt'), `${order.orderId} placedAt`) + SAMPLE_MINUTES.created * MINUTE_MS;
    drafts.push({ method: 'delivery', order, delivery, createdAt, steps: deliverySteps(order, delivery, createdAt), lines: lines.map((line) => ({ line, quantity: line.quantity })) });
  }

  for (const order of commerce.collections.orders) {
    if (order.deliveryType !== 'click_and_collect' || order.status === 'cancelled' || UNSTARTED_COLLECTION.has(order.status)) continue;
    if (!COLLECTION_ORDER_STATUSES.has(order.status)) throw new Error(`erp-fulfilment: ${order.orderId} is a click-and-collect order with status ${order.status}`);
    const lines = linesOf(order.orderId);
    if (lines.length === 0) throw new Error(`erp-fulfilment: ${order.orderId} has no lines in the ${COMMERCE} seed`);
    const createdAt = parseStamp(text(order, 'placedAt'), `${order.orderId} placedAt`) + SAMPLE_MINUTES.created * MINUTE_MS;
    drafts.push({ method: 'collection', order, delivery: null, createdAt, steps: collectionSteps(order.status === 'collected', createdAt), lines: lines.map((line) => ({ line, quantity: line.quantity })) });
  }

  const split = splitDraft(drafts);
  if (split) {
    const shared = split.lines.find((entry) => entry.quantity >= 2)!;
    const collected = Math.floor(shared.quantity / 2);
    shared.quantity -= collected;
    drafts.push({ method: 'collection', order: split.order, delivery: null, createdAt: split.createdAt, steps: collectionSteps(true, split.createdAt), lines: [{ line: shared.line, quantity: collected }] });
  }
  return drafts;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();
const numberOf = (id: string): string => id.slice(id.lastIndexOf('-') + 1);

function buildFulfilment(erp: SeedFile, commerce: SeedFile): Record<(typeof FULFILMENT_COLLECTIONS)[number], Rec[]> {
  const drafts = buildDrafts(erp, commerce)
    .sort((a, b) => a.createdAt - b.createdAt || text(a.order, 'orderId').localeCompare(text(b.order, 'orderId')) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
  const rank = (type: string): number => EVENT_TYPES.indexOf(type as (typeof EVENT_TYPES)[number]);
  const ids = new Map(drafts.map((draft, index): [Draft, string] => [draft, `CON-${String(SAMPLE_FIRST_CONSIGNMENT_NUMBER + index).padStart(NUMBER_WIDTH, '0')}`]));

  const consignments: Rec[] = [];
  const lines: Rec[] = [];
  const stamped: Array<{ owner: string; draft: Draft; step: Step }> = [];
  for (const draft of drafts) {
    const consignmentId = ids.get(draft)!;
    const own = draft.steps.filter((step) => !step.shipment);
    const newest = own.reduce<Step | undefined>((latest, step) => (!latest || step.at > latest.at || (step.at === latest.at && rank(step.type) > rank(latest.type)) ? step : latest), undefined);
    consignments.push({
      consignmentId,
      orderNumber: draft.order.orderId,
      accountId: draft.order.accountId,
      method: draft.method,
      fromBranchCode: draft.order.branchCode,
      shipmentId: draft.delivery ? draft.delivery.deliveryId : null,
      status: newest ? newest.type : 'planned',
      createdAt: isoOf(draft.createdAt),
      sample: true,
    });
    for (const entry of draft.lines) lines.push({ consignmentId, orderNumber: draft.order.orderId, lineKey: entry.line.lineId, sku: entry.line.sku, quantity: entry.quantity, sample: true });
    for (const step of draft.steps) stamped.push({ owner: step.shipment ? draft.delivery!.deliveryId : consignmentId, draft, step });
  }

  stamped.sort((a, b) => a.step.at - b.step.at || a.owner.localeCompare(b.owner) || rank(a.step.type) - rank(b.step.type));
  let proofs = 0;
  const events = stamped.map(({ owner, draft, step }, index): Rec => {
    const proof = step.type === 'delivered' || step.type === 'collected';
    const person = proof ? SAMPLE_PEOPLE[proofs++ % SAMPLE_PEOPLE.length] : null;
    return {
      eventId: `EVT-${String(SAMPLE_FIRST_EVENT_NUMBER + index).padStart(EVENT_NUMBER_WIDTH, '0')}`,
      consignmentId: step.shipment ? null : owner,
      shipmentId: step.shipment ? owner : null,
      type: step.type,
      at: isoOf(step.at),
      reason: step.type === 'failed_attempt' ? text(draft.delivery!, 'note') : null,
      receivedBy: step.type === 'delivered' ? person : null,
      collectedBy: step.type === 'collected' ? person : null,
      evidenceRef: proof ? `${step.type === 'delivered' ? 'POD' : 'COL'}-${numberOf(ids.get(draft)!)}` : null,
      sample: true,
    };
  });
  return { consignments, consignment_lines: lines, tracking_events: events };
}

/** Puts fields at the end of a row, keeping a value that is already there. The row's text is then the same whichever order the stages ran in. */
function placeLast(row: Rec, fields: Rec): void {
  for (const [name, value] of Object.entries(fields)) {
    const kept = name in row ? row[name] : value;
    delete row[name];
    row[name] = kept;
  }
}

const CARRIER_NOTE = 'carrier (a sample constant: the sample trucks and drivers belong to the branch)';

/** Puts the carrier note straight after the generator's own note, keeping the text that is there. The account-key stage adds its note at the end, so the order of the notes does not depend on which of the two stages ran first. */
function placeCarrierNote(madeUp: string[]): void {
  const at = madeUp.findIndex((entry) => entry.startsWith('carrier'));
  const kept = at === -1 ? CARRIER_NOTE : madeUp.splice(at, 1)[0];
  madeUp.splice(1, 0, kept);
}

/** Moves collections, with their provenance, to the end in this order, so the text of the seed does not depend on which stage ran first. */
function placeCollectionsLast(seed: SeedFile, names: readonly string[]): void {
  for (const name of names) {
    const rows = seed.collections[name];
    const provenance = seed.provenance[name];
    delete seed.collections[name];
    delete seed.provenance[name];
    seed.collections[name] = rows;
    seed.provenance[name] = provenance;
  }
}

const provenance = (): Record<(typeof FULFILMENT_COLLECTIONS)[number], CollectionProvenance> => ({
  consignments: {
    origin: 'sample',
    source: 'invented over the sample orders and deliveries: one for each delivery, one for each click-and-collect order that is picked, ready for collection or collected, and a second one for one split order',
    realFields: ['fromBranchCode (a real code)'],
    madeUpFields: ['every other field (the numbers, dates and statuses follow from the order and delivery rows by fixed sample rules)'],
  },
  consignment_lines: {
    origin: 'mixed',
    source: 'the lines of the sample orders, shared between the consignments of an order',
    realFields: ['sku'],
    madeUpFields: ['every other field'],
  },
  tracking_events: {
    origin: 'sample',
    source: 'invented from the order status and the delivery status, at fixed sample offsets; none for the three failed attempts on orders that were never dispatched',
    realFields: [],
    madeUpFields: ['every field (the times follow fixed sample offsets; the people and the proof references are made up)'],
  },
});

export const erpFulfilment: SeedStage = {
  name: 'erp-fulfilment',
  connectorId: 'ace-erp',
  reads: [COMMERCE],
  apply(seed, others) {
    const commerce = others?.get(COMMERCE);
    if (!commerce) throw new Error(`erp-fulfilment: it reads the '${COMMERCE}' seed, which it was not given`);
    const present = FULFILMENT_COLLECTIONS.filter((name) => seed.collections[name]);
    if (present.length === 0) Object.assign(seed.collections, buildFulfilment(seed, commerce));
    else if (present.length < FULFILMENT_COLLECTIONS.length) throw new Error(`erp-fulfilment: the seed has ${present.join(', ')} but not the rest of ${FULFILMENT_COLLECTIONS.join(', ')}`);
    for (const [name, note] of Object.entries(provenance())) if (!seed.provenance[name]) seed.provenance[name] = note;
    for (const delivery of seed.collections.deliveries) placeLast(delivery, { carrier: SAMPLE_CARRIER });
    placeCarrierNote(seed.provenance.deliveries.madeUpFields);
    placeCollectionsLast(seed, FULFILMENT_COLLECTIONS);
  },
};
