'use client';

import { BodyEstimate, GarmentCategory, SizingChart, ZONE_LABEL, ZoneFit, verdictLabel } from '@/lib/advisor-types';

/**
 * The body figure, with the garment drawn on it.
 *
 * Two things are being shown at once, and both are real rather than
 * decorative:
 *
 *   · The FIGURE is the shopper. Its chest, waist and hip widths are scaled
 *     from the body estimate, so a broader build produces a broader outline.
 *   · The GARMENT over it is this size, at this ease. Where it sits close to
 *     the body it reads tight; where it stands off, it reads roomy.
 *
 * One deliberate distortion, stated here so nobody mistakes it for accuracy:
 * ease is EXAGGERATED. Four inches of circumference is only about three
 * quarters of an inch of width per side, which at this scale is a couple of
 * pixels and invisible. EASE_PX_PER_IN blows that up so the difference
 * between a snug and a roomy fit is legible. The numbers quoted in the panel
 * are the true ones; the drawing is a diagram, not a measurement.
 */

const W = 240;
const H = 360;
const CX = W / 2;

// Vertical positions of each landmark.
const Y = { head: 34, neck: 60, shoulder: 76, chest: 118, waist: 168, hip: 208, knee: 275, ankle: 340 };

// Half-widths in pixels for a reference build, per chart.
const BASE: Record<SizingChart, { shoulder: number; chest: number; waist: number; hip: number }> = {
  mens: { shoulder: 50, chest: 43, waist: 36, hip: 40 },
  womens: { shoulder: 42, chest: 38, waist: 31, hip: 44 },
  unisex: { shoulder: 46, chest: 40, waist: 33, hip: 42 },
};

/** The build those base widths correspond to, in inches of circumference. */
const REF_IN = { chest: 40, waist: 34, hip: 39 };

/** Pixels of drawn stand-off per inch of ease. See the note above. */
const EASE_PX_PER_IN = 1.7;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function FitSilhouette({
  body,
  zones,
  category,
  chart,
  size,
}: {
  body: BodyEstimate;
  zones: ZoneFit[];
  category: GarmentCategory;
  chart: SizingChart;
  size: string;
}) {
  const base = BASE[chart] ?? BASE.unisex;

  // ── The figure ───────────────────────────────────────────────────────
  // Scale each landmark by how the estimate compares with the reference
  // build. Clamped so an extreme input bends the drawing rather than
  // breaking it.
  const scale = (measured: number | undefined, ref: number) =>
    clamp(measured ? measured / ref : 1, 0.72, 1.42);

  const sChest = scale(body.chest, REF_IN.chest);
  const sWaist = scale(body.waist, REF_IN.waist);
  const sHip = scale(body.hip, REF_IN.hip);

  const bodyW = {
    shoulder: base.shoulder * (0.55 + 0.45 * sChest),
    chest: base.chest * sChest,
    waist: base.waist * sWaist,
    hip: base.hip * sHip,
  };

  // ── The garment ──────────────────────────────────────────────────────
  const easeAt = (zone: ZoneFit['zone']) => zones.find(z => z.zone === zone)?.easeIn ?? null;
  const standOff = (zone: ZoneFit['zone'], fallback: number) => {
    const e = easeAt(zone);
    // No reading for this zone — follow the body with a token amount of room.
    if (e === null) return fallback;
    return clamp(e * EASE_PX_PER_IN, -6, 30);
  };

  const gChest = bodyW.chest + standOff('chest', 5);
  const gWaist = bodyW.waist + standOff('waist', 6);
  const gHip = bodyW.hip + standOff('hip', 6);

  // Worst zone drives the garment's colour, so the figure agrees with the
  // verdict printed above it.
  const worst = zones.length
    ? [...zones].sort((a, b) => Math.abs(b.position - 0.5) - Math.abs(a.position - 0.5))[0]
    : null;
  const tone = worst ? TONE[worst.verdict] : TONE['just-right'];

  const bodyPath = torsoPath(bodyW);
  const garment = category === 'bottom'
    ? bottomPath(gWaist, gHip)
    : topPath(bodyW.shoulder, gChest, gWaist);

  return (
    <div className="adv-fig">
      <svg
        className="adv-fig__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Size ${size} shown on a figure matching your measurements`}
      >
        {/* ── The person ─────────────────────────────────────────────── */}
        <g className="adv-fig__body">
          <circle cx={CX} cy={Y.head} r={20} />
          <rect x={CX - 9} y={Y.head + 16} width={18} height={16} rx={5} />
          <path d={bodyPath} />
          <path d={legsPath(bodyW.hip)} />
          <path d={armsPath(bodyW.shoulder)} />
        </g>

        {/* ── The garment at this size ───────────────────────────────── */}
        <path
          className="adv-fig__garment"
          d={garment}
          style={{ fill: tone.fill, stroke: tone.stroke }}
        />

        {/* ── Zone callouts ──────────────────────────────────────────── */}
        {zones.map(z => {
          const y = Y[z.zone === 'inseam' ? 'knee' : z.zone];
          const half = z.zone === 'chest' ? gChest : z.zone === 'waist' ? gWaist : gHip;
          const t = TONE[z.verdict];
          return (
            <g key={z.zone} className="adv-fig__zone">
              <line
                x1={CX - half - 4} y1={y} x2={CX + half + 4} y2={y}
                style={{ stroke: t.stroke }}
              />
              <circle cx={CX - half - 4} cy={y} r={2.5} style={{ fill: t.stroke }} />
              <circle cx={CX + half + 4} cy={y} r={2.5} style={{ fill: t.stroke }} />
            </g>
          );
        })}

        {/* The size, set into the figure the way a garment label would be. */}
        <text className="adv-fig__size" x={CX} y={Y.chest + 8} textAnchor="middle">{size}</text>
      </svg>

      {/* Legend beside the figure, so each zone's verdict has a name. */}
      <ul className="adv-fig__key">
        {zones.map(z => (
          <li key={z.zone}>
            <span className="adv-fig__keydot" style={{ background: TONE[z.verdict].stroke }} aria-hidden />
            <span className="adv-fig__keyzone">{ZONE_LABEL[z.zone]}</span>
            <span className="adv-fig__keyverdict">{verdictLabel(z.zone, z.verdict)}</span>
            <span className="adv-fig__keyease">
              {z.zone === 'inseam'
                ? `${z.easeIn >= 0 ? '+' : ''}${z.easeIn}″ vs your leg`
                : z.easeIn >= 0 ? `${z.easeIn}″ room` : `${Math.abs(z.easeIn)}″ stretch`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Tones ──────────────────────────────────────────────────────────────
const TONE: Record<ZoneFit['verdict'], { fill: string; stroke: string }> = {
  'very-tight': { fill: 'rgba(154,74,56,.20)', stroke: '#9A4A38' },
  snug: { fill: 'rgba(166,124,78,.20)', stroke: '#A67C4E' },
  'just-right': { fill: 'rgba(78,124,89,.20)', stroke: '#4E7C59' },
  relaxed: { fill: 'rgba(166,124,78,.20)', stroke: '#A67C4E' },
  loose: { fill: 'rgba(154,74,56,.20)', stroke: '#9A4A38' },
};

// ── Paths ──────────────────────────────────────────────────────────────
// Built from the landmark widths rather than hard-coded, so the outline
// actually changes shape with the estimate.

type Widths = { shoulder: number; chest: number; waist: number; hip: number };

function torsoPath(w: Widths): string {
  const { shoulder: sh, chest: ch, waist: wa, hip: hi } = w;
  return [
    `M ${CX - sh} ${Y.shoulder}`,
    `C ${CX - sh - 2} ${Y.shoulder + 18} ${CX - ch} ${Y.chest - 16} ${CX - ch} ${Y.chest}`,
    `C ${CX - ch} ${Y.chest + 26} ${CX - wa} ${Y.waist - 18} ${CX - wa} ${Y.waist}`,
    `C ${CX - wa} ${Y.waist + 20} ${CX - hi} ${Y.hip - 16} ${CX - hi} ${Y.hip}`,
    `L ${CX + hi} ${Y.hip}`,
    `C ${CX + hi} ${Y.hip - 16} ${CX + wa} ${Y.waist + 20} ${CX + wa} ${Y.waist}`,
    `C ${CX + wa} ${Y.waist - 18} ${CX + ch} ${Y.chest + 26} ${CX + ch} ${Y.chest}`,
    `C ${CX + ch} ${Y.chest - 16} ${CX + sh + 2} ${Y.shoulder + 18} ${CX + sh} ${Y.shoulder}`,
    `Q ${CX} ${Y.shoulder - 12} ${CX - sh} ${Y.shoulder}`,
    'Z',
  ].join(' ');
}

function legsPath(hip: number): string {
  const inner = 5;
  const thigh = hip * 0.46;
  const calf = hip * 0.30;
  return [
    // left
    `M ${CX - hip} ${Y.hip} L ${CX - hip + 4} ${Y.knee} L ${CX - thigh + 2} ${Y.ankle}`,
    `L ${CX - calf + 4} ${Y.ankle} L ${CX - inner} ${Y.knee} L ${CX - inner} ${Y.hip} Z`,
    // right
    `M ${CX + hip} ${Y.hip} L ${CX + hip - 4} ${Y.knee} L ${CX + thigh - 2} ${Y.ankle}`,
    `L ${CX + calf - 4} ${Y.ankle} L ${CX + inner} ${Y.knee} L ${CX + inner} ${Y.hip} Z`,
  ].join(' ');
}

function armsPath(shoulder: number): string {
  const w = 13;
  return [
    `M ${CX - shoulder} ${Y.shoulder} L ${CX - shoulder - w} ${Y.shoulder + 12}`,
    `L ${CX - shoulder - w + 3} ${Y.hip + 12} L ${CX - shoulder + 2} ${Y.hip + 12} Z`,
    `M ${CX + shoulder} ${Y.shoulder} L ${CX + shoulder + w} ${Y.shoulder + 12}`,
    `L ${CX + shoulder + w - 3} ${Y.hip + 12} L ${CX + shoulder - 2} ${Y.hip + 12} Z`,
  ].join(' ');
}

/** A tee: neckline, short sleeves, hem just below the hip. */
function topPath(shoulder: number, chest: number, waist: number): string {
  const neck = 15;
  const sl = shoulder + 16;      // sleeve outer edge
  const slHem = Y.chest - 4;     // where the sleeve ends
  const hem = Y.hip + 14;
  return [
    `M ${CX - neck} ${Y.shoulder - 4}`,
    `L ${CX - shoulder - 3} ${Y.shoulder + 2}`,
    `L ${CX - sl} ${slHem}`,
    `L ${CX - sl + 14} ${slHem + 5}`,
    `L ${CX - chest} ${Y.chest + 4}`,
    `C ${CX - chest} ${Y.chest + 28} ${CX - waist} ${Y.waist - 16} ${CX - waist} ${hem}`,
    `L ${CX + waist} ${hem}`,
    `C ${CX + waist} ${Y.waist - 16} ${CX + chest} ${Y.chest + 28} ${CX + chest} ${Y.chest + 4}`,
    `L ${CX + sl - 14} ${slHem + 5}`,
    `L ${CX + sl} ${slHem}`,
    `L ${CX + shoulder + 3} ${Y.shoulder + 2}`,
    `L ${CX + neck} ${Y.shoulder - 4}`,
    `Q ${CX} ${Y.shoulder + 14} ${CX - neck} ${Y.shoulder - 4}`,
    'Z',
  ].join(' ');
}

/** Trousers: waistband down to the ankle, with a rise between the legs. */
function bottomPath(waist: number, hip: number): string {
  const cuff = hip * 0.34;
  const rise = Y.hip + 34;
  return [
    `M ${CX - waist} ${Y.waist - 6}`,
    `C ${CX - waist - 2} ${Y.hip - 20} ${CX - hip} ${Y.hip - 8} ${CX - hip} ${Y.hip + 6}`,
    `L ${CX - cuff - 8} ${Y.ankle}`,
    `L ${CX - 4} ${Y.ankle}`,
    `L ${CX - 3} ${rise}`,
    `L ${CX + 3} ${rise}`,
    `L ${CX + 4} ${Y.ankle}`,
    `L ${CX + cuff + 8} ${Y.ankle}`,
    `L ${CX + hip} ${Y.hip + 6}`,
    `C ${CX + hip} ${Y.hip - 8} ${CX + waist + 2} ${Y.hip - 20} ${CX + waist} ${Y.waist - 6}`,
    'Z',
  ].join(' ');
}
