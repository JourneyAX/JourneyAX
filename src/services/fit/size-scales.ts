// ═══════════════════════════════════════════════════════════════════════
// Size scales.
//
// A scale is an ordered array, so "one size up" is index arithmetic. That
// is the whole reason the engine can talk about a delta without knowing
// whether it is moving YM→YL or 6→8.
//
// Adding a category (footwear, headwear, numeric denim) means adding a
// scale here. No other file changes.
// ═══════════════════════════════════════════════════════════════════════

import { SizeScale, SizeSystemId } from '@/lib/fit-types';

export const SCALES: Record<SizeSystemId, SizeScale> = {
  'youth-athletic': {
    id: 'youth-athletic',
    label: 'Youth athletic',
    steps: ['YXS', 'YS', 'YM', 'YL', 'YXL'],
    typicallyMinors: true,
  },
  'adult-athletic': {
    id: 'adult-athletic',
    label: 'Adult athletic',
    steps: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'],
  },
  'unisex-alpha': {
    id: 'unisex-alpha',
    label: 'Unisex alpha',
    steps: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  },
  'womens-numeric': {
    id: 'womens-numeric',
    label: "Women's numeric",
    steps: ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', '18'],
  },
  'mens-waist': {
    id: 'mens-waist',
    label: "Men's waist",
    steps: ['28', '29', '30', '31', '32', '33', '34', '36', '38', '40', '42', '44'],
  },
};

/** Alternate spellings we accept on input but never emit. */
const ALIASES: Record<string, string> = {
  SMALL: 'S', MEDIUM: 'M', LARGE: 'L',
  'X-LARGE': 'XL', XLARGE: 'XL',
  XXL: '2XL', XXXL: '3XL', XXXXL: '4XL',
  'Y-S': 'YS', 'Y-M': 'YM', 'Y-L': 'YL',
  YOUTHS: 'YS', YOUTHM: 'YM', YOUTHL: 'YL',
};

export function normalizeSize(raw: string): string {
  const s = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
  return ALIASES[s] ?? s;
}

/**
 * Work out which scale a size belongs to.
 *
 * Youth is checked first because "YL" would otherwise be ambiguous, and a
 * hint from the style always wins — some styles ship on their own scale.
 */
export function detectScale(size: string, hint?: SizeSystemId): SizeScale {
  if (hint) return SCALES[hint];
  const s = normalizeSize(size);

  if (SCALES['youth-athletic'].steps.includes(s)) return SCALES['youth-athletic'];
  if (SCALES['adult-athletic'].steps.includes(s)) return SCALES['adult-athletic'];
  if (SCALES['unisex-alpha'].steps.includes(s)) return SCALES['unisex-alpha'];
  if (SCALES['womens-numeric'].steps.includes(s)) return SCALES['womens-numeric'];
  if (SCALES['mens-waist'].steps.includes(s)) return SCALES['mens-waist'];

  // Unknown size — fall back to the broadest adult scale so callers still get
  // a scale object rather than having to null-check everywhere.
  return SCALES['adult-athletic'];
}

/** Index of a size within its scale, or −1. */
export function indexOf(size: string, scale: SizeScale): number {
  return scale.steps.indexOf(normalizeSize(size));
}

/**
 * Move `delta` steps along the scale.
 *
 * Returns null when the size is not on the scale at all, and clamps at both
 * ends — suggesting a size the brand does not make is worse than suggesting
 * nothing.
 */
export function step(size: string, delta: number, scale: SizeScale): string | null {
  const i = indexOf(size, scale);
  if (i < 0) return null;
  const target = Math.max(0, Math.min(scale.steps.length - 1, i + delta));
  return scale.steps[target];
}

/** How many steps apart two sizes are. Null when they are not comparable. */
export function stepsBetween(from: string, to: string, scale: SizeScale): number | null {
  const a = indexOf(from, scale);
  const b = indexOf(to, scale);
  if (a < 0 || b < 0) return null;
  return b - a;
}

/** True when the size sits at the top of its scale and cannot go up. */
export function atTop(size: string, scale: SizeScale): boolean {
  const i = indexOf(size, scale);
  return i >= 0 && i === scale.steps.length - 1;
}

// ── Measurement chart ──────────────────────────────────────────────────
// Adult chest ranges in inches. Used only when a brand allows self-reported
// measurements — never for minors. Values are ordinary apparel bands, and a
// brand with its own chart replaces this map.

const CHEST_IN: Partial<Record<SizeSystemId, [string, number, number][]>> = {
  'adult-athletic': [
    ['XS', 32, 34], ['S', 34, 37], ['M', 38, 41], ['L', 42, 45],
    ['XL', 46, 49], ['2XL', 50, 53], ['3XL', 54, 57], ['4XL', 58, 62],
  ],
  'unisex-alpha': [
    ['XXS', 30, 32], ['XS', 32, 34], ['S', 34, 37], ['M', 38, 41],
    ['L', 42, 45], ['XL', 46, 49], ['XXL', 50, 53], ['XXXL', 54, 58],
  ],
};

/** Nearest size for a chest measurement, or null when the scale has no chart. */
export function sizeForChest(chestIn: number, scale: SizeScale): string | null {
  const chart = CHEST_IN[scale.id];
  if (!chart) return null;
  for (const [size, lo, hi] of chart) {
    if (chestIn >= lo && chestIn <= hi) return size;
  }
  // Outside the chart — clamp to whichever end it fell off.
  const first = chart[0];
  const last = chart[chart.length - 1];
  return chestIn < first[1] ? first[0] : last[0];
}
