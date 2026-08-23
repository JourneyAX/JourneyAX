// ═══════════════════════════════════════════════════════════════════════
// The apparel journey's own vocabulary.
//
// Kept apart from types.ts because the bathroom journey has no bag, no
// try-on and no returns, and lib/types.ts is already carrying dead weight
// from the pre-AI version. Anything here is apparel-only.
//
// The shape of this file follows one rule from the research: a fashion
// journey is not four features bolted together, it is one loop —
// discover → size → see → buy → keep or return → learn. So a return knows
// which bag line it came from, and a return reason is expressible as a fit
// signal. Without that last link the loop is decorative.
// ═══════════════════════════════════════════════════════════════════════

/** Why a garment came back. Mirrors the fit engine's return-signal reasons. */
export type ReturnReason = 'too-small' | 'too-large' | 'style' | 'quality' | 'other';

/**
 * Only two of the five reasons say anything about size. The rest are real
 * reasons to return something and tell the fit engine nothing — treating
 * "wrong colour" as a sizing signal is how fit models learn superstitions.
 */
export const SIZE_REASONS: ReturnReason[] = ['too-small', 'too-large'];

export interface ReturnReasonOption {
  id: ReturnReason;
  /** i18n key; the panel resolves it against the active language. */
  labelKey: string;
  /** True when this reason should move a future size recommendation. */
  informsFit: boolean;
}

export const RETURN_REASONS: ReturnReasonOption[] = [
  { id: 'too-small', labelKey: 'return.reason.tooSmall', informsFit: true },
  { id: 'too-large', labelKey: 'return.reason.tooLarge', informsFit: true },
  { id: 'style', labelKey: 'return.reason.style', informsFit: false },
  { id: 'quality', labelKey: 'return.reason.quality', informsFit: false },
  { id: 'other', labelKey: 'return.reason.other', informsFit: false },
];

// ── The bag ────────────────────────────────────────────────────────────

/**
 * One line in the bag.
 *
 * `size` is optional on purpose: an item can be put in the bag before it has
 * been sized, and the panel shows that as an unresolved state rather than
 * silently guessing. The whole point of the journey is that a size is a
 * decision the shopper made, not one we inferred.
 */
export interface BagLine {
  id: string;
  sku: string;
  name: string;
  price: number;
  quantity: number;
  size?: string;
  /** How the size was arrived at, shown so the shopper can trust it. */
  sizeRationale?: string;
  category?: string;
  /** Why the assistant suggested it. */
  reason?: string;
}

export interface BagTotals {
  itemCount: number;
  subtotal: number;
  /** Lines still missing a size — the thing that should block checkout. */
  unsized: number;
}

export function calculateBagTotals(lines: BagLine[]): BagTotals {
  return {
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    subtotal: lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
    unsized: lines.filter(l => !l.size).length,
  };
}

// ── Try-on ─────────────────────────────────────────────────────────────

/**
 * What the try-on panel is currently showing.
 *
 * Deliberately thin. Try-on here is the *visual confidence layer* — it shows
 * a garment on an estimated body so the shopper can see drape and length. It
 * is not the fit engine and must never be presented as one; ASOS says this
 * out loud on their own try-on and the research deck calls it the single
 * most important framing to get right. The numbers come from the fit engine;
 * this only draws.
 */
export interface TryOnView {
  styleId: string;
  styleName: string;
  /** Size being visualised. Comes from the fit advisor, never invented here. */
  size: string;
  /** Optional: what the fit engine said, echoed so the two agree. */
  fitSummary?: string;
}

// ── Returns ────────────────────────────────────────────────────────────

export type ReturnStage = 'choose-item' | 'choose-reason' | 'resolved';

export interface ReturnCase {
  stage: ReturnStage;
  /** The bag/order line being returned. */
  line: BagLine | null;
  reason: ReturnReason | null;
  /** 'refund' or a swap to another size. */
  resolution: 'refund' | 'exchange' | null;
  /** The size an exchange should go out in, when the reason implies one. */
  exchangeSize?: string;
  /** True once the reason has been written back as a fit signal. */
  fedToFitEngine: boolean;
}

export const EMPTY_RETURN: ReturnCase = {
  stage: 'choose-item',
  line: null,
  reason: null,
  resolution: null,
  fedToFitEngine: false,
};

/**
 * Turn a return reason into the direction a future size should move.
 * Returns 0 when the reason says nothing about size — which is most of them.
 */
export function sizeDeltaFromReason(reason: ReturnReason | null): -1 | 0 | 1 {
  if (reason === 'too-small') return 1;
  if (reason === 'too-large') return -1;
  return 0;
}
