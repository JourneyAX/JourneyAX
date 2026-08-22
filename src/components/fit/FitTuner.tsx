'use client';

import { BodyEstimate, BodyZone, ZONE_LABEL } from '@/lib/advisor-types';

/**
 * "These are our numbers — correct them."
 *
 * The single most common complaint about size advisors is that they hand you
 * a verdict you cannot argue with. An estimate from height and weight is a
 * population average, and plenty of people know exactly where they differ
 * from it. Letting them drag the chest two inches, watch the avatar change
 * and watch the recommendation change with it turns the tool from an oracle
 * into something they are steering.
 *
 * The overrides feed straight back through resolveBody, so a corrected
 * measurement is used as fact and raises confidence rather than lowering it.
 */

type Tunable = 'chest' | 'waist' | 'hip' | 'inseam';

const RANGE: Record<Tunable, { min: number; max: number; step: number }> = {
  chest:  { min: 26, max: 64, step: 0.5 },
  waist:  { min: 22, max: 60, step: 0.5 },
  hip:    { min: 26, max: 64, step: 0.5 },
  inseam: { min: 24, max: 38, step: 0.5 },
};

/**
 * The profile is the whole body, not the current garment.
 *
 * Showing only the zones this style happens to be judged on means a shopper
 * who corrects their chest on a tee has to do it again on a shirt, and can
 * never tell us their leg length at all. Everything is editable; the ones
 * that decide THIS size are marked, so the connection stays obvious.
 */
const PROFILE_ORDER: Tunable[] = ['chest', 'waist', 'hip', 'inseam'];

export default function FitTuner({
  body,
  zones,
  overrides,
  onChange,
  onFocus,
  onReset,
}: {
  body: BodyEstimate;
  /** Only the zones this garment is judged on are worth tuning. */
  zones: BodyZone[];
  overrides: { chest?: number; waist?: number; hip?: number; inseam?: number };
  onChange: (zone: Tunable, value: number) => void;
  onFocus: (zone: BodyZone | null) => void;
  onReset: () => void;
}) {
  // Leg length is only worth asking about for bottoms; the rest always show.
  const showsLeg = zones.includes('inseam') || body.inseam !== undefined;
  const rows = PROFILE_ORDER.filter(z => z !== 'inseam' || showsLeg);
  if (!rows.length) return null;

  const decidesThis = new Set<string>(zones);
  const edited = rows.some(z => overrides[z] !== undefined);

  return (
    <div className="adv-tune">
      <div className="adv-tune__head">
        <span className="adv-tune__title">Not quite right? Adjust it.</span>
        {edited && (
          <button className="adv-tune__reset" onClick={onReset}>
            Back to our estimate
          </button>
        )}
      </div>

      {rows.map(zone => {
        const value = overrides[zone] ?? body[zone] ?? RANGE[zone].min;
        const isEdited = overrides[zone] !== undefined;
        const counts = decidesThis.has(zone);
        return (
          <label key={zone} className={`adv-tune__row${counts ? '' : ' is-inactive'}`}>
            <span className="adv-tune__label">
              {zone === 'inseam' ? 'Leg length' : ZONE_LABEL[zone]}
              {isEdited && <span className="adv-tune__flag">yours</span>}
            </span>
            <input
              className="adv-tune__slider"
              type="range"
              min={RANGE[zone].min}
              max={RANGE[zone].max}
              step={RANGE[zone].step}
              value={value}
              /* Fills the track up to the handle — a native range input has
                 no way to express this, and an unfilled track is the single
                 clearest tell that a control was left at its defaults. */
              style={{
                ['--pct' as string]:
                  `${((value - RANGE[zone].min) / (RANGE[zone].max - RANGE[zone].min)) * 100}%`,
              }}
              aria-label={`${ZONE_LABEL[zone]} measurement in inches`}
              onChange={e => onChange(zone, Number(e.target.value))}
              onPointerDown={() => onFocus(zone)}
              onPointerUp={() => onFocus(null)}
              onFocus={() => onFocus(zone)}
              onBlur={() => onFocus(null)}
            />
            <span className="adv-tune__value">{value.toFixed(1)}″</span>
          </label>
        );
      })}

      <p className="adv-tune__note">
        {edited
          ? 'Using your measurements. The size above updates as you drag.'
          : 'Measured yourself? Drag to match and the recommendation follows.'}
        {rows.some(z => !decidesThis.has(z)) && (
          <> Dimmed rows do not affect this item, but we keep them on your profile.</>
        )}
      </p>
    </div>
  );
}
