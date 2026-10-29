/**
 * The sample ERP learns invoices: one for each delivered order of a trade account. The account rows also learn how much of the balance the
 * invoices do not itemise (`broughtForward`, empty for an account with no invoice) and the day the invoices are as of (`invoicesAsOf`).
 * Nothing is drawn from a random stream: every value follows from the rows the stage reads (the ERP's deliveries, accounts and price list,
 * and the sample shop's orders and order lines) and from these rules.
 *
 *  1. One invoice for each delivered order of a trade account; a guest order has none. They are numbered in the order they were issued.
 *  2. Issued on the delivery's scheduledDate.
 *  3. The lines are the order's lines, priced at the account's tier from the ERP price list. A SKU the price list lacks stops the build.
 *  4. GST at SAMPLE_GST_RATE is added to the lines, which are taken as excluding it. Amounts are rounded to the cent, halves up.
 *  5. The due date follows the account's payment terms, for the three texts the sample accounts carry (TERMS). Any other text gives no due
 *     date and stays in dueNote.
 *  6. Status as of SAMPLE_AS_OF, oldest due first. An invoice due before that day is paid, unless the account is overdue: then the oldest
 *     past-due invoices are overdue for as long as they fit within the overdue amount together, and the rest are paid. An invoice not yet
 *     due (or with no due date) is open while the open invoices fit within the balance less the overdue invoices; the one that does not fit
 *     is part paid for what the balance leaves, and any after it are paid. broughtForward is the balance less the open and part-paid amounts.
 *  7. The account's balance, credit limit, overdue amount and last payment are never changed.
 *
 * Reads the shop's seed as well (stageConnectorIds names it, so extend-seeds loads it) and never changes it.
 */
import type { CollectionProvenance, Rec, SeedFile } from '../../src/types';
import type { SeedStage } from './index';

/** The day every status is worked out for: build-seeds.ts's REFERENCE_DAY, the day the data was last looked at. No real clock is read. */
export const SAMPLE_AS_OF = '2026-09-01';
/** SAMPLE ONLY, not a PlaceMakers decision: the rate GST is added at, to prices taken as excluding GST. */
export const SAMPLE_GST_RATE = 0.15;
/** SAMPLE ONLY: the number of the first invoice; the rest follow in the order they were issued. */
export const SAMPLE_FIRST_INVOICE_NUMBER = 40001;

const COMMERCE = 'sap-commerce';
const INVOICE_NUMBER_WIDTH = 5;
/** The rate is applied in ten-thousandths of the amount, so a half cent comes out exactly. */
const RATE_STEPS = 10_000;
const DAY_MS = 86_400_000;

/** The payment-term texts the sample accounts carry, and what each means for the due date. */
const TERMS = new Map<string, { afterDays: number } | { dayOfNextMonth: number }>([
  ['7 days', { afterDays: 7 }],
  ['30 days', { afterDays: 30 }],
  ['20th of the month', { dayOfNextMonth: 20 }],
]);

const text = (row: Rec, field: string): string => {
  const value = row[field];
  if (typeof value !== 'string' || value === '') throw new Error(`erp-invoices: a row has no ${field}`);
  return value;
};

const cents = (amount: unknown): number => {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error(`erp-invoices: ${String(amount)} is not an amount`);
  return Math.round(value * 100);
};
const money = (amountInCents: number): number => amountInCents / 100;

function parseDay(day: string): Date {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw new Error(`erp-invoices: '${day}' is not a date`);
  return parsed;
}
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The due date for the payment terms, and the terms as text. Terms this stage does not know give no date. */
export function dueFor(issuedAt: string, terms: string): { dueAt: string | null; dueNote: string } {
  const rule = TERMS.get(terms);
  if (!rule) return { dueAt: null, dueNote: terms };
  const issued = parseDay(issuedAt);
  if ('afterDays' in rule) return { dueAt: isoDay(new Date(issued.getTime() + rule.afterDays * DAY_MS)), dueNote: terms };
  return { dueAt: isoDay(new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth() + 1, rule.dayOfNextMonth))), dueNote: terms };
}

/** An order's lines priced at the account's tier. A SKU or a tier the price list does not have is an error, not a fallback to the shelf price. */
export function invoiceLines(orderLines: Rec[], tier: string, prices: Map<string, Rec>): Rec[] {
  const field = `${tier}Price`;
  return orderLines.map((line) => {
    const price = prices.get(String(line.sku));
    if (!price) throw new Error(`erp-invoices: the price list has no row for ${line.sku} (order ${line.orderId})`);
    if (typeof price[field] !== 'number') throw new Error(`erp-invoices: the price list row for ${line.sku} has no ${field} (order ${line.orderId})`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new Error(`erp-invoices: order ${line.orderId} line ${line.lineId} has quantity ${line.quantity}`);
    return { sku: line.sku, title: line.title, quantity: line.quantity, unitPrice: price[field], lineTotal: money(line.quantity * cents(price[field])) };
  });
}

function oldestFirst(a: Rec, b: Rec): number {
  if ((a.dueAt === null) !== (b.dueAt === null)) return a.dueAt === null ? 1 : -1;
  return String(a.dueAt ?? '').localeCompare(String(b.dueAt ?? '')) || String(a.issuedAt).localeCompare(String(b.issuedAt)) || String(a.invoiceId).localeCompare(String(b.invoiceId));
}

const mark = (invoice: Rec, status: string, paidInCents: number): void => {
  invoice.status = status;
  invoice.paidAmount = money(paidInCents);
};

/** Sets the status and the paid amount of one account's invoices (rule 6). Reads the account's balance and overdue amount; changes only the invoices. */
export function settleInvoices(invoices: Rec[], account: Rec, asOf: string = SAMPLE_AS_OF): void {
  let overdueLeft = cents(account.overdue);
  let overdueTotal = 0;
  const notYetDue: Rec[] = [];
  for (const invoice of [...invoices].sort(oldestFirst)) {
    const total = cents(invoice.total);
    if (invoice.dueAt === null || invoice.dueAt >= asOf) { notYetDue.push(invoice); continue; }
    if (overdueLeft > 0 && total <= overdueLeft) {
      overdueLeft -= total;
      overdueTotal += total;
      mark(invoice, 'overdue', 0);
    } else mark(invoice, 'paid', total);
  }
  let room = Math.max(0, cents(account.balance) - overdueTotal);
  for (const invoice of notYetDue) {
    const total = cents(invoice.total);
    if (total <= room) {
      room -= total;
      mark(invoice, 'open', 0);
    } else if (room > 0) {
      mark(invoice, 'part_paid', total - room);
      room = 0;
    } else mark(invoice, 'paid', total);
  }
}

/** The balance less what the open and part-paid invoices still owe, never below zero; null for an account with no invoice. */
export function broughtForwardFor(invoices: Rec[], account: Rec): number | null {
  if (invoices.length === 0) return null;
  let itemised = 0;
  for (const invoice of invoices) if (invoice.status === 'open' || invoice.status === 'part_paid') itemised += cents(invoice.total) - cents(invoice.paidAmount);
  return money(Math.max(0, cents(account.balance) - itemised));
}

function buildInvoices(erp: SeedFile, commerce: SeedFile): Rec[] {
  const accounts = new Map(erp.collections.account_balances.map((row) => [text(row, 'accountId'), row]));
  const prices = new Map(erp.collections.price_list.map((row) => [text(row, 'sku'), row]));
  const orders = new Map(commerce.collections.orders.map((row) => [text(row, 'orderId'), row]));
  const delivered = erp.collections.deliveries
    .filter((delivery) => delivery.status === 'delivered' && delivery.accountId)
    .sort((a, b) => text(a, 'scheduledDate').localeCompare(text(b, 'scheduledDate')) || text(a, 'deliveryId').localeCompare(text(b, 'deliveryId')));

  const invoices = delivered.map((delivery, index): Rec => {
    const accountId = text(delivery, 'accountId');
    const account = accounts.get(accountId);
    if (!account) throw new Error(`erp-invoices: ${delivery.deliveryId} is for ${accountId}, which has no balance row`);
    const order = orders.get(text(delivery, 'orderId'));
    if (!order) throw new Error(`erp-invoices: ${delivery.deliveryId} is for ${delivery.orderId}, which the ${COMMERCE} seed does not have`);
    if (order.accountId !== accountId) throw new Error(`erp-invoices: ${order.orderId} belongs to ${order.accountId}, but ${delivery.deliveryId} is for ${accountId}`);
    const ownLines = commerce.collections.order_lines.filter((line) => line.orderId === order.orderId);
    if (ownLines.length === 0) throw new Error(`erp-invoices: ${order.orderId} has no lines in the ${COMMERCE} seed`);

    const lines = invoiceLines(ownLines, text(account, 'tier'), prices);
    const subtotal = lines.reduce((sum, line) => sum + cents(line.lineTotal), 0);
    const gst = Math.round((subtotal * Math.round(SAMPLE_GST_RATE * RATE_STEPS)) / RATE_STEPS);
    const issuedAt = text(delivery, 'scheduledDate');
    return {
      invoiceId: `INV-${String(SAMPLE_FIRST_INVOICE_NUMBER + index).padStart(INVOICE_NUMBER_WIDTH, '0')}`,
      accountId,
      commercetoolsOrderNumber: text(delivery, 'commercetoolsOrderNumber'),
      orderId: text(delivery, 'orderId'),
      deliveryId: text(delivery, 'deliveryId'),
      issuedAt,
      ...dueFor(issuedAt, text(account, 'terms')),
      status: 'open',
      currency: text(account, 'currency'),
      lines,
      subtotal: money(subtotal),
      gst: money(gst),
      total: money(subtotal + gst),
      paidAmount: 0,
      sample: true,
    };
  });

  for (const [accountId, account] of accounts) settleInvoices(invoices.filter((invoice) => invoice.accountId === accountId), account);
  return invoices;
}

/** Puts fields at the end of a row, keeping a value that is already there. The row's text is then the same whichever order the stages ran in. */
function placeLast(row: Rec, fields: Rec): void {
  for (const [name, value] of Object.entries(fields)) {
    const kept = name in row ? row[name] : value;
    delete row[name];
    row[name] = kept;
  }
}

const provenance = (): CollectionProvenance => ({
  origin: 'mixed',
  source: 'invented over the delivered sample orders; the same stage adds broughtForward and invoicesAsOf to the account_balances rows',
  realFields: ['lines: sku and title'],
  madeUpFields: [
    `every other field (unit prices are the invented tier prices, GST is added at a sample rate, dates and statuses follow the sample rules as of ${SAMPLE_AS_OF})`,
    'account_balances: broughtForward and invoicesAsOf (added to every account row by the same stage)',
  ],
});

export const erpInvoices: SeedStage = {
  name: 'erp-invoices',
  connectorId: 'ace-erp',
  reads: [COMMERCE],
  apply(seed, others) {
    const commerce = others?.get(COMMERCE);
    if (!commerce) throw new Error(`erp-invoices: it reads the '${COMMERCE}' seed, which it was not given`);
    if (!seed.collections.invoices) seed.collections.invoices = buildInvoices(seed, commerce);
    if (!seed.provenance.invoices) seed.provenance.invoices = provenance();
    for (const account of seed.collections.account_balances) {
      const own = seed.collections.invoices.filter((invoice) => invoice.accountId === account.accountId);
      placeLast(account, { broughtForward: broughtForwardFor(own, account), invoicesAsOf: SAMPLE_AS_OF });
    }
  },
};
