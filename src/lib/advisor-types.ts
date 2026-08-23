// ═══════════════════════════════════════════════════════════════════════
// Fit Advisor — the shopper-facing "What's my size?" widget.
//
// Different problem from the batch review in services/fit/engine.ts:
//
//   engine.ts  → an operator looking at many wearers, using history.
//   advisor.ts → ONE shopper who has no history at all, standing on a
//                product page, about to guess.
//
// The advisor answers the cold-start case, which is the one the whole
// retail fit-tech category exists for. It has no purchase record to lean
// on, so it works forward from what the shopper can tell it in ten seconds.
//
// Two entry routes, because shoppers differ:
//   1. Height, weight, age  → estimated body → matched against the garment.
//   2. "I wear a M in <brand>" → that brand's garment worked backwards into
//      a body estimate, then matched against ours.
//
// Both converge on the same body estimate, so the rest of the pipeline is
// shared.
// ═══════════════════════════════════════════════════════════════════════

/** Which measurement set a garment is cut against. Not a statement about the wearer. */
export type SizingChart = 'mens' | 'womens' | 'unisex';

export type FitPreferenceLevel = 'snug' | 'regular' | 'relaxed';

export type BodyZone = 'chest' | 'waist' | 'hip' | 'inseam';

export const ZONE_LABEL: Record<BodyZone, string> = {
  chest: 'Chest',
  waist: 'Waist',
  hip: 'Hip',
  inseam: 'Length',
};

// ── Input ──────────────────────────────────────────────────────────────

export interface AdvisorAnswers {
  /** Total height in inches. */
  heightIn?: number;
  /** Weight in pounds. */
  weightLb?: number;
  /** Years. Used only for a small posture/waist adjustment. */
  age?: number;
  chart?: SizingChart;
  preference?: FitPreferenceLevel;
  /** The "I wear a M in X" route. */
  reference?: { brandId: string; size: string };

  /**
   * Measurements the shopper corrected by hand.
   *
   * An estimate from height and weight is a population average, and plenty
   * of people know they are not it — broad shoulders on a light frame, a
   * small waist for the chest. Letting them say so is the difference between
   * a tool that argues with them and one they trust. Overrides win outright.
   */
  overrides?: { chest?: number; waist?: number; hip?: number; inseam?: number };
}

// ── Body estimate ──────────────────────────────────────────────────────

export interface BodyEstimate {
  /** Inches, circumference. Only the zones we can estimate are present. */
  chest?: number;
  waist?: number;
  hip?: number;
  /** Inches, crotch to floor. A length, not a circumference — see below. */
  inseam?: number;
  /** 0–1. Falls off outside the range the model is reliable in. */
  confidence: number;
  /** How this estimate was produced, in plain words. */
  source: string;
  /** Set when the inputs sit outside the range we trust. */
  caveat?: string;
}

// ── Garment ────────────────────────────────────────────────────────────

export type GarmentCategory = 'top' | 'bottom';

/**
 * What the garment actually looks like.
 *
 * Without this every top is drawn as the same short-sleeved shape, so a
 * dress shirt, a crew tee and a sleeveless jersey render identically — which
 * makes the whole model look like one asset reused, because it is.
 */
export interface GarmentSilhouette {
  sleeve: 'none' | 'cap' | 'short' | 'threequarter' | 'long';
  /** Where the hem falls, as a fraction of total height from the floor. */
  hem: 'waist' | 'high-hip' | 'hip' | 'below-hip' | 'thigh' | 'above-knee' | 'knee' | 'calf' | 'ankle';
  /** A raised collar rather than a plain neckline. */
  collar?: boolean;
  /** How close the garment is cut, independent of its measurements. */
  drape?: 'fitted' | 'standard' | 'loose';
}

export interface GarmentSpec {
  styleId: string;
  styleName: string;
  brandId: string;
  category: GarmentCategory;
  chart: SizingChart;
  /** Which zones decide the fit of this garment, most important first. */
  zones: BodyZone[];
  /**
   * Finished garment measurements in inches, per size, per zone. These are
   * the garment, not the body — ease is the difference between the two, and
   * ease is the whole game.
   */
  measurements: Record<string, Partial<Record<BodyZone, number>>>;
  /** How much stretch the fabric has, in inches of forgiveness at the chest. */
  stretchIn: number;
  /** Drawn shape. Defaults to a short-sleeve hip-length top if absent. */
  silhouette?: GarmentSilhouette;
}

// ── Output ─────────────────────────────────────────────────────────────

export type EaseVerdict = 'very-tight' | 'snug' | 'just-right' | 'relaxed' | 'loose';

export const EASE_LABEL: Record<EaseVerdict, string> = {
  'very-tight': 'Very tight',
  snug: 'Snug',
  'just-right': 'Just right',
  relaxed: 'Relaxed',
  loose: 'Loose',
};

/**
 * Length reads differently from girth.
 *
 * Ease is room around the body and more of it is a preference. Length is a
 * match: a 30″ inseam on a 30″ leg is simply correct, and being "relaxed" in
 * the leg means the hem is dragging on the floor. Same verdict scale, honest
 * words for what it means.
 */
export const LENGTH_LABEL: Record<EaseVerdict, string> = {
  'very-tight': 'Much too short',
  snug: 'A little short',
  'just-right': 'Right length',
  relaxed: 'A little long',
  loose: 'Much too long',
};

export function verdictLabel(zone: BodyZone, verdict: EaseVerdict): string {
  return zone === 'inseam' ? LENGTH_LABEL[verdict] : EASE_LABEL[verdict];
}

export interface ZoneFit {
  zone: BodyZone;
  /** Inches of room between the garment and the body. Negative means it stretches. */
  easeIn: number;
  verdict: EaseVerdict;
  /**
   * 0–1 position on a tight→loose axis, for the fit bar. 0.5 is the middle of
   * the shopper's chosen preference.
   */
  position: number;
}

export interface SizeOption {
  size: string;
  zones: ZoneFit[];
  /** Lower is better. Internal, not shown. */
  score: number;
  /** One line describing how this size will feel. */
  verdict: string;
}

export interface AdvisorResult {
  recommended: SizeOption | null;
  /** The next size either way, when it is a genuinely close call. */
  alternates: SizeOption[];
  confidence: number;
  band: 'high' | 'medium' | 'low';
  body: BodyEstimate;
  /** Short sentences explaining the pick. */
  reasons: string[];
  /** Shown when we would rather the shopper knew something. */
  caveats: string[];
  garment: GarmentSpec;
  preference: FitPreferenceLevel;
}
