// Pretend Zendesk, commercetools and Salesforce for a recording: one small server that answers the connector server's JSON-RPC
// (`tools/call`) with fictional data it keeps in memory, so the care desk can read a ticket, look an order up and, when a person approves,
// really change something, without any real system or customer being touched.
//
//   PRETEND_PORT=4040 PRETEND_KEY=<shared key> node scripts/demo/pretend-vendors.cjs
//   CONNECTOR_MCP_SERVERS={"zendesk":"http://127.0.0.1:4040/mcp/zendesk","commercetools":"http://127.0.0.1:4040/mcp/commercetools","salesforce":"http://127.0.0.1:4040/mcp/salesforce"}
//
// Beside the three systems it has a few doors for the person making the recording (all on this machine only):
//   POST /control/new-ticket  { subject, message, name, email, orderNumber? }   a customer writes in (the ticket arrives in the pretend Zendesk)
//   GET  /control/state       everything the pretend systems hold, so a recording can show or check what an approval changed
//   POST /control/reset       back to the starting data
const http = require('http');

const PORT = Number(process.env.PRETEND_PORT) || 4040;
const KEY = process.env.PRETEND_KEY || '';
if (!KEY) { console.error('Set PRETEND_KEY to the shared key the care desk will send.'); process.exit(1); }

const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
let state;
function fresh() {
  const now = Date.now();
  const ago = (min) => iso(new Date(now - min * 60_000));
  return {
    nextTicket: 5001,
    tickets: [],
    orders: {
      'OPP-4821': { orderNumber: 'OPP-4821', state: 'Confirmed', shipmentState: 'Delayed', paymentState: 'Paid', total: 1284.6, currency: 'NZD', createdAt: ago(60 * 24 * 6), shipTo: { city: 'Hamilton' }, lines: [{ name: 'Treated pine fence post 100 x 100 x 2.4 m', sku: 'FP-100-24', quantity: 24 }, { name: 'Treated pine fence rail 100 x 50 x 3.6 m', sku: 'FR-100-36', quantity: 36 }], notes: [] },
      'OPP-4790': { orderNumber: 'OPP-4790', state: 'Confirmed', shipmentState: 'Shipped', paymentState: 'Paid', total: 642.2, currency: 'NZD', createdAt: ago(60 * 24 * 4), shipTo: { city: 'Tauranga' }, lines: [{ name: 'Decking board 140 x 32 x 4.8 m', sku: 'DB-140-48', quantity: 30 }], notes: [] },
      'OPP-4812': { orderNumber: 'OPP-4812', state: 'Confirmed', shipmentState: 'Ready', paymentState: 'Paid', total: 389.0, currency: 'NZD', createdAt: ago(60 * 24 * 2), shipTo: { city: 'Napier' }, lines: [{ name: 'Weatherboard primed 180 x 18 x 3.0 m', sku: 'WB-180-30', quantity: 18 }], notes: [] },
    },
    cases: [],
    tasks: [],
  };
}
state = fresh();

const publicTicket = (t) => ({ ticketId: t.ticketId, subject: t.subject, status: t.status, priority: t.priority, via: t.via, requester: t.requester, created: t.created, updated: t.updated, description: t.description, summary: t.description });
const reply = (payload, isError = false) => ({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
const fail = (code, message) => reply({ ok: false, error: { code, message } }, true);

const tools = {
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
    create_case({ subject, description, priority, ticketId }) {
      const c = { caseNumber: String(1001 + state.cases.length).padStart(8, '0'), subject: String(subject || ''), description: String(description || '').slice(0, 500), priority: String(priority || 'Medium'), status: 'New', ticketId, createdAt: iso() };
      state.cases.push(c);
      return { ok: true, connector: 'salesforce', record: c };
    },
    create_task({ subject, description, ticketId }) {
      const t = { subject: String(subject || ''), description: String(description || ''), status: 'Not started', ticketId, createdAt: iso() };
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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (iso8601) => new Date(iso8601).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });

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
:root{--ink:#12121A;--blue:#4545F5;--lime:#C6FF00;--bg:#FAF8F4;--line:#E4E0D8;--mute:#6B6A66}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "DM Sans",system-ui,sans-serif}
header{padding:28px 56px 8px}h1{font-size:30px;margin:0 0 4px;font-weight:600}header p{margin:0;color:var(--mute)}
main{display:grid;grid-template-columns:1.25fr 1fr;gap:20px;padding:20px 56px 48px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 24px}.card h2{margin:0 0 2px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);font-weight:600}
.card h3{margin:2px 0 10px;font-size:21px;font-weight:600}.chip{display:inline-block;padding:3px 12px;border-radius:999px;font-size:14px;font-weight:600;background:var(--lime);color:var(--ink)}.chip.blue{background:var(--blue);color:#fff}
ul{list-style:none;margin:12px 0 0;padding:0}li{border-top:1px solid var(--line);padding:12px 0}li b{margin-right:10px}li span{color:var(--mute);font-size:14px}li p{margin:4px 0 0;white-space:pre-line}li.note{background:#FFFBE6}
.side{display:grid;gap:20px;align-content:start}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 18px;margin:8px 0 0}dt{color:var(--mute)}dd{margin:0;font-weight:600}
.stamp{font-size:14px;color:var(--mute);margin-top:10px}
</style></head><body>
<header><h1>What changed in the connected systems</h1><p>Ticket ${esc(t.ticketId)}, ${esc(t.requester.name)}</p></header>
<main>
<section class="card"><h2>Ticket desk</h2><h3>#${esc(t.ticketId)} · ${esc(t.subject)}</h3><span class="chip ${t.status === 'pending' ? 'blue' : ''}">${esc(t.status[0].toUpperCase() + t.status.slice(1))}</span><ul>${thread}</ul></section>
<div class="side">
<section class="card"><h2>Order system</h2><h3>${order ? esc(order.orderNumber) : 'No order named'}</h3>${order ? `<dl><dt>Order</dt><dd>${esc(order.state)}</dd><dt>Shipment</dt><dd>${esc(order.shipmentState)}</dd><dt>Payment</dt><dd>${esc(order.paymentState)}</dd><dt>Total</dt><dd>${esc(order.total.toFixed(2))} ${esc(order.currency)}</dd></dl><ul>${order.notes.map((n) => `<li class="note"><span>Internal note · ${esc(clock(n.at))}</span><p>${esc(n.note)}</p></li>`).join('') || '<li><span>No notes yet</span></li>'}</ul>` : ''}</section>
<section class="card"><h2>Customer records</h2><h3>${cases.length ? `Case ${esc(cases[0].caseNumber)}` : 'No case yet'}</h3>${cases.map((c) => `<span class="chip">${esc(c.status)}</span><p>${esc(c.subject)}</p>`).join('')}</section>
</div></main></body></html>`;
}

const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 200_000) req.destroy(); });
  req.on('end', () => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/desk') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(deskPage(url.searchParams.get('ticket'))); }
      if (url.pathname.startsWith('/control/')) {
        if (req.socket.remoteAddress && !/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(req.socket.remoteAddress)) return send(403, { error: 'This machine only.' });
        if (req.method === 'GET' && url.pathname === '/control/state') return send(200, state);
        if (req.method === 'POST' && url.pathname === '/control/reset') { state = fresh(); return send(200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/control/new-ticket') return send(200, { ok: true, ticket: publicTicket(newTicket(JSON.parse(raw || '{}'))) });
        return send(404, { error: 'No such door.' });
      }
      const m = /^\/mcp\/([a-z]+)$/.exec(url.pathname);
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
server.listen(PORT, '127.0.0.1', () => console.log(`Pretend Zendesk, commercetools and Salesforce on http://127.0.0.1:${PORT}`));
