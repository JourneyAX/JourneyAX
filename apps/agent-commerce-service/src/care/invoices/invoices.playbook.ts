/**
 * The rules of the invoices desk that are not the model's to decide: who is on the team, what kinds of mismatch exist, how an invoice is compared
 * with the order, the delivery and the agreed prices, what credit is due, when the finance manager has to decide, and the checks on the correction.
 * The AI reads what the customer said and writes the words; this file finds the difference, in code, from the records the systems gave.
 *
 * It is the fourth desk on the care desk's machinery: the same stages, the same approval, the same write-back. Only the words, the sources and the
 * three changes it may propose are its own.
 */
import { dateKeys } from '../care.checks';
import type { CareTeam } from '../care.playbook';
import type { CareStep, InvoiceDetail } from '../care.types';
import { GST_RATE, asTier, dayWords, moneyIn, tierWord, tierPrice, type PriceRow, type Tier } from '../quotes/quotes.playbook';

export { dayWords, moneyIn };

/** The staff groups that work the invoices desk: the project's "Finance" team as the gateway signs it. */
export const INVOICES_GROUPS = ['finance'];

export const INVOICE_TOPICS = ['Price mismatch', 'Quantity mismatch', 'Duplicate invoice', 'Missing credit note'] as const;
export const INVOICE_URGENCY = ['Routine', 'Soon', 'Urgent'] as const;
export type InvoiceTopic = (typeof INVOICE_TOPICS)[number];

export const DEFAULT_INVOICES_TEAM: CareTeam = {
  reps: [
    { name: 'Ana Rangi', id: 'FIN-3101', email: 'finance@placemakers.demo', skills: ['Price mismatch', 'Quantity mismatch', 'Duplicate invoice', 'Missing credit note'] },
    { name: 'Wiki Anderson', id: 'FIN-3102', skills: ['Duplicate invoice', 'Missing credit note'] },
  ],
  lead: { name: 'Peter Lowe', id: 'FM-3001' },
};

export function invoicesTeamFromEnv(env: Record<string, string | undefined> = process.env): CareTeam {
  try {
    const parsed = JSON.parse(env.INVOICES_TEAM || 'null');
    if (parsed && Array.isArray(parsed.reps) && parsed.reps.length && parsed.lead?.id) return parsed as CareTeam;
  } catch { /* an unreadable setting means the default team */ }
  return DEFAULT_INVOICES_TEAM;
}

/** A credit over this (with GST) is the finance manager's to decide. */
export const DEFAULT_CREDIT_LIMIT = 1_000;

const cents = (n: number): number => Math.round(n * 100) / 100;

/** One invoice line as the ERP gives it. */
export interface InvoiceLine { sku: string; name?: string; quantity: number; unitPrice: number }
/** The invoice as the ERP gives it. */
export interface InvoiceRecord { invoiceId: string; accountId?: string; accountName?: string; orderNumber?: string; deliveryId?: string; issuedAt?: string; dueAt?: string; currency?: string; subtotal?: number; gst?: number; total: number; lines: InvoiceLine[] }

export interface CompareEvidence {
  /** What the order says was agreed, by SKU: quantity and unit price (commercetools). */
  ordered: Record<string, { quantity: number; unitPrice?: number } | undefined>;
  /** What was delivered, by SKU (the ERP's delivery record); absent when no delivery record was found. */
  delivered: Record<string, number | undefined> | null;
  /** The ERP's price list, by SKU, and the customer's tier. */
  prices: Record<string, PriceRow | undefined>;
  tier: Tier | null;
  /** Another invoice for the same order that is the same as this one, and was issued first. */
  duplicateOf?: string;
}

export interface Compared {
  lines: InvoiceDetail['lines'];
  overcharge: number;
  gst: number;
  credit: number;
  /** The kind of mismatch the figures show: the part that is the most money. Null when the invoice matches. */
  cause: InvoiceTopic | null;
  priceOver: number;
  qtyOver: number;
}

/**
 * Compares an invoice with the evidence. For each line the right price is the one on the order, else the customer's tier price from the ERP, else
 * the invoiced price (no evidence, no difference); the right quantity is the least of what was invoiced, ordered and delivered. A duplicate of an
 * earlier invoice for the same order is credited in full. GST is charged on the credit at the invoice's own rate.
 */
export function compareInvoice(inv: InvoiceRecord, ev: CompareEvidence): Compared {
  const lines: InvoiceDetail['lines'] = [];
  let priceOver = 0; let qtyOver = 0; let duplicateOver = 0;
  for (const l of inv.lines) {
    const invoicedLine = cents(l.unitPrice * l.quantity);
    if (ev.duplicateOf) {
      lines.push({ sku: l.sku, name: l.name || l.sku, invoicedQty: l.quantity, invoicedPrice: l.unitPrice, rightQty: 0, rightPrice: l.unitPrice, over: invoicedLine, why: `Duplicate of ${ev.duplicateOf}` });
      duplicateOver += invoicedLine;
      continue;
    }
    const order = ev.ordered[l.sku]; const price = ev.prices[l.sku]; const delivered = ev.delivered ? ev.delivered[l.sku] : undefined;
    const tier = ev.tier && price ? tierPrice(price, ev.tier) : null;
    const rightPrice = order?.unitPrice ?? tier ?? l.unitPrice;
    const rightQty = Math.min(l.quantity, order?.quantity ?? l.quantity, delivered ?? l.quantity);
    const qtyPart = cents((l.quantity - rightQty) * l.unitPrice);
    const pricePart = cents(Math.max(l.unitPrice - rightPrice, 0) * rightQty);
    const over = cents(qtyPart + pricePart);
    priceOver += pricePart; qtyOver += qtyPart;
    const reasons: string[] = [];
    if (pricePart > 0) reasons.push(order?.unitPrice != null ? 'Not the price on the order' : `Not the ${ev.tier ? tierWord(ev.tier) : 'agreed'} trade price`);
    if (qtyPart > 0) reasons.push(delivered != null && delivered < l.quantity ? `${l.quantity} invoiced, ${delivered} delivered` : `${l.quantity} invoiced, ${order?.quantity ?? rightQty} ordered`);
    lines.push({ sku: l.sku, name: l.name || l.sku, invoicedQty: l.quantity, invoicedPrice: l.unitPrice, rightQty, rightPrice, over, why: reasons.join('; ') || 'Matches' });
  }
  const overcharge = cents(lines.reduce((sum, l) => sum + l.over, 0));
  const gst = cents(overcharge * GST_RATE);
  const cause: InvoiceTopic | null = overcharge <= 0 ? null : ev.duplicateOf ? 'Duplicate invoice' : priceOver >= qtyOver ? 'Price mismatch' : 'Quantity mismatch';
  return { lines, overcharge, gst, credit: cents(overcharge + gst), cause, priceOver: cents(priceOver), qtyOver: cents(qtyOver) };
}

/** True when the correction is not the controller's to decide, and why. */
export function needsManager(c: { credit: number; limit: number; found: boolean; unreadable: boolean; lowConfidence: boolean; currency?: string }): string | null {
  const money = moneyIn(c.currency);
  if (c.unreadable) return 'the invoice could not be read';
  if (!c.found) return 'no difference was found between the invoice, the order and the delivery';
  if (c.credit > c.limit) return `the credit is over ${money(c.limit)}`;
  if (c.lowConfidence) return 'the AI is not sure what is being disputed';
  return null;
}

export interface CorrectionContext {
  exceptionId: number;
  invoice: InvoiceRecord;
  accountName: string;
  contactName: string;
  contactEmail: string;
  cause: InvoiceTopic;
  compared: Pick<Compared, 'lines' | 'overcharge' | 'gst' | 'credit'>;
  owner: string;
}

/**
 * The changes an invoice exception may propose. Fixed here, never written by the model, so what can happen is always one of a few known actions.
 * Each step names the tool the write-back will run. The email is the draft the person approves, word for word.
 */
export function correctionStepsFor(c: CorrectionContext): CareStep[] {
  const money = moneyIn(c.invoice.currency);
  const why = c.cause === 'Duplicate invoice' ? 'duplicate' : c.cause === 'Quantity mismatch' ? 'quantity' : 'price';
  return [
    {
      id: 's1', system: 'SAP ERP', kind: 'money', what: `Issue a credit note against invoice ${c.invoice.invoiceId}`,
      before: `Invoice ${money(c.invoice.total)}`, after: `Credit ${money(c.compared.credit)} with GST`,
      action: { tool: 'create_credit_note', args: { invoiceId: c.invoice.invoiceId, exceptionId: c.exceptionId, accountId: c.invoice.accountId, reason: c.cause, overcharge: c.compared.overcharge, gst: c.compared.gst, total: c.compared.credit, lines: c.compared.lines.filter((l) => l.over > 0).map((l) => ({ sku: l.sku, amount: l.over, why: l.why })) } },
    },
    {
      id: 's2', system: 'SAP ERP', kind: 'customer', what: `Email the credit note to ${c.contactName || c.accountName}`,
      after: `${money(c.compared.credit)} with GST`,
      action: { tool: 'send_credit_note_email', args: { invoiceId: c.invoice.invoiceId, to: c.contactEmail, subject: `Credit note for invoice ${c.invoice.invoiceId}` } },
    },
    {
      id: 's3', system: 'Salesforce', kind: 'record', what: `Create a task for ${c.owner || 'the account owner'} to find out how it happened`,
      after: `Check invoice ${c.invoice.invoiceId}: ${why} was wrong`,
      action: { tool: 'create_task', args: { subject: `Check invoice ${c.invoice.invoiceId} for ${c.accountName}: the ${why} was wrong`, description: `A credit note of ${money(c.compared.credit)} with GST was issued. Find out how it happened so it does not happen again.`, exceptionId: c.exceptionId } },
    },
  ];
}

/** The detail the canvas draws as a table. */
export function invoiceDetail(inv: InvoiceRecord, cmp: Compared, extra: { tier: Tier | null; balanceBefore?: number; owner?: string }): InvoiceDetail {
  return {
    invoiceId: inv.invoiceId, ...(inv.orderNumber ? { orderRef: inv.orderNumber } : {}), ...(inv.deliveryId ? { deliveryId: inv.deliveryId } : {}), ...(extra.tier ? { tier: tierWord(extra.tier) } : {}), ...(inv.currency ? { currency: inv.currency } : {}),
    invoiceTotal: inv.total, lines: cmp.lines, overcharge: cmp.overcharge, gst: cmp.gst, credit: cmp.credit,
    ...(extra.balanceBefore != null ? { balanceBefore: extra.balanceBefore, balanceAfter: cents(extra.balanceBefore - cmp.credit) } : {}), ...(extra.owner ? { owner: extra.owner } : {}),
  };
}

/** Checks on the correction and on the email, in code, before a person sees them. They do not stop the correction; they tell the person where to look. */
export function correctionChecks(email: string, ctx: { facts: string[]; invoiceTotal: number; overcharge: number; gst: number; credit: number; balanceAfter?: number; currency?: string; found: boolean; hasEvidence: boolean }): Array<{ label: string; ok: boolean }> {
  const money = moneyIn(ctx.currency);
  const amounts = [...email.matchAll(/[$€£]\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const known = [ctx.credit, ctx.overcharge, ctx.gst, ctx.invoiceTotal, ...(ctx.balanceAfter != null ? [ctx.balanceAfter] : [])].map(cents);
  const stray = amounts.filter((a) => !known.includes(cents(a)));
  const knownDates = new Set(ctx.facts.flatMap((f) => dateKeys(f)));
  const strayDates = dateKeys(email).filter((k) => !knownDates.has(k));
  return [
    ctx.found ? { label: `The credit is the whole difference (${money(ctx.overcharge)} plus ${money(ctx.gst)} GST)`, ok: true } : { label: 'No difference was found, so no credit is proposed', ok: false },
    ctx.credit <= ctx.invoiceTotal + 0.005 ? { label: 'The credit is not more than the invoice', ok: true } : { label: 'The credit is more than the invoice: check it', ok: false },
    ctx.hasEvidence ? { label: 'The right price and quantity come from the order, the delivery and the price list', ok: true } : { label: 'Some of the evidence could not be read: check it', ok: false },
    stray.length === 0 ? { label: 'Amounts in the email match the credit note', ok: true } : { label: `The email names an amount that is not on the credit note (${stray.map(money).join(', ')}): check it`, ok: false },
    strayDates.length ? { label: `Names a date the systems did not show (${[...new Set(strayDates)].join(', ')}): check it`, ok: false } : { label: 'Dates come from the systems', ok: true },
  ];
}

/** The words each part falls back to when the model cannot be used. */
export function correctionFallbackWords(c: { accountName: string; contactName: string; repName: string; invoiceId: string; cause: InvoiceTopic | null; credit: number; overcharge: number; balanceAfter?: number; currency?: string }) {
  const money = moneyIn(c.currency);
  const first = (c.contactName || c.accountName).split(/[ ,]/)[0] || 'there';
  const what = c.cause === 'Duplicate invoice' ? 'was invoiced twice' : c.cause === 'Quantity mismatch' ? 'was invoiced for more than was delivered' : 'was charged at the wrong price';
  if (!c.cause) {
    return {
      summary: `Invoice ${c.invoiceId} matches the order and the delivery. Nothing to credit.`,
      recommendation: 'A person should look: no difference was found, so the customer needs an answer, not a credit.',
      otherOption: 'Ring the customer and go through the invoice line by line.',
      email: `Kia ora ${first},\n\nThank you for raising invoice ${c.invoiceId}. We have checked it against your order and the delivery and cannot see a difference yet. I will ring you to go through it.\n\nNgā mihi,\n${c.repName.split(' ')[0]}`,
    };
  }
  return {
    summary: `Invoice ${c.invoiceId} ${what}: credit ${money(c.credit)} with GST.`,
    recommendation: `Issue a credit note for ${money(c.credit)} with GST, email it to the customer, and ask the account owner to find out how it happened.`,
    otherOption: 'Ring the customer first to go through the invoice before the credit note goes out.',
    email: `Kia ora ${first},\n\nThank you for raising invoice ${c.invoiceId}. You are right: it ${what}. We have issued a credit note for ${money(c.credit)} including GST${c.balanceAfter != null ? `, which brings your balance to ${money(c.balanceAfter)}` : ''}.\n\nNgā mihi,\n${c.repName.split(' ')[0]}`,
  };
}

/** The reading used when no model is available or its answer is unusable: plain words in what the customer said. Always Medium or Low, never High. */
export function readInvoiceByWords(text: string, hoursToDue: number): { topic: InvoiceTopic; topicConfidence: 'Medium' | 'Low'; urgency: (typeof INVOICE_URGENCY)[number] } {
  const t = text.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  let topic: InvoiceTopic = 'Price mismatch'; let sure = true;
  if (has('twice', 'duplicate', 'charged again', 'two invoices', 'billed again')) topic = 'Duplicate invoice';
  else if (has('credit note', 'credit not', 'not credited', 'still waiting for the credit')) topic = 'Missing credit note';
  else if (has('not delivered', 'short', 'only got', 'only received', 'fewer', 'missing', 'quantity')) topic = 'Quantity mismatch';
  else if (!has('price', 'charged', 'trade', 'rate', 'too high', 'more than', 'quote')) sure = false;
  const urgency = hoursToDue <= 4 || has('today', 'urgent', 'asap', 'overdue notice') ? 'Urgent' : hoursToDue <= 24 || has('this week', 'tomorrow') ? 'Soon' : 'Routine';
  return { topic, topicConfidence: sure ? 'Medium' : 'Low', urgency };
}

export { asTier, tierWord, GST_RATE };
export type { PriceRow, Tier };
