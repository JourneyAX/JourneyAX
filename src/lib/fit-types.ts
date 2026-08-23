// ═══════════════════════════════════════════════════════════════════════
// Fit & size intelligence — domain model.
//
// Deliberately brand-neutral. Nothing in this file knows about Augusta,
// rosters, sport or sublimation. A team-sports reorder and a retail fashion
// purchase both reduce to the same question:
//
//     "Given what we already know about this wearer, is the size on this
//      line still the right one — and can we say why?"
//
// The differences between brands live in a BrandFitProfile (which signals
// are available, how much each is trusted, what the wearers are called),
// never in the engine.
//
// Design rule: this engine NEVER decides. It proposes, with evidence, and a
// human accepts. A size that is silently changed is a size the customer did
// not agree to.
// ═══════════════════════════════════════════════════════════════════════

// ── Size scales ────────────────────────────────────────────────────────
// A scale is an ordered list, so "one size up" is arithmetic rather than a
// lookup table. Adding a scale is enough to support a new product category.

export type SizeSystemId =
  | 'youth-athletic'
  | 'adult-athletic'
  | 'unisex-alpha'
  | 'womens-numeric'
  | 'mens-waist';

export interface SizeScale {
  id: SizeSystemId;
  label: string;
  /** Smallest → largest. Adjacent entries are exactly one step apart. */
  steps: string[];
  /** True when this scale is normally worn by under-18s. Gates body-data policy. */
  typicallyMinors?: boolean;
}

// ── The wearer ─────────────────────────────────────────────────────────
// A "wearer" is whoever ends up in the garment: a player on a roster, or a
// shopper buying for themselves. Every field is optional except identity and
// the current size — brands populate whichever signals they actually hold.

export type AgeBand = 'child' | 'peak' | 'late' | 'senior' | 'adult';
export type FitPreference = 'compression' | 'athletic' | 'true' | 'relaxed';

export interface WearerSizeRecord {
  /** MM/DD/YYYY or ISO. */
  at: string;
  size: string;
  styleId?: string;
}

export interface WearerReturn {
  at: string;
  size: string;
  reason: 'too-small' | 'too-large' | 'other';
}

export interface Wearer {
  id: string;
  name: string;
  /** The size currently on the line under review. */
  size: string;

  /** US grade 1–12 when known. The strongest cheap growth predictor we have. */
  gradeLevel?: number;
  ageBand?: AgeBand;

  /** When this size was last confirmed. Defaults to the order date. */
  sizedAt?: string;
  /** Previously confirmed sizes, oldest first. */
  history?: WearerSizeRecord[];

  /** Retail signals. Absent in made-to-order businesses — the engine copes. */
  fitPreference?: FitPreference;
  returns?: WearerReturn[];

  /**
   * Self-reported measurements only. Never a body scan, never inferred from
   * a photo — see BrandFitPolicy.allowBodyMeasurement.
   */
  measurements?: { chestIn?: number; waistIn?: number; heightIn?: number };
}

// ── The garment ────────────────────────────────────────────────────────
export type GarmentCut = 'compression' | 'athletic' | 'standard' | 'relaxed';

export interface StyleFitProfile {
  styleId: string;
  styleName?: string;
  cut: GarmentCut;
  /** −1 runs small, 0 true to size, +1 runs large. Per style, not per brand. */
  runs: -1 | 0 | 1;
  /** Overrides scale detection when a style uses an unusual scale. */
  scaleHint?: SizeSystemId;
}

// ── Signals ────────────────────────────────────────────────────────────
// Each signal answers one narrow question and returns a size delta it
// believes in, plus a sentence a human can read. A signal that has no data
// returns null and the engine simply proceeds without it.

export type FitSignalId =
  | 'elapsed-growth'
  | 'size-history'
  | 'return-signal'
  | 'fit-preference'
  | 'style-offset'
  | 'measurement-chart';

export interface SignalReading {
  /** Size steps to move. Positive is larger. */
  delta: number;
  /** 0–1. How much this signal trusts its own reading. */
  confidence: number;
  /** Plain sentence shown to the human. No jargon, no percentages-as-truth. */
  because: string;
}

export interface SignalEvidence extends SignalReading {
  signal: FitSignalId;
  label: string;
  /** The brand's trust in this signal, from the profile. */
  weight: number;
}

// ── Output ─────────────────────────────────────────────────────────────
export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface SizeSuggestion {
  wearerId: string;
  wearerName: string;
  from: string;
  to: string;
  delta: number;
  confidence: number;
  band: ConfidenceBand;
  /** One line, written for the buyer rather than the operator. */
  headline: string;
  evidence: SignalEvidence[];
}

export interface SkippedWearer {
  wearerId: string;
  wearerName: string;
  why: string;
}

export interface FitReview {
  brandId: string;
  reviewed: number;
  suggestions: SizeSuggestion[];
  /** Looked at, nothing to say. Kept so the human sees full coverage. */
  unchanged: SkippedWearer[];
  /** Could not be assessed — missing data, or blocked by policy. */
  skipped: SkippedWearer[];
  /** One sentence for the chat bubble / panel header. */
  summary: string;
  /** Policy decisions worth stating out loud, e.g. body data not used. */
  policyNotes: string[];
  /** Signals that contributed at all, for the "how did you know" question. */
  signalsUsed: FitSignalId[];
}

// ── Brand configuration ────────────────────────────────────────────────

export interface BrandFitPolicy {
  /**
   * Whether self-reported body measurements may be used at all. Set false for
   * any brand whose wearers are minors — biometric and child-privacy law is
   * not worth the extra half-point of accuracy.
   */
  allowBodyMeasurement: boolean;
  /** Treat wearers as minors regardless of what the data says. */
  assumeMinors: boolean;
  /** Never move more than this many steps in one suggestion. */
  maxStep: number;
  /** Below this confidence, say nothing rather than guess out loud. */
  minConfidence: number;
  /**
   * Suggestions are applied automatically. Almost always false: a size the
   * customer did not agree to is a return, or a reprint.
   */
  autoApply: boolean;
}

export interface BrandFitCopy {
  /** "player", "customer", "wearer" — used in generated sentences. */
  wearerNoun: string;
  wearerNounPlural: string;
  /** "roster", "order", "basket". */
  groupNoun: string;
}

export interface BrandFitProfile {
  brandId: string;
  brandName: string;
  /** Signal id → trust weight. Omitted signals are switched off for this brand. */
  signals: Partial<Record<FitSignalId, number>>;
  policy: BrandFitPolicy;
  copy: BrandFitCopy;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse MM/DD/YYYY (COMS) or anything Date understands. Null when unusable. */
export function parseDate(value?: string): Date | null {
  if (!value) return null;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12
    + (to.getMonth() - from.getMonth())
    + (to.getDate() - from.getDate()) / 30.4;
}

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.45) return 'medium';
  return 'low';
}

/** US grade → the growth band that grade sits in. */
export function ageBandForGrade(grade?: number): AgeBand | undefined {
  if (grade === undefined) return undefined;
  if (grade <= 6) return 'child';
  if (grade <= 9) return 'peak';
  if (grade <= 11) return 'late';
  if (grade === 12) return 'senior';
  return 'adult';
}
