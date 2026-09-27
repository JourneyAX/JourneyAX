import { resolveSkuByName } from './retrieval';
import { lookupSkuFacts } from '../../presentation/provenance';

export async function buildAuthoritativeQuote(ctx: { quoteService: any; tenantId: string; sessionId: string; args: any; pricing: any }): Promise<any> {
  const args = ctx.args || {};
  return ctx.quoteService.build({
    tenantId: ctx.tenantId,
    sessionId: ctx.sessionId,
    title: args.title,
    items: await resolveQuoteItemSkus(ctx.tenantId, Array.isArray(args.items) ? args.items : []),
    installationSummary: args.installationSummary,
    warrantySummary: args.warrantySummary,
    pricing: ctx.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
  });
}

export async function applyStorefrontCartCommand(ctx: { tenantId: string; sessionId: string; text: string; journeyState: any; projectConfig: any; uiToolCalls: any[]; conversation: any[]; emit?: (event: string, data: any) => void; quoteService: any; fetchPricebookRows: (tenantId: string, skus: string[]) => Promise<any[]>; lookupSkuFacts: (tenantId: string, skus: string[]) => Promise<any[]>; productMatches: (match: any, fact: any) => boolean; pickNamedProduct: (text: string, pool: any[]) => any }): Promise<boolean> {
  const t = (ctx.text || '').trim();
  // Card taps send a sentence a customer could have typed — the product's
  // NAME first, its code in brackets — so the thread reads "Add The Raid
  // Playmat (SKU AT-20514, qty 1) to my bag." not a bare code. The older
  // "Add SKU X (qty 1)" form is still accepted.
  const add = t.match(/^Add SKU (\S+) \(qty (\d+)\) to my (?:bag|quote|cart)\.?$/i)
    || (() => { const m = t.match(/^Add .+? \(SKU (\S+?), qty (\d+)\) to my (?:bag|quote|cart)\.?$/i); return m ? [m[0], m[1], m[2]] : null; })();
  // "Add all" from a products / bundle card:
  //   "Add these to my bag: A (SKU X, qty 1); B (SKU Y, qty 2)."  (or the older "Add SKUs A (qty 1), B (qty 2) to my bag.")
  const addMany = t.match(/^Add SKUs ((?:\S+ \(qty \d+\)(?:, )?)+) to my (?:bag|quote|cart)\.?$/i)
    || (() => { const m = t.match(/^Add these to my (?:bag|quote|cart): (.+)$/i); return m ? [m[0], m[1].replace(/\(SKU (\S+?), qty (\d+)\)/g, '$1 (qty $2)')] : null; })();
  const remove = t.match(/^Remove SKU (\S+) from my (?:bag|quote|cart)\.?$/i);
  const change = t.match(/^Change the quantity of SKU (\S+) to (\d+)\.?$/i);
  if (!add && !addMany && !remove && !change) {
    // Typed, not tapped: "add to bag", "add the non-glare ones", "remove the
    // sleeves", "change the binder to 2". Resolved against the bag and every
    // product shown this session; only an unambiguous match is applied here
    // — anything else goes to the model, which has the bag tool.
    const num: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const typedAdd = t.match(/^(?:please\s+)?(?:add|put)\s+(?:(\d+|one|two|three|four|five)\s+(?:of\s+)?)?(?:the\s+|these\s+|those\s+|it\s+|them\s+|that\s+|this\s+)?(.*?)\s*(?:(?:to|in|into)\s+(?:my\s+|the\s+)?(?:bag|cart|basket))?\s*[.!]?$/i);
    const typedRemove = !typedAdd && t.match(/^(?:please\s+)?(?:remove|delete|take\s+out)\s+(?:the\s+)?(.*?)\s*(?:(?:from|out\s+of)\s+(?:my\s+|the\s+)?(?:bag|cart|basket))?\s*[.!]?$/i);
    const typedQty = !typedAdd && !typedRemove && t.match(/^(?:please\s+)?(?:change|make|set|update)\s+(?:the\s+)?(?:quantity\s+of\s+)?(.*?)\s*(?:quantity\s+)?(?:to|=)\s+(\d+|one|two|three|four|five)\s*[.!]?$/i);
    if (!typedAdd && !typedRemove && !typedQty) return false;
    const bagWordT = ctx.projectConfig?.commerceMode === 'cart' ? 'bag' : 'quote';
    const bag = ctx.journeyState?.quoteId ? await ctx.quoteService.get(ctx.journeyState.quoteId, ctx.tenantId).catch(() => null) : null;
    const bagLines = (bag?.lines || []).map((l: any) => ({ sku: String(l.sku), name: l.name }));
    const shownAll = [...(ctx.journeyState?.lastShown || []), ...((ctx.journeyState?.selections?.products || []).map((p: any) => ({ sku: String(p.sku || ''), name: p.name })))];
    const pool = typedAdd ? [...bagLines, ...shownAll] : bagLines;   // remove / quantity only apply to what is in the bag
    const ref = typedAdd ? typedAdd[2] : typedRemove ? typedRemove[1] : (typedQty as RegExpMatchArray)[1];
    const pick = ctx.pickNamedProduct(ref || '', pool);
    if (!pick) return false;
    const sentence = typedAdd
      ? `Add ${pick.name || pick.sku} (SKU ${pick.sku}, qty ${typedAdd[1] ? (num[typedAdd[1].toLowerCase()] || Number(typedAdd[1]) || 1) : 1}) to my ${bagWordT}.`
      : typedRemove
        ? `Remove SKU ${pick.sku} from my ${bagWordT}.`
        : `Change the quantity of SKU ${pick.sku} to ${num[(typedQty as RegExpMatchArray)[2].toLowerCase()] || Number((typedQty as RegExpMatchArray)[2]) || 1}.`;
    console.log(`[agent] typed cart command "${t}" → ${sentence}`);
    return applyStorefrontCartCommand({ ...ctx, text: sentence });
  }

  const current = ctx.journeyState?.quoteId ? await ctx.quoteService.get(ctx.journeyState.quoteId, ctx.tenantId).catch(() => null) : null;
  const qty = new Map<string, number>();
  for (const l of current?.lines || []) if (l?.sku) qty.set(String(l.sku).toUpperCase(), Math.max(1, Number(l.quantity) || 1));
  const key = (add?.[1] || remove?.[1] || change?.[1] || '').toUpperCase();
  const touched: string[] = [];
  if (add) { qty.set(key, (qty.get(key) || 0) + Math.max(1, Number(add[2]) || 1)); touched.push(key); }
  else if (addMany) {
    for (const m of addMany[1].matchAll(/(\S+) \(qty (\d+)\)/g)) { const k = m[1].toUpperCase(); qty.set(k, (qty.get(k) || 0) + Math.max(1, Number(m[2]) || 1)); touched.push(k); }
  }
  else if (remove) qty.delete(key);
  else if (change) { const n = Number(change[2]) || 0; if (n <= 0) qty.delete(key); else qty.set(key, n); touched.push(key); }

  const isCart = ctx.projectConfig?.commerceMode === 'cart';
  const bagWord = isCart ? 'bag' : 'quote';

  // SOLD OUT never enters the bag — the QuoteService only warns, and a
  // customer paid for a sold-out playmat that way. Checked on the catalogue's
  // own availability for the SKUs this tap touched.
  const soldOut: string[] = [];
  if (touched.length && (add || addMany || change)) {
    const before = new Map<string, number>();
    for (const l of current?.lines || []) if (l?.sku) before.set(String(l.sku).toUpperCase(), Math.max(1, Number(l.quantity) || 1));
    for (const row of await ctx.fetchPricebookRows(ctx.tenantId, touched)) {
      if (row.inStock !== false) continue;
      const k = String(row.sku).toUpperCase();
      soldOut.push(String(row.name || k));
      if (before.has(k)) qty.set(k, before.get(k)!); else qty.delete(k);
    }
    const changed = touched.some((k) => (qty.get(k) ?? 0) !== (before.get(k) ?? 0));
    if (soldOut.length && !changed) {
      ctx.conversation.push({ role: 'system', content: `[${bagWord.toUpperCase()} NOT UPDATED] ${soldOut.join(', ')} ${soldOut.length > 1 ? 'are' : 'is'} SOLD OUT, so nothing was added. Say so plainly by product name, then offer to find an in-stock alternative (searchKnowledge + showItems if they say yes). Do NOT call updateQuote.` });
      return true;
    }
  }

  // Purchase limits (config `purchaseLimits`, e.g. one limited-drop item per
  // person) are enforced HERE, at the bag, not only in prose — matched on
  // the catalogue's own facts for the touched SKUs.
  const capped: string[] = [];
  const limits: any[] = Array.isArray(ctx.projectConfig?.purchaseLimits) ? ctx.projectConfig.purchaseLimits : [];
  if (limits.length && touched.length) {
    const facts = await ctx.lookupSkuFacts(ctx.tenantId, touched);
    for (const f of facts) {
      for (const lim of limits) {
        if (!ctx.productMatches(lim.match, f) || !(lim.maxQuantity > 0)) continue;
        const k = f.sku.toUpperCase();
        if ((qty.get(k) || 0) > lim.maxQuantity) { qty.set(k, lim.maxQuantity); capped.push(`${f.name} (limit ${lim.maxQuantity}${lim.reason ? ` — ${lim.reason}` : ''})`); }
      }
    }
  }
  const items = [...qty.entries()].map(([sku, quantity]) => ({ sku, quantity }));
  if (!items.length) {
    // Nothing left to price. The storefront keeps its last quote card; the
    // model just acknowledges. (An empty quote cannot be emitted — the
    // authoritative-quote contract refuses zero lines.)
    ctx.conversation.push({ role: 'system', content: `[${bagWord.toUpperCase()} UPDATED] The customer removed the last item; their ${bagWord} is now empty. Confirm that in one short sentence and offer to find something else. Do NOT call updateQuote.` });
    return true;
  }
  const quote = await ctx.quoteService.build({
    tenantId: ctx.tenantId, sessionId: ctx.sessionId,
    title: current?.title || (isCart ? 'Your bag' : 'Your quote'),
    items,
    pricing: ctx.projectConfig.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
  });
  if (!quote.lines?.length) {
    console.warn(`[agent] storefront cart command: SKU ${key} not priceable for tenant ${ctx.tenantId} (pricebook returned no line)`);
    ctx.conversation.push({ role: 'system', content: `[${bagWord.toUpperCase()} NOT UPDATED] SKU ${key} could not be priced from the catalogue, so nothing was added. Say so in one sentence and offer to find the right item. Do NOT call updateQuote.` });
    return true;
  }
  ctx.journeyState.quoteId = quote.quoteId;
  const call: any = {
    id: `storefront_cart_${Date.now()}`,
    type: 'function',
    function: { name: 'updateQuote', arguments: JSON.stringify({ items }) },
    __quote: quote,
  };
  ctx.uiToolCalls.push(call);
  if (ctx.emit) ctx.emit('uiAction', { name: 'updateQuote', arguments: quote });
  const lines = quote.lines.map((l: any) => `${l.name} × ${l.quantity}${l.unitPrice !== null ? ` @ ${quote.symbol || ''}${l.unitPrice}` : ''}`).join('; ');
  console.log(`[agent] storefront cart command applied (${add ? 'add' : addMany ? 'add-many' : remove ? 'remove' : 'qty'} ${addMany ? touched.join(',') : key}) → ${quote.lines.length} line(s), total ${quote.total}${capped.length ? ` | capped: ${capped.join('; ')}` : ''}`);
  ctx.conversation.push({ role: 'system', content:
    `[${bagWord.toUpperCase()} UPDATED — already applied by the customer's own tap, server-authoritative] ` +
    `${bagWord} now: ${lines}. Total ${quote.symbol || ''}${quote.total} ${quote.currency || ''}. The updated ${bagWord} card is already on screen. ` +
    (capped.length ? `A purchase limit applied and the quantity was held at the maximum for: ${capped.join('; ')} — say so plainly. ` : '') +
    (soldOut.length ? `${soldOut.join(', ')} ${soldOut.length > 1 ? 'are' : 'is'} SOLD OUT and was NOT added — say so. ` : '') +
    `Reply in ONE short sentence confirming what changed — call the product by its NAME (never by its code), e.g. "Added The Raid Playmat to your bag." — then offer one natural next step. Do NOT call updateQuote, searchKnowledge or showItems this turn, and do not restate the line items.` });
  return true;
}

/**
 * Back from checkout. The storefront sends one silent turn — "Payment
 * received for order <id>." — once the order is confirmed paid, so the
 * conversation continues on the agent's side: a thank-you with the order
 * number, then ONE relevant add-on offer. The order is read from the
 * OrderService (never trusted from the message), lines from its quote.
 */

export const DEMO_CUSTOMER_TOOLS = new Set(['getMyOrders', 'getMyLatestOrder', 'getMyOrder', 'getCurrentOffer', 'getStaffInventory']);

export function demoProfile(cfg: any, principalId?: string): any | null {
  const dc = cfg?.demoCustomers;
  if (!dc?.enabled || !Array.isArray(dc.profiles) || !principalId) return null;
  return dc.profiles.find((p: any) => String(p?.id || '').toUpperCase() === String(principalId).toUpperCase()) || null;
}

export async function applyOrderPlacedContext(ctx: { tenantId: string; text: string; conversation: any[]; journeyState: any; orderService: any; quoteService: any }): Promise<boolean> {
  const m = (ctx.text || '').trim().match(/^Payment received for order (\S+?)\.?$/i);
  if (!m) return false;
  const orderId = m[1];
  const order = await ctx.orderService.get(orderId, ctx.tenantId).catch(() => null);
  if (!order) {
    ctx.conversation.push({ role: 'system', content: `[ORDER] No order ${orderId} exists for this business. Say you could not find that order and offer to help.` });
    return true;
  }
  const quote = order.quoteId ? await ctx.quoteService.get(order.quoteId, ctx.tenantId).catch(() => null) : null;
  const lines = (quote?.lines || []).map((l: any) => `${l.name} × ${l.quantity}`).join('; ');
  const paid = order.status === 'paid';
  if (paid) ctx.journeyState.quoteId = null;
  ctx.conversation.push({ role: 'system', content:
    `[ORDER ${paid ? 'PLACED' : 'PENDING'}] Order ${order.orderId} — status ${order.status}, total ${quote?.symbol || ''}${order.total} ${order.currency || ''}${lines ? `, items: ${lines}` : ''}. The order card is already on screen. ` +
    (paid
      ? `Thank the customer warmly, quote the order number ${order.orderId} once, and say a confirmation email is on its way${order.customer?.email ? ` to ${order.customer.email}` : ''}. Then offer ONE natural add-on that goes with what they bought (a matching sleeve size, a box for that deck, a playmat) — searchKnowledge for it and showItems the real matches if you have a clear complement; otherwise just ask what they play next. Do NOT call updateQuote.`
      : 'Payment has not been confirmed yet — say you are waiting on the payment provider and will confirm shortly. Do not thank them for a completed order.') });
  return true;
}

export async function runDemoCustomerTool(cfg: any, principalId: string | undefined, name: string, rawArgs: string, tenantId: string): Promise<Record<string, unknown>> {
  const dc = cfg?.demoCustomers;
  if (!dc?.enabled) return { error: 'customer_history_not_available', demo: true };
  const profile = demoProfile(cfg, principalId);
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* empty */ }
  const signedIn = !!profile && profile.signedIn === true && profile.role !== 'guest';
  console.log(`[agent] demo customer tool ${name} for ${profile?.id || 'no-principal'} (${signedIn ? 'signed in' : 'not signed in'})`);
  const withNames = async (lines: any[]) => {
    const facts = await lookupSkuFacts(tenantId, lines.map((l) => String(l.sku || '')).filter(Boolean));
    const byCode = new Map(facts.map((f) => [f.sku.toUpperCase(), f]));
    return lines.map((l) => ({ ...l, productName: byCode.get(String(l.sku).toUpperCase())?.name || l.productName || l.sku }));
  };
  const myOrders = async () => {
    const orders = (dc.orders || []).filter((o: any) => String(o.principalId).toUpperCase() === String(profile.id).toUpperCase());
    orders.sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
    return Promise.all(orders.map(async (o: any) => ({
      orderReference: o.orderId, date: o.date, currency: o.currency, status: o.status,
      lines: await withNames(o.lines || []), merchandiseSubtotal: o.subtotal,
      purposeNote: o.purposeNote, issue: o.issue, note: o.note,
    })));
  };
  switch (name) {
    case 'getMyOrders': {
      if (!signedIn) return { error: 'sign_in_required', message: 'Order history is only available to a signed-in customer for their own account.', demo: true };
      const orders = await myOrders();
      return { orders: orders.slice(0, 10), sortOrder: 'date_descending', mostRecentOrderReference: orders[0]?.orderReference || null, customerIdentity: 'server_bound_demo_profile', demo: true };
    }
    case 'getMyLatestOrder': {
      if (!signedIn) return { error: 'sign_in_required', message: 'Order history is only available to a signed-in customer for their own account.', demo: true };
      const orders = await myOrders();
      if (!orders.length) return { error: 'no_order_history', demo: true };
      return { order: orders[0], selection: 'most_recent_by_date', demo: true };
    }
    case 'getMyOrder': {
      if (!signedIn) return { error: 'sign_in_required', message: 'Order history is only available to a signed-in customer for their own account.', demo: true };
      const ref = String(args.orderReference || '').trim();
      const order = (await myOrders()).find((o: any) => String(o.orderReference).toUpperCase() === ref.toUpperCase());
      return order ? { order, demo: true } : { error: 'not_found_or_not_authorized', demo: true };
    }
    case 'getCurrentOffer': {
      const sku = String(args.sku || '').trim().toUpperCase();
      const quantity = Math.max(1, Math.min(1000, Math.floor(Number(args.quantity) || 1)));
      const country = profile?.country ? String(profile.country).toUpperCase() : null;
      if (!sku) return { error: 'invalid_arguments', reason: 'sku is required', demo: true };
      const offers = (dc.offers || []).filter((o: any) => String(o.sku).toUpperCase() === sku);
      const offer = offers.find((o: any) => !country || String(o.country).toUpperCase() === country) || null;
      if (!offer) return { error: 'demo_offer_not_available_for_variant_and_market', sku, country, demo: true, liveConnection: false };
      if (offer.unitPrice === null || offer.unitPrice === undefined) return { error: 'price_on_request', sku, country: offer.country, note: offer.note, demo: true };
      const [fact] = await lookupSkuFacts(tenantId, [sku]);
      return {
        sku, productName: fact?.name || sku, country: offer.country, currency: offer.currency,
        unitPrice: offer.unitPrice, availableQuantity: offer.availableUnits, quantityRequested: quantity,
        subtotal: Number((offer.unitPrice * quantity).toFixed(2)), taxAndShippingIncluded: false,
        demo: true, liveConnection: false, observedAt: new Date().toISOString(),
      };
    }
    case 'getStaffInventory': {
      const staff = signedIn && (profile.role === 'staff_read_only' || (profile.permissions || []).includes('demo_inventory_read'));
      if (!staff) return { error: 'staff_authorization_required', message: 'Inventory is only available to a signed-in staff profile.', demo: true };
      const inventory = await withNames(dc.inventory || []);
      return { inventory, demo: true, forecastReady: false, reason: 'Missing lead times, inbound stock and adequate real demand history — a replenishment commitment cannot be grounded.' };
    }
    default:
      return { error: 'unsupported_tool', demo: true };
  }
}

export async function recommendSize(tenantId: string, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/sizing/recommend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, body: JSON.stringify({ category: args?.category, usualSize: args?.usualSize, waistIn: typeof args?.waistIn === 'number' ? args.waistIn : undefined, chestIn: typeof args?.chestIn === 'number' ? args.chestIn : undefined, division: args?.division }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, message: 'The sizing guide is unavailable right now.' };
    const data: any = await response.json();
    return { ...data, instruction: data.recommendedSize ? `State the size as exactly "${data.recommendedSize}" — do not round up or down, and do not invent a reason (stretch fabric, fit style, etc.) not present in this result.` : 'No real size chart data matched — say plainly you cannot confirm a size for this yet. Do not guess one.' };
  } catch (err) { console.error('[AgentService] recommendSize error:', err); return { ok: false, message: 'Could not look up a size recommendation right now.' }; }
}

/** Compute storage recommendations from the tenant's Back Office storage guide. */
export function recommendStorage(cfg: any, rawArgs: string): Record<string, unknown> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* empty */ }
  const guide: any[] = Array.isArray(cfg?.storageGuide) ? cfg.storageGuide : [];
  if (!guide.length) return { found: false, message: 'This business has no storage capacity guide configured — recommend from retrieved product descriptions and say the capacity comes from the product page.' };
  const cards = Math.max(1, Math.floor(Number(args.cards) || 0));
  if (!cards) return { found: false, message: 'cards is required.' };
  const sleeving = String(args.sleeving || 'single');
  const kind = String(args.kind || 'any');
  const capacityOf = (row: any) => sleeving === 'unsleeved' ? (row.unsleeved ?? row.singleSleeved) : sleeving === 'double' ? row.doubleSleeved : sleeving === 'sealable-double' ? (row.sealableDoubleSleeved ?? row.doubleSleeved) : row.singleSleeved;
  const rows = guide.filter((row) => kind === 'any' || row.kind === kind).map((row) => ({ family: row.family, kind: row.kind, capacity: capacityOf(row), fits: (capacityOf(row) || 0) >= cards, spare: (capacityOf(row) || 0) - cards, note: row.note, searchFor: row.match?.titleContains || row.family })).filter((row) => typeof row.capacity === 'number');
  const fits = rows.filter((row) => row.fits).sort((a, b) => a.spare - b.spare);
  const tooSmall = rows.filter((row) => !row.fits).sort((a, b) => b.capacity - a.capacity);
  return { found: fits.length > 0, cards, sleeving, kind, fits: fits.slice(0, 4), tooSmall: tooSmall.slice(0, 3), note: 'Capacities are the business\'s own per-family facts for the sleeving stated. Present the fitting families with searchKnowledge + showItems (search by family name), and say the capacity number you used.' };
}

export async function resolveQuoteItemSkus(tenantId: string, items: any[]): Promise<any[]> {

  return Promise.all((items || []).map(async (item: any) => {
    const sku = String(item?.sku || '').trim();
    if (!sku || !/\s/.test(sku)) return item;
    const resolved = await resolveSkuByName(tenantId, sku);
    return resolved ? { ...item, sku: resolved, quotedAs: sku } : item;
  }));
}
