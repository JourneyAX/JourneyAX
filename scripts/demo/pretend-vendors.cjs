// Pretend Zendesk, commercetools, Salesforce and SAP ERP for a recording: one small server that answers the connector server's JSON-RPC
// (`tools/call`) with fictional data it keeps in memory, so the care desk can read a ticket, look an order up and, when a person approves,
// really change something, without any real system or customer being touched.
//
//   PRETEND_PORT=4040 PRETEND_KEY=<shared key> node scripts/demo/pretend-vendors.cjs
//   CONNECTOR_MCP_SERVERS={"zendesk":"http://127.0.0.1:4040/mcp/zendesk","commercetools":"http://127.0.0.1:4040/mcp/commercetools","salesforce":"http://127.0.0.1:4040/mcp/salesforce","ace-erp":"http://127.0.0.1:4040/mcp/ace-erp"}
//
// Beside the three systems it has a few doors for the person making the recording (all on this machine only):
//   POST /control/new-ticket  { subject, message, name, email, orderNumber? }   a customer writes in (the ticket arrives in the pretend Zendesk)
//   POST /control/new-exception { branchCode, sku, orderNumber, customerName, needed, note? }   the pretend ERP raises a short order line
//   POST /control/new-invoice-exception { invoiceId, message, contactName, contactEmail }   a customer queries an invoice (the pretend ERP flags it)
//   POST /control/new-quote-request { accountName, contactName, contactEmail, branchCode, lines:[{sku,quantity}], message }   a deal in the pretend Salesforce needs a quote
//   GET  /control/state       everything the pretend systems hold, so a recording can show or check what an approval changed
//   POST /control/reset       back to the starting data
const http = require('http');

const PORT = Number(process.env.PRETEND_PORT) || 4040;
const KEY = process.env.PRETEND_KEY || '';
if (!KEY) { console.error('Set PRETEND_KEY to the shared key the care desk will send.'); process.exit(1); }

const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- The pretend SAP ERP: branches, stock by branch, similar products, exceptions and transfer requests. ----
const BRANCHES = [['HAM', 'Hamilton'], ['CAM', 'Cambridge'], ['TGA', 'Tauranga'], ['ROT', 'Rotorua'], ['WHK', 'Whakatane'], ['NPR', 'Napier']];
// Days for a truck to bring stock to Hamilton from each branch; other destinations use the same table, mirrored from Hamilton's.
const DAYS_TO = { HAM: { HAM: 0, CAM: 1, TGA: 1, ROT: 1, WHK: 2, NPR: 3 } };
const daysBetween = (from, to) => (from === to ? 0 : (DAYS_TO[to] && DAYS_TO[to][from]) ?? (DAYS_TO.HAM[from] != null && DAYS_TO.HAM[to] != null ? Math.max(1, Math.abs(DAYS_TO.HAM[from] - DAYS_TO.HAM[to])) : 2));
const PRODUCTS = {
  'FR-100-36': { name: 'Treated pine fence rail 100 x 50 x 3.6 m', retail: 18.6, stock: { HAM: [60, 0, 20], CAM: [40, 0, 20], TGA: [50, 6, 20], ROT: [70, 0, 25], WHK: [120, 10, 40], NPR: [200, 30, 50] }, similar: { sku: 'FR-100-48', name: 'Treated pine fence rail 100 x 50 x 4.8 m', onHand: { HAM: 30 } } },
  'DP-25-40': { name: 'Decking pedestal 25-40 mm', retail: 9.8, stock: { HAM: [200, 20, 50], CAM: [120, 0, 40], TGA: [150, 10, 40], ROT: [90, 0, 30], WHK: [60, 0, 30], NPR: [300, 40, 60] }, similar: { sku: 'DP-40-65', name: 'Decking pedestal 40-65 mm', onHand: { HAM: 80 } } },
  'FP-100-24': { name: 'Treated pine fence post 100 x 100 x 2.4 m', retail: 27.8, stock: { HAM: [6, 0, 20], CAM: [26, 0, 20], TGA: [30, 12, 15], ROT: [64, 10, 30], WHK: [140, 20, 80], NPR: [300, 40, 60] }, similar: { sku: 'FP-125-24', name: 'Treated pine fence post 125 x 125 x 2.4 m', onHand: { HAM: 40 } } },
  'DB-140-48': { name: 'Decking board 140 x 32 x 4.8 m', retail: 38.4, stock: { HAM: [120, 10, 40], CAM: [60, 0, 30], TGA: [18, 4, 20], ROT: [80, 6, 30], WHK: [90, 0, 40], NPR: [160, 20, 50] }, similar: { sku: 'DB-140-36', name: 'Decking board 140 x 32 x 3.6 m', onHand: { TGA: 44 } } },
  'WB-180-30': { name: 'Weatherboard primed 180 x 18 x 3.0 m', retail: 21.9, stock: { HAM: [90, 10, 30], CAM: [40, 0, 20], TGA: [70, 5, 30], ROT: [50, 0, 25], WHK: [30, 0, 20], NPR: [12, 0, 20] }, similar: { sku: 'WB-180-36', name: 'Weatherboard primed 180 x 18 x 3.6 m', onHand: { NPR: 30 } } },
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const branchName = (code) => (BRANCHES.find((b) => b[0] === code) || [code, code])[1];
function erpFresh() {
  const stock = {};
  for (const [sku, p] of Object.entries(PRODUCTS)) stock[sku] = Object.fromEntries(Object.entries(p.stock).map(([code, [onHand, reserved, safety]]) => [code, { onHand, reserved, safety, incoming: 0 }]));
  const accounts = {
    'ACC-9001': { accountId: 'ACC-9001', name: 'Hartley Construction Ltd', tier: 'silver', creditLimit: 20000, balance: 6000, overdue: 0, terms: '20th of the month', currency: 'NZD' },
    'ACC-9002': { accountId: 'ACC-9002', name: 'Tapsell Roofing Ltd', tier: 'bronze', creditLimit: 15000, balance: 3200, overdue: 0, terms: '20th of the month', currency: 'NZD' },
    'ACC-9003': { accountId: 'ACC-9003', name: 'Pene Fencing Ltd', tier: 'gold', creditLimit: 30000, balance: 6900, overdue: 0, terms: '20th of the month', currency: 'NZD' },
  };
  const earlier = { quoteNumber: 'Q-2188', accountName: 'Hartley Construction Ltd', opportunityId: 'OPP-0871', total: 3912.4, subtotal: 3402.09, status: 'Accepted', createdAt: iso(new Date(Date.now() - 21 * 86_400_000)), lines: [] };
  // Invoices (with the delivery and the order behind each): one billed at retail against the silver price, one billed for more than was delivered, and one billed twice.
  const invoiceLine = (sku, quantity, unitPrice) => ({ sku, name: PRODUCTS[sku].name, quantity, unitPrice, lineTotal: Math.round(quantity * unitPrice * 100) / 100 });
  const invoice = (invoiceId, accountId, orderNumber, deliveryId, daysAgo, lines) => {
    const subtotal = Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100; const gst = Math.round(subtotal * 15) / 100;
    const day = (n) => ymd(new Date(Date.now() + n * 86_400_000));
    return { invoiceId, accountId, accountName: accounts[accountId].name, orderNumber, deliveryId, issuedAt: day(-daysAgo), dueAt: day(30 - daysAgo), status: 'Open', currency: 'NZD', subtotal, gst, total: Math.round((subtotal + gst) * 100) / 100, lines };
  };
  const invoices = {
    'INV-6032': invoice('INV-6032', 'ACC-9001', 'OPP-4851', 'DEL-31001', 7, [invoiceLine('DB-140-48', 80, 38.4), invoiceLine('FR-100-36', 24, 18.6), invoiceLine('DP-25-40', 60, 8.82)]),
    'INV-6040': invoice('INV-6040', 'ACC-9002', 'OPP-4852', 'DEL-31002', 6, [invoiceLine('WB-180-30', 60, 20.8)]),
    'INV-6050': invoice('INV-6050', 'ACC-9003', 'OPP-4853', 'DEL-31003', 9, [invoiceLine('FP-100-24', 40, 23.63), invoiceLine('FR-100-36', 60, 15.81)]),
    'INV-6051': invoice('INV-6051', 'ACC-9003', 'OPP-4853', 'DEL-31003', 8, [invoiceLine('FP-100-24', 40, 23.63), invoiceLine('FR-100-36', 60, 15.81)]),
  };
  const deliveries = {
    'DEL-31001': { deliveryId: 'DEL-31001', orderId: 'OPP-4851', accountId: 'ACC-9001', status: 'Delivered', scheduledDate: ymd(new Date(Date.now() - 8 * 86_400_000)), lines: [{ sku: 'DB-140-48', name: PRODUCTS['DB-140-48'].name, delivered: 80 }, { sku: 'FR-100-36', name: PRODUCTS['FR-100-36'].name, delivered: 24 }, { sku: 'DP-25-40', name: PRODUCTS['DP-25-40'].name, delivered: 60 }] },
    'DEL-31002': { deliveryId: 'DEL-31002', orderId: 'OPP-4852', accountId: 'ACC-9002', status: 'Delivered', scheduledDate: ymd(new Date(Date.now() - 7 * 86_400_000)), lines: [{ sku: 'WB-180-30', name: PRODUCTS['WB-180-30'].name, delivered: 54 }] },
    'DEL-31003': { deliveryId: 'DEL-31003', orderId: 'OPP-4853', accountId: 'ACC-9003', status: 'Delivered', scheduledDate: ymd(new Date(Date.now() - 10 * 86_400_000)), lines: [{ sku: 'FP-100-24', name: PRODUCTS['FP-100-24'].name, delivered: 40 }, { sku: 'FR-100-36', name: PRODUCTS['FR-100-36'].name, delivered: 60 }] },
  };
  const owners = { 'Hartley Construction Ltd': { name: 'Hana Williams', role: 'Sales rep' }, 'Tapsell Roofing Ltd': { name: 'Eru Campbell', role: 'Sales rep' }, 'Pene Fencing Ltd': { name: 'Hana Williams', role: 'Sales rep' } };
  return { stock, exceptions: [], transfers: [], nextException: 7301, nextTransfer: 3001, accounts, quoteRequests: [], quotes: [earlier], emails: [], holds: [], nextRequest: 501, nextOpportunity: 912, nextQuote: 2210, nextHold: 4001, invoices, deliveries, owners, invoiceExceptions: [], creditNotes: [], creditEmails: [], nextInvoiceException: 8101, nextCreditNote: 5001 };
}

let state;
function fresh() {
  const now = Date.now();
  const ago = (min) => iso(new Date(now - min * 60_000));
  const state0 = {
    nextTicket: 5001,
    tickets: [],
    orders: {
      'OPP-4821': { orderNumber: 'OPP-4821', state: 'Confirmed', shipmentState: 'Delayed', paymentState: 'Paid', total: 1284.6, currency: 'NZD', createdAt: ago(60 * 24 * 6), shipTo: { city: 'Hamilton' }, lines: [{ name: 'Treated pine fence post 100 x 100 x 2.4 m', sku: 'FP-100-24', quantity: 24 }, { name: 'Treated pine fence rail 100 x 50 x 3.6 m', sku: 'FR-100-36', quantity: 36 }], notes: [] },
      'OPP-4790': { orderNumber: 'OPP-4790', state: 'Confirmed', shipmentState: 'Shipped', paymentState: 'Paid', total: 642.2, currency: 'NZD', createdAt: ago(60 * 24 * 4), shipTo: { city: 'Tauranga' }, lines: [{ name: 'Decking board 140 x 32 x 4.8 m', sku: 'DB-140-48', quantity: 30 }], notes: [] },
      'OPP-4812': { orderNumber: 'OPP-4812', state: 'Confirmed', shipmentState: 'Ready', paymentState: 'Paid', total: 389.0, currency: 'NZD', createdAt: ago(60 * 24 * 2), shipTo: { city: 'Napier' }, lines: [{ name: 'Weatherboard primed 180 x 18 x 3.0 m', sku: 'WB-180-30', quantity: 18 }], notes: [] },
    },
    cases: [],
    tasks: [],
    ...erpFresh(),
  };
  state0.orders['OPP-4833'] = { orderNumber: 'OPP-4833', state: 'Confirmed', shipmentState: 'Pending', paymentState: 'Paid', total: 2184.0, currency: 'NZD', createdAt: ago(60 * 24 * 3), shipTo: { city: 'Hamilton' }, lines: [{ name: 'Treated pine fence post 100 x 100 x 2.4 m', sku: 'FP-100-24', quantity: 24 }, { name: 'Treated pine fence rail 100 x 50 x 3.6 m', sku: 'FR-100-36', quantity: 36 }], notes: [] };
  const orderLine = (sku, quantity, unitPrice) => ({ name: PRODUCTS[sku].name, sku, quantity, unitPrice });
  state0.orders['OPP-4851'] = { orderNumber: 'OPP-4851', state: 'Confirmed', shipmentState: 'Delivered', paymentState: 'Pending', total: 4250.12, currency: 'NZD', createdAt: ago(60 * 24 * 12), shipTo: { city: 'Hamilton' }, lines: [orderLine('DB-140-48', 80, 34.56), orderLine('FR-100-36', 24, 16.74), orderLine('DP-25-40', 60, 8.82)], notes: [] };
  state0.orders['OPP-4852'] = { orderNumber: 'OPP-4852', state: 'Confirmed', shipmentState: 'Delivered', paymentState: 'Pending', total: 1435.2, currency: 'NZD', createdAt: ago(60 * 24 * 11), shipTo: { city: 'Tauranga' }, lines: [orderLine('WB-180-30', 60, 20.8)], notes: [] };
  state0.orders['OPP-4853'] = { orderNumber: 'OPP-4853', state: 'Confirmed', shipmentState: 'Delivered', paymentState: 'Pending', total: 2177.87, currency: 'NZD', createdAt: ago(60 * 24 * 14), shipTo: { city: 'Napier' }, lines: [orderLine('FP-100-24', 40, 23.63), orderLine('FR-100-36', 60, 15.81)], notes: [] };
  return state0;
}
state = fresh();

const publicTicket = (t) => ({ ticketId: t.ticketId, subject: t.subject, status: t.status, priority: t.priority, via: t.via, requester: t.requester, created: t.created, updated: t.updated, description: t.description, summary: t.description });
const reply = (payload, isError = false) => ({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
const fail = (code, message) => reply({ ok: false, error: { code, message } }, true);

const tools = {
  'ace-erp': {
    list_invoice_exceptions({ since, limit }) {
      const records = state.invoiceExceptions.filter((e) => e.status === 'open' && (!since || e.updated >= since)).slice(-Math.min(Number(limit) || 25, 25));
      return { ok: true, connector: 'ace-erp', returned: records.length, records };
    },
    get_invoice({ invoiceId }) {
      const inv = state.invoices[String(invoiceId)];
      if (!inv) return { ok: false, error: { code: 'not_found', message: `There is no invoice ${invoiceId}.` } };
      return { ok: true, connector: 'ace-erp', record: inv };
    },
    find_invoices({ accountId, limit }) {
      const records = Object.values(state.invoices).filter((i) => !accountId || i.accountId === String(accountId)).slice(0, Math.min(Number(limit) || 10, 25)).map((i) => ({ invoiceId: i.invoiceId, orderNumber: i.orderNumber, total: i.total, issuedAt: i.issuedAt, status: i.status }));
      return { ok: true, connector: 'ace-erp', returned: records.length, records };
    },
    delivery_status({ deliveryId }) {
      const d = state.deliveries[String(deliveryId)];
      if (!d) return { ok: false, error: { code: 'not_found', message: `There is no delivery ${deliveryId}.` } };
      return { ok: true, connector: 'ace-erp', record: d };
    },
    create_credit_note({ invoiceId, exceptionId, reason, overcharge, gst, total, lines }) {
      const inv = state.invoices[String(invoiceId)];
      if (!inv) return { ok: false, error: { code: 'not_found', message: `There is no invoice ${invoiceId}.` } };
      const already = state.creditNotes.filter((c) => c.invoiceId === inv.invoiceId).reduce((sum, c) => sum + c.total, 0);
      if (!(Number(total) > 0)) return { ok: false, error: { code: 'invalid', message: 'A credit note needs an amount.' } };
      if (Number(total) + already > inv.total + 0.005) return { ok: false, error: { code: 'invalid', message: `That is more than invoice ${inv.invoiceId} came to.` } };
      const cn = { creditNumber: `CN-${state.nextCreditNote++}`, invoiceId: inv.invoiceId, accountId: inv.accountId, accountName: inv.accountName, exceptionId, reason: String(reason || ''), overcharge: Number(overcharge), gst: Number(gst), total: Number(total), lines: Array.isArray(lines) ? lines : [], createdAt: iso() };
      state.creditNotes.push(cn);
      const acc = state.accounts[inv.accountId];
      if (acc) acc.balance = Math.round((acc.balance - cn.total) * 100) / 100;
      inv.status = already + cn.total >= inv.total - 0.005 ? 'Credited' : 'Part credited';
      const e = state.invoiceExceptions.find((x) => x.exceptionId === Number(exceptionId));
      if (e) { e.status = 'credited'; e.updated = iso(); }
      return { ok: true, connector: 'ace-erp', record: { creditNumber: cn.creditNumber, invoiceId: inv.invoiceId, total: cn.total, balance: acc ? acc.balance : undefined } };
    },
    send_credit_note_email({ invoiceId, to, subject, body, author }) {
      const cn = state.creditNotes.filter((c) => c.invoiceId === String(invoiceId)).pop();
      if (!cn) return { ok: false, error: { code: 'not_found', message: `There is no credit note on invoice ${invoiceId} to send.` } };
      if (!String(body || '').trim()) return { ok: false, error: { code: 'invalid', message: 'An email needs some words.' } };
      state.creditEmails.push({ at: iso(), to: String(to), subject: String(subject || ''), body: String(body), author: String(author || ''), creditNumber: cn.creditNumber, invoiceId: String(invoiceId) });
      return { ok: true, connector: 'ace-erp', record: { creditNumber: cn.creditNumber, to: String(to), emails: state.creditEmails.length } };
    },

    find_account({ query, limit }) {
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const records = Object.values(state.accounts).filter((a) => words.every((w) => a.name.toLowerCase().includes(w))).slice(0, Math.min(Number(limit) || 5, 10)).map((a) => ({ accountId: a.accountId, name: a.name, tier: a.tier, terms: a.terms }));
      return { ok: true, connector: 'ace-erp', returned: records.length, records };
    },
    account_balance({ accountId }) {
      const a = state.accounts[String(accountId)];
      if (!a) return { ok: false, error: { code: 'not_found', message: `There is no account ${accountId}.` } };
      return { ok: true, connector: 'ace-erp', record: a };
    },
    trade_price({ sku }) {
      const p = PRODUCTS[String(sku)];
      if (!p) return { ok: false, error: { code: 'not_found', message: `There is no product ${sku}.` } };
      const at = (f) => Math.round(p.retail * f * 100) / 100;
      return { ok: true, connector: 'ace-erp', record: { sku: String(sku), title: p.name, unitOfMeasure: 'each', currency: 'NZD', retailPrice: p.retail, bronzePrice: at(0.95), silverPrice: at(0.9), goldPrice: at(0.85) } };
    },
    hold_stock({ branchCode, lines, until, reference, opportunityId }) {
      const list = Array.isArray(lines) ? lines : [];
      if (!list.length) return { ok: false, error: { code: 'invalid', message: 'There is nothing to hold.' } };
      for (const l of list) {
        const row = state.stock[String(l.sku)] && state.stock[String(l.sku)][String(branchCode)];
        if (!row) return { ok: false, error: { code: 'not_found', message: `${l.sku} is not stocked at ${branchName(branchCode)}.` } };
        if (row.onHand - row.reserved < Number(l.quantity)) return { ok: false, error: { code: 'invalid', message: `${branchName(branchCode)} has only ${Math.max(row.onHand - row.reserved, 0)} of ${l.sku} free.` } };
      }
      for (const l of list) state.stock[String(l.sku)][String(branchCode)].reserved += Number(l.quantity);
      const h = { holdNumber: `HOLD-${state.nextHold++}`, branchCode: String(branchCode), lines: list.map((l) => ({ sku: String(l.sku), quantity: Number(l.quantity) })), until: until ? String(until) : undefined, reference: reference ? String(reference) : undefined, opportunityId, createdAt: iso() };
      state.holds.push(h);
      return { ok: true, connector: 'ace-erp', record: h };
    },
    list_stock_exceptions({ since, limit }) {
      const records = state.exceptions.filter((e) => !since || e.updated >= since).slice(-Math.min(Number(limit) || 25, 25));
      return { ok: true, connector: 'ace-erp', returned: records.length, records };
    },
    stock_by_branch({ sku, toBranch, branchCode: only, limit }) {
      const rows = state.stock[String(sku)];
      if (!rows) return { ok: false, error: { code: 'not_found', message: `There is no product ${sku}.` } };
      const records = Object.entries(rows).filter(([code]) => !only || code === String(only)).slice(0, Math.min(Number(limit) || 10, 25)).map(([code, r]) => {
        const days = toBranch ? daysBetween(code, String(toBranch)) : undefined;
        return { branchCode: code, branchName: branchName(code), sku: String(sku), onHand: r.onHand, reserved: r.reserved, safety: r.safety, ...(days != null ? { transferDays: days, arrives: inDays(days) } : {}) };
      });
      return { ok: true, connector: 'ace-erp', returned: records.length, records };
    },
    similar_products({ sku, branchCode }) {
      const p = PRODUCTS[String(sku)];
      if (!p) return { ok: false, error: { code: 'not_found', message: `There is no product ${sku}.` } };
      const onHand = (p.similar.onHand && p.similar.onHand[String(branchCode)]) || 0;
      return { ok: true, connector: 'ace-erp', returned: 1, records: [{ sku: p.similar.sku, name: p.similar.name, onHand, branchCode: String(branchCode) }] };
    },
    request_stock_transfer({ sku, fromBranch, toBranch, quantity, orderNumber, exceptionId, arrives }) {
      const row = state.stock[String(sku)] && state.stock[String(sku)][String(fromBranch)];
      const dest = state.stock[String(sku)] && state.stock[String(sku)][String(toBranch)];
      const qty = Number(quantity);
      if (!row || !dest) return { ok: false, error: { code: 'not_found', message: 'That product or branch is not in the ERP.' } };
      if (!(qty > 0)) return { ok: false, error: { code: 'invalid', message: 'A transfer needs a quantity.' } };
      const spare = row.onHand - row.reserved - row.safety;
      if (qty > spare) return { ok: false, error: { code: 'invalid', message: `${branchName(fromBranch)} has only ${Math.max(spare, 0)} to spare after its safety stock.` } };
      row.reserved += qty; dest.incoming += qty;
      const t = { transferNumber: `TR-${state.nextTransfer++}`, sku: String(sku), productName: PRODUCTS[String(sku)].name, fromBranch: String(fromBranch), toBranch: String(toBranch), quantity: qty, orderNumber: orderNumber ? String(orderNumber) : undefined, exceptionId, arrives: arrives ? String(arrives) : inDays(daysBetween(String(fromBranch), String(toBranch))), status: 'Requested', createdAt: iso() };
      state.transfers.push(t);
      const e = state.exceptions.find((x) => x.exceptionId === Number(exceptionId));
      if (e) { e.status = 'transfer_requested'; e.updated = iso(); }
      return { ok: true, connector: 'ace-erp', record: t };
    },
  },
  zendesk: {
    list_recent_tickets({ since, limit }) {
      // "At or after": a ticket updated in the same second as the last one the desk saw must not be missed (the desk ignores one it already has).
      const records = state.tickets.filter((t) => !since || t.updated >= since).slice(-Math.min(Number(limit) || 25, 25)).map(publicTicket);
      return { ok: true, connector: 'zendesk', returned: records.length, records };
    },
    find_tickets({ requesterEmail, status, limit }) {
      const live = new Set(['new', 'open', 'pending', 'hold']);
      const records = state.tickets
        .filter((t) => (!requesterEmail || t.requester.email.toLowerCase() === String(requesterEmail).toLowerCase()) && (status !== 'unsolved' || live.has(t.status)))
        .slice(0, Math.min(Number(limit) || 10, 25)).map(publicTicket);
      return { ok: true, connector: 'zendesk', returned: records.length, records };
    },
    reply_to_ticket({ ticketId, status, body, author }) {
      const t = state.tickets.find((x) => x.ticketId === Number(ticketId));
      if (!t) return { ok: false, error: { code: 'not_found', message: `There is no ticket ${ticketId}.` } };
      if (!String(body || '').trim()) return { ok: false, error: { code: 'invalid', message: 'A reply needs some words.' } };
      if (!['open', 'pending', 'hold', 'solved'].includes(String(status))) return { ok: false, error: { code: 'invalid', message: `Zendesk has no status ${status}.` } };
      t.comments.push({ from: String(author || 'Care'), kind: 'public reply', at: iso(), said: String(body) });
      t.status = String(status); t.updated = iso();
      return { ok: true, connector: 'zendesk', record: { ticketId: t.ticketId, status: t.status, replies: t.comments.length } };
    },
    update_ticket({ ticketId, assignToLead, note }) {
      const t = state.tickets.find((x) => x.ticketId === Number(ticketId));
      if (!t) return { ok: false, error: { code: 'not_found', message: `There is no ticket ${ticketId}.` } };
      t.comments.push({ from: 'Care desk', kind: 'internal note', at: iso(), said: String(note || '') });
      if (assignToLead) t.assignee = 'Team lead';
      t.updated = iso();
      return { ok: true, connector: 'zendesk', record: { ticketId: t.ticketId, assignee: t.assignee } };
    },
  },
  commercetools: {
    get_order({ orderId }) {
      const o = state.orders[String(orderId).toUpperCase()];
      if (!o) return { ok: false, error: { code: 'not_found', message: `There is no order ${orderId}.` } };
      const { notes, ...record } = o;
      return { ok: true, connector: 'commercetools', record };
    },
    add_order_note({ orderNumber, note }) {
      const o = state.orders[String(orderNumber).toUpperCase()];
      if (!o) return { ok: false, error: { code: 'not_found', message: `There is no order ${orderNumber}.` } };
      o.notes.push({ at: iso(), note: String(note) });
      return { ok: true, connector: 'commercetools', record: { orderNumber: o.orderNumber, notes: o.notes.length } };
    },
    cancel_order({ orderNumber }) {
      const o = state.orders[String(orderNumber).toUpperCase()];
      if (!o) return { ok: false, error: { code: 'not_found', message: `There is no order ${orderNumber}.` } };
      o.state = 'Cancelled';
      return { ok: true, connector: 'commercetools', record: { orderNumber: o.orderNumber, state: o.state } };
    },
  },
  salesforce: {
    find_account_owner({ accountName }) {
      const o = state.owners[String(accountName)];
      if (!o) return { ok: false, error: { code: 'not_found', message: `There is no account ${accountName}.` } };
      return { ok: true, connector: 'salesforce', record: { account: String(accountName), owner: o } };
    },
    list_quote_requests({ since, limit }) {
      const records = state.quoteRequests.filter((r) => r.status === 'open' && (!since || r.updated >= since)).slice(-Math.min(Number(limit) || 25, 25));
      return { ok: true, connector: 'salesforce', returned: records.length, records };
    },
    find_quotes({ accountName, limit }) {
      const records = state.quotes.filter((q) => !accountName || q.accountName.toLowerCase() === String(accountName).toLowerCase()).slice().reverse().slice(0, Math.min(Number(limit) || 5, 10)).map((q) => ({ quoteNumber: q.quoteNumber, total: q.total, status: q.status, createdAt: q.createdAt, opportunityId: q.opportunityId }));
      return { ok: true, connector: 'salesforce', returned: records.length, records };
    },
    create_quote({ opportunityId, requestId, tier, lines, subtotal, gst, total, validUntil }) {
      const req = state.quoteRequests.find((r) => r.opportunityId === String(opportunityId) || r.requestId === Number(requestId));
      if (!req) return { ok: false, error: { code: 'not_found', message: `There is no deal ${opportunityId}.` } };
      if (!Array.isArray(lines) || !lines.length) return { ok: false, error: { code: 'invalid', message: 'A quote needs lines.' } };
      const q = { quoteNumber: `Q-${state.nextQuote++}`, accountName: req.accountName, opportunityId: req.opportunityId, requestId: req.requestId, tier: String(tier), lines, subtotal: Number(subtotal), gst: Number(gst), total: Number(total), validUntil: validUntil ? String(validUntil) : undefined, status: 'Sent', createdAt: iso() };
      state.quotes.push(q);
      req.status = 'quoted'; req.stage = 'Proposal sent'; req.updated = iso();
      return { ok: true, connector: 'salesforce', record: { quoteNumber: q.quoteNumber, total: q.total, status: q.status, dealStage: req.stage } };
    },
    send_quote_email({ opportunityId, to, subject, body, author }) {
      const q = state.quotes.filter((x) => x.opportunityId === String(opportunityId)).pop();
      if (!q) return { ok: false, error: { code: 'not_found', message: `There is no quote on deal ${opportunityId} to send.` } };
      if (!String(body || '').trim()) return { ok: false, error: { code: 'invalid', message: 'An email needs some words.' } };
      state.emails.push({ at: iso(), to: String(to), subject: String(subject || ''), body: String(body), author: String(author || ''), quoteNumber: q.quoteNumber, opportunityId: String(opportunityId) });
      return { ok: true, connector: 'salesforce', record: { quoteNumber: q.quoteNumber, to: String(to), emails: state.emails.length } };
    },

    create_case({ subject, description, priority, ticketId }) {
      const c = { caseNumber: String(1001 + state.cases.length).padStart(8, '0'), subject: String(subject || ''), description: String(description || '').slice(0, 500), priority: String(priority || 'Medium'), status: 'New', ticketId, createdAt: iso() };
      state.cases.push(c);
      return { ok: true, connector: 'salesforce', record: c };
    },
    create_task({ subject, description, ticketId, exceptionId }) {
      const t = { subject: String(subject || ''), description: String(description || ''), status: 'Not started', ticketId, exceptionId, createdAt: iso() };
      state.tasks.push(t);
      return { ok: true, connector: 'salesforce', record: t };
    },
  },
};

function newTicket({ subject, message, name, email, orderNumber, via = 'email', priority = 'normal' }) {
  const id = state.nextTicket++;
  const t = {
    ticketId: id, subject: String(subject), status: 'new', priority, via, requester: { name: String(name), email: String(email) },
    created: iso(), updated: iso(), assignee: null, description: String(message),
    comments: [{ from: String(name), kind: 'public reply', at: iso(), said: String(message) }],
  };
  state.tickets.push(t);
  return t;
}


function newException({ branchCode, sku, orderNumber, customerName, customerAccount = 'Trade account', needed, note, hoursToDispatch = 3.5, neededInDays = 2 }) {
  const row = state.stock[String(sku)] && state.stock[String(sku)][String(branchCode)];
  if (!row) throw new Error('That product or branch is not in the pretend ERP.');
  const id = state.nextException++;
  const e = {
    exceptionId: id, raised: iso(), updated: iso(), status: 'open', branchCode: String(branchCode), branchName: branchName(branchCode), sku: String(sku), productName: PRODUCTS[String(sku)].name,
    orderNumber: orderNumber ? String(orderNumber) : undefined, customerName: String(customerName), customerAccount, needed: Number(needed), onHand: row.onHand,
    dispatchBy: iso(new Date(Date.now() + hoursToDispatch * 3_600_000)), neededBy: inDays(neededInDays), note: note ? String(note) : undefined,
  };
  state.exceptions.push(e);
  const order = e.orderNumber && state.orders[e.orderNumber.toUpperCase()];
  if (order) order.promised = new Date(e.neededBy + 'T12:00:00').toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  return e;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (iso8601) => new Date(iso8601).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });

const PAGE_STYLE = `:root{--ink:#12121A;--blue:#4545F5;--lime:#C6FF00;--bg:#FAF8F4;--line:#E4E0D8;--mute:#6B6A66}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "DM Sans",system-ui,sans-serif}
header{padding:28px 56px 8px}h1{font-size:30px;margin:0 0 4px;font-weight:600}header p{margin:0;color:var(--mute)}
main{display:grid;grid-template-columns:1.25fr 1fr;gap:20px;padding:20px 56px 48px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 24px}.card h2{margin:0 0 2px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);font-weight:600}
.card h3{margin:2px 0 10px;font-size:21px;font-weight:600}.chip{display:inline-block;padding:3px 12px;border-radius:999px;font-size:14px;font-weight:600;background:var(--lime);color:var(--ink)}.chip.blue{background:var(--blue);color:#fff}
ul{list-style:none;margin:12px 0 0;padding:0}li{border-top:1px solid var(--line);padding:12px 0}li b{margin-right:10px}li span{color:var(--mute);font-size:14px}li p{margin:4px 0 0;white-space:pre-line}li.note{background:#FFFBE6}
.side{display:grid;gap:20px;align-content:start}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 18px;margin:8px 0 0}dt{color:var(--mute)}dd{margin:0;font-weight:600}
.stamp{font-size:14px;color:var(--mute);margin-top:10px}
`;

/** A plain page that shows what the three pretend systems hold for one ticket, so a recording can show what an approval changed. No vendor look, no vendor name beyond the system's own. */
function deskPage(ticketId) {
  const t = state.tickets.find((x) => x.ticketId === Number(ticketId)) || state.tickets[state.tickets.length - 1];
  if (!t) return '<!doctype html><title>Connected systems</title><p>No tickets yet.</p>';
  const refs = (t.description.match(/\bOPP-\d{4}\b/g) || []).map((r) => r.toUpperCase());
  const order = state.orders[refs[0]];
  const cases = state.cases.filter((c) => c.ticketId === t.ticketId);
  const thread = t.comments.map((c) => `<li class="${c.kind === 'internal note' ? 'note' : ''}"><b>${esc(c.from)}</b><span>${esc(c.kind)} · ${esc(clock(c.at))}</span><p>${esc(c.said)}</p></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected systems</title>
<style>
${PAGE_STYLE}</style></head><body>
<header><h1>What changed in the connected systems</h1><p>Ticket ${esc(t.ticketId)}, ${esc(t.requester.name)}</p></header>
<main>
<section class="card"><h2>Ticket desk</h2><h3>#${esc(t.ticketId)} · ${esc(t.subject)}</h3><span class="chip ${t.status === 'pending' ? 'blue' : ''}">${esc(t.status[0].toUpperCase() + t.status.slice(1))}</span><ul>${thread}</ul></section>
<div class="side">
<section class="card"><h2>Order system</h2><h3>${order ? esc(order.orderNumber) : 'No order named'}</h3>${order ? `<dl><dt>Order</dt><dd>${esc(order.state)}</dd><dt>Shipment</dt><dd>${esc(order.shipmentState)}</dd><dt>Payment</dt><dd>${esc(order.paymentState)}</dd><dt>Total</dt><dd>${esc(order.total.toFixed(2))} ${esc(order.currency)}</dd></dl><ul>${order.notes.map((n) => `<li class="note"><span>Internal note · ${esc(clock(n.at))}</span><p>${esc(n.note)}</p></li>`).join('') || '<li><span>No notes yet</span></li>'}</ul>` : ''}</section>
<section class="card"><h2>Customer records</h2><h3>${cases.length ? `Case ${esc(cases[0].caseNumber)}` : 'No case yet'}</h3>${cases.map((c) => `<span class="chip">${esc(c.status)}</span><p>${esc(c.subject)}</p>`).join('')}</section>
</div></main></body></html>`;
}


/** The same kind of page for a stock exception: the ERP's transfer request and stock figures, the order's note, and the follow-up task. */
function exceptionPage(exceptionId) {
  const e = state.exceptions.find((x) => x.exceptionId === Number(exceptionId)) || state.exceptions[state.exceptions.length - 1];
  if (!e) return '<!doctype html><title>Connected systems</title><p>No exceptions yet.</p>';
  const transfers = state.transfers.filter((t) => t.exceptionId === e.exceptionId);
  const order = e.orderNumber && state.orders[e.orderNumber.toUpperCase()];
  const tasks = state.tasks.filter((t) => t.exceptionId === e.exceptionId);
  const day = (iso8601) => (iso8601 ? new Date(`${iso8601}T12:00:00`).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '') : '');
  const rows = state.stock[e.sku] || {};
  const stockRows = Object.entries(rows).filter(([code]) => code === e.branchCode || transfers.some((t) => t.fromBranch === code)).map(([code, r]) => `<li><b>${esc(branchName(code))}</b><span>${esc(r.onHand)} on hand · ${esc(r.reserved)} promised${r.incoming ? ` · ${esc(r.incoming)} arriving` : ''}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected systems</title>
<style>
${PAGE_STYLE}</style></head><body>
<header><h1>What changed in the connected systems</h1><p>Stock exception ${esc(e.exceptionId)}, ${esc(e.branchName)}</p></header>
<main>
<section class="card"><h2>SAP ERP</h2><h3>${esc(e.productName)}</h3><span class="chip ${transfers.length ? 'blue' : ''}">${transfers.length ? 'Transfer requested' : 'Exception open'}</span>
<ul>${transfers.map((t) => `<li class="note"><b>${esc(t.transferNumber)}</b><span>${esc(branchName(t.fromBranch))} to ${esc(branchName(t.toBranch))} · ${esc(clock(t.createdAt))}</span><p>${esc(t.quantity)} × ${esc(t.productName)}, arriving ${esc(day(t.arrives))}.${t.orderNumber ? ` For order ${esc(t.orderNumber)}.` : ''}</p></li>`).join('') || '<li><span>No transfer requested yet</span></li>'}${stockRows}</ul></section>
<div class="side">
<section class="card"><h2>Order system</h2><h3>${order ? esc(order.orderNumber) : 'No order named'}</h3>${order ? `<dl><dt>Order</dt><dd>${esc(order.state)}</dd><dt>Shipment</dt><dd>${esc(order.shipmentState)}</dd><dt>Payment</dt><dd>${esc(order.paymentState)}</dd><dt>Total</dt><dd>${esc(order.total.toFixed(2))} ${esc(order.currency)}</dd></dl><ul>${order.notes.map((n) => `<li class="note"><span>Internal note · ${esc(clock(n.at))}</span><p>${esc(n.note)}</p></li>`).join('') || '<li><span>No notes yet</span></li>'}</ul>` : ''}</section>
<section class="card"><h2>Customer records</h2><h3>${tasks.length ? 'Task for the team' : 'No task yet'}</h3>${tasks.map((t) => `<span class="chip">${esc(t.status)}</span><p>${esc(t.subject)}</p>`).join('')}</section>
</div></main></body></html>`;
}

function newQuoteRequest({ accountName, contactName, contactEmail, branchCode, lines, message, neededInDays = 8, hoursToRespond = 3.5 }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('A quote request needs lines.');
  const id = state.nextRequest++;
  const r = {
    requestId: id, opportunityId: `OPP-0${state.nextOpportunity++}`, raised: iso(), updated: iso(), status: 'open', stage: 'Propose', accountName: String(accountName), contactName: String(contactName || ''), contactEmail: String(contactEmail || ''),
    branchCode: String(branchCode), branchName: branchName(branchCode), neededBy: inDays(neededInDays), message: message ? String(message) : undefined,
    lines: lines.map((l) => ({ sku: String(l.sku), name: PRODUCTS[String(l.sku)] ? PRODUCTS[String(l.sku)].name : String(l.sku), quantity: Number(l.quantity) })), respondBy: iso(new Date(Date.now() + hoursToRespond * 3_600_000)),
  };
  state.quoteRequests.push(r);
  return r;
}

/** The same kind of page for a quote: the quote and the email in Salesforce, and the stock the ERP now holds. */
function quotePage(requestId) {
  const r = state.quoteRequests.find((x) => x.requestId === Number(requestId)) || state.quoteRequests[state.quoteRequests.length - 1];
  if (!r) return '<!doctype html><title>Connected systems</title><p>No quote requests yet.</p>';
  const q = state.quotes.filter((x) => x.opportunityId === r.opportunityId).pop();
  const mails = state.emails.filter((m) => m.opportunityId === r.opportunityId);
  const hold = state.holds.filter((h) => h.opportunityId === r.opportunityId).pop();
  const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '') : '');
  const nz = (n) => `$${Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = q ? q.lines.map((l) => `<li><b>${esc(l.quantity)} × ${esc(l.name)}</b><span>${esc(nz(l.unitPrice))} each</span><p>${esc(nz(l.lineTotal))}</p></li>`).join('') : '';
  const held = hold ? hold.lines.map((l) => `<li><b>${esc(l.quantity)} × ${esc((PRODUCTS[l.sku] || {}).name || l.sku)}</b><span>${esc(branchName(hold.branchCode))}</span></li>`).join('') : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected systems</title>
<style>
${PAGE_STYLE}</style></head><body>
<header><h1>What changed in the connected systems</h1><p>Quote request ${esc(r.requestId)}, ${esc(r.accountName)}</p></header>
<main>
<section class="card"><h2>Salesforce</h2><h3>${q ? `Quote ${esc(q.quoteNumber)} · ${esc(r.accountName)}` : `Deal ${esc(r.opportunityId)}`}</h3><span class="chip ${q ? 'blue' : ''}">${q ? 'Quote sent' : 'No quote yet'}</span>
<ul>${lines}${q ? `<li class="note"><b>Total with GST ${esc(nz(q.total))}</b><span>${esc(nz(q.subtotal))} before GST · ${esc(q.tier[0].toUpperCase() + q.tier.slice(1))} trade prices${q.validUntil ? ` · valid to ${esc(day(q.validUntil))}` : ''}</span></li>` : ''}
${mails.map((m) => `<li><b>Email to ${esc(m.to)}</b><span>${esc(m.author)} · ${esc(clock(m.at))}</span><p>${esc(m.body)}</p></li>`).join('')}</ul></section>
<div class="side">
<section class="card"><h2>Deal</h2><h3>${esc(r.opportunityId)}</h3><dl><dt>Customer</dt><dd>${esc(r.accountName)}</dd><dt>Stage</dt><dd>${esc(r.stage)}</dd><dt>Needed by</dt><dd>${esc(day(r.neededBy))}</dd></dl></section>
<section class="card"><h2>SAP ERP</h2><h3>${hold ? esc(hold.holdNumber) : 'No stock held yet'}</h3>${hold ? `<span class="chip">Held${hold.until ? ` until ${esc(day(hold.until))}` : ''}</span><ul>${held}</ul>` : ''}</section>
</div></main></body></html>`;
}

function newInvoiceException({ invoiceId, message, contactName, contactEmail, hoursToRespond = 3.5 }) {
  const inv = state.invoices[String(invoiceId)];
  if (!inv) throw new Error('That invoice is not in the pretend ERP.');
  const id = state.nextInvoiceException++;
  const e = { exceptionId: id, invoiceId: inv.invoiceId, raised: iso(), updated: iso(), status: 'open', accountName: inv.accountName, contactName: contactName ? String(contactName) : undefined, contactEmail: contactEmail ? String(contactEmail) : undefined, message: message ? String(message) : undefined, respondBy: iso(new Date(Date.now() + hoursToRespond * 3_600_000)) };
  state.invoiceExceptions.push(e);
  return e;
}

/** The same kind of page for an invoice exception: the credit note and the email in the ERP, the account's balance, and the task for the account owner. */
function invoicePage(exceptionId) {
  const e = state.invoiceExceptions.find((x) => x.exceptionId === Number(exceptionId)) || state.invoiceExceptions[state.invoiceExceptions.length - 1];
  if (!e) return '<!doctype html><title>Connected systems</title><p>No invoice exceptions yet.</p>';
  const inv = state.invoices[e.invoiceId];
  const cns = state.creditNotes.filter((c) => c.invoiceId === e.invoiceId);
  const mails = state.creditEmails.filter((m) => m.invoiceId === e.invoiceId);
  const tasks = state.tasks.filter((t) => t.exceptionId === e.exceptionId);
  const acc = inv && state.accounts[inv.accountId];
  const nz = (n) => `$${Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cnHtml = cns.map((c) => `<li class="note"><b>${esc(c.creditNumber)} · ${esc(nz(c.total))} with GST</b><span>${esc(c.reason)} · ${esc(clock(c.createdAt))}</span><p>${esc(nz(c.overcharge))} over-charged plus ${esc(nz(c.gst))} GST, against invoice ${esc(c.invoiceId)}.</p></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected systems</title>
<style>
${PAGE_STYLE}</style></head><body>
<header><h1>What changed in the connected systems</h1><p>Invoice exception ${esc(e.exceptionId)}, ${esc(e.accountName)}</p></header>
<main>
<section class="card"><h2>SAP ERP</h2><h3>Invoice ${esc(e.invoiceId)}${inv ? ` · ${esc(nz(inv.total))}` : ''}</h3><span class="chip ${cns.length ? 'blue' : ''}">${esc(inv ? inv.status : 'Unknown')}</span>
<ul>${cnHtml || '<li><span>No credit note yet</span></li>'}${mails.map((m) => `<li><b>Email to ${esc(m.to)}</b><span>${esc(m.author)} · ${esc(m.creditNumber)} · ${esc(clock(m.at))}</span><p>${esc(m.body)}</p></li>`).join('')}</ul></section>
<div class="side">
<section class="card"><h2>Account</h2><h3>${esc(e.accountName)}</h3>${acc ? `<dl><dt>Trade tier</dt><dd>${esc(acc.tier[0].toUpperCase() + acc.tier.slice(1))}</dd><dt>Balance</dt><dd>${esc(nz(acc.balance))}</dd><dt>Credit limit</dt><dd>${esc(nz(acc.creditLimit))}</dd></dl>` : ''}</section>
<section class="card"><h2>Salesforce</h2><h3>${tasks.length ? 'Task for the account owner' : 'No task yet'}</h3>${tasks.map((t) => `<span class="chip">${esc(t.status)}</span><p>${esc(t.subject)}</p>`).join('')}</section>
</div></main></body></html>`;
}

const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 200_000) req.destroy(); });
  req.on('end', () => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/desk' && url.searchParams.get('invoice')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(invoicePage(url.searchParams.get('invoice'))); }
      if (req.method === 'GET' && url.pathname === '/desk' && url.searchParams.get('quote')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(quotePage(url.searchParams.get('quote'))); }
      if (req.method === 'GET' && url.pathname === '/desk' && url.searchParams.get('exception')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(exceptionPage(url.searchParams.get('exception'))); }
      if (req.method === 'GET' && url.pathname === '/desk') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(deskPage(url.searchParams.get('ticket'))); }
      if (url.pathname.startsWith('/control/')) {
        if (req.socket.remoteAddress && !/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress)) return send(403, { error: 'This machine only.' });
        if (req.method === 'GET' && url.pathname === '/control/state') return send(200, state);
        if (req.method === 'POST' && url.pathname === '/control/reset') { state = fresh(); return send(200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/control/new-invoice-exception') return send(200, { ok: true, exception: newInvoiceException(JSON.parse(raw || '{}')) });
        if (req.method === 'POST' && url.pathname === '/control/new-quote-request') return send(200, { ok: true, request: newQuoteRequest(JSON.parse(raw || '{}')) });
        if (req.method === 'POST' && url.pathname === '/control/new-exception') return send(200, { ok: true, exception: newException(JSON.parse(raw || '{}')) });
        if (req.method === 'POST' && url.pathname === '/control/new-ticket') return send(200, { ok: true, ticket: publicTicket(newTicket(JSON.parse(raw || '{}'))) });
        return send(404, { error: 'No such door.' });
      }
      const m = /^\/mcp\/([a-z-]+)$/.exec(url.pathname);
      if (!m || req.method !== 'POST') return send(404, { error: 'Not found.' });
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Unauthorized.' });
      const rpc = JSON.parse(raw || '{}');
      if (rpc.method !== 'tools/call') return send(200, { jsonrpc: '2.0', id: rpc.id ?? 1, error: { code: -32601, message: 'Only tools/call is answered here.' } });
      const fn = (tools[m[1]] || {})[rpc.params?.name];
      if (!fn) return send(200, fail('unknown_tool', `${m[1]} has no tool ${rpc.params?.name}.`));
      const payload = fn(rpc.params.arguments || {});
      return send(200, reply(payload, payload.ok === false));
    } catch (error) {
      return send(200, fail('failed', String(error && error.message || error).slice(0, 160)));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Pretend Zendesk, commercetools, Salesforce and SAP ERP on http://127.0.0.1:${PORT}`));
