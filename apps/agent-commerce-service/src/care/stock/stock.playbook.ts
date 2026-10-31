/**
 * The rules of the stock exceptions desk that are not the model's to decide: who is on the team, what kinds of exception exist, which branch the
 * stock may come from, what a transfer may be proposed with, and the checks on the plan. The AI reads the exception and writes the words; this
 * file decides what can be done, in code, from the figures the ERP gave.
 *
 * It is the second desk on the care desk's machinery: the same stages, the same approval, the same write-back. Only the words, the sources and the
 * three changes it may propose are its own.
 */
import { dateKeys } from '../care.checks';
import type { CareTeam } from '../care.playbook';
import type { CareStep, StockExceptionDetail } from '../care.types';

/** The staff groups that work the stock desk: the project's "Branch" team as the gateway signs it (lower case, dashes). */
export const STOCK_GROUPS = ['branch'];

export const STOCK_TOPICS = ['Short at branch', 'Damaged in store', 'Late from supplier', 'Count mismatch'] as const;
export const STOCK_URGENCY = ['Routine', 'Soon', 'Urgent'] as const;
export type StockTopic = (typeof STOCK_TOPICS)[number];

export const DEFAULT_STOCK_TEAM: CareTeam = {
  reps: [
    { name: 'Wiremu Fox', id: 'STK-1101', email: 'branch@placemakers.demo', skills: ['Short at branch', 'Damaged in store', 'Count mismatch'] },
    { name: 'Priya Nair', id: 'STK-1102', skills: ['Late from supplier', 'Count mismatch'] },
  ],
  lead: { name: 'Hone Rewi', id: 'TL-3001' },
};

export function stockTeamFromEnv(env: Record<string, string | undefined> = process.env): CareTeam {
  try {
    const parsed = JSON.parse(env.STOCK_TEAM || 'null');
    if (parsed && Array.isArray(parsed.reps) && parsed.reps.length && parsed.lead?.id) return parsed as CareTeam;
  } catch { /* an unreadable setting means the default team */ }
  return DEFAULT_STOCK_TEAM;
}

/** One branch's stock of the product, as the ERP gives it. */
export interface BranchStock {
  code: string;
  name: string;
  onHand: number;
  /** Already promised to other orders. */
  reserved: number;
  /** The least the branch keeps for its own counter. */
  safety: number;
  /** Days for a truck to bring stock from this branch to the short one. */
  transferDays?: number;
  /** The day it would arrive (YYYY-MM-DD). */
  arrives?: string;
}

export const spareOf = (b: BranchStock): number => Math.max(0, b.onHand - b.reserved - b.safety);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Thursday 30 October" for a day written YYYY-MM-DD, or '' when it is not one. A day has no time zone here: it is the date the ERP wrote. */
export function dayWords(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface Pick {
  source?: BranchStock;
  /** True when the stock would arrive on or before the day the order needs it (or no day was given). */
  inTime: boolean;
  /** Why no branch was chosen, in plain words. */
  none?: string;
}

/**
 * The branch the stock should come from: one that can give the whole shortfall without going under its own safety stock. Of those, the ones that
 * arrive in time come first, then the quickest, then the one with the most to spare. No branch can give part of it: a half-filled order is a
 * person's decision, not a proposal.
 */
export function pickSource(rows: BranchStock[], shortCode: string, shortfall: number, neededBy?: string): Pick {
  const able = rows.filter((r) => r.code !== shortCode && spareOf(r) >= shortfall && r.transferDays != null);
  if (!able.length) return { inTime: false, none: `No other branch has ${shortfall} to spare without going under its own safety stock.` };
  const early = (r: BranchStock) => (!neededBy || !r.arrives || r.arrives <= neededBy ? 0 : 1);
  const best = [...able].sort((a, b) => early(a) - early(b) || (a.transferDays ?? 99) - (b.transferDays ?? 99) || spareOf(b) - spareOf(a) || a.code.localeCompare(b.code))[0];
  return { source: best, inTime: early(best) === 0 };
}

export interface StockContext {
  exceptionId: number;
  product: { sku: string; name: string };
  short: { code: string; name: string; needed: number; onHand: number };
  source: BranchStock;
  quantity: number;
  orderRef?: string;
  customerName: string;
}

/**
 * The changes a stock exception may propose. Fixed here, never written by the model, so what can happen is always one of a few known actions.
 * Each step names the tool the write-back will run.
 */
export function stockStepsFor(c: StockContext): CareStep[] {
  const arrives = dayWords(c.source.arrives);
  const steps: CareStep[] = [{
    id: 's1', system: 'SAP ERP', kind: 'record',
    what: `Ask ${c.source.name} to send ${c.quantity} × ${c.product.name} to ${c.short.name}`,
    before: `${c.short.name}: ${c.short.onHand} on hand`, after: `${c.short.name}: ${c.short.onHand + c.quantity}${arrives ? ` by ${arrives}` : ''}`,
    action: { tool: 'request_stock_transfer', args: { sku: c.product.sku, fromBranch: c.source.code, toBranch: c.short.code, quantity: c.quantity, orderNumber: c.orderRef, exceptionId: c.exceptionId, arrives: c.source.arrives } },
  }];
  if (c.orderRef) {
    steps.push({
      id: 's2', system: 'commercetools', kind: 'internal', what: `Add a note on order ${c.orderRef}`,
      after: `${c.quantity} moving from ${c.source.name}${arrives ? `, due ${arrives}` : ''}`,
      action: { tool: 'add_order_note', args: { orderNumber: c.orderRef, note: `Short at ${c.short.name}: ${c.quantity} × ${c.product.name} moving from ${c.source.name}${arrives ? `, due ${arrives}` : ''}. See the stock desk work-up (exception ${c.exceptionId}).` } },
    });
  }
  steps.push({
    id: `s${steps.length + 1}`, system: 'Salesforce', kind: 'record', what: `Create a task to tell ${c.customerName}`,
    after: c.orderRef ? `Order ${c.orderRef}${arrives ? ` ready ${arrives}` : ''}` : arrives ? `Ready ${arrives}` : 'Stock confirmed',
    action: { tool: 'create_task', args: { subject: `Tell ${c.customerName}: ${c.orderRef ? `order ${c.orderRef}` : c.product.name}${arrives ? ` is ready ${arrives}` : ' stock is confirmed'}`, description: `${c.quantity} × ${c.product.name} is moving from ${c.source.name} to ${c.short.name}. A person calls the customer.`, exceptionId: c.exceptionId } },
  });
  return steps;
}

/** The detail the canvas draws as a table: the short branch first, the chosen source next, then the rest by what they could spare. */
export function branchTable(rows: BranchStock[], shortCode: string, sourceCode?: string): StockExceptionDetail['branches'] {
  const role = (r: BranchStock): 'short' | 'source' | 'other' => (r.code === shortCode ? 'short' : r.code === sourceCode ? 'source' : 'other');
  const rank = { short: 0, source: 1, other: 2 };
  return rows.map((r) => ({ name: r.name, onHand: r.onHand, spare: spareOf(r), role: role(r), ...(r.transferDays != null && r.code !== shortCode ? { note: `${r.transferDays} day${r.transferDays === 1 ? '' : 's'} by truck` } : {}) }))
    .sort((a, b) => rank[a.role] - rank[b.role] || b.spare - a.spare || a.name.localeCompare(b.name))
    .slice(0, 6);
}

/** Checks on the plan and on the note, in code, before a person sees them. They do not stop the plan; they tell the person where to look. */
export function stockChecks(text: string, ctx: { facts: string[]; quantity: number; shortfall: number; source: BranchStock; inTime: boolean; neededByWords?: string }): Array<{ label: string; ok: boolean }> {
  const left = ctx.source.onHand - ctx.source.reserved - ctx.quantity;
  const known = new Set(ctx.facts.flatMap((f) => dateKeys(f)));
  const stray = dateKeys(text).filter((k) => !known.has(k));
  return [
    ctx.quantity >= ctx.shortfall ? { label: `Covers the whole shortfall (${ctx.quantity} of ${ctx.shortfall})`, ok: true } : { label: `Covers only ${ctx.quantity} of the ${ctx.shortfall} short: check it`, ok: false },
    left >= ctx.source.safety ? { label: `${ctx.source.name} keeps its safety stock (${left} left, it keeps ${ctx.source.safety})`, ok: true } : { label: `${ctx.source.name} would go under its safety stock (${left} left, it keeps ${ctx.source.safety})`, ok: false },
    ctx.inTime ? { label: `Arrives in time${ctx.neededByWords ? ` for ${ctx.neededByWords}` : ''}`, ok: true } : { label: `Arrives after the day the order needs it${ctx.neededByWords ? ` (${ctx.neededByWords})` : ''}: check it`, ok: false },
    stray.length ? { label: `Names a date the systems did not show (${[...new Set(stray)].join(', ')}): check it`, ok: false } : { label: 'Dates come from the systems', ok: true },
  ];
}

/** The words each part falls back to when the model cannot be used. */
export function stockFallbackWords(c: { product: string; shortBranch: string; shortfall: number; orderRef?: string; customerName: string; source?: { name: string; arrives?: string }; quantity?: number; substitute?: string }) {
  const order = c.orderRef ? ` for order ${c.orderRef}` : '';
  if (!c.source) {
    return {
      summary: `${c.shortBranch} is ${c.shortfall} short${order}. No branch can cover it.`,
      recommendation: `A person should decide: no other branch can give ${c.shortfall} without going under its safety stock.`,
      otherOption: c.substitute ? `Offer ${c.substitute} instead, if ${c.customerName} agrees.` : 'Ask the supplier for the quickest delivery.',
      note: `Notes for the counter\n• ${c.shortBranch} is ${c.shortfall} × ${c.product} short${order}.\n• No branch can cover it from its spare stock.\n• Ring ${c.customerName} before anything else is promised.`,
    };
  }
  const when = dayWords(c.source.arrives);
  return {
    summary: `${c.shortBranch} is ${c.shortfall} short${order}. ${c.source.name} can cover it${when ? `, due ${when}` : ''}.`,
    recommendation: `Move ${c.quantity} × ${c.product} from ${c.source.name} to ${c.shortBranch}${when ? `, arriving ${when}` : ''}.`,
    otherOption: c.substitute ? `Offer ${c.substitute} instead, if ${c.customerName} agrees.` : `Ask the supplier to deliver direct to ${c.shortBranch}.`,
    note: `Notes for the counter\n• ${c.shortBranch} is ${c.shortfall} × ${c.product} short${order}.\n• ${c.source.name} has the stock to spare; ${c.quantity} come by truck${when ? `, due ${when}` : ''}.\n• Ring ${c.customerName} once the truck is confirmed.`,
  };
}

/** The reading used when no model is available or its answer is unusable: plain words in the exception. Always Medium or Low, never High. */
export function readStockByWords(text: string, hoursToDispatch: number): { topic: StockTopic; topicConfidence: 'Medium' | 'Low'; urgency: (typeof STOCK_URGENCY)[number] } {
  const t = text.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  let topic: StockTopic = 'Short at branch'; let sure = true;
  if (has('damaged', 'broken', 'water', 'crushed', 'wet')) topic = 'Damaged in store';
  else if (has('supplier', 'late from', 'not received', 'did not arrive', 'inwards', 'backorder')) topic = 'Late from supplier';
  else if (has('recount', 'mismatch', 'does not match', 'discrepancy', 'count differs', 'count is out')) topic = 'Count mismatch';
  else if (!has('short', 'not enough', 'only', 'pick')) sure = false;
  const urgency = hoursToDispatch <= 4 || has('today', 'urgent', 'crew') ? 'Urgent' : hoursToDispatch <= 24 ? 'Soon' : 'Routine';
  return { topic, topicConfidence: sure ? 'Medium' : 'Low', urgency };
}
