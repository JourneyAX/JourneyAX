// ═══════════════════════════════════════════════════════════════════════
// The Fit Advisor.
//
// One shopper, one garment, one answer — plus the reason, and the honest
// admission when it is close.
//
// The mechanism is ease: the difference between the finished garment and
// the estimated body, zone by zone. A size is not "right" in the abstract;
// it is right for how this person wants it to sit. So the shopper's stated
// preference sets the target ease, and we pick the size whose ease profile
// lands nearest that target.
//
// Deliberate behaviours:
//   · When two sizes score within a hair of each other, we say so rather
//     than picking one and sounding certain. "Between sizes" is a real
//     answer and shoppers trust it more than false precision.
//   · Stretch is forgiveness in one direction only. A knit that is slightly
//     small still wears; a woven that is slightly small does not.
//   · Tight in the primary zone is penalised harder than loose. A garment
//     that is a bit roomy gets worn. One that does not do up gets returned.
// ═══════════════════════════════════════════════════════════════════════

import {
  AdvisorAnswers, AdvisorResult, BodyEstimate, BodyZone, EaseVerdict,
  FitPreferenceLevel, GarmentSpec, SizeOption, ZoneFit, ZONE_LABEL,
} from '@/lib/advisor-types';
import { resolveBody } from './body-model';
import { sizesOf } from './garment-specs';

// ── Target ease, in inches, by preference ──────────────────────────────
// Chest and waist carry different amounts of room at the same "feel", and a
// bottom is cut far closer than a top, so targets are per category.

const TARGET_EASE: Record<FitPreferenceLevel, Partial<Record<BodyZone, number>>> = {
  snug: { chest: 1.5, waist: 1.5, hip: 1.5, inseam: 0 },
  regular: { chest: 4, waist: 4, hip: 3, inseam: 0 },
  relaxed: { chest: 7, waist: 7, hip: 5, inseam: 0 },
};

const BOTTOM_EASE: Record<FitPreferenceLevel, Partial<Record<BodyZone, number>>> = {
  // Inseam target is 0 at every preference: a trouser leg matching your leg
  // is correct, and nobody's idea of a "roomy" fit is two inches of hem on
  // the floor. Preference changes girth, never length.
  snug: { waist: 0, hip: 0.5, inseam: 0 },
  regular: { waist: 1, hip: 1.5, inseam: 0 },
  relaxed: { waist: 2.5, hip: 3, inseam: 0 },
};

function targetEase(
  spec: GarmentSpec,
  preference: FitPreferenceLevel,
  zone: BodyZone
): number {
  const table = spec.category === 'bottom' ? BOTTOM_EASE : TARGET_EASE;
  return table[preference][zone] ?? 3;
}

// ── Verdict per zone ───────────────────────────────────────────────────

/**
 * Thresholds are per zone because an inch means different things.
 *
 * An inch of extra room around the chest is barely perceptible; an inch of
 * extra trouser length is visible from across the room. Length also gets no
 * help from stretch — fabric gives sideways, not downwards.
 */
const BANDS = {
  girth:  { veryTight: -2.5, snug: -1, right: 1.5, relaxed: 3.5 },
  length: { veryTight: -2, snug: -0.75, right: 0.75, relaxed: 2 },
};

function verdictFor(
  easeIn: number, target: number, stretchIn: number, zone: BodyZone
): EaseVerdict {
  const isLength = zone === 'inseam';
  const b = isLength ? BANDS.length : BANDS.girth;

  // Stretch only helps when the garment is under-sized, and never on length.
  const effective = !isLength && easeIn < target
    ? easeIn + Math.min(stretchIn, target - easeIn) * 0.6
    : easeIn;
  const delta = effective - target;

  if (delta < b.veryTight) return 'very-tight';
  if (delta < b.snug) return 'snug';
  if (delta <= b.right) return 'just-right';
  if (delta <= b.relaxed) return 'relaxed';
  return 'loose';
}

/** 0 = as tight as we'd ever show, 1 = as loose. 0.5 is on target. */
function positionFor(easeIn: number, target: number, zone: BodyZone): number {
  // Narrower span for length, so the same visual travel represents the
  // smaller range that actually matters.
  const span = zone === 'inseam' ? 3 : 6;
  return Math.max(0.02, Math.min(0.98, 0.5 + (easeIn - target) / (span * 2)));
}

function zoneFit(
  spec: GarmentSpec,
  size: string,
  zone: BodyZone,
  body: BodyEstimate,
  preference: FitPreferenceLevel
): ZoneFit | null {
  const garment = spec.measurements[size]?.[zone];
  const bodyValue = body[zone];
  if (garment === undefined || bodyValue === undefined) return null;

  const easeIn = Math.round((garment - bodyValue) * 10) / 10;
  const target = targetEase(spec, preference, zone);

  return {
    zone,
    easeIn,
    verdict: verdictFor(easeIn, target, spec.stretchIn, zone),
    position: positionFor(easeIn, target, zone),
  };
}

// ── Scoring ────────────────────────────────────────────────────────────

function scoreSize(
  spec: GarmentSpec,
  zones: ZoneFit[],
  preference: FitPreferenceLevel
): number {
  let score = 0;
  zones.forEach((z, i) => {
    // The first zone in the spec is the one that decides whether the garment
    // is wearable at all; later zones are tie-breakers.
    const weight = i === 0 ? 1 : 0.55;
    const target = targetEase(spec, preference, z.zone);
    const delta = z.easeIn - target;

    if (z.zone === 'inseam') {
      // Length is symmetric — too long and too short are both just wrong —
      // and it is weighted low, because a hem can be altered and a waist
      // cannot. It should nudge between sizes, never pick one on its own.
      score += Math.pow(Math.abs(delta), 1.3) * 0.35;
      return;
    }

    // Asymmetric: too small is worse than too big.
    const penalty = delta < 0
      ? Math.pow(-delta, 1.35) * (spec.stretchIn >= 2 ? 1.15 : 1.6)
      : Math.pow(delta, 1.2);

    score += penalty * weight;
  });
  return score;
}

function describe(spec: GarmentSpec, zones: ZoneFit[]): string {
  if (!zones.length) return 'No measurements for this size.';

  const allGood = zones.every(z => z.verdict === 'just-right');
  if (allGood) return 'Sits the way you asked, everywhere we measure.';

  // Lead with the zone that decides whether the garment works at all. Saying
  // "the waist is roomy" while the chest bar reads Snug makes the two halves
  // of the panel look like they disagree.
  const worst = zones[0].verdict !== 'just-right'
    ? zones[0]
    : [...zones].sort((a, b) => Math.abs(b.position - 0.5) - Math.abs(a.position - 0.5))[0];

  const others = zones.filter(z => z !== worst);
  const rest = others.every(z => z.verdict === 'just-right')
    ? ' Everything else sits right.'
    : '';

  const word: Record<EaseVerdict, string> = {
    'very-tight': 'much tighter than you asked',
    snug: 'a little closer than you asked',
    'just-right': 'as you asked',
    relaxed: 'a little roomier than you asked',
    loose: 'much roomier than you asked',
  };
  const lengthWord: Record<EaseVerdict, string> = {
    'very-tight': 'noticeably short on you',
    snug: 'a little short on you',
    'just-right': 'the right length',
    relaxed: 'a little long on you',
    loose: 'noticeably long on you',
  };

  if (worst.zone === 'inseam') {
    return `The leg will be ${lengthWord[worst.verdict]}.${rest}`;
  }
  return `${ZONE_LABEL[worst.zone]} will feel ${word[worst.verdict]}.${rest}`;
}

// ── Public entry point ─────────────────────────────────────────────────

export function advise(
  spec: GarmentSpec,
  answers: AdvisorAnswers
): AdvisorResult | null {
  const preference: FitPreferenceLevel = answers.preference ?? 'regular';
  const body = resolveBody({ ...answers, chart: answers.chart ?? spec.chart });
  if (!body) return null;

  const options: SizeOption[] = [];
  for (const size of sizesOf(spec)) {
    const zones = spec.zones
      .map(z => zoneFit(spec, size, z, body, preference))
      .filter((z): z is ZoneFit => z !== null);
    if (!zones.length) continue;
    options.push({ size, zones, score: scoreSize(spec, zones, preference), verdict: describe(spec, zones) });
  }

  if (!options.length) return null;

  const ranked = [...options].sort((a, b) => a.score - b.score);
  const best = ranked[0];
  const runnerUp = ranked[1];

  // ── Confidence ───────────────────────────────────────────────────────
  // Two independent things have to hold: the body estimate has to be sound,
  // and this size has to be clearly better than the next one. A confident
  // body estimate on a knife-edge choice is still a knife-edge choice.
  const margin = runnerUp ? runnerUp.score - best.score : 4;
  const separation = Math.max(0, Math.min(1, margin / 3));
  const confidence = Math.max(0.2, Math.min(0.93, body.confidence * (0.55 + 0.45 * separation)));

  const reasons: string[] = [];
  const primary = best.zones[0];
  if (primary) {
    reasons.push(
      `${ZONE_LABEL[primary.zone].toLowerCase()} ${primary.easeIn >= 0 ? `${primary.easeIn}″ of room` : `${Math.abs(primary.easeIn)}″ of stretch`} — ${
        preference === 'snug' ? 'close, the way you asked'
        : preference === 'relaxed' ? 'roomy, the way you asked'
        : 'the standard amount for this cut'
      }`
    );
  }
  reasons.push(body.source);
  if (spec.stretchIn >= 2) reasons.push('this fabric has some give');

  const caveats: string[] = [];
  if (body.caveat) caveats.push(body.caveat);
  if (separation < 0.35 && runnerUp) {
    caveats.push(
      `You are between sizes. ${best.size} is the closer fit; ${runnerUp.size} if you would rather have the extra room.`
    );
  }
  if (spec.stretchIn < 1) {
    caveats.push('This one is woven, so there is very little give — worth sizing carefully.');
  }

  // The best of a bad set is still a bad set. When even the closest size is
  // badly out on the zone that decides whether the garment is wearable, say
  // the range does not cover them rather than recommending something that
  // will not do up. Silence here is how a tool loses a customer for good.
  if (primary && (primary.verdict === 'very-tight' || primary.verdict === 'loose')) {
    // "Is anything bigger?" cannot be answered by position in the list — a
    // waist x length grid is not a single ordered scale, and 38x32 sits in
    // the middle of it while still being the widest waist we make. Ask the
    // measurements instead.
    const zone = primary.zone;
    const values = sizesOf(spec)
      .map(sz => spec.measurements[sz]?.[zone])
      .filter((v): v is number => typeof v === 'number');
    const chosen = spec.measurements[best.size]?.[zone];
    const atEdge = chosen !== undefined && values.length > 0 && (
      primary.verdict === 'very-tight'
        ? chosen >= Math.max(...values)
        : chosen <= Math.min(...values)
    );
    if (atEdge) {
      caveats.push(
        primary.verdict === 'very-tight'
          ? `This style does not run large enough for you — ${best.size} is the biggest we make and it would still be tight through the ${ZONE_LABEL[primary.zone].toLowerCase()}.`
          : `This style does not run small enough for you — ${best.size} is the smallest we make and it would still be loose through the ${ZONE_LABEL[primary.zone].toLowerCase()}.`
      );
    }
  }

  // Offer the neighbours, in the brand's own order, not by score.
  const all = sizesOf(spec);
  const idx = all.indexOf(best.size);
  const alternates = [all[idx - 1], all[idx + 1]]
    .filter(Boolean)
    .map(s => options.find(o => o.size === s))
    .filter((o): o is SizeOption => !!o);

  return {
    recommended: best,
    alternates,
    confidence,
    band: confidence >= 0.7 ? 'high' : confidence >= 0.45 ? 'medium' : 'low',
    body,
    reasons,
    caveats,
    garment: spec,
    preference,
  };
}
