/**
 * The rules of the quotes desk that are not the model's to decide: who is on the team, what kinds of quote request exist, which price a line gets,
 * what the totals are, when the sales manager has to decide, and the checks on the quote. The AI reads the request and writes the words; this file
 * prices the quote in code, from the prices and the customer's tier the ERP gave.
 *
 * It is the third desk on the care desk's machinery: the same stages, the same approval, the same write-back. Only the words, the sources and the
 * three changes it may propose are its own.
 */
import { dateKeys } from '../care.checks';
import type { CareTeam } from '../care.playbook';
import type { CareStep, QuoteDetail } from '../care.types';

/** The staff groups that work the quotes desk: the project's "Sales" team as the gateway signs it, and the sales managers, who decide what a rep may not. */
export const QUOTES_GROUPS = ['sales'];
export const QUOTES_LEAD_GROUPS = ['sales-managers'];

export const QUOTE_TOPICS = ['New quote', 'Repeat order', 'Large job', 'Price check'] as const;
export const QUOTE_URGENCY = ['Routine', 'Soon', 'Urgent'] as const;
export type QuoteTopic = (typeof QUOTE_TOPICS)[number];

export const DEFAULT_QUOTES_TEAM: CareTeam = {
  reps: [
    { name: 'Hana Williams', id: 'SLS-2101', email: 'sales@placemakers.demo', skills: ['New quote', 'Repeat order', 'Price check'] },
    { name: 'Eru Campbell', id: 'SLS-2102', skills: ['Large job', 'Repeat order'] },
  ],
  lead: { name: 'Rob Taylor', id: 'SM-2001' },
};

export function quotesTeamFromEnv(env: Record<string, string | undefined> = process.env): CareTeam {
  try {
    const parsed = JSON.parse(env.QUOTES_TEAM || 'null');
    if (parsed && Array.isArray(parsed.reps) && parsed.reps.length && parsed.lead?.id) return parsed as CareTeam;
  } catch { /* an unreadable setting means the default team */ }
  return DEFAULT_QUOTES_TEAM;
}

/** New Zealand's goods and services tax. */
export const GST_RATE = 0.15;
/** A quote over this (before GST) is the sales manager's to decide. */
export const DEFAULT_MANAGER_LIMIT = 25_000;
/** How long the prices and the stock hold. */
export const VALID_DAYS = 14;

export type Tier = 'bronze' | 'silver' | 'gold';
export const asTier = (v: unknown): Tier | null => (['bronze', 'silver', 'gold'].includes(String(v).toLowerCase()) ? (String(v).toLowerCase() as Tier) : null);
export const tierWord = (t: Tier): string => t[0].toUpperCase() + t.slice(1);

/** One price list row, as the ERP gives it. */
export interface PriceRow { sku: string; title?: string; unitOfMeasure?: string; currency?: string; retailPrice: number; bronzePrice?: number; silverPrice?: number; goldPrice?: number }

/** A line the customer asked for. */
export interface AskedLine { sku: string; name: string; quantity: number }

/** Money in the currency the ERP declared ("NZD" reads "$4,250.12" in New Zealand); with no declared currency, a plain number and no symbol. */
export const moneyIn = (currency?: string) => (n: number): string => (currency
  ? new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(n)
  : n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cents = (n: number): number => Math.round(n * 100) / 100;

/** The price of a line at a tier, or null when the ERP gave no price for that tier (the quote then does not go out priced by guesswork). */
export function tierPrice(row: PriceRow, tier: Tier): number | null {
  const v = tier === 'bronze' ? row.bronzePrice : tier === 'silver' ? row.silverPrice : row.goldPrice;
  return typeof v === 'number' && v > 0 ? v : null;
}

export interface PricedLine { sku: string; name: string; quantity: number; unit: string; retailPrice: number; unitPrice: number; lineTotal: number; stock: string; enough: boolean | null }

/**
 * The quote's lines and totals, from the asked-for lines, the price list and the customer's tier. A line with no price in the ERP is left out of the
 * quote and named in `unpriced`, so nothing is quoted at a made-up price. `stock` says what the delivering branch holds for each line.
 */
export function priceQuote(asked: AskedLine[], prices: Record<string, PriceRow | undefined>, tier: Tier, stock: Record<string, { onHand: number; reserved: number } | undefined>, branch: string): { lines: PricedLine[]; unpriced: AskedLine[]; subtotal: number; gst: number; total: number; discountPercent: number; currency?: string } {
  const lines: PricedLine[] = []; const unpriced: AskedLine[] = [];
  for (const a of asked) {
    const row = prices[a.sku]; const unitPrice = row ? tierPrice(row, tier) : null;
    if (!row || unitPrice == null || !(a.quantity > 0)) { unpriced.push(a); continue; }
    const s = stock[a.sku]; const available = s ? s.onHand - s.reserved : null;
    lines.push({
      sku: a.sku, name: a.name || row.title || a.sku, quantity: a.quantity, unit: row.unitOfMeasure || 'each', retailPrice: row.retailPrice, unitPrice, lineTotal: cents(unitPrice * a.quantity),
      stock: available == null ? `Not checked at ${branch}` : available >= a.quantity ? `${available} in stock at ${branch}` : `Only ${Math.max(available, 0)} at ${branch}`, enough: available == null ? null : available >= a.quantity,
    });
  }
  const subtotal = cents(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const retail = lines.reduce((sum, l) => sum + l.retailPrice * l.quantity, 0);
  const gst = cents(subtotal * GST_RATE);
  return { lines, unpriced, subtotal, gst, total: cents(subtotal + gst), discountPercent: retail > 0 ? Math.round((1 - subtotal / retail) * 1000) / 10 : 0, currency: lines.length ? prices[lines[0].sku]?.currency : undefined };
}

/** True when the quote is not the rep's to decide, and why. */
export function needsManager(c: { subtotal: number; limit: number; overdue: number; creditHold: boolean; unpriced: number; lowConfidence: boolean; currency?: string }): string | null {
  const money = moneyIn(c.currency);
  if (c.creditHold) return 'the account is on credit hold';
  if (c.overdue > 0) return `the account has ${money(c.overdue)} overdue`;
  if (c.subtotal > c.limit) return `the quote is over ${money(c.limit)}`;
  if (c.unpriced > 0) return `${c.unpriced} line${c.unpriced === 1 ? ' has' : 's have'} no price in the ERP`;
  if (c.lowConfidence) return 'the AI is not sure what is being asked';
  return null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Friday 14 November" for a day written YYYY-MM-DD, or '' when it is not one. */
export function dayWords(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** The day `n` days after a day written YYYY-MM-DD, in the same form. */
export function addDays(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface QuoteContext {
  requestId: number;
  opportunityId: string;
  customerName: string;
  contactName: string;
  contactEmail: string;
  branch: { code: string; name: string };
  tier: Tier;
  quote: Pick<QuoteDetail, 'lines' | 'subtotal' | 'gst' | 'total' | 'discountPercent' | 'currency'>;
  validUntil: string;
}

/**
 * The changes a quote request may propose. Fixed here, never written by the model, so what can happen is always one of a few known actions. Each
 * step names the tool the write-back will run. The email is the draft the person approves, word for word.
 */
export function quoteStepsFor(c: QuoteContext): CareStep[] {
  const money = moneyIn(c.quote.currency);
  const until = dayWords(c.validUntil);
  const inStock = c.quote.lines.filter((l) => l.stock && !/^Only |^Not checked/.test(l.stock));
  const steps: CareStep[] = [
    {
      id: 's1', system: 'Salesforce', kind: 'record', what: `Create the quote for ${c.customerName} on deal ${c.opportunityId}`,
      before: 'Deal stage: Propose', after: `Quote ${money(c.quote.total)} with GST${until ? `, valid to ${until}` : ''}`,
      action: { tool: 'create_quote', args: { opportunityId: c.opportunityId, requestId: c.requestId, tier: c.tier, lines: c.quote.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, lineTotal: l.lineTotal })), subtotal: c.quote.subtotal, gst: c.quote.gst, total: c.quote.total, validUntil: c.validUntil } },
    },
    {
      id: 's2', system: 'Salesforce', kind: 'customer', what: `Email the quote to ${c.contactName || c.customerName}`,
      after: `${money(c.quote.total)} with GST`,
      action: { tool: 'send_quote_email', args: { opportunityId: c.opportunityId, to: c.contactEmail, subject: `Your quote from ${c.branch.name}` } },
    },
  ];
  if (inStock.length) {
    steps.push({
      id: 's3', system: 'SAP ERP', kind: 'record', what: `Hold ${inStock.length === c.quote.lines.length ? 'the stock' : `the ${inStock.length} line${inStock.length === 1 ? '' : 's'} that ${inStock.length === 1 ? 'is' : 'are'} in stock`} at ${c.branch.name}`,
      after: until ? `Held until ${until}` : 'Held',
      action: { tool: 'hold_stock', args: { branchCode: c.branch.code, lines: inStock.map((l) => ({ sku: l.sku, quantity: l.quantity })), until: c.validUntil, reference: `Quote request ${c.requestId}`, opportunityId: c.opportunityId } },
    });
  }
  return steps;
}

/** The detail the canvas draws as a table. */
export function quoteDetail(p: ReturnType<typeof priceQuote>, tier: Tier, branch: string, validUntil: string): QuoteDetail {
  return { tier: tierWord(tier), validUntil, branch, lines: p.lines.map(({ enough, ...l }) => { void enough; return l; }), subtotal: p.subtotal, gst: p.gst, total: p.total, discountPercent: p.discountPercent, ...(p.currency ? { currency: p.currency } : {}) };
}

/** Checks on the quote and on the email, in code, before a person sees them. They do not stop the quote; they tell the person where to look. */
export function quoteChecks(email: string, ctx: { facts: string[]; priced: number; asked: number; tier: Tier; total: number; subtotal: number; short: number; unpriced: number; hasValidity: boolean; currency?: string }): Array<{ label: string; ok: boolean }> {
  const money = moneyIn(ctx.currency);
  const amounts = [...email.matchAll(/[$€£]\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const known = [ctx.total, ctx.subtotal, cents(ctx.total - ctx.subtotal)].map(cents);
  const stray = amounts.filter((a) => !known.includes(cents(a)));
  const knownDates = new Set(ctx.facts.flatMap((f) => dateKeys(f)));
  const strayDates = dateKeys(email).filter((k) => !knownDates.has(k));
  return [
    ctx.unpriced === 0 ? { label: `Every line is priced at ${tierWord(ctx.tier)} trade prices (${ctx.priced} of ${ctx.asked})`, ok: true } : { label: `${ctx.unpriced} line${ctx.unpriced === 1 ? '' : 's'} left out: no price in the ERP`, ok: false },
    ctx.short === 0 ? { label: 'Every line is in stock at the delivering branch', ok: true } : { label: `${ctx.short} line${ctx.short === 1 ? ' is' : 's are'} not fully in stock: check it`, ok: false },
    stray.length === 0 ? { label: 'Amounts in the email match the quote', ok: true } : { label: `The email names an amount that is not on the quote (${stray.map(money).join(', ')}): check it`, ok: false },
    strayDates.length ? { label: `Names a date the systems did not show (${[...new Set(strayDates)].join(', ')}): check it`, ok: false } : { label: ctx.hasValidity ? 'Dates come from the systems and the quote' : 'No date promised', ok: true },
  ];
}

/** The words each part falls back to when the model cannot be used. */
export function quoteFallbackWords(c: { customerName: string; contactName: string; repName: string; branch: string; total: number; subtotal: number; gst: number; lineCount: number; tier: string; validUntil: string; unpriced: number; currency?: string }) {
  const money = moneyIn(c.currency);
  const first = (c.contactName || c.customerName).split(/[ ,]/)[0] || 'there';
  const until = dayWords(c.validUntil);
  return {
    summary: c.unpriced ? `${c.lineCount} lines priced, ${c.unpriced} without a price. A person should look.` : `${c.lineCount} lines at ${c.tier} trade prices: ${money(c.total)} with GST.`,
    recommendation: c.unpriced ? 'Send the quote only after the lines with no price are sorted.' : `Send the quote at ${c.tier} trade prices, ${money(c.subtotal)} before GST${until ? `, valid to ${until}` : ''}, and hold the stock.`,
    otherOption: 'Ring the customer first to go through the quote.',
    email: `Kia ora ${first},\n\nThank you for asking us to quote. Your quote is attached: ${money(c.subtotal)} before GST, ${money(c.total)} with GST${until ? `, and the prices and stock hold until ${until}` : ''}.\n\nNgā mihi,\n${c.repName.split(' ')[0]}`,
  };
}

/** The reading used when no model is available or its answer is unusable: plain words in the request. Always Medium or Low, never High. */
export function readQuoteByWords(text: string, subtotal: number, hoursToDue: number): { topic: QuoteTopic; topicConfidence: 'Medium' | 'Low'; urgency: (typeof QUOTE_URGENCY)[number] } {
  const t = text.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  let topic: QuoteTopic = 'New quote'; let sure = true;
  if (has('same as last', 'repeat', 'reorder', 're-order', 'again')) topic = 'Repeat order';
  else if (has('price check', 'how much', 'what is the price', 'ballpark')) topic = 'Price check';
  else if (subtotal > 10_000 || has('whole site', 'subdivision', 'tender')) topic = 'Large job';
  else if (!has('quote', 'price', 'pricing', 'supply')) sure = false;
  const urgency = hoursToDue <= 4 || has('today', 'urgent', 'asap') ? 'Urgent' : hoursToDue <= 24 || has('tomorrow', 'this week') ? 'Soon' : 'Routine';
  return { topic, topicConfidence: sure ? 'Medium' : 'Low', urgency };
}
