// ═══════════════════════════════════════════════════════════════════════
// Fit signals.
//
// Each signal answers one narrow question from one kind of evidence, and
// returns null the moment it does not have what it needs. That is what
// lets the same engine serve two very different businesses:
//
//   Made-to-order team wear   → elapsed-growth + size-history fire.
//                               return-signal never fires (you cannot
//                               return a jersey with a name on it).
//   Retail fashion            → return-signal + fit-preference fire.
//                               elapsed-growth never fires (adults).
//
// Neither case needs a code path of its own. The signals that have nothing
// to say simply stay quiet.
// ═══════════════════════════════════════════════════════════════════════

import {
  AgeBand, FitSignalId, SignalReading, SizeScale, StyleFitProfile, Wearer,
  ageBandForGrade, monthsBetween, parseDate,
} from '@/lib/fit-types';
import { atTop, normalizeSize, sizeForChest, stepsBetween } from './size-scales';

export interface SignalContext {
  wearer: Wearer;
  scale: SizeScale;
  style?: StyleFitProfile;
  /** Date the review is being run for. Injectable so results are testable. */
  asOf: Date;
  /** Fallback for wearer.sizedAt — usually the previous order date. */
  defaultSizedAt?: string;
  allowBodyMeasurement: boolean;
}

export interface FitSignal {
  id: FitSignalId;
  label: string;
  evaluate(ctx: SignalContext): SignalReading | null;
}

// ── 1. Elapsed growth ──────────────────────────────────────────────────
// The cheap one, and for youth team wear the valuable one. No model, no
// training data: how long ago was this size set, and how old is the wearer.
//
// Rates are the share of wearers in each band who move up one size across a
// full year. They are conservative starting values, deliberately declared in
// one place so they can be replaced wholesale the day real reorder-pair data
// lands. Nothing else in the codebase depends on their being estimates.

export const GROWTH_PER_YEAR: Record<AgeBand, number> = {
  child: 0.55,
  peak: 0.70,
  late: 0.30,
  senior: 0.12,
  adult: 0.02,
};

/** Below this likelihood we say nothing rather than nag about every line. */
const GROWTH_THRESHOLD = 0.4;

function describeMonths(m: number): string {
  const r = Math.round(m);
  if (r < 1) return 'less than a month ago';
  if (r === 1) return 'a month ago';
  if (r < 12) return `${r} months ago`;
  if (r < 15) return 'about a year ago';
  if (r < 24) return 'over a year ago';
  return `${Math.floor(m / 12)} years ago`;
}

export const elapsedGrowth: FitSignal = {
  id: 'elapsed-growth',
  label: 'Time since sized',

  evaluate({ wearer, scale, asOf, defaultSizedAt }) {
    const band = wearer.ageBand ?? ageBandForGrade(wearer.gradeLevel);
    if (!band || band === 'adult') return null;

    const sized = parseDate(wearer.sizedAt ?? defaultSizedAt);
    if (!sized) return null;

    const months = monthsBetween(sized, asOf);
    if (months <= 0) return null;

    // Already at the top of the scale — there is nowhere to grow into.
    if (atTop(wearer.size, scale)) return null;

    const rate = GROWTH_PER_YEAR[band];
    const likelihood = Math.min(0.9, rate * (months / 12));
    if (likelihood < GROWTH_THRESHOLD) return null;

    const who = band === 'peak'
      ? 'players this age usually move up within a season'
      : band === 'child'
        ? 'younger players grow fastest'
        : 'still growing, though more slowly';

    return {
      delta: 1,
      confidence: likelihood,
      because: `Sized ${describeMonths(months)} — ${who}.`,
    };
  },
};

// ── 2. Size history ────────────────────────────────────────────────────
// What this individual actually did last time, which beats any average.
// Needs two confirmed sizes; with one it has nothing to compare.

export const sizeHistory: FitSignal = {
  id: 'size-history',
  label: 'This wearer’s own history',

  evaluate({ wearer, scale, asOf }) {
    const history = (wearer.history ?? [])
      .map(h => ({ ...h, date: parseDate(h.at) }))
      .filter((h): h is typeof h & { date: Date } => !!h.date)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (history.length < 2) return null;

    const first = history[0];
    const last = history[history.length - 1];
    const moved = stepsBetween(first.size, last.size, scale);
    if (moved === null) return null;

    const spanMonths = monthsBetween(first.date, last.date);
    if (spanMonths < 1) return null;

    const stepsPerYear = moved / (spanMonths / 12);
    const sinceLast = monthsBetween(last.date, asOf);
    const projected = stepsPerYear * (sinceLast / 12);

    const delta = Math.round(projected);
    if (delta === 0) return null;
    if (atTop(wearer.size, scale) && delta > 0) return null;

    // Two data points is a line, not a trend. Confidence rises with the
    // number of observations and falls as we project further past the last one.
    const observations = Math.min(history.length, 4);
    const base = 0.35 + 0.15 * (observations - 1);
    const decay = Math.max(0.5, 1 - sinceLast / 36);

    return {
      delta,
      confidence: Math.min(0.9, base * decay + 0.1),
      because: moved > 0
        ? `Moved up ${moved} size${Math.abs(moved) === 1 ? '' : 's'} over the last ${Math.round(spanMonths)} months.`
        : `Has moved down the scale across ${history.length} previous orders.`,
    };
  },
};

// ── 3. Return signal ───────────────────────────────────────────────────
// The signal the whole retail fit-tech category is built on. Fires only for
// brands that take returns — silent everywhere else, by design.

export const returnSignal: FitSignal = {
  id: 'return-signal',
  label: 'Previous return reason',

  evaluate({ wearer, scale }) {
    const returns = (wearer.returns ?? [])
      .map(r => ({ ...r, date: parseDate(r.at) }))
      .filter((r): r is typeof r & { date: Date } => !!r.date)
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    const latest = returns.find(r => r.reason !== 'other');
    if (!latest) return null;

    // Only act when the returned size is the one still on the line — if they
    // have already moved on from it, the return has been dealt with.
    if (normalizeSize(latest.size) !== normalizeSize(wearer.size)) return null;

    const delta = latest.reason === 'too-small' ? 1 : -1;
    if (delta > 0 && atTop(wearer.size, scale)) return null;

    return {
      delta,
      confidence: 0.85,
      because: `Returned a ${normalizeSize(latest.size)} as ${latest.reason === 'too-small' ? 'too small' : 'too large'}.`,
    };
  },
};

// ── 4. Fit preference vs cut ───────────────────────────────────────────
// A stated preference only matters when the garment disagrees with it.

const CUT_POSITION: Record<StyleFitProfile['cut'], number> = {
  compression: -1.5, athletic: -0.5, standard: 0, relaxed: 1,
};
const PREF_POSITION: Record<NonNullable<Wearer['fitPreference']>, number> = {
  compression: -1.5, athletic: -0.5, true: 0, relaxed: 1,
};

export const fitPreference: FitSignal = {
  id: 'fit-preference',
  label: 'Stated fit preference',

  evaluate({ wearer, style, scale }) {
    if (!wearer.fitPreference || !style) return null;

    const gap = PREF_POSITION[wearer.fitPreference] - CUT_POSITION[style.cut];
    const delta = Math.round(gap / 1.5);
    if (delta === 0) return null;
    if (delta > 0 && atTop(wearer.size, scale)) return null;

    return {
      delta,
      confidence: 0.5,
      because: `Prefers a ${wearer.fitPreference} fit; this style is cut ${style.cut}.`,
    };
  },
};

// ── 5. Style offset ────────────────────────────────────────────────────
// Per-style, not per-brand. This is how a substituted style stops being a
// silent size change — the classic "we swapped the discontinued style and
// nobody mentioned it runs small".

export const styleOffset: FitSignal = {
  id: 'style-offset',
  label: 'How this style runs',

  evaluate({ style, wearer, scale }) {
    if (!style || style.runs === 0) return null;
    const delta = -style.runs; // runs small (−1) → size up (+1)
    if (delta > 0 && atTop(wearer.size, scale)) return null;

    return {
      delta,
      confidence: 0.6,
      because: `${style.styleName || style.styleId} runs ${style.runs < 0 ? 'small' : 'large'}.`,
    };
  },
};

// ── 6. Measurement chart ───────────────────────────────────────────────
// Self-reported measurements against the brand's chart. Hard-gated: it
// refuses outright on a youth scale or when the brand disallows body data.
// No photos, no scans, no inference — the input is a number the wearer typed.

export const measurementChart: FitSignal = {
  id: 'measurement-chart',
  label: 'Measurement against the size chart',

  evaluate({ wearer, scale, allowBodyMeasurement }) {
    if (!allowBodyMeasurement) return null;
    if (scale.typicallyMinors) return null;

    const chest = wearer.measurements?.chestIn;
    if (!chest || chest <= 0) return null;

    const target = sizeForChest(chest, scale);
    if (!target) return null;

    const delta = stepsBetween(wearer.size, target, scale);
    if (delta === null || delta === 0) return null;

    return {
      delta,
      confidence: 0.65,
      because: `${chest}" chest maps to ${target} on our chart.`,
    };
  },
};

// ── Registry ───────────────────────────────────────────────────────────
export const ALL_SIGNALS: Record<FitSignalId, FitSignal> = {
  'elapsed-growth': elapsedGrowth,
  'size-history': sizeHistory,
  'return-signal': returnSignal,
  'fit-preference': fitPreference,
  'style-offset': styleOffset,
  'measurement-chart': measurementChart,
};
