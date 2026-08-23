'use client';

import { AdvisorAnswers, GarmentSpec } from '@/lib/advisor-types';
import { advise } from '@/services/fit/advisor';
import { garmentsForBrand } from '@/services/fit/garment-specs';

/**
 * "Your size across the range."
 *
 * Once the body estimate exists, running it against every other garment the
 * brand sells is nearly free — and it answers the question a shopper has
 * next, which is whether the number they just learned means anything on the
 * item beside it. It almost never does: a tee, a woven shirt and a jean are
 * three different scales.
 *
 * This is the profile becoming useful beyond the one product page, which is
 * the whole argument for holding a size profile at all.
 */
export default function SizeAcrossRange({
  current,
  answers,
}: {
  current: GarmentSpec;
  answers: AdvisorAnswers;
}) {
  const others = garmentsForBrand(current.brandId).filter(g => g.styleId !== current.styleId);
  if (!others.length) return null;

  const rows = others
    .map(g => ({ garment: g, result: advise(g, { ...answers, chart: g.chart }) }))
    .filter(r => r.result?.recommended);

  if (!rows.length) return null;

  return (
    <div className="adv-range">
      <div className="adv-range__label">Your size elsewhere in this range</div>
      <ul className="adv-range__list">
        {rows.map(({ garment, result }) => (
          <li key={garment.styleId}>
            <span className="adv-range__size">{result!.recommended!.size}</span>
            <span className="adv-range__name">{garment.styleName}</span>
            <span className="adv-range__note">
              {garment.stretchIn < 1 ? 'woven, little give' : `${garment.category === 'bottom' ? 'bottoms' : 'tops'} scale`}
            </span>
          </li>
        ))}
      </ul>
      <p className="adv-range__foot">
        Sizes are not comparable between styles — these are worked out separately.
      </p>
    </div>
  );
}
