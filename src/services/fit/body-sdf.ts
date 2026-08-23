// ═══════════════════════════════════════════════════════════════════════
// The body as one continuous surface.
//
// The previous approach — a lofted torso with cylinders stuck on for limbs
// and spheres over the joins — produces an artist's pivot mannequin. That is
// not a tuning problem. Separate primitives with visible seams read as
// assembled parts no matter how well each part is shaped.
//
// So the body is defined instead as a SIGNED DISTANCE FIELD: a function that
// answers "how far is this point from the surface?" for every point in
// space. Shapes are combined with a SMOOTH minimum, which fuses them into a
// single skin — a deltoid flowing into a torso, a thigh into a hip — with no
// seam anywhere, because there is no join to see. The field is then polygon-
// ised with naive surface nets into one mesh.
//
// What this buys: continuous anatomy from arbitrary measurements, no rig, no
// licensed asset. What it does not buy: a real human. This is a shop
// mannequin, and it is meant to look like one — no face, no hands, neutral.
// That is the honest ceiling of a procedural body, and a deliberate choice:
// the figure stands for the shopper's measurements, not their appearance.
// ═══════════════════════════════════════════════════════════════════════

import { BodyMeasurements, LANDMARK, Ring, interpolate, limbs, semiAxisFor, smooth, torsoRings } from './body-mesh';
import { GarmentSilhouette } from '@/lib/advisor-types';

/** Hem positions as a fraction of total height from the floor. */
const HEM_AT: Record<GarmentSilhouette['hem'], number> = {
  waist: LANDMARK.waist,
  'high-hip': LANDMARK.hip + 0.03,
  hip: LANDMARK.hip,
  'below-hip': LANDMARK.hip - 0.045,
  thigh: 0.40,
  'above-knee': 0.33,
  knee: LANDMARK.knee,
  calf: 0.16,
  ankle: 0.035,
};

/** Where a sleeve ends, as a fraction of total height. */
const SLEEVE_AT: Record<GarmentSilhouette['sleeve'], number | null> = {
  none: null,
  cap: LANDMARK.shoulder - 0.03,
  short: LANDMARK.chest - 0.02,
  threequarter: LANDMARK.chest - 0.11,
  long: LANDMARK.waist - 0.11,
};

const DRAPE: Record<NonNullable<GarmentSilhouette['drape']>, number> = {
  fitted: 0.88, standard: 1, loose: 1.16,
};

export const DEFAULT_SILHOUETTE: GarmentSilhouette = { sleeve: 'short', hem: 'below-hip', drape: 'standard' };

export function hemHeight(m: BodyMeasurements, s: GarmentSilhouette): number {
  return m.heightIn * HEM_AT[s.hem];
}

// ── Distance primitives ────────────────────────────────────────────────

/** Polynomial smooth minimum. `k` is the blend radius, in inches. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Smooth maximum, for carving without a hard edge. */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/**
 * A tapered capsule between two points — the workhorse for limbs and neck.
 * Rounded at both ends, so it blends into whatever it meets.
 */
function sdRoundCone(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, r1: number,
  bx: number, by: number, bz: number, r2: number
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-9) return Math.hypot(px - ax, py - ay, pz - az) - r1;

  const pax = px - ax, pay = py - ay, paz = pz - az;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / l2));
  const cx = pax - bax * t, cy = pay - bay * t, cz = paz - baz * t;
  return Math.hypot(cx, cy, cz) - (r1 + (r2 - r1) * t);
}

/** The torso: a swept elliptical section, capped top and bottom. */
function sdTorso(
  px: number, py: number, pz: number,
  rings: Ring[], yTop: number, yBottom: number
): number {
  const y = Math.max(yBottom, Math.min(yTop, py));
  const r = interpolate(rings, y);

  // Superelliptic rather than elliptic: a real ribcage and pelvis are
  // squarer in section than a true ellipse, and the difference is what stops
  // a torso reading as a tube.
  const nx = Math.abs(px / r.a);
  const nz = Math.abs((pz - r.z) / r.b);
  const e = 2.4;
  const k = Math.pow(Math.pow(nx, e) + Math.pow(nz, e), 1 / e) - 1;
  const radial = k * Math.min(r.a, r.b);

  const dy = Math.max(yBottom - py, py - yTop);
  return Math.min(Math.max(radial, dy), 0) + Math.hypot(Math.max(radial, 0), Math.max(dy, 0));
}

/** An ellipsoid, for the head. */
function sdEllipsoid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number
): number {
  const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
  const k0 = Math.hypot(x, y, z);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const k1 = Math.hypot(x / rx, y / ry, z / rz);
  return (k0 * (k0 - 1)) / k1;
}

// ── The figure ─────────────────────────────────────────────────────────

export interface FigureField {
  /** Signed distance at a point, in inches. Negative is inside. */
  sample: (x: number, y: number, z: number) => number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface GarmentField {
  category: 'top' | 'bottom';
  rings: Ring[];
  /** Where the garment stops, in inches from the floor. */
  hemY: number;
  stretchIn: number;
  silhouette: GarmentSilhouette;
}

/** Build the sampler for a body with these measurements. */
export function bodyField(m: BodyMeasurements): FigureField {
  const H = m.heightIn;
  const L = limbs(m);
  const rings = smooth(torsoRings(m), 48);

  const yShoulder = H * LANDMARK.shoulder;
  const yChin = H * LANDMARK.chin;
  const yCrotch = H * LANDMARK.crotch;
  const yKnee = H * LANDMARK.knee;

  const zShoulder = interpolate(rings, yShoulder).z;
  const zCrotch = interpolate(rings, yCrotch).z;
  const headR = L.headR;

  // Blend radius. Large enough that shoulders and hips fuse, small enough
  // that the waist keeps its shape — too much and the whole figure melts.
  const K = Math.max(0.9, L.armR * 0.85);

  const armTopX = L.shoulderX * 0.80;
  const armBotX = L.shoulderX * 1.02;
  const armBotY = yShoulder - L.armLen;
  const hipX = L.thighR * 0.92;

  const sample = (x: number, y: number, z: number): number => {
    let d = sdTorso(x, y, z, rings, yShoulder + H * 0.022, yCrotch);

    // Neck, then head — smin fuses them into the shoulders.
    d = smin(d, sdRoundCone(x, y, z,
      0, yShoulder - H * 0.01, zShoulder * 0.9, L.neckR * 1.15,
      0, yChin + H * 0.012, interpolate(rings, yChin).z * 0.6, L.neckR * 0.86), K * 0.9);

    d = smin(d, sdEllipsoid(x, y, z,
      0, yChin + headR * 0.98, zShoulder * 0.5,
      headR * 0.82, headR * 1.1, headR * 0.9), K * 0.55);

    for (const side of [-1, 1]) {
      // Deltoid: a small mass at the shoulder point. Without it the arm
      // meets the torso in a straight tube and the silhouette goes soft.
      d = smin(d, sdEllipsoid(x, y, z,
        side * armTopX * 0.94, yShoulder - H * 0.006, zShoulder,
        L.armR * 1.35, L.armR * 1.5, L.armR * 1.3), K);

      // Upper arm to wrist.
      d = smin(d, sdRoundCone(x, y, z,
        side * armTopX, yShoulder - H * 0.012, zShoulder - L.armR * 0.2, L.armR * 1.02,
        side * armBotX, armBotY, zShoulder * 0.35, L.armR * 0.56), K * 0.85);

      // Thigh, then calf, sharing the knee point so the leg is continuous.
      const kneeX = side * hipX * 0.9;
      d = smin(d, sdRoundCone(x, y, z,
        side * hipX, yCrotch + H * 0.02, zCrotch, L.thighR * 1.02,
        kneeX, yKnee, zCrotch * 0.45, L.calfR * 1.04), K * 1.15);
      d = smin(d, sdRoundCone(x, y, z,
        kneeX, yKnee, zCrotch * 0.45, L.calfR * 1.06,
        side * hipX * 0.84, H * 0.035, 0, L.calfR * 0.5), K * 0.8);

      // Foot.
      d = smin(d, sdEllipsoid(x, y, z,
        side * hipX * 0.84, H * 0.026, L.calfR * 0.62,
        L.calfR * 0.56, L.calfR * 0.42, L.calfR * 1.5), K * 0.6);
    }

    // Carve the gap between the legs back in — smin fuses the thighs into
    // one mass otherwise, and a mannequin with fused legs looks wrong in a
    // way nobody can name but everybody sees.
    if (y < yCrotch + 1) {
      const gap = Math.abs(x) - hipX * 0.16;
      const below = yCrotch - y;
      d = smax(d, -(gap + Math.max(0, 1.2 - below) * 2.2), K * 0.55);
    }

    return d;
  };

  const halfW = L.shoulderX + L.armR * 2.6;
  const halfD = Math.max(...rings.map(r => Math.abs(r.z) + r.b)) + L.calfR * 2;
  return {
    sample,
    bounds: { min: [-halfW, -0.5, -halfD], max: [halfW, H + headR * 2.6, halfD] },
  };
}

/** The garment as its own continuous surface, offset from the body. */
export function garmentField(m: BodyMeasurements, g: GarmentField): FigureField {
  const H = m.heightIn;
  const L = limbs(m);
  const rings = smooth(g.rings, 40);
  const yTop = rings[0].y;
  const K = Math.max(0.7, L.armR * 0.7);

  const zCrotch = interpolate(torsoRings(m), H * LANDMARK.crotch).z;
  const yCrotch = H * LANDMARK.crotch;
  const yKnee = H * LANDMARK.knee;
  const hipX = L.thighR * 0.92;
  const drape = DRAPE[g.silhouette.drape ?? 'standard'];
  const sleeveR = L.armR * 1.42 * drape;
  const sleeveEnd = SLEEVE_AT[g.silhouette.sleeve];

  const sample = (x: number, y: number, z: number): number => {
    // A bottom's swept section is the PELVIS only — waistband to crotch. Run
    // it down to the hem and you get a hip-width tube to the ankle, which
    // renders as a jumpsuit wide enough to swallow the arms. The legs below
    // are the tapered cones added after this.
    const torsoBottom = g.category === 'bottom' ? yCrotch : g.hemY;
    let d = sdTorso(x, y, z, rings, yTop, torsoBottom);

    if (g.category === 'top') {
      const zShoulder = rings[0].z;

      // A raised collar, for anything with one. Its absence is most of why a
      // dress shirt and a tee looked like the same garment.
      if (g.silhouette.collar) {
        const yNeck = H * LANDMARK.shoulder;
        d = smin(d, sdRoundCone(x, y, z,
          0, yNeck - H * 0.004, zShoulder * 0.9, L.neckR * 1.34,
          0, yNeck + H * 0.028, zShoulder * 0.7, L.neckR * 1.26), K * 0.5);
      }

      // Sleeves, at this garment's own length. `none` draws none at all.
      if (sleeveEnd !== null) {
        const ySleeve = H * sleeveEnd;
        // A long sleeve narrows to the wrist; a short one barely tapers.
        const endR = g.silhouette.sleeve === 'long' ? L.armR * 0.78 * drape
          : g.silhouette.sleeve === 'threequarter' ? L.armR * 0.95 * drape
            : sleeveR * 0.94;
        for (const side of [-1, 1]) {
          d = smin(d, sdRoundCone(x, y, z,
            side * L.shoulderX * 0.74, yTop - H * 0.012, zShoulder - L.armR * 0.2, sleeveR,
            side * L.shoulderX * (g.silhouette.sleeve === 'long' ? 1.04 : 0.98),
            ySleeve, zShoulder * 0.45, endR), K);
        }
      }
    } else {
      // Trouser legs, or shorts when the hem sits above the knee.
      for (const side of [-1, 1]) {
        const kneeX = side * hipX * 0.9;
        if (g.hemY < yKnee) {
          d = smin(d, sdRoundCone(x, y, z,
            side * hipX, yCrotch + H * 0.02, zCrotch, L.thighR * 1.1,
            kneeX, yKnee, zCrotch * 0.45, L.calfR * 1.16), K * 0.9);
          d = smin(d, sdRoundCone(x, y, z,
            kneeX, yKnee, zCrotch * 0.45, L.calfR * 1.16,
            side * hipX * 0.86, g.hemY, zCrotch * 0.1, L.calfR * 1.0), K * 0.7);
        } else {
          d = smin(d, sdRoundCone(x, y, z,
            side * hipX, yCrotch + H * 0.02, zCrotch, L.thighR * 1.22,
            side * hipX * 0.95, g.hemY, zCrotch * 0.6, L.thighR * 1.1), K);
        }
      }
      // Carve between the legs. Without it the smooth union fuses the two
      // trouser legs into one skirt.
      if (y < yCrotch + 1) {
        const gap = Math.abs(x) - hipX * 0.14;
        const below = yCrotch - y;
        d = smax(d, -(gap + Math.max(0, 1.0 - below) * 2.4), K * 0.55);
      }
    }
    return d;
  };

  const halfW = L.shoulderX + sleeveR * 2.2;
  const halfD = Math.max(...rings.map(r => Math.abs(r.z) + r.b)) + L.calfR * 2.4;
  return {
    sample,
    bounds: { min: [-halfW, g.hemY - 2, -halfD], max: [halfW, yTop + 2, halfD] },
  };
}

/** Where a top's hem and sleeve fall, given the body. */
export function topExtents(m: BodyMeasurements) {
  const H = m.heightIn;
  return {
    hemY: H * LANDMARK.hip - H * 0.045,
    sleeveY: H * (LANDMARK.chest - 0.02),
  };
}

/** Convert a garment inseam ease into a hem height. */
export function hemForLeg(m: BodyMeasurements, legEaseIn: number | null): number {
  const H = m.heightIn;
  const ankle = H * 0.035;
  const crotch = H * LANDMARK.crotch;
  if (legEaseIn === null) return H * 0.30;
  const bodyLeg = crotch - ankle;
  const garmentLeg = Math.max(bodyLeg * 0.12, bodyLeg + legEaseIn);
  return Math.max(ankle * 0.6, crotch - garmentLeg);
}

// ── Polygonisation: naive surface nets ─────────────────────────────────
// Chosen over marching cubes because it is a fraction of the code, has no
// 256-entry lookup table to get wrong, and produces smoother surfaces on
// organic shapes — which is exactly what this is.

const CUBE_EDGES: [number, number][] = [
  [0, 1], [1, 3], [2, 3], [0, 2], [4, 5], [5, 7], [6, 7], [4, 6],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
const CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Sample the field on a grid and emit one vertex per surface-crossing cell,
 * placed at the average of its edge crossings, then quad-join neighbours.
 */
export function surfaceNet(field: FigureField, resolution = 46): MeshData {
  const { min, max } = field.bounds;
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(span[0], span[1], span[2]);
  const step = longest / resolution;

  const dims: [number, number, number] = [
    Math.max(2, Math.ceil(span[0] / step) + 1),
    Math.max(2, Math.ceil(span[1] / step) + 1),
    Math.max(2, Math.ceil(span[2] / step) + 1),
  ];

  const [nx, ny, nz] = dims;
  const values = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * step;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * step;
      for (let i = 0; i < nx; i++) {
        values[idx(i, j, k)] = field.sample(min[0] + i * step, y, z);
      }
    }
  }

  const vertexAt = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellIdx = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const positions: number[] = [];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v: number[] = [];
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          const s = values[idx(i + dx, j + dy, k + dz)];
          v.push(s);
          if (s < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of CUBE_EDGES) {
          const va = v[a], vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a], cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        if (!n) continue;

        vertexAt[cellIdx(i, j, k)] = positions.length / 3;
        positions.push(
          min[0] + (i + sx / n) * step,
          min[1] + (j + sy / n) * step,
          min[2] + (k + sz / n) * step
        );
      }
    }
  }

  // Each sign change on a grid edge owns the quad of the four cells around it.
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };

  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const s = values[idx(i, j, k)] < 0;
        if (values[idx(i + 1, j, k)] < 0 !== s) {
          quad(
            vertexAt[cellIdx(i, j - 1, k - 1)], vertexAt[cellIdx(i, j, k - 1)],
            vertexAt[cellIdx(i, j, k)], vertexAt[cellIdx(i, j - 1, k)], s
          );
        }
        if (values[idx(i, j + 1, k)] < 0 !== s) {
          quad(
            vertexAt[cellIdx(i - 1, j, k - 1)], vertexAt[cellIdx(i, j, k - 1)],
            vertexAt[cellIdx(i, j, k)], vertexAt[cellIdx(i - 1, j, k)], !s
          );
        }
        if (values[idx(i, j, k + 1)] < 0 !== s) {
          quad(
            vertexAt[cellIdx(i - 1, j - 1, k)], vertexAt[cellIdx(i, j - 1, k)],
            vertexAt[cellIdx(i, j, k)], vertexAt[cellIdx(i - 1, j, k)], s
          );
        }
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Half-width helper re-exported so callers need only this module. */
export { semiAxisFor };
