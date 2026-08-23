// ═══════════════════════════════════════════════════════════════════════
// The fit engine.
//
// Runs every signal the brand has switched on, combines the readings into
// one proposed size per wearer, and hands back evidence in plain English.
//
// Three rules it does not break:
//
//   1. It proposes; a human accepts. Nothing is applied here.
//   2. Every suggestion carries the sentences that produced it. A number a
//      coach cannot interrogate is a number she will not trust.
//   3. Silence is a valid answer. Below the brand's confidence bar we say
//      nothing rather than guess out loud — the cost of nagging a coach
//      about thirteen players is that she stops reading the thirteenth.
// ═══════════════════════════════════════════════════════════════════════

import {
  BrandFitProfile, FitReview, FitSignalId, SignalEvidence, SizeSuggestion,
  SkippedWearer, StyleFitProfile, Wearer, ageBandForGrade, bandFor,
} from '@/lib/fit-types';
import { atTop, detectScale, indexOf, normalizeSize, step } from './size-scales';
import { ALL_SIGNALS, SignalContext } from './signals';
import { hydrate } from './return-store';

export interface ReviewInput {
  brand: BrandFitProfile;
  wearers: Wearer[];
  style?: StyleFitProfile;
  /** Fallback "last confirmed" date — usually the previous order's date. */
  defaultSizedAt?: string;
  /** Injectable so the same input always produces the same output in tests. */
  asOf?: Date;
}

interface WearerOutcome {
  suggestion?: SizeSuggestion;
  unchanged?: SkippedWearer;
  skipped?: SkippedWearer;
  signalsUsed: FitSignalId[];
}

function reviewOne(
  wearer: Wearer,
  input: ReviewInput,
  asOf: Date
): WearerOutcome {
  const { brand, style, defaultSizedAt } = input;
  const scale = detectScale(wearer.size, style?.scaleHint);
  const label = wearer.name?.trim() || `#${wearer.id}`;

  // A size we do not recognise cannot be stepped, so say so rather than
  // silently dropping the line from the review.
  if (indexOf(wearer.size, scale) < 0) {
    return {
      signalsUsed: [],
      skipped: {
        wearerId: wearer.id,
        wearerName: label,
        why: wearer.size?.trim()
          ? `“${wearer.size}” is not on the ${scale.label.toLowerCase()} scale.`
          : 'No size on this line yet.',
      },
    };
  }

  const ctx: SignalContext = {
    wearer,
    scale,
    style,
    asOf,
    defaultSizedAt,
    allowBodyMeasurement: brand.policy.allowBodyMeasurement && !brand.policy.assumeMinors,
  };

  // ── Gather ───────────────────────────────────────────────────────────
  const evidence: SignalEvidence[] = [];
  const signalsUsed: FitSignalId[] = [];

  for (const [id, weight] of Object.entries(brand.signals) as [FitSignalId, number][]) {
    if (!weight) continue;
    const signal = ALL_SIGNALS[id];
    if (!signal) continue;

    const reading = signal.evaluate(ctx);
    if (!reading || reading.delta === 0) continue;

    signalsUsed.push(id);
    evidence.push({ ...reading, signal: id, label: signal.label, weight });
  }

  if (!evidence.length) {
    // Nothing fired. If they are already at the largest size we make, that is
    // usually *why* nothing fired — the up-signals all decline to suggest a
    // size that does not exist. Say so, rather than letting it read as "we
    // checked and they're fine". The two mean very different things.
    if (atTop(wearer.size, scale)) {
      return {
        signalsUsed,
        skipped: {
          wearerId: wearer.id,
          wearerName: label,
          why: `Already at ${normalizeSize(wearer.size)}, the largest size in this range.`,
        },
      };
    }
    return {
      signalsUsed,
      unchanged: {
        wearerId: wearer.id,
        wearerName: label,
        why: describeNoChange(wearer, brand),
      },
    };
  }

  // ── Combine ──────────────────────────────────────────────────────────
  // Weighted mean of the deltas, where each signal's vote is scaled by both
  // the brand's trust in it and its own confidence in this particular read.
  let weightedDelta = 0;
  let mass = 0;
  for (const e of evidence) {
    weightedDelta += e.delta * e.weight * e.confidence;
    mass += e.weight * e.confidence;
  }
  if (mass === 0) {
    return { signalsUsed, unchanged: { wearerId: wearer.id, wearerName: label, why: describeNoChange(wearer, brand) } };
  }

  const raw = weightedDelta / mass;
  let delta = Math.round(raw);
  delta = Math.max(-brand.policy.maxStep, Math.min(brand.policy.maxStep, delta));

  if (delta === 0) {
    return {
      signalsUsed,
      unchanged: {
        wearerId: wearer.id,
        wearerName: label,
        why: 'Signals disagreed — leaving the size as it is.',
      },
    };
  }

  if (delta > 0 && atTop(wearer.size, scale)) {
    return {
      signalsUsed,
      skipped: {
        wearerId: wearer.id,
        wearerName: label,
        why: `Already at ${normalizeSize(wearer.size)}, the largest size in this range.`,
      },
    };
  }

  const to = step(wearer.size, delta, scale);
  if (!to || normalizeSize(to) === normalizeSize(wearer.size)) {
    return {
      signalsUsed,
      unchanged: { wearerId: wearer.id, wearerName: label, why: 'No larger size available on this scale.' },
    };
  }

  // ── Score ────────────────────────────────────────────────────────────
  // Signals pointing in opposite directions should not add up to certainty.
  // Agreement is the share of the total mass that voted the way we landed.
  const agreeingMass = evidence
    .filter(e => Math.sign(e.delta) === Math.sign(delta))
    .reduce((sum, e) => sum + e.weight * e.confidence, 0);
  const agreement = agreeingMass / mass;

  // More independent signals saying the same thing is worth something, but
  // not unbounded — cap well short of certainty.
  const corroboration = 1 + 0.12 * Math.max(0, evidence.length - 1);
  const strongest = Math.max(...evidence.map(e => e.confidence));
  const confidence = Math.min(0.95, strongest * agreement * corroboration);

  if (confidence < brand.policy.minConfidence) {
    return {
      signalsUsed,
      unchanged: {
        wearerId: wearer.id,
        wearerName: label,
        why: 'Not confident enough to raise it.',
      },
    };
  }

  const ordered = [...evidence].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);

  return {
    signalsUsed,
    suggestion: {
      wearerId: wearer.id,
      wearerName: label,
      from: normalizeSize(wearer.size),
      to: normalizeSize(to),
      delta,
      confidence,
      band: bandFor(confidence),
      headline: ordered[0].because,
      evidence: ordered,
    },
  };
}

/** Why a wearer came back clean — worth saying, so coverage is visible. */
function describeNoChange(wearer: Wearer, brand: BrandFitProfile): string {
  const band = wearer.ageBand ?? ageBandForGrade(wearer.gradeLevel);
  if (band === 'senior') return 'Final year — unlikely to have changed.';
  if (band === 'adult' || (!band && !brand.policy.assumeMinors)) return 'Nothing suggests a change.';
  return 'Nothing on record suggests a change.';
}

// ── Public entry point ─────────────────────────────────────────────────

export function reviewSizes(input: ReviewInput): FitReview {
  const asOf = input.asOf ?? new Date();
  const { brand } = input;

  const suggestions: SizeSuggestion[] = [];
  const unchanged: SkippedWearer[] = [];
  const skipped: SkippedWearer[] = [];
  const signalsUsed = new Set<FitSignalId>();

  for (const rawWearer of input.wearers) {
    // Fold in any returns recorded since this wearer's record was loaded.
    // Without this the return-signal only ever sees seeded data and the
    // engine cannot learn from a return the shopper just made.
    const wearer = hydrate(rawWearer);
    const outcome = reviewOne(wearer, input, asOf);
    outcome.signalsUsed.forEach(s => signalsUsed.add(s));
    if (outcome.suggestion) suggestions.push(outcome.suggestion);
    if (outcome.unchanged) unchanged.push(outcome.unchanged);
    if (outcome.skipped) skipped.push(outcome.skipped);
  }

  // Most confident first — the coach reads from the top and stops when she
  // stops agreeing, so the strongest cases have to be there.
  suggestions.sort((a, b) => b.confidence - a.confidence);

  return {
    brandId: brand.brandId,
    reviewed: input.wearers.length,
    suggestions,
    unchanged,
    skipped,
    summary: buildSummary(brand, input.wearers.length, suggestions),
    policyNotes: buildPolicyNotes(brand),
    signalsUsed: [...signalsUsed],
  };
}

function buildSummary(
  brand: BrandFitProfile,
  reviewed: number,
  suggestions: SizeSuggestion[]
): string {
  const { wearerNoun, wearerNounPlural, groupNoun } = brand.copy;
  if (reviewed === 0) return `Nothing on the ${groupNoun} to check.`;

  if (!suggestions.length) {
    return `Checked all ${reviewed} ${reviewed === 1 ? wearerNoun : wearerNounPlural} — every size still looks right.`;
  }

  const n = suggestions.length;
  const names = suggestions.slice(0, 3).map(s => s.wearerName.split(/\s+/).slice(-1)[0] || s.wearerName);
  const list = n <= 3
    ? names.join(n === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1')
    : `${names.join(', ')} and ${n - 3} more`;

  return `${n} of ${reviewed} ${n === 1 ? wearerNoun : wearerNounPlural} may need a different size — ${list}.`;
}

function buildPolicyNotes(brand: BrandFitProfile): string[] {
  const notes: string[] = [];

  if (!brand.policy.allowBodyMeasurement || brand.policy.assumeMinors) {
    notes.push(
      brand.policy.assumeMinors
        ? 'No body measurements are collected or used — wearers are minors.'
        : 'No body measurements are collected or used.'
    );
  }
  if (!brand.policy.autoApply) {
    notes.push('Nothing is changed until you accept it.');
  }
  return notes;
}

// ── Convenience: apply a suggestion ────────────────────────────────────
// Kept here rather than in the reducer so the "what does accepting mean"
// answer lives next to the engine that proposed it.

export function applySuggestion<T extends { id: string; size: string }>(
  rows: T[],
  suggestion: SizeSuggestion
): T[] {
  return rows.map(r => (r.id === suggestion.wearerId ? { ...r, size: suggestion.to } : r));
}
