// ═══════════════════════════════════════════════════════════════════════
// Body estimate.
//
// Turns what a shopper will actually tell you — height, weight, roughly how
// old they are — into the three circumferences a garment is cut against.
//
// Two things to be honest about, both surfaced in the UI rather than buried:
//
//   1. These are population averages, not this person. Two shoppers with
//      identical height and weight can be two sizes apart. That is why the
//      advisor reports a confidence and offers the neighbouring size instead
//      of pretending to a precision it does not have.
//   2. The coefficients below are fitted to published apparel sizing charts,
//      not to a measured sample of our own customers. They are declared in
//      one place so they can be replaced the day we have real data.
//
// No body scan, no photo, no inference from anything the shopper did not
// type. Height and weight are used to size clothing and for nothing else —
// we never derive or display a health metric from them.
// ═══════════════════════════════════════════════════════════════════════

import { AdvisorAnswers, BodyEstimate, SizingChart } from '@/lib/advisor-types';

/** Coefficients per chart. `base` is the ratio to height at `refBmi`. */
const MODEL: Record<SizingChart, {
  refBmi: number;
  chest: { base: number; perBmi: number };
  waist: { base: number; perBmi: number };
  hip: { base: number; perBmi: number };
}> = {
  mens: {
    refBmi: 22,
    chest: { base: 0.550, perBmi: 0.0157 },
    waist: { base: 0.470, perBmi: 0.0210 },
    hip: { base: 0.535, perBmi: 0.0150 },
  },
  womens: {
    refBmi: 21.5,
    chest: { base: 0.545, perBmi: 0.0157 },
    waist: { base: 0.425, perBmi: 0.0200 },
    hip: { base: 0.575, perBmi: 0.0165 },
  },
  // Unisex garments are cut to a middle set. Averaging the two models is
  // cruder than having its own, and is flagged as lower confidence below.
  unisex: {
    refBmi: 21.75,
    chest: { base: 0.5475, perBmi: 0.0157 },
    waist: { base: 0.4475, perBmi: 0.0205 },
    hip: { base: 0.555, perBmi: 0.01575 },
  },
};

/**
 * Inseam as a fraction of height.
 *
 * Deliberately has no weight term: leg length is skeletal, and two people of
 * the same height wear the same inseam whatever they weigh. Getting this
 * wrong is why so many size charts quietly assume everyone is 5'10".
 */
const INSEAM_RATIO: Record<SizingChart, number> = {
  mens: 0.455, womens: 0.465, unisex: 0.460,
};

/** The range the model was fitted over. Outside it, confidence drops. */
const TRUSTED = { bmiLo: 18, bmiHi: 32, heightLo: 58, heightHi: 78 };

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Height and weight → chest, waist and hip.
 *
 * Weight enters only through BMI, which is used here purely as a build index
 * for garment sizing. Nothing about it is reported to the shopper.
 */
export function estimateBody(answers: AdvisorAnswers): BodyEstimate | null {
  const { heightIn, weightLb, age } = answers;
  const chart: SizingChart = answers.chart ?? 'unisex';

  if (!heightIn || !weightLb || heightIn <= 0 || weightLb <= 0) return null;

  const m = MODEL[chart];
  const bmi = (703 * weightLb) / (heightIn * heightIn);
  const d = bmi - m.refBmi;

  let chest = heightIn * (m.chest.base + m.chest.perBmi * d);
  let waist = heightIn * (m.waist.base + m.waist.perBmi * d);
  const hip = heightIn * (m.hip.base + m.hip.perBmi * d);

  // Waist thickens with age at roughly a tenth of an inch a year past thirty,
  // and the chest follows a little. Capped — the trend flattens, and we would
  // rather under-adjust than tell a 70-year-old they are two sizes bigger.
  if (age && age > 30) {
    const years = Math.min(age - 30, 30);
    waist += years * 0.09;
    chest += years * 0.035;
  }

  // ── Confidence ───────────────────────────────────────────────────────
  let confidence = 0.82;
  const notes: string[] = [];

  if (bmi < TRUSTED.bmiLo || bmi > TRUSTED.bmiHi) {
    confidence -= 0.22;
    notes.push('your measurements sit outside the range this estimate is most reliable in');
  }
  if (heightIn < TRUSTED.heightLo || heightIn > TRUSTED.heightHi) {
    confidence -= 0.12;
    notes.push('your height is outside our usual range');
  }
  if (chart === 'unisex') {
    confidence -= 0.06;
  }
  if (!age) confidence -= 0.03;

  return {
    chest: round(chest),
    waist: round(waist),
    hip: round(hip),
    inseam: round(heightIn * INSEAM_RATIO[chart]),
    confidence: Math.max(0.25, Math.min(0.88, confidence)),
    source: 'Estimated from your height and weight',
    caveat: notes.length
      ? `We are less certain here — ${notes.join(', and ')}.`
      : undefined,
  };
}

// ── Route 2: "I wear a medium in <brand>" ──────────────────────────────
// Works the garment backwards. If a shopper is happily wearing a brand's
// medium, their body is somewhere near that garment minus its intended ease.
// It is a rougher estimate than height and weight, and it says so — but it
// takes one tap, and a shopper who will not type their weight will use it.

export interface ReferenceBrand {
  id: string;
  name: string;
  /** Finished chest measurement, in inches, per size, for a standard tee. */
  chestBySize: Record<string, number>;
  /** Ease this brand cuts into that garment. Subtracted to recover the body. */
  intendedEaseIn: number;
  /** Waist is estimated as a ratio of chest — brands do not publish it consistently. */
  waistRatio: number;
}

/**
 * Reference brands. Real spec sheets vary; these are representative and
 * deliberately different from one another, because "your M there is an L
 * here" is the single most useful thing this route can tell someone.
 */
export const REFERENCE_BRANDS: ReferenceBrand[] = [
  {
    id: 'generic-us',
    name: 'A standard US brand',
    chestBySize: { XS: 34, S: 37, M: 40, L: 44, XL: 48, '2XL': 52 },
    intendedEaseIn: 4,
    waistRatio: 0.88,
  },
  {
    id: 'athletic-slim',
    name: 'An athletic brand (slim cut)',
    chestBySize: { XS: 31, S: 34, M: 37, L: 40, XL: 44, '2XL': 48 },
    intendedEaseIn: 2,
    waistRatio: 0.86,
  },
  {
    // Vanity sizing is real: a relaxed heritage brand's medium fits a
    // noticeably larger body than an athletic brand's medium. Keeping that
    // spread is the point of this route — "your M there is an L here" is the
    // most useful sentence it can produce.
    id: 'heritage-relaxed',
    name: 'A heritage brand (relaxed cut)',
    chestBySize: { XS: 38, S: 42, M: 46, L: 50, XL: 54, '2XL': 58 },
    intendedEaseIn: 8,
    waistRatio: 0.9,
  },
];

export function getReferenceBrand(id: string): ReferenceBrand | undefined {
  return REFERENCE_BRANDS.find(b => b.id === id);
}

export function estimateBodyFromReference(
  brandId: string,
  size: string
): BodyEstimate | null {
  const brand = getReferenceBrand(brandId);
  if (!brand) return null;

  const garmentChest = brand.chestBySize[size];
  if (!garmentChest) return null;

  const chest = garmentChest - brand.intendedEaseIn;

  return {
    chest: round(chest),
    waist: round(chest * brand.waistRatio),
    confidence: 0.6,
    source: `Worked back from a ${size} at ${brand.name.toLowerCase()}`,
    caveat:
      'This route assumes that size fits you the way the brand intended. '
      + 'Height and weight give a closer answer.',
  };
}

/** Whichever route the shopper took, produce one estimate. */
export function resolveBody(answers: AdvisorAnswers): BodyEstimate | null {
  const base = answers.reference
    ? estimateBodyFromReference(answers.reference.brandId, answers.reference.size)
    : estimateBody(answers);
  if (!base) return null;

  // A measurement the shopper typed beats one we inferred, every time, and
  // it raises confidence rather than lowering it — they know their own body
  // better than a regression does.
  // The reference-brand route recovers girth from a garment but tells us
  // nothing about leg length, so fill inseam from height when we have it and
  // otherwise leave it absent rather than guess.
  if (base.inseam === undefined && answers.heightIn) {
    base.inseam = round(answers.heightIn * INSEAM_RATIO[answers.chart ?? 'unisex']);
  }

  const o = answers.overrides;
  const edited = (['chest', 'waist', 'hip', 'inseam'] as const).filter(k => o?.[k] && o[k]! > 0);
  if (!edited.length) return base;

  const next: BodyEstimate = { ...base };
  for (const k of edited) next[k] = o![k];

  const named = edited.map(k => (k === 'inseam' ? 'leg length' : k));
  next.confidence = Math.min(0.94, base.confidence + 0.05 * edited.length);
  next.source = edited.length >= 3
    ? 'Your own measurements'
    : `${base.source}, with your ${named.join(' and ')} as you entered ${edited.length === 1 ? 'it' : 'them'}`;
  // The caveat was about the estimate. Once they have corrected most of it,
  // it no longer describes what we are working from.
  if (edited.length >= 3) next.caveat = undefined;
  return next;
}

// ── Height helpers, because shoppers think in feet and inches ──────────

export function toInches(feet: number, inches: number): number {
  return feet * 12 + inches;
}

export function formatHeight(totalIn: number): string {
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  return `${ft}′ ${inch}″`;
}
