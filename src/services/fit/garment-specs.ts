// ═══════════════════════════════════════════════════════════════════════
// Garment specs — finished garment measurements, per size, per zone.
//
// This is the file a brand actually hands over. Everything the advisor says
// is derived from it plus the body estimate: ease is garment minus body, and
// ease is what "fits" means.
//
// Note the two Augusta entries. A team jersey is cut nothing like a retail
// tee, which is exactly why a single global "runs small" flag is not enough
// and per-style measurements are.
// ═══════════════════════════════════════════════════════════════════════

import { GarmentSpec } from '@/lib/advisor-types';

export const GARMENT_SPECS: GarmentSpec[] = [
  // ── Abercrombie & Fitch — the retail case ────────────────────────────
  {
    styleId: 'AF-8841',
    styleName: 'Essential Crew Tee',
    brandId: 'abercrombie',
    category: 'top',
    chart: 'unisex',
    // Straight-cut, so the "waist" measurement is just the hem width. Judging
    // it against a body waist reports every slim wearer as "loose", which is
    // a fact about the pattern, not about them. Chest decides a tee.
    zones: ['chest'],
    stretchIn: 2,
    silhouette: { sleeve: 'short', hem: 'below-hip', drape: 'standard' },
    measurements: {
      XS: { chest: 34, waist: 32 },
      S: { chest: 37, waist: 35 },
      M: { chest: 40, waist: 38 },
      L: { chest: 44, waist: 42 },
      XL: { chest: 48, waist: 46 },
      '2XL': { chest: 52, waist: 50 },
      '3XL': { chest: 56, waist: 54 },
    },
  },
  {
    styleId: 'AF-2207',
    styleName: 'Athletic Slim Fit Shirt',
    brandId: 'abercrombie',
    category: 'top',
    chart: 'mens',
    zones: ['chest', 'waist'],
    // Woven, so almost no give. Getting the size wrong here actually hurts.
    stretchIn: 0.5,
    silhouette: { sleeve: 'long', hem: 'below-hip', collar: true, drape: 'fitted' },
    measurements: {
      XS: { chest: 33, waist: 30 },
      S: { chest: 36, waist: 33 },
      M: { chest: 39, waist: 36 },
      L: { chest: 42, waist: 39 },
      XL: { chest: 46, waist: 43 },
      '2XL': { chest: 50, waist: 47 },
    },
  },
  {
    styleId: 'AF-5510',
    styleName: 'High-Rise Straight Jean',
    brandId: 'abercrombie',
    category: 'bottom',
    chart: 'womens',
    // Waist decides whether they do up; hip decides whether they sit right;
    // length is last because a hem can be altered and a waistband cannot.
    zones: ['waist', 'hip', 'inseam'],
    stretchIn: 1.5,
    silhouette: { sleeve: 'none', hem: 'ankle', drape: 'fitted' },
    // Inseam creeps up half an inch across the size run, the way real graded
    // patterns do — larger sizes are cut for slightly taller bodies.
    measurements: {
      '00': { waist: 24, hip: 34, inseam: 29 },
      '0': { waist: 25, hip: 35, inseam: 29 },
      '2': { waist: 26, hip: 36, inseam: 29.5 },
      '4': { waist: 27.5, hip: 37.5, inseam: 29.5 },
      '6': { waist: 29, hip: 39, inseam: 30 },
      '8': { waist: 30.5, hip: 40.5, inseam: 30 },
      '10': { waist: 32, hip: 42, inseam: 30.5 },
      '12': { waist: 34, hip: 44, inseam: 30.5 },
      '14': { waist: 36, hip: 46, inseam: 31 },
      '16': { waist: 38, hip: 48, inseam: 31 },
    },
  },
  {
    // Waist x length, the way men's trousers are actually sold. Every waist
    // is offered in three lengths on purpose: two sizes that differ only in
    // leg are exactly the case the length signal exists to separate, and a
    // grid that quietly drops the short leg above a 34" waist — as the first
    // draft of this did — makes length look like it does nothing.
    styleId: 'AF-3320',
    styleName: 'Straight Chino',
    brandId: 'abercrombie',
    category: 'bottom',
    chart: 'mens',
    zones: ['waist', 'hip', 'inseam'],
    stretchIn: 1,
    silhouette: { sleeve: 'none', hem: 'ankle', drape: 'standard' },
    // Hip runs about 4" over the garment waist. Cut it more generously than
    // that and every trouser reports as loose in the seat.
    measurements: {
      '30x30': { waist: 31, hip: 35, inseam: 30 },
      '30x32': { waist: 31, hip: 35, inseam: 32 },
      '30x34': { waist: 31, hip: 35, inseam: 34 },
      '32x30': { waist: 33, hip: 37, inseam: 30 },
      '32x32': { waist: 33, hip: 37, inseam: 32 },
      '32x34': { waist: 33, hip: 37, inseam: 34 },
      '34x30': { waist: 35, hip: 39, inseam: 30 },
      '34x32': { waist: 35, hip: 39, inseam: 32 },
      '34x34': { waist: 35, hip: 39, inseam: 34 },
      '36x30': { waist: 37, hip: 41, inseam: 30 },
      '36x32': { waist: 37, hip: 41, inseam: 32 },
      '36x34': { waist: 37, hip: 41, inseam: 34 },
      '38x30': { waist: 39, hip: 43, inseam: 30 },
      '38x32': { waist: 39, hip: 43, inseam: 32 },
      '38x34': { waist: 39, hip: 43, inseam: 34 },
    },
  },
  {
    // Shorts: the inseam is short by design, so it is measured against the
    // garment's own intended length rather than against the leg. Judged on
    // waist and hip only — see the note on `zones` above.
    styleId: 'AF-4415',
    styleName: 'Pull-On Jersey Short',
    brandId: 'abercrombie',
    category: 'bottom',
    chart: 'unisex',
    zones: ['waist', 'hip'],
    stretchIn: 3,
    silhouette: { sleeve: 'none', hem: 'above-knee', drape: 'loose' },
    measurements: {
      XS: { waist: 26, hip: 35 },
      S: { waist: 28, hip: 37 },
      M: { waist: 31, hip: 40 },
      L: { waist: 34, hip: 43 },
      XL: { waist: 38, hip: 47 },
      '2XL': { waist: 42, hip: 51 },
    },
  },

  // ── Augusta — the team-wear case ─────────────────────────────────────
  // Cut close, because it is worn to play in. A shopper used to retail tees
  // will find these smaller than expected, which is precisely the surprise
  // the advisor exists to prevent.
  {
    styleId: '228325',
    styleName: 'Ladies FreeStyle Sublimated Jersey',
    brandId: 'augusta',
    category: 'top',
    chart: 'womens',
    // Straight-cut and sized on the chest. Judging it on the waist would
    // report every jersey as "loose", which is just what a jersey is.
    zones: ['chest'],
    stretchIn: 3,
    silhouette: { sleeve: 'cap', hem: 'hip', drape: 'fitted' },
    measurements: {
      XS: { chest: 31, waist: 29 },
      S: { chest: 33, waist: 31 },
      M: { chest: 35.5, waist: 33.5 },
      L: { chest: 38.5, waist: 36.5 },
      XL: { chest: 41.5, waist: 39.5 },
      '2XL': { chest: 45, waist: 43 },
    },
  },
  {
    styleId: '329X3M',
    styleName: 'Youth FreeStyle Baseball Jersey',
    brandId: 'augusta',
    category: 'top',
    chart: 'unisex',
    zones: ['chest'],
    stretchIn: 2.5,
    silhouette: { sleeve: 'short', hem: 'hip', drape: 'loose' },
    measurements: {
      YXS: { chest: 26 },
      YS: { chest: 28 },
      YM: { chest: 30 },
      YL: { chest: 32.5 },
      YXL: { chest: 35 },
    },
  },
];

export function getGarment(styleId: string): GarmentSpec | undefined {
  return GARMENT_SPECS.find(g => g.styleId === styleId);
}

export function garmentsForBrand(brandId: string): GarmentSpec[] {
  return GARMENT_SPECS.filter(g => g.brandId === brandId);
}

/** Sizes in the order the brand lists them, smallest first. */
export function sizesOf(spec: GarmentSpec): string[] {
  return Object.keys(spec.measurements);
}

// ── Resolving a garment the journey is talking about ───────────────────
// Inside JourneyAX the advisor is opened by the model mid-conversation, so
// the garment is whatever the shopper happens to be looking at. Two cases:
//
//   1. We already hold the spec — the model passes a styleId and we look it
//      up. Always preferred: our own numbers, not the model's.
//   2. We do not — the model passes the size chart it retrieved from the
//      catalogue. It is forbidden from inventing those numbers, and if they
//      are missing or unusable we return null and the caller declines to
//      show an advisor at all rather than guess.

export interface InlineGarment {
  styleId?: string;
  styleName?: string;
  brandId?: string;
  category?: GarmentSpec['category'];
  chart?: GarmentSpec['chart'];
  stretch?: 'none' | 'some' | 'lots';
  sizes?: { size: string; chest?: number; waist?: number; hip?: number; inseam?: number }[];
}

const STRETCH_IN: Record<NonNullable<InlineGarment['stretch']>, number> = {
  none: 0.5, some: 2, lots: 3.5,
};

export function resolveGarment(input: InlineGarment): GarmentSpec | null {
  // Case 1 — we hold it.
  if (input.styleId) {
    const known = getGarment(input.styleId);
    if (known) return known;
  }

  // Case 2 — build from what the model retrieved.
  const rows = (input.sizes ?? []).filter(r => r.size && (r.chest || r.waist || r.hip));
  if (rows.length < 2) return null; // one size is not a size chart

  const measurements: GarmentSpec['measurements'] = {};
  for (const r of rows) {
    measurements[r.size.trim().toUpperCase()] = {
      ...(r.chest ? { chest: r.chest } : {}),
      ...(r.waist ? { waist: r.waist } : {}),
      ...(r.hip ? { hip: r.hip } : {}),
      ...(r.inseam ? { inseam: r.inseam } : {}),
    };
  }

  const category = input.category ?? 'top';
  // Only claim a zone every size actually carries — a chart that lists chest
  // for some sizes and not others would otherwise silently skip lines.
  const has = (z: 'chest' | 'waist' | 'hip' | 'inseam') =>
    rows.every(r => typeof r[z] === 'number' && r[z]! > 0);
  const zones = (category === 'bottom'
    ? (['waist', 'hip', 'inseam'] as const)
    : (['chest', 'waist'] as const)
  ).filter(has);

  if (!zones.length) return null;

  return {
    styleId: input.styleId || 'inline',
    styleName: input.styleName || 'This item',
    brandId: input.brandId || 'generic',
    category,
    chart: input.chart ?? 'unisex',
    zones: [...zones],
    stretchIn: STRETCH_IN[input.stretch ?? 'some'],
    measurements,
  };
}
