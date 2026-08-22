/**
 * The single source of truth for money.
 *
 * Before this module, `calculateTotals` lived in `JourneyContext.tsx` and ran
 * exclusively in the browser: the shopper's own machine decided what the
 * shopper owed, and nothing on the server ever checked it. That is fine for a
 * demo and unacceptable for a transaction.
 *
 * The maths now lives here so both sides can run *the same* code, and
 * `/api/quote` re-runs it server-side to produce the authoritative figure.
 * The client is free to compute totals for instant feedback; it is simply no
 * longer believed.
 */

import type { BOMLine, QuoteTotals } from './types';
import { DEFAULT_ADDONS } from './types';

// ── Policy ─────────────────────────────────────────────────────────────
/**
 * Rates are declared once, here. They were previously inline literals
 * (`* 0.12`, `* 0.10`) in the reducer, which is exactly the kind of thing
 * that drifts between client and server.
 */
export const PRICING = {
  /** Trade discount applied to the subtotal before tax. */
  discountRate: 0.12,
  /** Australian GST, applied after the discount. */
  gstRate: 0.10,
  /** Refuse to price a single line above this. Catches misplaced decimals. */
  maxLinePrice: 100_000,
  /** Refuse a quote above this. Catches a fabricated BOM. */
  maxQuoteTotal: 1_000_000,
  /** Largest quantity a single line may carry. */
  maxQuantity: 999,
} as const;

// ── Validation ─────────────────────────────────────────────────────────
export interface PriceIssue {
  sku: string;
  field: string;
  detail: string;
}

/** A number we are willing to treat as money. Excludes NaN, Infinity, negatives. */
function isMoney(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Round to cents. Floating-point subtotals otherwise leak fractions of a cent. */
export function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Check a BOM line before it is allowed to influence a total.
 *
 * Returns every problem found rather than the first, so a caller can report
 * the whole story instead of making the user fix one field at a time.
 */
export function validateBomLine(line: Partial<BOMLine>): PriceIssue[] {
  const sku = line.sku || line.key || '(unknown)';
  const issues: PriceIssue[] = [];

  if (!isMoney(line.price)) {
    issues.push({ sku, field: 'price', detail: 'not a valid non-negative number' });
  } else if (line.price > PRICING.maxLinePrice) {
    issues.push({ sku, field: 'price', detail: `exceeds ${PRICING.maxLinePrice}` });
  }

  const qty = line.quantity;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
    issues.push({ sku, field: 'quantity', detail: 'must be a whole number of at least 1' });
  } else if (qty > PRICING.maxQuantity) {
    issues.push({ sku, field: 'quantity', detail: `exceeds ${PRICING.maxQuantity}` });
  }

  // lineTotal is supplied by the client but is derivable. If the two disagree
  // the client is either buggy or lying; either way we do not use its number.
  if (isMoney(line.price) && typeof qty === 'number' && isMoney(line.lineTotal)) {
    const expected = toCents(line.price * qty);
    if (Math.abs(expected - toCents(line.lineTotal)) > 0.01) {
      issues.push({
        sku,
        field: 'lineTotal',
        detail: `claims ${line.lineTotal}, price x quantity is ${expected}`,
      });
    }
  }

  return issues;
}

// ── Computation ────────────────────────────────────────────────────────
/**
 * Compute quote totals from lines and selected add-ons.
 *
 * Deliberately ignores any `lineTotal` on the input and recomputes it from
 * price x quantity. A caller that wants to know the client disagreed should
 * run `validateBomLine` — this function simply does not give the client's
 * arithmetic a vote.
 */
export function computeTotals(
  bom: Partial<BOMLine>[],
  selectedAddons: string[],
  qty: number,
): QuoteTotals {
  const bomTotal = bom.reduce((sum, line) => {
    if (!isMoney(line.price)) return sum;
    const lineQty = Number.isInteger(line.quantity) && (line.quantity as number) > 0
      ? (line.quantity as number)
      : 1;
    return sum + line.price * lineQty;
  }, 0);

  const addonQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
  const addonTotal = selectedAddons.reduce((sum, id) => {
    const addon = DEFAULT_ADDONS.find(a => a.id === id);
    return sum + (addon ? addon.price * addonQty : 0);
  }, 0);

  const subtotal = toCents(bomTotal + addonTotal);
  const discount = toCents(subtotal * PRICING.discountRate);
  const afterDiscount = toCents(subtotal - discount);
  const gst = toCents(afterDiscount * PRICING.gstRate);
  const total = toCents(afterDiscount + gst);

  return { subtotal, discount, gst, total };
}

// ── Server-side verification ───────────────────────────────────────────
export interface QuoteVerdict {
  totals: QuoteTotals;
  issues: PriceIssue[];
  /** False when the quote must not be acted on (ordered, emailed, charged). */
  acceptable: boolean;
}

/**
 * The authoritative answer. `/api/quote` returns this; the client displays
 * `totals` and must refuse to place an order when `acceptable` is false.
 */
export function verifyQuote(
  bom: Partial<BOMLine>[],
  selectedAddons: string[],
  qty: number,
): QuoteVerdict {
  const issues = bom.flatMap(validateBomLine);
  const totals = computeTotals(bom, selectedAddons, qty);

  if (totals.total > PRICING.maxQuoteTotal) {
    issues.push({
      sku: '(quote)',
      field: 'total',
      detail: `exceeds ${PRICING.maxQuoteTotal}`,
    });
  }

  return { totals, issues, acceptable: issues.length === 0 };
}
