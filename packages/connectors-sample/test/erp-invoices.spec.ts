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
import { erpAccountKeys } from '../scripts/seed-stages/erp-account-keys';
import { SAMPLE_AS_OF, SAMPLE_FIRST_INVOICE_NUMBER, SAMPLE_GST_RATE, broughtForwardFor, dueFor, erpInvoices, invoiceLines, settleInvoices } from '../scripts/seed-stages/erp-invoices';
import { readme, seedText } from '../scripts/seed-writing';

/**
 * The sample ERP's invoices and the two invoice tools. Every tool runs in the process (`handle`, never `listen`), and the stage is tested
 * through the stage list and extend-seeds: the full build (build-seeds.ts) reads a data folder outside the repository.
 */
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const TENANT = 'placemakers';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const inCents = (amount: number) => Math.round(amount * 100);
const CONTRACT_SPEC = path.resolve(__dirname, 'contract.spec.ts');
const BUILD_SEEDS = path.resolve(__dirname, '..', 'scripts', 'build-seeds.ts');
const RUNTIME_REGISTRY = path.resolve(__dirname, '..', '..', '..', 'apps', 'journey-runtime-service', 'test', 'fixtures', 'sample-connectors-registry.json');

/** SHA-256 of accountId, balance, overdue and lastPaymentAt of the 30 account rows, one JSON line each, as committed before invoices (the same at HEAD and after the account-key fields). */
const BALANCES_BEFORE = '6048410167927f7897b4cfa2757e9fb8f32054cba5c8273ed0288c20c7738086';
const BALANCE_FIELDS = ['accountId', 'balance', 'overdue', 'lastPaymentAt'];
const project = (row: Rec, fields: string[]): Rec => Object.fromEntries(fields.map((field) => [field, row[field]]));

/** The fields and provenance notes the account-key stage added (erp-account-keys), so a seed can be taken back to before both stages. */
const KEY_FIELDS: Record<string, string[]> = {
  deliveries: ['commercetoolsOrderNumber'],
  account_balances: ['commercetoolsUnitKey', 'salesforceAccountId', 'zendeskOrganizationId'],
};
const INVOICE_ACCOUNT_FIELDS = ['broughtForward', 'invoicesAsOf'];

function withoutInvoices(seed: SeedFile): SeedFile {
  const copy = structuredClone(seed);
  delete copy.collections.invoices;
  delete copy.provenance.invoices;
  for (const row of copy.collections.account_balances) for (const field of INVOICE_ACCOUNT_FIELDS) delete row[field];
  return copy;
}

function beforeBothStages(seed: SeedFile): SeedFile {
  const copy = withoutInvoices(seed);
  for (const [collection, fields] of Object.entries(KEY_FIELDS)) {
    for (const row of copy.collections[collection]) for (const field of fields) delete row[field];
    copy.provenance[collection].madeUpFields = copy.provenance[collection].madeUpFields.filter((entry) => !fields.some((field) => entry.startsWith(field)));
  }
  return copy;
}

/** The seven invoices as the rules work them out from the dates and the money in the seed: a test input, not read from the seed under test. */
interface Expected {
  invoiceId: string; deliveryId: string; orderId: string; accountId: string; terms: string; issuedAt: string; dueAt: string;
  lines: Array<[sku: string, quantity: number, unitPrice: number, lineTotal: number]>;
  subtotal: number; gst: number; total: number; status: string; paidAmount: number;
}
const EXPECTED: Expected[] = [
  // ACC-0016: bronze, "7 days", balance 2716.98, overdue 0.
  // INV-40001: issued 2026-07-10, the date of delivery DEL-30002. Due 2026-07-10 + 7 days = 2026-07-17, before 2026-09-01, and the account owes nothing overdue: paid.
  //   7 x 5585.05 = 39095.35 and 7 x 1005.29 = 7037.03, subtotal 46132.38; GST 46132.38 x 0.15 = 6919.857, so 6919.86; total 53052.24.
  { invoiceId: 'INV-40001', deliveryId: 'DEL-30002', orderId: 'ORD-100042', accountId: 'ACC-0016', terms: '7 days', issuedAt: '2026-07-10', dueAt: '2026-07-17',
    lines: [['5616088', 7, 5585.05, 39095.35], ['3161810', 7, 1005.29, 7037.03]], subtotal: 46132.38, gst: 6919.86, total: 53052.24, status: 'paid', paidAmount: 53052.24 },
  // INV-40002: issued 2026-08-01 (DEL-30010), due 2026-08-01 + 7 days = 2026-08-08: paid.
  //   1 x 77.13 = 77.13 and 7 x 650.75 = 4555.25, subtotal 4632.38; GST 4632.38 x 0.15 = 694.857, so 694.86; total 5327.24.
  { invoiceId: 'INV-40002', deliveryId: 'DEL-30010', orderId: 'ORD-100015', accountId: 'ACC-0016', terms: '7 days', issuedAt: '2026-08-01', dueAt: '2026-08-08',
    lines: [['3030733', 1, 77.13, 77.13], ['2910018', 7, 650.75, 4555.25]], subtotal: 4632.38, gst: 694.86, total: 5327.24, status: 'paid', paidAmount: 5327.24 },
  // ACC-0008: bronze, "7 days", balance 27398.87, overdue 0.
  // INV-40003: issued 2026-08-07 (DEL-30014), due 2026-08-14: paid.
  //   4 x 13.77 = 55.08, 5 x 19.56 = 97.80 and 3 x 968.05 = 2904.15, subtotal 3057.03; GST 3057.03 x 0.15 = 458.5545, so 458.55; total 3515.58.
  { invoiceId: 'INV-40003', deliveryId: 'DEL-30014', orderId: 'ORD-100018', accountId: 'ACC-0008', terms: '7 days', issuedAt: '2026-08-07', dueAt: '2026-08-14',
    lines: [['4080402', 4, 13.77, 55.08], ['4066019', 5, 19.56, 97.8], ['5615805', 3, 968.05, 2904.15]], subtotal: 3057.03, gst: 458.55, total: 3515.58, status: 'paid', paidAmount: 3515.58 },
  // ACC-0028: silver, "7 days", balance 21302.75, overdue 0.
  // INV-40004: issued 2026-08-07 (DEL-30015; the same day as INV-40003, so it comes after it by delivery id), due 2026-08-14: paid.
  //   1 x 16.61 = 16.61, 7 x 243.51 = 1704.57, 29 x 20.60 = 597.40 and 8 x 22.49 = 179.92, subtotal 2498.50; GST 2498.50 x 0.15 = 374.775, a half cent, rounded up to 374.78; total 2873.28.
  { invoiceId: 'INV-40004', deliveryId: 'DEL-30015', orderId: 'ORD-100033', accountId: 'ACC-0028', terms: '7 days', issuedAt: '2026-08-07', dueAt: '2026-08-14',
    lines: [['2804280', 1, 16.61, 16.61], ['1357728', 7, 243.51, 1704.57], ['3433075', 29, 20.6, 597.4], ['4100124', 8, 22.49, 179.92]], subtotal: 2498.5, gst: 374.78, total: 2873.28, status: 'paid', paidAmount: 2873.28 },
  // INV-40005: issued 2026-08-10 (DEL-30019), due 2026-08-17: paid.
  //   19 x 73.25 = 1391.75, subtotal 1391.75; GST 1391.75 x 0.15 = 208.7625, so 208.76; total 1600.51.
  { invoiceId: 'INV-40005', deliveryId: 'DEL-30019', orderId: 'ORD-100007', accountId: 'ACC-0028', terms: '7 days', issuedAt: '2026-08-10', dueAt: '2026-08-17',
    lines: [['2600519', 19, 73.25, 1391.75]], subtotal: 1391.75, gst: 208.76, total: 1600.51, status: 'paid', paidAmount: 1600.51 },
  // ACC-0004: bronze, "20th of the month", balance 5717.27, overdue 0.
  // INV-40006: issued 2026-08-14 (DEL-30020). Due the 20th of the month after August: 2026-09-20, after 2026-09-01, so not yet due. The balance has room (1510.30 <= 5717.27): open.
  //   19 x 22.70 = 431.30 and 36 x 24.50 = 882.00, subtotal 1313.30; GST 1313.30 x 0.15 = 196.995, a half cent, rounded up to 197.00; total 1510.30.
  { invoiceId: 'INV-40006', deliveryId: 'DEL-30020', orderId: 'ORD-100034', accountId: 'ACC-0004', terms: '20th of the month', issuedAt: '2026-08-14', dueAt: '2026-09-20',
    lines: [['3433067', 19, 22.7, 431.3], ['1357686', 36, 24.5, 882]], subtotal: 1313.3, gst: 197, total: 1510.3, status: 'open', paidAmount: 0 },
  // ACC-0015: silver, "20th of the month", balance 21737.55, overdue 0.
  // INV-40007: issued 2026-09-01 (DEL-30027, the as-of day itself). Due the 20th of the month after September: 2026-10-20, so not yet due.
  //   7 x 3711.17 = 25978.19, 12 x 890.10 = 10681.20, 3 x 38.77 = 116.31 and 19 x 16.91 = 321.29, subtotal 37096.99; GST 37096.99 x 0.15 = 5564.5485, so 5564.55; total 42661.54.
  //   The total is more than the whole balance (42661.54 > 21737.55), so the balance rule applies: part paid. It still owes what the balance holds, 21737.55, and 42661.54 - 21737.55 = 20923.99 is paid.
  { invoiceId: 'INV-40007', deliveryId: 'DEL-30027', orderId: 'ORD-100025', accountId: 'ACC-0015', terms: '20th of the month', issuedAt: '2026-09-01', dueAt: '2026-10-20',
    lines: [['3800355', 7, 3711.17, 25978.19], ['3812701', 12, 890.1, 10681.2], ['4031703', 3, 38.77, 116.31], ['3432978', 19, 16.91, 321.29]], subtotal: 37096.99, gst: 5564.55, total: 42661.54, status: 'part_paid', paidAmount: 20923.99 },
];
/** The balance less what the open and part-paid invoices still owe: ACC-0004 5717.27 - 1510.30 = 4206.97; ACC-0015 21737.55 - 21737.55 = 0; the three whose invoices are all paid keep their whole balance. */
const BROUGHT_FORWARD: Record<string, number> = { 'ACC-0004': 4206.97, 'ACC-0008': 27398.87, 'ACC-0015': 0, 'ACC-0016': 2716.98, 'ACC-0028': 21302.75 };

/**
 * What must hold for one account's invoices, in whole cents. Only an account with invoices has a broughtForward.
 * The open and part-paid invoices fit within the balance, the overdue ones within the account's overdue amount, and with broughtForward
 * the balance is reconciled exactly; the overdue invoices sit inside what is brought forward.
 */
function assertLedger(account: Rec, invoices: Rec[], label: string): void {
  if (invoices.length === 0) { assert.equal(account.broughtForward, null, `${label}: no invoices, nothing brought forward`); return; }
  const owing = (status: string) => invoices.filter((invoice) => invoice.status === status).reduce((sum, invoice) => sum + inCents(invoice.total) - inCents(invoice.paidAmount), 0);
  const open = owing('open');
  const part = owing('part_paid');
  const overdue = owing('overdue');
  const broughtForward = inCents(account.broughtForward);
  assert.ok(open + part <= inCents(account.balance), `${label}: open and part-paid invoices fit within the balance`);
  assert.ok(overdue <= inCents(account.overdue), `${label}: overdue invoices fit within the account's overdue amount`);
  assert.ok(broughtForward >= 0, `${label}: broughtForward is not negative`);
  assert.equal(open + part + broughtForward, inCents(account.balance), `${label}: the invoices and broughtForward reconcile with the balance exactly`);
  assert.ok(overdue <= broughtForward, `${label}: overdue invoices sit inside what is brought forward`);
  assert.ok(invoices.filter((invoice) => invoice.status === 'part_paid').length <= 1, `${label}: at most one part-paid invoice`);
  for (const invoice of invoices) {
    const paid = inCents(invoice.paidAmount);
    const total = inCents(invoice.total);
    if (invoice.status === 'paid') assert.equal(paid, total, `${invoice.invoiceId}: paid in full`);
    else if (invoice.status === 'part_paid') assert.ok(paid > 0 && paid < total, `${invoice.invoiceId}: part paid`);
    else assert.equal(paid, 0, `${invoice.invoiceId}: ${invoice.status} has nothing paid`);
  }
}

/**
 * TEST FIXTURE ONLY: an invented mini world for the cases the seed does not have (an overdue account, a part-paid invoice, a due date on
 * the as-of day, terms the stage does not know). None of these values is sample data, and none is a decision. One product, priced by tier.
 */
interface MiniAccount { accountId: string; tier: string; terms: string; balance: number; overdue: number; orders: Array<[issuedAt: string, quantity: number]> }
function miniWorld(accounts: MiniAccount[]): { erp: SeedFile; shop: SeedFile } {
  const balances: Rec[] = [];
  const deliveries: Rec[] = [];
  const orders: Rec[] = [];
  const lines: Rec[] = [];
  let n = 0;
  for (const account of accounts) {
    balances.push({ accountId: account.accountId, name: `Test account ${account.accountId}`, tier: account.tier, creditLimit: 10000, balance: account.balance, overdue: account.overdue, lastPaymentAt: '2026-08-01', terms: account.terms, currency: 'NZD', sample: true });
    for (const [issuedAt, quantity] of account.orders) {
      n++;
      orders.push({ orderId: `TEST-ORD-${n}`, accountId: account.accountId, customerType: 'trade', sample: true });
      lines.push({ lineId: `TEST-OL-${n}`, orderId: `TEST-ORD-${n}`, sku: 'TEST-SKU', title: 'Test product', quantity, sample: true });
      deliveries.push({ deliveryId: `TEST-DEL-${n}`, orderId: `TEST-ORD-${n}`, accountId: account.accountId, status: 'delivered', scheduledDate: issuedAt, commercetoolsOrderNumber: `TEST-ORD-${n}`, sample: true });
    }
  }
  // Neither of these is invoiced: a delivered guest order, and a trade order that is only scheduled.
  deliveries.push({ deliveryId: 'TEST-DEL-GUEST', orderId: 'TEST-ORD-GUEST', accountId: null, status: 'delivered', scheduledDate: '2026-08-01', commercetoolsOrderNumber: 'TEST-ORD-GUEST', sample: true });
  deliveries.push({ deliveryId: 'TEST-DEL-LATER', orderId: 'TEST-ORD-LATER', accountId: accounts[0].accountId, status: 'scheduled', scheduledDate: '2026-09-02', commercetoolsOrderNumber: 'TEST-ORD-LATER', sample: true });
  const priceList = [{ sku: 'TEST-SKU', title: 'Test product', unitOfMeasure: 'EA', currency: 'NZD', retailPrice: 120, bronzePrice: 110, silverPrice: 100, goldPrice: 90, effectiveFrom: '2026-01-01', sample: true }];
  return {
    erp: { connectorId: 'ace-erp', tenantId: TENANT, builtFrom: 'TEST FIXTURE ONLY', collections: { price_list: priceList, deliveries, account_balances: balances }, provenance: {} },
    shop: { connectorId: 'sap-commerce', tenantId: TENANT, builtFrom: 'TEST FIXTURE ONLY', collections: { orders, order_lines: lines }, provenance: {} },
  };
}

async function main() {
  console.log('Sample ERP: invoices and the two invoice tools');
  const connectors = loadConnectors();
  const erp = connectors.get('ace-erp')!;
  const shop = connectors.get('sap-commerce')!;
  const rows = (collection: string): Rec[] => erp.seed.collections[collection];
  const invoices = rows('invoices');
  const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
  const call = async (tool: string, args: Rec, connector = 'ace-erp'): Promise<Rec> => {
    const answer = await server.handle(connector, TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
    return (answer!.result as Rec).structuredContent ?? JSON.parse((answer!.result as Rec).content[0].text);
  };
  const others = () => new Map<string, SeedFile>([['sap-commerce', structuredClone(shop.seed)]]);

  await check('there are seven invoices, one for each delivered order of a trade account, and none for a guest order, a delivery that has not happened or an account without an order', () => {
    assert.equal(invoices.length, 7);
    const delivered = rows('deliveries').filter((delivery) => delivery.status === 'delivered' && delivery.accountId);
    assert.deepEqual(delivered.map((delivery) => delivery.deliveryId).sort(), invoices.map((invoice) => invoice.deliveryId).sort());
    assert.equal(rows('deliveries').filter((delivery) => delivery.status === 'delivered' && !delivery.accountId).length, 4, 'four delivered guest orders have no invoice');
    assert.equal(new Set(invoices.map((invoice) => invoice.deliveryId)).size, 7, 'one invoice for each delivery');
    assert.equal(new Set(invoices.map((invoice) => invoice.orderId)).size, 7, 'one invoice for each order');
    assert.equal(new Set(invoices.map((invoice) => invoice.accountId)).size, 5, 'on five accounts');
  });

  await check('invoice numbers are INV- and five digits, unique, from the first number on, in the order the invoices were issued; a record has the fields the plan lists, in order', () => {
    assert.deepEqual(invoices.map((invoice) => invoice.invoiceId), invoices.map((_, index) => `INV-${SAMPLE_FIRST_INVOICE_NUMBER + index}`));
    for (const invoice of invoices) {
      assert.match(invoice.invoiceId, /^INV-\d{5}$/);
      assert.deepEqual(Object.keys(invoice), ['invoiceId', 'accountId', 'commercetoolsOrderNumber', 'orderId', 'deliveryId', 'issuedAt', 'dueAt', 'dueNote', 'status', 'currency', 'lines', 'subtotal', 'gst', 'total', 'paidAmount', 'sample']);
      assert.deepEqual(Object.keys(invoice.lines[0]), ['sku', 'title', 'quantity', 'unitPrice', 'lineTotal']);
      assert.equal(invoice.sample, true);
      assert.ok(['open', 'part_paid', 'paid', 'overdue'].includes(invoice.status));
    }
    const issued = invoices.map((invoice) => invoice.issuedAt);
    assert.deepEqual(issued, [...issued].sort(), 'issued in date order');
  });

  await check('every invoice points at an order, a delivery and an account that exist and agree with each other', () => {
    const orders = new Map(shop.seed.collections.orders.map((order) => [order.orderId, order]));
    const deliveries = new Map(rows('deliveries').map((delivery) => [delivery.deliveryId, delivery]));
    const accounts = new Map(rows('account_balances').map((account) => [account.accountId, account]));
    for (const invoice of invoices) {
      const order = orders.get(invoice.orderId)!;
      const delivery = deliveries.get(invoice.deliveryId)!;
      const account = accounts.get(invoice.accountId)!;
      assert.ok(order && delivery && account, invoice.invoiceId);
      assert.equal(delivery.status, 'delivered');
      assert.equal(delivery.orderId, invoice.orderId);
      assert.equal(delivery.accountId, invoice.accountId);
      assert.equal(order.accountId, invoice.accountId);
      assert.equal(order.customerType, 'trade');
      assert.equal(invoice.commercetoolsOrderNumber, delivery.commercetoolsOrderNumber, 'the order key is the delivery\'s');
      assert.equal(invoice.issuedAt, delivery.scheduledDate, 'issued on the delivery\'s date');
      assert.equal(invoice.currency, account.currency);
      assert.equal(invoice.dueNote, account.terms);
    }
  });

  await check('lines come from the order\'s lines, priced at the account\'s tier from the price list, and add up: lines, GST and total, to the cent', () => {
    const prices = new Map(rows('price_list').map((row) => [row.sku, row]));
    const tiers = new Map(rows('account_balances').map((account) => [account.accountId, account.tier]));
    for (const invoice of invoices) {
      const ordered = shop.seed.collections.order_lines.filter((line) => line.orderId === invoice.orderId);
      assert.deepEqual(invoice.lines.map((line: Rec) => [line.sku, line.title, line.quantity]), ordered.map((line) => [line.sku, line.title, line.quantity]), `${invoice.invoiceId}: the order's lines, in order`);
      for (const line of invoice.lines) {
        assert.equal(line.unitPrice, prices.get(line.sku)![`${tiers.get(invoice.accountId)}Price`], `${invoice.invoiceId} ${line.sku}: the tier price`);
        assert.equal(inCents(line.lineTotal), line.quantity * inCents(line.unitPrice), `${invoice.invoiceId} ${line.sku}: quantity x unit price`);
      }
      const subtotal = invoice.lines.reduce((sum: number, line: Rec) => sum + inCents(line.lineTotal), 0);
      assert.equal(inCents(invoice.subtotal), subtotal, `${invoice.invoiceId}: the lines add up`);
      assert.equal(inCents(invoice.gst), Math.round((subtotal * Math.round(SAMPLE_GST_RATE * 10000)) / 10000), `${invoice.invoiceId}: GST at the sample rate`);
      assert.equal(inCents(invoice.total), subtotal + inCents(invoice.gst), `${invoice.invoiceId}: total is lines plus GST`);
    }
  });

  await check('the seven-row table, worked out by hand from the rules, equals the seed: dates, lines, GST, totals, status and what is paid', () => {
    assert.equal(SAMPLE_GST_RATE, 0.15, 'the table is worked out at the sample rate; change both together');
    assert.equal(SAMPLE_AS_OF, '2026-09-01');
    // The table checks itself first: each line is quantity x unit price, the lines add up, GST is 15% to the cent (halves up), the total is both.
    for (const row of EXPECTED) {
      for (const [sku, quantity, unitPrice, lineTotal] of row.lines) assert.equal(inCents(lineTotal), quantity * inCents(unitPrice), `${row.invoiceId} ${sku}`);
      const subtotal = row.lines.reduce((sum, line) => sum + inCents(line[3]), 0);
      assert.equal(inCents(row.subtotal), subtotal, `${row.invoiceId} subtotal`);
      assert.equal(inCents(row.gst), Math.floor((subtotal * 15 + 50) / 100), `${row.invoiceId} GST: 15% to the cent, halves up`);
      assert.equal(inCents(row.total), subtotal + inCents(row.gst), `${row.invoiceId} total`);
    }
    assert.equal(invoices.length, EXPECTED.length);
    EXPECTED.forEach((row, index) => {
      const invoice = invoices[index];
      assert.equal(invoice.invoiceId, row.invoiceId);
      assert.deepEqual([invoice.deliveryId, invoice.orderId, invoice.accountId, invoice.issuedAt, invoice.dueAt, invoice.dueNote], [row.deliveryId, row.orderId, row.accountId, row.issuedAt, row.dueAt, row.terms], row.invoiceId);
      assert.deepEqual(invoice.lines.map((line: Rec) => [line.sku, line.quantity, line.unitPrice, line.lineTotal]), row.lines, `${row.invoiceId} lines`);
      assert.deepEqual([invoice.subtotal, invoice.gst, invoice.total, invoice.status, invoice.paidAmount], [row.subtotal, row.gst, row.total, row.status, row.paidAmount], `${row.invoiceId} money and status`);
    });
    assert.deepEqual(Object.fromEntries(rows('account_balances').filter((account) => account.broughtForward !== null).map((account) => [account.accountId, account.broughtForward])), BROUGHT_FORWARD);
    assert.deepEqual(invoices.map((invoice) => invoice.status), ['paid', 'paid', 'paid', 'paid', 'paid', 'open', 'part_paid']);
  });

  await check('per account: open and part-paid invoices fit within the balance, overdue ones within the overdue amount, and with broughtForward they reconcile exactly', () => {
    for (const account of rows('account_balances')) assertLedger(account, invoices.filter((invoice) => invoice.accountId === account.accountId), account.accountId);
    assert.equal(rows('account_balances').filter((account) => typeof account.broughtForward === 'number').length, 5, 'five accounts have invoices');
    assert.equal(rows('account_balances').filter((account) => account.broughtForward === null).length, 25, 'the other 25 have nothing itemised, so nothing brought forward');
    for (const account of rows('account_balances')) assert.equal(account.invoicesAsOf, SAMPLE_AS_OF, `${account.accountId}: the day the invoices are as of`);
  });

  await check('no invoice is dated after the as-of day, and the as-of day is the generator\'s reference day (no real clock is read)', () => {
    for (const invoice of invoices) assert.ok(invoice.issuedAt <= SAMPLE_AS_OF, `${invoice.invoiceId} issued ${invoice.issuedAt}`);
    const build = readFileSync(BUILD_SEEDS, 'utf8');
    const reference = /const REFERENCE_DAY = Date\.UTC\((\d+), (\d+), (\d+)\);/.exec(build)!;
    assert.ok(reference, 'build-seeds.ts names its reference day');
    assert.equal(`${reference[1]}-${String(Number(reference[2]) + 1).padStart(2, '0')}-${String(reference[3]).padStart(2, '0')}`, SAMPLE_AS_OF);
    const stage = readFileSync(path.resolve(__dirname, '..', 'scripts', 'seed-stages', 'erp-invoices.ts'), 'utf8');
    assert.doesNotMatch(stage, /new Date\(\)|Date\.now\(\)/, 'the stage reads no clock');
  });

  await check('the balance, overdue amount and last payment of every account never moved: the same bytes as before invoices', () => {
    const text = rows('account_balances').map((row) => JSON.stringify(project(row, BALANCE_FIELDS))).join('\n');
    assert.equal(sha256(text), BALANCES_BEFORE);
    const before = structuredClone(erp.seed);
    erpInvoices.apply(before, others());
    assert.deepEqual(rows('account_balances').map((row) => project(row, ['accountId', 'creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'tier'])), before.collections.account_balances.map((row) => project(row, ['accountId', 'creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'tier'])));
  });

  await check('the new fields stand last on the account rows, after the old fields and the account keys, and the new collection comes after the ones that were there', () => {
    const oldFields = ['accountId', 'name', 'tier', 'creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'currency', 'sample'];
    for (const row of rows('account_balances')) {
      assert.deepEqual(Object.keys(row), [...oldFields, ...KEY_FIELDS.account_balances, ...INVOICE_ACCOUNT_FIELDS]);
    }
    assert.deepEqual(Object.keys(erp.seed.collections), ['branches', 'stock', 'price_list', 'deliveries', 'account_balances', 'invoices']);
    assert.deepEqual(Object.keys(erp.seed.provenance), ['branches', 'stock', 'price_list', 'deliveries', 'account_balances', 'invoices']);
  });

  await check('the new collection has provenance, a minimum and sample: true, and the README says so', () => {
    const provenance = erp.seed.provenance.invoices;
    assert.equal(provenance.origin, 'mixed');
    assert.match(provenance.source, /invented over the delivered sample orders/);
    assert.deepEqual(provenance.realFields, ['lines: sku and title']);
    assert.match(provenance.madeUpFields[0], /^every other field/);
    assert.match(provenance.madeUpFields[1], /^account_balances: broughtForward and invoicesAsOf/);
    assert.match(provenance.source, /broughtForward and invoicesAsOf/);
    assert.equal(erp.definition.minimums.invoices, 7);
    assert.ok(invoices.length >= erp.definition.minimums.invoices);
    for (const invoice of invoices) assert.equal(invoice.sample, true);
    const text = readFileSync(path.join(DEFAULT_CONNECTORS_DIR, 'ace-erp', 'README.md'), 'utf8');
    assert.match(text, /\| `invoices` \| 7 \| real and made up \| 7\/7 \| lines: sku and title \|/);
    assert.match(text, /invoices 7\./);
    assert.match(text, /- `find_invoices`: /);
    assert.match(text, /- `get_invoice`: /);
    assert.equal(erp.seed.provenance.account_balances.madeUpFields[0], 'every field', 'the account rows were already all made up');
  });

  await check('the stage reads the shop\'s seed and never changes it; the ERP\'s other collections and every other field are not touched', () => {
    const keysOnly = beforeBothStages(erp.seed);
    erpAccountKeys.apply(keysOnly);
    const both = structuredClone(keysOnly);
    const shopSeed = structuredClone(shop.seed);
    erpInvoices.apply(both, new Map([['sap-commerce', shopSeed]]));
    assert.deepEqual(shopSeed, shop.seed, 'the shop seed is as it was');
    for (const collection of Object.keys(keysOnly.collections).filter((name) => name !== 'account_balances')) assert.deepEqual(both.collections[collection], keysOnly.collections[collection], `${collection} is untouched`);
    const fields = Object.keys(keysOnly.collections.account_balances[0]);
    assert.deepEqual(both.collections.account_balances.map((row) => project(row, fields)), keysOnly.collections.account_balances, 'every account field that was there is as it was');
    assert.deepEqual(Object.keys(keysOnly.provenance).map((id) => both.provenance[id]), Object.values(keysOnly.provenance), 'no collection\'s provenance changes');
    assert.deepEqual(Object.keys(both.provenance), [...Object.keys(keysOnly.provenance), 'invoices']);
    assert.deepEqual(Object.keys(both.collections), [...Object.keys(keysOnly.collections), 'invoices']);
  });

  await check('a second run changes nothing, and from the seed before both stages the stages give back the committed bytes, in either order of the account fields', () => {
    const finished = structuredClone(erp.seed);
    erpInvoices.apply(finished, others());
    assert.equal(seedText(finished), seedText(erp.seed), 'applied to the finished seed: no difference, not even in the order of the fields');

    const fresh = new Map<string, SeedFile>([['ace-erp', beforeBothStages(erp.seed)], ['sap-commerce', structuredClone(shop.seed)]]);
    applySeedStages(fresh);
    assert.equal(seedText(fresh.get('ace-erp')!), seedText(erp.seed), 'a build gives the committed seed');
    applySeedStages(fresh);
    assert.equal(seedText(fresh.get('ace-erp')!), seedText(erp.seed), 'and again gives no difference');

    const early = structuredClone(erp.seed);
    for (const row of early.collections.account_balances) {
      const mine = Object.fromEntries(INVOICE_ACCOUNT_FIELDS.map((field) => [field, row[field]]));
      for (const field of INVOICE_ACCOUNT_FIELDS) delete row[field];
      const keys = Object.entries(row).slice(0, 10);
      const rest = Object.entries(row).slice(10);
      for (const field of Object.keys(row)) delete row[field];
      Object.assign(row, Object.fromEntries(keys), mine, Object.fromEntries(rest));
    }
    assert.notEqual(seedText(early), seedText(erp.seed), 'the account fields really are in another order here');
    erpInvoices.apply(early, others());
    assert.equal(seedText(early), seedText(erp.seed), 'the stage puts its fields last, so the text does not depend on which stage ran first');
  });

  await check('a value already on the row is kept: a stored brought-forward amount, and the invoices already there, are not worked out again', () => {
    const seed = structuredClone(erp.seed);
    // TEST FIXTURE ONLY: not a real amount; it stands for a value a later hand edit or backfill would have written.
    seed.collections.account_balances[3].broughtForward = 12345.67;
    seed.collections.invoices[0].status = 'overdue';
    erpInvoices.apply(seed, others());
    assert.equal(seed.collections.account_balances[3].broughtForward, 12345.67);
    assert.equal(seed.collections.invoices[0].status, 'overdue', 'existing invoices are not settled again');
    assert.equal(Object.keys(seed.collections.account_balances[3]).at(-1), 'invoicesAsOf');
  });

  await check('a rule that cannot be met stops the build: a SKU or tier the price list lacks, an order of another account, a missing order, a missing order number, bad quantity, no shop seed', () => {
    const attempt = (change: (erpSeed: SeedFile, shopSeed: SeedFile) => void): void => {
      const erpSeed = withoutInvoices(erp.seed);
      const shopSeed = structuredClone(shop.seed);
      change(erpSeed, shopSeed);
      erpInvoices.apply(erpSeed, new Map([['sap-commerce', shopSeed]]));
    };
    assert.throws(() => attempt((e) => { e.collections.price_list = e.collections.price_list.filter((row) => row.sku !== '2600519'); }), /price list has no row for 2600519 \(order ORD-100007\)/);
    assert.throws(() => attempt((e) => { e.collections.account_balances.find((row) => row.accountId === 'ACC-0004')!.tier = 'platinum'; }), /no platinumPrice/);
    assert.throws(() => attempt((_, s) => { s.collections.orders.find((row) => row.orderId === 'ORD-100034')!.accountId = 'ACC-0001'; }), /ORD-100034 belongs to ACC-0001/);
    assert.throws(() => attempt((_, s) => { s.collections.orders = s.collections.orders.filter((row) => row.orderId !== 'ORD-100034'); }), /ORD-100034, which the sap-commerce seed does not have/);
    assert.throws(() => attempt((_, s) => { s.collections.order_lines = s.collections.order_lines.filter((row) => row.orderId !== 'ORD-100034'); }), /ORD-100034 has no lines/);
    assert.throws(() => attempt((_, s) => { s.collections.order_lines.find((row) => row.orderId === 'ORD-100034')!.quantity = 0; }), /has quantity 0/);
    assert.throws(() => attempt((e) => { delete e.collections.deliveries.find((row) => row.deliveryId === 'DEL-30020')!.commercetoolsOrderNumber; }), /no commercetoolsOrderNumber/);
    assert.throws(() => attempt((e) => { e.collections.account_balances = e.collections.account_balances.filter((row) => row.accountId !== 'ACC-0004'); }), /DEL-30020 is for ACC-0004, which has no balance row/);
    assert.throws(() => erpInvoices.apply(withoutInvoices(erp.seed), new Map()), /reads the 'sap-commerce' seed/);
    assert.throws(() => erpInvoices.apply(withoutInvoices(erp.seed)), /reads the 'sap-commerce' seed/);
    assert.throws(() => applySeedStages(new Map([['ace-erp', withoutInvoices(erp.seed)]])), /reads 'sap-commerce', which has no seed/);
    assert.deepEqual(stageConnectorIds(), ['ace-erp', 'sap-commerce'], 'extend-seeds loads the seed the stage reads');
  });

  await check('due dates: 7 and 30 days from issue, the 20th of the month after, any other text gives no date and stays in dueNote', () => {
    assert.deepEqual(dueFor('2026-07-10', '7 days'), { dueAt: '2026-07-17', dueNote: '7 days' });
    assert.deepEqual(dueFor('2026-08-01', '30 days'), { dueAt: '2026-08-31', dueNote: '30 days' });
    assert.deepEqual(dueFor('2026-02-26', '7 days'), { dueAt: '2026-03-05', dueNote: '7 days' }, 'across the end of a month');
    assert.deepEqual(dueFor('2026-08-14', '20th of the month'), { dueAt: '2026-09-20', dueNote: '20th of the month' });
    assert.deepEqual(dueFor('2026-12-05', '20th of the month'), { dueAt: '2027-01-20', dueNote: '20th of the month' }, 'December goes into the next year');
    assert.deepEqual(dueFor('2026-03-20', '20th of the month'), { dueAt: '2026-04-20', dueNote: '20th of the month' }, 'issued on the 20th: still the month after');
    assert.deepEqual(dueFor('2026-08-01', 'cash on delivery'), { dueAt: null, dueNote: 'cash on delivery' });
    assert.deepEqual(dueFor('2026-08-01', '14 days'), { dueAt: null, dueNote: '14 days' }, 'only the three texts of the sample accounts are understood');
    assert.deepEqual(dueFor('2026-08-01', 'constructor'), { dueAt: null, dueNote: 'constructor' });
    assert.throws(() => dueFor('2026-13-40', '7 days'), /not a date/);
    assert.equal(rows('account_balances').every((row) => ['7 days', '30 days', '20th of the month'].includes(row.terms)), true, 'the 30 sample accounts carry only those');
    assert.deepEqual(invoices.map((invoice) => invoice.dueAt).filter((due) => due === null), []);
  });

  await check('hand-made fixture: an overdue account, a part-paid invoice, a due date on the as-of day and terms nobody knows give the statuses the rules say', () => {
    const accounts: MiniAccount[] = [
      // gold price 90.00. Invoices: 10 x 90 + GST 135.00 = 1035.00; 4 x 90 + 54.00 = 414.00; 1 x 90 + 13.50 = 103.50. All due 7 days on (2026-07-08, -09, -10), before 2026-09-01.
      // The account is overdue by 1200.00: oldest first, 1035.00 fits (165.00 left); 414.00 does not fit, so it is paid; 103.50 fits (61.50 left). Overdue 1138.50 <= 1200.00. Nothing is open, so all 3000.00 is brought forward.
      { accountId: 'T-OVER', tier: 'gold', terms: '7 days', balance: 3000, overdue: 1200, orders: [['2026-07-01', 10], ['2026-07-02', 4], ['2026-07-03', 1]] },
      // silver price 100.00. Invoices: 10 x 100 + 150.00 = 1150.00; 4 x 100 + 60.00 = 460.00; 2 x 100 + 30.00 = 230.00. Due 30 days on (2026-09-19, -24, -29): not yet due.
      // The balance is 1500.00: 1150.00 fits (350.00 left) so open; 460.00 does not fit, so part paid: it owes the 350.00 left and 110.00 is paid; 230.00 comes after, with nothing left: paid. Brought forward 1500.00 - 1150.00 - 350.00 = 0.
      { accountId: 'T-PART', tier: 'silver', terms: '30 days', balance: 1500, overdue: 0, orders: [['2026-08-20', 10], ['2026-08-25', 4], ['2026-08-30', 2]] },
      // bronze price 110.00. Invoices: 3 x 110 + 49.50 = 379.50 (due 2026-08-17, past); 1 x 110 + 16.50 = 126.50 (due 2026-09-01, the as-of day itself, so not before it); 8 x 110 + 132.00 = 1012.00 (due 2026-09-06).
      // Overdue 500.00: 379.50 fits, so overdue (120.50 left). The balance room is 2000.00 - 379.50 = 1620.50: 126.50 is open, then 1012.00 is open. Brought forward 2000.00 - 126.50 - 1012.00 = 861.50, which holds the 379.50.
      { accountId: 'T-MIX', tier: 'bronze', terms: '7 days', balance: 2000, overdue: 500, orders: [['2026-08-10', 3], ['2026-08-25', 1], ['2026-08-30', 8]] },
      // gold 90.00. One invoice 1 x 90 + 13.50 = 103.50 under terms the stage does not know: no due date, so it is not past due; open. Brought forward 800.00 - 103.50 = 696.50.
      { accountId: 'T-TERMS', tier: 'gold', terms: 'cash on delivery', balance: 800, overdue: 0, orders: [['2026-08-01', 1]] },
      // No order at all: no invoice, nothing brought forward.
      { accountId: 'T-NONE', tier: 'gold', terms: '7 days', balance: 500, overdue: 0, orders: [] },
    ];
    const world = miniWorld(accounts);
    const shopBefore = structuredClone(world.shop);
    const balancesBefore = structuredClone(world.erp.collections.account_balances.map((row) => project(row, ['accountId', 'balance', 'overdue', 'lastPaymentAt'])));
    erpInvoices.apply(world.erp, new Map([['sap-commerce', world.shop]]));
    assert.deepEqual(world.shop, shopBefore);
    const made = world.erp.collections.invoices;
    assert.equal(made.length, 3 + 3 + 3 + 1, 'the guest order and the scheduled delivery have no invoice');
    const of = (accountId: string) => made.filter((invoice) => invoice.accountId === accountId).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    const view = (accountId: string) => of(accountId).map((invoice) => [invoice.dueAt, invoice.total, invoice.status, invoice.paidAmount]);
    assert.deepEqual(view('T-OVER'), [['2026-07-08', 1035, 'overdue', 0], ['2026-07-09', 414, 'paid', 414], ['2026-07-10', 103.5, 'overdue', 0]]);
    assert.deepEqual(view('T-PART'), [['2026-09-19', 1150, 'open', 0], ['2026-09-24', 460, 'part_paid', 110], ['2026-09-29', 230, 'paid', 230]]);
    assert.deepEqual(view('T-MIX'), [['2026-08-17', 379.5, 'overdue', 0], ['2026-09-01', 126.5, 'open', 0], ['2026-09-06', 1012, 'open', 0]]);
    assert.deepEqual(view('T-TERMS'), [[null, 103.5, 'open', 0]]);
    assert.equal(of('T-TERMS')[0].dueNote, 'cash on delivery');
    assert.deepEqual(Object.fromEntries(world.erp.collections.account_balances.map((row) => [row.accountId, row.broughtForward])), { 'T-OVER': 3000, 'T-PART': 0, 'T-MIX': 861.5, 'T-TERMS': 696.5, 'T-NONE': null });
    for (const account of world.erp.collections.account_balances) assertLedger(account, of(account.accountId), account.accountId);
    assert.deepEqual(world.erp.collections.account_balances.map((row) => project(row, ['accountId', 'balance', 'overdue', 'lastPaymentAt'])), balancesBefore, 'balance, overdue and last payment did not move');
    assert.ok(made.every((invoice) => invoice.sample === true && invoice.currency === 'NZD'));
    assert.deepEqual(made.map((invoice) => invoice.invoiceId), made.map((_, index) => `INV-${SAMPLE_FIRST_INVOICE_NUMBER + index}`));
    assert.equal(made.length, new Set(made.map((invoice) => invoice.orderId)).size);
    assert.equal(world.erp.provenance.invoices.origin, 'mixed');
  });

  await check('settling: an overdue amount with nothing past due leaves every invoice open; an overdue amount larger than the balance leaves no room for open ones; a balance of nothing makes a not-yet-due invoice paid', () => {
    const invoice = (id: string, dueAt: string | null, total: number): Rec => ({ invoiceId: id, issuedAt: '2026-08-01', dueAt, total, status: 'open', paidAmount: 0 });
    const asOf = '2026-09-01';

    const nothingPastDue = [invoice('A', '2026-09-10', 100), invoice('B', '2026-09-20', 200)];
    settleInvoices(nothingPastDue, { balance: 1000, overdue: 400 }, asOf);
    assert.deepEqual(nothingPastDue.map((i) => i.status), ['open', 'open']);
    assert.equal(broughtForwardFor(nothingPastDue, { balance: 1000, overdue: 400 }), 700);

    const tooMuchOverdue = [invoice('C', '2026-08-01', 300), invoice('D', '2026-09-10', 100)];
    settleInvoices(tooMuchOverdue, { balance: 250, overdue: 300 }, asOf);
    assert.deepEqual(tooMuchOverdue.map((i) => [i.status, i.paidAmount]), [['overdue', 0], ['paid', 100]], 'overdue 300 fits C; the balance 250 is smaller than that, so D has no room');

    const noBalance = [invoice('E', '2026-09-10', 100)];
    settleInvoices(noBalance, { balance: 0, overdue: 0 }, asOf);
    assert.deepEqual(noBalance.map((i) => [i.status, i.paidAmount]), [['paid', 100]]);
    assert.equal(broughtForwardFor(noBalance, { balance: 0, overdue: 0 }), 0);

    const exactFit = [invoice('F', '2026-09-10', 100)];
    settleInvoices(exactFit, { balance: 100, overdue: 0 }, asOf);
    assert.deepEqual(exactFit.map((i) => [i.status, i.paidAmount]), [['open', 0]], 'a total equal to the balance is open, not part paid');
    assert.equal(broughtForwardFor([], { balance: 100, overdue: 0 }), null);
    assert.throws(() => invoiceLines([{ sku: 'X', orderId: 'O', lineId: 'L', quantity: 1 }], 'gold', new Map()), /no row for X/);
    assert.throws(() => invoiceLines([{ sku: 'X', orderId: 'O', lineId: 'L', quantity: 1.5 }], 'gold', new Map([['X', { goldPrice: 1 }]])), /quantity 1.5/);
  });

  await check('extend-seeds: from the seeds before the stages, --check names only the ERP\'s files, --write gives the committed bytes, and --check after --write is empty; the shop\'s files are read and left alone', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'erp-invoices-'));
    try {
      for (const id of stageConnectorIds()) cpSync(path.join(DEFAULT_CONNECTORS_DIR, id), path.join(tmp, id), { recursive: true });
      assert.deepEqual(planExtension(tmp), [], 'the committed seeds already hold what every stage adds');
      assert.equal(run(['--check'], tmp, () => {}), 0);

      const files = { seed: path.join(tmp, 'ace-erp', 'seed.json'), readme: path.join(tmp, 'ace-erp', 'README.md') };
      const shopFiles = ['seed.json', 'README.md', 'connector.json'].map((name) => path.join(tmp, 'sap-commerce', name));
      const shopBytes = shopFiles.map((file) => readFileSync(file, 'utf8'));
      const old = beforeBothStages(erp.seed);
      writeFileSync(files.seed, seedText(old));
      writeFileSync(files.readme, readme(erp.definition, old));

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
      assert.deepEqual(planExtension(tmp), [], '--check after --write is empty');
      assert.equal(run(['--write'], tmp, () => {}), 0);
      assert.equal(readFileSync(files.seed, 'utf8'), seedText(erp.seed), 'a second --write changes nothing');
      assert.deepEqual(shopFiles.map((file) => readFileSync(file, 'utf8')), shopBytes, 'the shop\'s files are as they were');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('find_invoices: one account\'s invoices, newest first, without the lines; a status or an order number narrows them; a limit is honoured; the account id is required', async () => {
    const summary = ['invoiceId', 'accountId', 'commercetoolsOrderNumber', 'orderId', 'deliveryId', 'issuedAt', 'dueAt', 'dueNote', 'status', 'currency', 'subtotal', 'gst', 'total', 'paidAmount', 'sample'];
    const both = await call('find_invoices', { accountId: 'ACC-0028' });
    assert.equal(both.ok, true);
    assert.equal(both.connector, 'ace-erp');
    assert.deepEqual([both.total, both.returned], [2, 2]);
    assert.deepEqual(both.records.map((record: Rec) => record.invoiceId), ['INV-40005', 'INV-40004'], 'newest first');
    for (const record of both.records) assert.deepEqual(Object.keys(record), summary);
    assert.equal(both.records[0].total, 1600.51);

    assert.equal((await call('find_invoices', { accountId: 'acc-0028' })).returned, 2, 'the account id is not case sensitive, like the other ERP tools');
    assert.deepEqual((await call('find_invoices', { accountId: 'ACC-0028', status: 'paid' })).records.map((record: Rec) => record.invoiceId), ['INV-40005', 'INV-40004']);
    assert.equal((await call('find_invoices', { accountId: 'ACC-0028', status: 'open' })).returned, 0);
    assert.deepEqual((await call('find_invoices', { accountId: 'ACC-0015', status: 'part_paid' })).records.map((record: Rec) => [record.invoiceId, record.total, record.paidAmount]), [['INV-40007', 42661.54, 20923.99]]);
    assert.deepEqual((await call('find_invoices', { accountId: 'ACC-0028', orderNumber: 'ORD-100033' })).records.map((record: Rec) => record.invoiceId), ['INV-40004']);
    assert.equal((await call('find_invoices', { accountId: 'ACC-0004', orderNumber: 'ORD-100033' })).returned, 0, 'an order number of another account finds nothing');
    const limited = await call('find_invoices', { accountId: 'ACC-0028', limit: 1 });
    assert.deepEqual([limited.total, limited.returned, limited.records[0].invoiceId], [2, 1, 'INV-40005']);
    assert.equal((await call('find_invoices', { accountId: 'ACC-0001' })).returned, 0, 'an account with no invoices has none');

    const missing = await call('find_invoices', {});
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'invalid_arguments');
    assert.match(missing.error.message, /accountId is required/);
  });

  await check('get_invoice: the whole record with its lines, not found for a number nobody has, and the number is required', async () => {
    const one = await call('get_invoice', { invoiceId: 'INV-40007' });
    assert.equal(one.ok, true);
    assert.deepEqual(one.record, invoices[6], 'the record in the seed, nothing cut');
    assert.equal(one.record.lines.length, 4);
    assert.deepEqual(one.record.lines[0], { sku: '3800355', title: shop.seed.collections.order_lines.find((line) => line.orderId === 'ORD-100025' && line.sku === '3800355')!.title, quantity: 7, unitPrice: 3711.17, lineTotal: 25978.19 });
    assert.equal((await call('get_invoice', { invoiceId: 'inv-40001' })).record.invoiceId, 'INV-40001', 'not case sensitive');
    const none = await call('get_invoice', { invoiceId: 'INV-99999' });
    assert.equal(none.ok, false);
    assert.equal(none.error.code, 'not_found');
    const empty = await call('get_invoice', {});
    assert.equal(empty.error.code, 'invalid_arguments');
    assert.match(empty.error.message, /invoiceId is required/);
  });

  await check('account_balance returns broughtForward and invoicesAsOf with the old fields; find_account keeps its four; the delivery tools are as they were', async () => {
    const itemised = await call('account_balance', { accountId: 'ACC-0004' });
    assert.equal(itemised.record.broughtForward, 4206.97);
    assert.equal(itemised.record.invoicesAsOf, '2026-09-01');
    assert.equal(itemised.record.balance, 5717.27);
    assert.equal(itemised.record.overdue, 0);
    const none = await call('account_balance', { accountId: 'ACC-0001' });
    assert.equal(none.record.broughtForward, null);
    assert.equal(none.record.invoicesAsOf, '2026-09-01');
    const listed = await call('list_account_balances', { limit: 30 });
    assert.equal(listed.returned, 30);
    assert.equal(listed.records.filter((record: Rec) => record.broughtForward !== null).length, 5);
    for (const record of (await call('find_account', { query: 'Hartley' })).records) assert.deepEqual(Object.keys(record), ['accountId', 'name', 'tier', 'terms']);
    assert.equal((await call('delivery_status', { deliveryId: 'DEL-30027' })).record.commercetoolsOrderNumber, 'ORD-100025');
  });

  await check('both tools only read, run on their examples, and their descriptions leave out the word the stock query looks for', async () => {
    const tools = erp.definition.tools;
    assert.deepEqual(tools.slice(-2).map((tool) => tool.name), ['find_invoices', 'get_invoice']);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const tool of tools.slice(-2)) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} only reads`);
      assert.ok(tool.description.length > 20);
      assert.deepEqual(tool.inputSchema.required, [tool.name === 'find_invoices' ? 'accountId' : 'invoiceId']);
      const args = resolveExample(tool.example, new TenantCollections(erp.seed));
      const answer = await call(tool.name, args);
      assert.equal(answer.ok, true, tool.name);
      assert.ok(JSON.stringify(answer).length < 32 * 1024, `${tool.name} fits the size cap`);
      assert.ok(answer.records?.length > 0 || answer.record, `${tool.name} finds something for its own example`);
      assert.deepEqual(await call(tool.name, args), answer, `${tool.name} reads the same twice`);
    }
    // The runtime narrows a connector's tools by a query with this rule (loadTools in apps/journey-runtime-service/src/kernel/connector.runtime.ts).
    const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
    const matching = (query: string) => tools.filter((tool) => tokens(query).every((token) => tokens(`${tool.name} ${tool.description}`).some((word) => word.startsWith(token) || token.startsWith(word)))).map((tool) => tool.name);
    assert.deepEqual(matching('stock'), ['stock_by_branch'], 'a query for stock still finds the stock tool alone');
    assert.deepEqual(matching('invoice'), ['find_invoices', 'get_invoice']);
  });

  await check('the contract spec\'s count: 50 tools in all, every one runs on its example in the process and answers in the shape the contract expects, and the contract spec says 50', async () => {
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
    assert.equal(calls, 50);
    assert.match(readFileSync(CONTRACT_SPEC, 'utf8'), /assert\.equal\(calls, 50\);/);
  });

  await check('the runtime\'s frozen registry lists the two tools, in the order the server offers them, as reads; the pack schema accepts it; its summaries fit', () => {
    const registry = JSON.parse(readFileSync(RUNTIME_REGISTRY, 'utf8'));
    const parsed = ConnectorsSchema.parse(registry);
    const listed = parsed.connectors.find((connector) => connector.connectorId === 'ace-erp')!;
    assert.deepEqual(listed.tools.map((tool) => tool.name), erp.definition.tools.map((tool) => tool.name), 'the same tools in the same order');
    for (const name of ['find_invoices', 'get_invoice']) {
      const tool = listed.tools.find((entry) => entry.name === name)!;
      assert.equal(tool.sideEffect, 'read');
      assert.ok(tool.summary && tool.summary.length > 0);
      assert.equal(tool.claimClasses, undefined, 'no statement class: an invoice figure is not quoted as fact on the strength of the call alone');
    }
    for (const [id, { definition }] of connectors) {
      const entry = parsed.connectors.find((connector) => connector.connectorId === id)!;
      assert.deepEqual(entry.tools.map((tool) => tool.name), definition.tools.map((tool) => tool.name), `${id} is listed as the server offers it`);
    }
    assert.deepEqual(parsed.policy.filter((row) => row.connectorId === 'ace-erp').map((row) => [row.tool, row.state]), [['*', 'allow']], 'staff may read every ERP tool, the new ones too');
  });

  console.log(`sample ERP invoices: ${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
