'use client';

import { useState } from 'react';
import { GARMENT_SPECS, sizesOf } from '@/services/fit/garment-specs';
import FitAdvisor from './FitAdvisor';

/**
 * A stand-in product page.
 *
 * It exists so the advisor can be judged where it will actually live —
 * next to a size picker, competing with a shopper's impatience — rather
 * than on a page of its own where it looks better than it is.
 */
export default function ProductPage() {
  const [styleId, setStyleId] = useState(GARMENT_SPECS[0].styleId);
  const [size, setSize] = useState<string | null>(null);
  const [advised, setAdvised] = useState(false);

  const garment = GARMENT_SPECS.find(g => g.styleId === styleId)!;
  const sizes = sizesOf(garment);

  const pick = (s: string) => { setSize(s); setAdvised(false); };
  const fromAdvisor = (s: string) => { setSize(s); setAdvised(true); };

  return (
    <div className="pdp">
      <div className="pdp__switcher">
        <span className="pdp__switchlabel">Try it on</span>
        {GARMENT_SPECS.map(g => (
          <button
            key={g.styleId}
            className={`pdp__switch${g.styleId === styleId ? ' is-on' : ''}`}
            onClick={() => { setStyleId(g.styleId); setSize(null); setAdvised(false); }}
          >
            {g.styleName}
          </button>
        ))}
      </div>

      <div className="pdp__grid">
        <div className="pdp__media" aria-hidden>
          <div className="pdp__shot">
            <span className="pdp__shotid">{garment.styleId}</span>
          </div>
        </div>

        <div className="pdp__info">
          <div className="pdp__brand">
            {garment.brandId === 'abercrombie' ? 'Abercrombie & Fitch' : 'Augusta Sportswear'}
          </div>
          <h1 className="pdp__name">{garment.styleName}</h1>
          <div className="pdp__price">
            {garment.category === 'bottom' ? '$89.00' : garment.brandId === 'augusta' ? '$70.50' : '$39.00'}
          </div>

          <div className="pdp__sizerow">
            <span className="pdp__sizelabel">Size</span>
            <FitAdvisor garment={garment} onUseSize={fromAdvisor} />
          </div>

          <div className="pdp__sizes">
            {sizes.map(s => (
              <button
                key={s}
                className={`pdp__size${s === size ? ' is-on' : ''}`}
                onClick={() => pick(s)}
              >
                {s}
              </button>
            ))}
          </div>

          {advised && size && (
            <div className="pdp__advised">
              <span className="pdp__advisedmark" aria-hidden>⌖</span>
              Size {size} selected by the Fit Advisor.
            </div>
          )}

          <button className="pdp__add" disabled={!size}>
            {size ? `Add ${size} to bag` : 'Select a size'}
          </button>

          <p className="pdp__note">
            {garment.stretchIn < 1
              ? 'Woven fabric — very little give.'
              : 'Fabric has some stretch.'}{' '}
            {garment.chart === 'womens' ? "Cut to women's sizing."
              : garment.chart === 'mens' ? "Cut to men's sizing." : 'Unisex cut.'}
          </p>
        </div>
      </div>
    </div>
  );
}
