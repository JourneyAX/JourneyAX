// ═══════════════════════════════════════════════════════════════════════
// Parametric body geometry.
//
// The avatar is not a stock model that gets scaled. It is built from the
// shopper's own circumferences, which is what makes it worth showing at all:
// a 38″ chest and a 44″ chest produce genuinely different meshes, and the
// garment over them is this size at this ease.
//
// The maths, briefly:
//   A horizontal slice through a torso is closer to an ellipse than a
//   circle — people are wider than they are deep. So each landmark becomes
//   an ellipse with semi-axes a (half-width) and b = DEPTH_RATIO·a, sized so
//   that the ellipse's PERIMETER equals the measured circumference.
//
//   Ramanujan's approximation gives the perimeter of an ellipse as
//     P ≈ π(a+b)·[1 + 3h/(10+√(4−3h))],  h = ((a−b)/(a+b))²
//   With b = k·a, everything but `a` is constant, so a = P / C(k) and we can
//   go straight from a tape measurement to a mesh without iterating.
//
// Everything here is pure geometry and unit-free in inches; the renderer
// scales to world units. No three.js import, so it stays testable.
// ═══════════════════════════════════════════════════════════════════════

/** How deep a torso is relative to its width, per landmark. */
const DEPTH_RATIO = { chest: 0.78, waist: 0.82, hip: 0.80 } as const;

/**
 * Fore/aft offset of each landmark, as a fraction of that ring's depth.
 * These are posture, not measurement — they do not change with the numbers.
 */
const LEAN = { shoulder: -0.10, chest: 0.16, waist: -0.06, hip: -0.20 } as const;

/** Ramanujan constant for a given depth ratio: perimeter = a · C(k). */
function ellipseC(k: number): number {
  const h = Math.pow((1 - k) / (1 + k), 2);
  return Math.PI * (1 + k) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** Half-width of an ellipse with the given circumference and depth ratio. */
export function semiAxisFor(circumferenceIn: number, k: number): number {
  return circumferenceIn / ellipseC(k);
}

export interface Ring {
  /** Height above the floor, in inches. */
  y: number;
  /** Half-width (x) and half-depth (z), in inches. */
  a: number;
  b: number;
  /**
   * How far forward (+) or back (-) this slice sits.
   *
   * Without it every ring shares one axis and the figure is a flat slab in
   * profile — which is the single clearest tell that a body was generated
   * rather than modelled. Chest forward, waist back, seat back again gives
   * the spine its S and the silhouette a side view worth rotating to.
   */
  z: number;
}

export interface BodyMeasurements {
  heightIn: number;
  chestIn: number;
  waistIn: number;
  hipIn: number;
}

/** Where each landmark sits as a fraction of total height. */
export const LANDMARK = {
  crown: 1.0,
  chin: 0.87,
  shoulder: 0.82,
  chest: 0.72,
  waist: 0.62,
  hip: 0.52,
  crotch: 0.48,
  knee: 0.28,
  floor: 0.0,
} as const;

/**
 * The torso profile: shoulder → chest → waist → hip, plus a shoulder ring
 * derived from the chest (shoulders scale with frame, not independently)
 * and a small taper below the hip so the mesh closes cleanly into the legs.
 */
export function torsoRings(m: BodyMeasurements): Ring[] {
  const H = m.heightIn;
  const aChest = semiAxisFor(m.chestIn, DEPTH_RATIO.chest);
  const aWaist = semiAxisFor(m.waistIn, DEPTH_RATIO.waist);
  const aHip = semiAxisFor(m.hipIn, DEPTH_RATIO.hip);

  // Shoulders run wider than the chest ellipse and flatter front-to-back.
  const aShoulder = aChest * 1.16;

  const bChest = aChest * DEPTH_RATIO.chest;
  const bWaist = aWaist * DEPTH_RATIO.waist;
  const bHip = aHip * DEPTH_RATIO.hip;

  const zShoulder = bChest * LEAN.shoulder;
  const zChest = bChest * LEAN.chest;
  const zWaist = bWaist * LEAN.waist;
  const zHip = bHip * LEAN.hip;

  return [
    // Trapezius: the slope from neck to shoulder point, rather than a flat
    // cap. Bodies do not have a horizontal top edge.
    { y: H * LANDMARK.shoulder + H * 0.022, a: aShoulder * 0.60, b: bChest * 0.86, z: zShoulder * 0.6 },
    { y: H * LANDMARK.shoulder + H * 0.009, a: aShoulder * 0.88, b: bChest * 0.94, z: zShoulder * 0.85 },
    { y: H * LANDMARK.shoulder, a: aShoulder, b: bChest * 0.96, z: zShoulder },
    { y: H * (LANDMARK.shoulder + LANDMARK.chest) / 2, a: (aShoulder + aChest) / 2, b: bChest * 1.02, z: (zShoulder + zChest) / 2 },
    { y: H * LANDMARK.chest, a: aChest, b: bChest, z: zChest },
    { y: H * (LANDMARK.chest + LANDMARK.waist) / 2, a: (aChest + aWaist) / 2 * 0.985, b: (bChest + bWaist) / 2, z: (zChest + zWaist) / 2 },
    { y: H * LANDMARK.waist, a: aWaist, b: bWaist, z: zWaist },
    { y: H * (LANDMARK.waist + LANDMARK.hip) / 2, a: (aWaist + aHip) / 2, b: (bWaist + bHip) / 2 * 1.03, z: (zWaist + zHip) / 2 },
    { y: H * LANDMARK.hip, a: aHip, b: bHip, z: zHip },
    { y: H * LANDMARK.crotch, a: aHip * 0.94, b: bHip * 0.92, z: zHip * 0.7 },
  ];
}

/**
 * The garment as a second surface over the same skeleton.
 *
 * Ease is a circumference difference, so it converts to a half-width delta
 * through the same formula — no fudge factor. Unlike the flat diagram this
 * replaces, nothing here is exaggerated: what you see is the real stand-off.
 *
 * Zones without a reading follow the body with a token amount of room, and
 * ease is never allowed to pull the garment inside the body by more than the
 * fabric could actually stretch.
 */
export function garmentRings(
  m: BodyMeasurements,
  ease: { chest?: number; waist?: number; hip?: number },
  opts: { category: 'top' | 'bottom'; stretchIn: number }
): Ring[] {
  const H = m.heightIn;
  const body = torsoRings(m);

  const deltaFor = (zone: 'chest' | 'waist' | 'hip') => {
    const e = ease[zone];
    if (e === undefined) return 1.2 / ellipseC(DEPTH_RATIO[zone]) * ellipseC(DEPTH_RATIO[zone]) * 0.35;
    // Negative ease is the fabric stretching over the body; it cannot
    // compress the body further than the fabric has give.
    const bounded = Math.max(e, -opts.stretchIn);
    return semiAxisFor(bounded, DEPTH_RATIO[zone]);
  };

  const dChest = deltaFor('chest');
  const dWaist = deltaFor('waist');
  const dHip = deltaFor('hip');

  const grow = (r: Ring, d: number): Ring => ({
    y: r.y,
    a: Math.max(r.a * 0.94, r.a + d),
    b: Math.max(r.b * 0.94, r.b + d * 0.9),
    // Cloth hangs off the body: it follows the lean but relaxes towards
    // vertical as it stands further off, the way a real garment drapes.
    z: r.z * Math.max(0.35, 1 - d / 6),
  });

  // Sample the body by HEIGHT, never by array index. The torso profile gains
  // and loses rings as the anatomy is refined, and positional lookups here
  // silently start grabbing the wrong landmark when it does.
  const at = (fraction: number) => interpolate(body, H * fraction);

  if (opts.category === 'bottom') {
    // Waistband to hip, then down the legs — the renderer draws the legs as
    // tubes, so this is the pelvis section only.
    return [
      grow(at(LANDMARK.waist), dWaist),
      grow(at((LANDMARK.waist + LANDMARK.hip) / 2), (dWaist + dHip) / 2),
      grow(at(LANDMARK.hip), dHip),
      grow(at(LANDMARK.crotch), dHip),
    ];
  }

  // A top: from the shoulder seam down to a hem below the hip.
  return [
    grow(at(LANDMARK.shoulder + 0.009), dChest * 0.55),
    grow(at(LANDMARK.shoulder), dChest * 0.8),
    grow(at((LANDMARK.shoulder + LANDMARK.chest) / 2), dChest * 0.94),
    grow(at(LANDMARK.chest), dChest),
    grow(at((LANDMARK.chest + LANDMARK.waist) / 2), (dChest + dWaist) / 2),
    grow(at(LANDMARK.waist), dWaist),
    grow(at((LANDMARK.waist + LANDMARK.hip) / 2), (dWaist + dHip) / 2),
    grow(at(LANDMARK.hip - 0.045), dHip * 0.9),
  ];
}

/** Linear interpolation of the profile at an arbitrary height. */
export function interpolate(rings: Ring[], y: number): Ring {
  if (y >= rings[0].y) return { ...rings[0] };
  const last = rings[rings.length - 1];
  if (y <= last.y) return { ...last };
  for (let i = 0; i < rings.length - 1; i++) {
    const hi = rings[i];
    const lo = rings[i + 1];
    if (y <= hi.y && y >= lo.y) {
      const t = (hi.y - y) / (hi.y - lo.y || 1);
      return {
        y,
        a: hi.a + (lo.a - hi.a) * t,
        b: hi.b + (lo.b - hi.b) * t,
        z: hi.z + (lo.z - hi.z) * t,
      };
    }
  }
  return { ...last };
}

/**
 * Resample a profile to a smooth, evenly spaced set of rings.
 * Straight lofting between eight landmarks reads as a stack of cones; this
 * gives the surface something to shade.
 */
export function smooth(rings: Ring[], steps = 34): Ring[] {
  const top = rings[0].y;
  const bottom = rings[rings.length - 1].y;
  const out: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = top - ((top - bottom) * i) / steps;
    out.push(interpolate(rings, y));
  }
  // One pass of neighbour averaging to take the corners off the landmarks.
  return out.map((r, i) => {
    if (i === 0 || i === out.length - 1) return r;
    const p = out[i - 1], n = out[i + 1];
    return {
      y: r.y,
      a: (p.a + 2 * r.a + n.a) / 4,
      b: (p.b + 2 * r.b + n.b) / 4,
      z: (p.z + 2 * r.z + n.z) / 4,
    };
  });
}

/** Limb sizing, derived from the torso so proportions hold at any build. */
export function limbs(m: BodyMeasurements) {
  const H = m.heightIn;
  const aChest = semiAxisFor(m.chestIn, DEPTH_RATIO.chest);
  const aHip = semiAxisFor(m.hipIn, DEPTH_RATIO.hip);
  return {
    headR: H * 0.0575,
    neckR: aChest * 0.30,
    armR: aChest * 0.235,
    armLen: H * 0.30,
    shoulderX: aChest * 1.16,
    thighR: aHip * 0.50,
    calfR: aHip * 0.32,
  };
}
