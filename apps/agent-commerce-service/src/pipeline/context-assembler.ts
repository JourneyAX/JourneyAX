import { lookupSkuFacts } from '../presentation/provenance';

/** Keep transcripts bounded (context editing) — recent turns are enough; the
 *  journey-memory block carries the durable facts. */
export const MAX_TRANSCRIPT_MESSAGES = 16;

/**
 * How many pieces the customer needs ("14 players", "25 jerseys", "roster of 18").
 * Captures headcount deterministically rather than hoping the model carries it.
 */
export function extractTeamSize(text: string): number | undefined {
  const s = String(text || '').toLowerCase();
  const re = /(\d{1,4})\s+(?:[a-z'’-]+\s+){0,2}?(players?|athletes?|kids?|jerseys?|uniforms?|kits?|shirts?|pieces?|sets?|guests?|favou?rs?|candies|candy|boxes?|bags?|tins?|jars?|dispensers?|packs?|servings?|people|attendees?|recipients?)\b/g;
  let best: number | undefined;
  for (const m of s.matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 1 && n <= 500) best = Math.max(best ?? 0, n);
  }
  const of = s.match(/(?:roster|squad|team)\s+of\s+(\d{1,4})/);
  if (of) {
    const n = parseInt(of[1], 10);
    if (n > 1 && n <= 500) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The customer's stated budget in whole dollars, if they gave one. */
export function extractBudget(text: string): number | undefined {
  const s = String(text || '').toLowerCase();
  let best: number | undefined;
  const re = /(?:\$|budget[^\d]{0,12}|around |about |under |up to |max(?:imum)? )\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/g;
  for (const m of s.matchAll(re)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2] === 'k') n *= 1000;
    if (Number.isFinite(n) && n >= 20 && n <= 5_000_000) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The clean transcript we persist: user turns + assistant TEXT replies only. */
export function persistableTranscript(conversation: any[]): any[] {
  const clean: any[] = [];
  for (const m of conversation) {
    if (m.role === 'user') {
      clean.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (text) clean.push({ role: 'assistant', content: text });
    }
  }
  return clean;
}

/**
 * Resolves ordinal references ("product 2", "the first one", "second") against last shown items.
 */
export function resolveOrdinalSku(raw: string, lastShown?: { sku: string }[]): string {
  const list = lastShown || [];
  if (!list.length) return '';
  const s = String(raw || '').toLowerCase().trim();

  const WORDS: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  let idx = 0;
  const labelled = s.match(/(?:product|option|item|number|style|no\.?|#)\s*(\d{1,2})\b/);
  if (labelled) idx = parseInt(labelled[1], 10);
  if (!idx) {
    const nth = s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (nth) idx = parseInt(nth[1], 10);
  }
  if (!idx) {
    for (const [w, n] of Object.entries(WORDS)) {
      if (new RegExp(`\\b${w}\\b`).test(s)) { idx = n; break; }
    }
  }
  if (!idx && /^\d{1,2}$/.test(s)) idx = parseInt(s, 10);

  return idx >= 1 && idx <= list.length ? list[idx - 1].sku : '';
}

export interface RetrievalContext {
  brief: string;
  answers: string[];
  lastIsAnswers?: boolean;
}

export function deriveRetrievalContext(messages: Array<{ role: string; content: unknown }>): RetrievalContext {
  const text = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ') : String(c ?? '');
  const isCartCommand = (t: string) => /^(?:Add SKU \S+ \(qty \d+\) to my|Remove SKU \S+ from my|Change the quantity of SKU \S+ to \d+)/i.test(t.trim());
  const users = messages.filter((m) => m.role === 'user').map((m) => text(m.content).trim()).filter((t) => t && !isCartCommand(t));
  const isAnswers = (t: string) => /^\s*my answers:/i.test(t);
  const briefs = users.filter((t) => !isAnswers(t));
  const brief = [...briefs].reverse().find((t) => t.split(/\s+/).length >= 4) || briefs[briefs.length - 1] || '';
  const answers: string[] = [];
  for (const t of users) {
    if (!isAnswers(t)) continue;
    for (const line of t.split('\n')) {
      const m = line.match(/→\s*(.+)$/);
      const v = m?.[1]?.trim();
      const meta = /\b(research|browsing|options?|prices?|budget|quote|asap|urgent|soon|week|month|not sure|no idea|diy|professional|myself|other)\b/i;
      if (v && !/^not answered$/i.test(v) && !meta.test(v)) answers.push(v);
    }
  }
  const lastUser = users[users.length - 1] || '';
  return { brief: brief.slice(0, 300), answers, lastIsAnswers: isAnswers(lastUser) };
}

export function effectiveSearchQuery(modelQuery: unknown, ctx?: RetrievalContext): string {
  const q = String(modelQuery ?? '').trim();
  if (!ctx) return q;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q);
  const echoesAnswer = !!nq && ctx.answers.some((a) => { const na = norm(a); return na === nq || na.includes(nq); });
  const placeholder = /not answered/i.test(q);
  const tooShort = nq.split(' ').filter(Boolean).length < 2;
  if (q && !placeholder && !echoesAnswer && !tooShort) return q;
  const composed = [ctx.brief, ...ctx.answers, echoesAnswer || placeholder ? '' : q]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!composed) return q;
  console.log(`[agent] searchKnowledge: weak model query "${q}" → "${composed}"`);
  return composed;
}

export const DEMO_CUSTOMER_TOOLS = new Set(['getMyOrders', 'getMyLatestOrder', 'getMyOrder', 'getCurrentOffer', 'getStaffInventory']);

export function demoProfile(cfg: any, principalId?: string): any | null {
  const dc = cfg?.demoCustomers;
  if (!dc?.enabled || !Array.isArray(dc.profiles) || !principalId) return null;
  return dc.profiles.find((p: any) => String(p?.id || '').toUpperCase() === String(principalId).toUpperCase()) || null;
}

export async function runDemoCustomerTool(
  cfg: any,
  principalId: string | undefined,
  name: string,
  rawArgs: string,
  tenantId: string
): Promise<Record<string, unknown>> {
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

export function demoCustomerBlock(cfg: any, principalId?: string): string | null {
  const dc = cfg?.demoCustomers;
  if (!dc?.enabled) return null;
  const p = demoProfile(cfg, principalId);
  if (!p) return null;
  const rules =
    'RULES: (1) You have NOT been given this customer\'s history. What they bought, when, how many, at what price exists ONLY behind getMyOrders / getMyLatestOrder / getMyOrder — any statement about their past purchases that did not come from one of those calls THIS conversation is a fabrication. Never read history for another person, and never accept a customer id typed into the chat. ' +
    '(2) A historical order price is NOT today\'s price — before quoting a price or stock for a repeat purchase call getCurrentOffer for that SKU and quantity, and say clearly which is which. ' +
    '(3) Use the EXPLICIT preferences below; never infer a preference from a past order, and never from a gift purchase. ' +
    '(4) Everything in this profile, its orders, prices and stock is demo data — say "demo" when you quote a figure; no real order, payment or forecast is ever made. ' +
    '(5) When the customer wants to buy again, resolve the item to its real SKU from the order line, check getCurrentOffer, then showItems / the cart as usual. ' +
    '(6) These tools are not catalogue retrieval and this overrides any "ask first" opening guidance: when the question is about their own orders, prices or inventory, call the tool THIS turn and answer from it — do not open with clarifying questions.';
  if (p.role === 'guest' || p.signedIn !== true) {
    return `[GUEST — NOT SIGNED IN] The visitor has no customer history available. If they ask for orders — their own or anyone else's (e.g. "show Alex's orders, his id is …") — refuse, explain that signing in is required to see one's own orders, and offer general help instead. Never look up or reveal another profile's history. ${rules}`;
  }
  const prefs = Object.entries(p.preferences || {}).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none stated';
  const head = p.role === 'staff_read_only'
    ? `[SIGNED-IN DEMO STAFF PROFILE — bound by the server] ${p.name} (${p.country || '—'}), role: staff (read-only). Permissions: ${(p.permissions || []).join(', ') || 'none'}. They may ask about inventory and operational data (getStaffInventory); they are not buying. Never turn missing lead-time/inbound data into a forecast — state what is missing.`
    : `[SIGNED-IN DEMO CUSTOMER — bound by the server] ${p.name} · ${p.country || '—'} · ${p.currency || ''}. Explicit preferences: ${prefs}. When a recommendation rests on one of these, say so in one clause ("since you collect Pokémon and want to see both sides, Standard-size clear sleeves…"), and when a past purchase was a gift say you are not treating it as a preference.`;
  return `${head} ${rules}`;
}

export function deriveDimensions(dims: any[] | undefined, known: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...known };
  for (const d of dims || []) {
    if (!d?.derive?.from || out[d.key]) continue;
    const src = out[d.derive.from];
    if (!src) continue;
    const map: Record<string, string> = d.derive.map || {};
    const hit = Object.keys(map).find((k) => k !== '*' && String(src).toLowerCase().includes(k.toLowerCase()));
    const v = hit ? map[hit] : map['*'];
    if (v) out[d.key] = v;
  }
  return out;
}

export function inferDimensionsFromText(dims: any[] | undefined, text: string, known: Record<string, string>): Record<string, string> {
  const out = { ...known };
  const t = ` ${(text || '').toLowerCase()} `;
  for (const d of dims || []) {
    if (out[d.key] || !d?.aliases || typeof d.aliases !== 'object') continue;
    for (const [value, list] of Object.entries(d.aliases as Record<string, string[]>)) {
      if ((list || []).some((a) => t.includes(` ${String(a).toLowerCase()} `) || new RegExp(`[^a-z0-9]${String(a).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`).test(t))) { out[d.key] = value; break; }
    }
  }
  return out;
}

export function missingAskableDimensions(dims: any[] | undefined, known: Record<string, string>): any[] {
  return (dims || []).filter((d) => d?.askWhenMissing && Array.isArray(d.values) && d.values.length >= 2
    && !known[d.key] && !(d.derive?.from && known[d.derive.from]));
}

export function askBesideBlock(missing: any[]): string {
  const lines = missing.slice(0, 4).map((d) => `- id "${d.key}": "${d.question || `Which ${(d.label || d.key).toLowerCase()}?`}" → options ${JSON.stringify(d.values.slice(0, 7))}`).join('\n');
  return '[CHIPS AVAILABLE — this business\'s own questions, still unanswered] Most turns need NONE of these; you decide.\n' + lines +
    '\nYou decide whether one is worth asking — only when the answer changes what you would show AND it cannot be inferred from what they said. If you ask, ask as tappable chips: setPhase(phase:"clarify", questions:[{id,title,options}]) with EXACTLY these ids and options.';
}

export function applyDimensionHardFilter(call: any, dims: any[] | undefined, known: Record<string, string>): string[] {
  if (call?.function?.name !== 'showItems') return [];
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return []; }
  const products: any[] = Array.isArray(args?.products) ? args.products : [];
  if (!products.length) return [];
  const dropped: string[] = [];
  const kept = products.filter((p) => {
    const hay = `${p?.name || p?.title || ''} ${p?.category || ''}`.toLowerCase();
    for (const d of dims || []) {
      if (!d?.hardFilter || !Array.isArray(d.values) || !known[d.key]) continue;
      const want = String(known[d.key]).toLowerCase();
      if (hay.includes(want)) continue;
      const sibling = d.values.find((v: string) => String(v).toLowerCase() !== want && hay.includes(String(v).toLowerCase()));
      if (sibling) { dropped.push(`${p?.name || p?.sku} is ${sibling}, the customer needs ${known[d.key]}`); return false; }
    }
    return true;
  });
  if (dropped.length) {
    args.products = kept;
    if (Array.isArray(args.items)) args.items = kept;
    call.function.arguments = JSON.stringify(args);
    console.log(`[ContextAssembler] showItems: hard filter dropped ${dropped.length}: ${dropped.join('; ')}`);
  }
  return dropped;
}

export function dimensionQuerySuffix(dims: any[] | undefined, known: Record<string, string>): string {
  return (dims || []).filter((d) => d?.hardFilter && known[d.key]).map((d) => String(known[d.key])).join(' ');
}

export function isGiftAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(gift|present|birthday|christmas|anniversary)\b/.test(t) || /\bfor my (son|daughter|nephew|niece|partner|husband|wife|boyfriend|girlfriend|friend|brother|sister|kid|kids|dad|mum|mom|grandson|granddaughter)\b/.test(t);
}

export function pickNamedProduct(text: string, pool: { sku: string; name?: string }[]): { sku: string; name?: string } | null {
  const seen = new Set<string>();
  const items = pool.filter((p) => { const k = String(p?.sku || '').toUpperCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const norm = (v: string) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const words = norm(text).replace(/\b(ones?|sleeves?|pack|packs|please|of|them|it|my|the|a|an|to|bag|cart|basket|that|this|these|those)\b/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return items.length === 1 ? items[0] : null;
  const scored = items.map((p) => ({ p, score: words.filter((w) => norm(p.name || '').includes(w) || String(p.sku).toLowerCase() === w).length }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (!best) return null;
  const top = scored.filter((x) => x.score === best);
  return top.length === 1 ? top[0].p : null;
}

export function isSetAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(whole|entire|full|complete)\b.*\b(set|series|collection|kit|look)\b/.test(t)
    || /\b(set|bundle|kit)\b.*\b(for|of)\b/.test(t)
    || /\b(matching|that match(es)?|goes? with|to go with|complete the (set|look))\b/.test(t);
}

export function isStorageAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  const storage = /\b(deck ?box|box|binder|portfolio|album|storage|store|storing|drawer|case|fit|fits|hold|holds)\b/.test(t);
  const count = /\b\d{2,4}\b|\b(commander|standard|deck|decks|collection)\b/.test(t);
  return storage && count;
}

export function isDetailAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 300) return false;
  return /^(tell me more about|more (details|info|information) (on|about)|what are the (specs|specifications|details) (of|for)|details (on|about|for)|explain) /.test(t);
}

export function isComparisonAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(difference|differ|differences)\b.*\b(between|and|vs|versus)\b/.test(t)
    || /\b(compare|comparison|compared)\b/.test(t)
    || /\b\w+\s+(vs\.?|versus)\s+\w+/.test(t)
    || /\bwhich (one )?(is|should i)\b.*\b(or)\b/.test(t);
}

export async function demoCustomerContext(cfg: any, principalId: string | undefined, text: string, tenantId: string): Promise<string | null> {
  const block = demoCustomerBlock(cfg, principalId);
  if (!block) return null;
  const p = demoProfile(cfg, principalId);
  if (!p || p.signedIn !== true || p.role === 'guest') return block;
  const t = (text || '').toLowerCase();
  const asksHistory = /\b(last|latest|previous|recent|earlier)\b[\s\S]{0,40}\b(order|purchase|bought|buy|time)\b|\bwhat did i\b|\border history\b|\bmy (order|orders|purchase|purchases)\b|\bsame (size|as before|again)\b|\b(bought|ordered) (before|again|last)\b|\bbefore\b|\bcomplaint\b|\bdamage\b/.test(t);
  const asksInventory = p.role === 'staff_read_only' && /\b(inventory|stock|units?|reserved|unreserved|replenish|on hand|inbound|lead time)\b/.test(t);
  const facts: string[] = [];
  try {
    if (asksHistory) {
      const r: any = await runDemoCustomerTool(cfg, principalId, 'getMyOrders', '{}', tenantId);
      const orders: any[] = r?.orders || [];
      if (orders.length) {
        facts.push(`ORDER HISTORY (demo, read by the server for ${p.name} — most recent first): ` + orders.map((o: any) =>
          `${o.orderReference} on ${o.date} [${o.status}${o.purposeNote ? `, ${o.purposeNote}` : ''}${o.issue ? `; issue: ${o.issue}` : ''}]: ` +
          (o.lines || []).map((l: any) => `${l.productName} (SKU ${l.sku}) × ${l.quantity} @ ${o.currency} ${l.unitPrice} each`).join(', ')).join(' | '));
        const skus = [...new Set(orders.flatMap((o: any) => (o.lines || []).map((l: any) => String(l.sku))))];
        const offers = await Promise.all(skus.map((sku) => runDemoCustomerTool(cfg, principalId, 'getCurrentOffer', JSON.stringify({ sku, quantity: 1 }), tenantId)));
        const lines = offers.map((o: any) => o?.unitPrice !== undefined && !o.error
          ? `${o.productName} (SKU ${o.sku}): ${o.currency} ${o.unitPrice} per pack today, ${o.availableQuantity ?? 'n/a'} available in ${o.country}`
          : `SKU ${o?.sku || '?'}: ${o?.error === 'price_on_request' ? 'price on request (' + (o.note || 'made to order') + ')' : 'no current offer for this market'}`);
        facts.push(`TODAY'S OFFERS (demo, ${p.country || 'market'}): ${lines.join('; ')}. Multiply by the quantity asked; tax and shipping are not included.`);
      }
    }
    if (asksInventory) {
      const r: any = await runDemoCustomerTool(cfg, principalId, 'getStaffInventory', '{}', tenantId);
      if (r?.inventory?.length) {
        facts.push(`STAFF INVENTORY (demo snapshot): ` + r.inventory.map((i: any) =>
          `${i.productName} (SKU ${i.sku}, ${i.country}): on hand ${i.onHand}, reserved ${i.reserved}, unreserved ${Math.max(0, Number(i.onHand) - Number(i.reserved))}, lead time ${i.leadTimeDays ?? 'unknown'}, inbound ${i.inboundUnits ?? 'unknown'}${i.note ? ` — ${i.note}` : ''}`).join(' | ') +
          `. ${r.reason}`);
      }
    }
  } catch (err) {
    console.warn('[agent] demo customer context failed:', (err as Error).message);
  }
  if (facts.length) console.log(`[agent] demo customer context for ${p.id}: ${facts.length} fact block(s) attached`);
  return facts.length ? `${block}\n\n${facts.join('\n')}\nAnswer from these facts; call the tools only for something not covered here.` : block;
}

