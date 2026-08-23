'use client';

import { useJourney } from '@/context/JourneyContext';
import { formatAUD } from '@/lib/types';

/**
 * The bag.
 *
 * Two things make this different from the bathroom QuotePanel, and both come
 * straight out of the research:
 *
 *   · It accumulates. updateQuote replaces the whole BOM every time the
 *     model calls it; a bag that forgot the shirt you chose four turns ago
 *     would break the "one continuous journey" claim outright.
 *   · An unsized line blocks checkout. The whole point of putting fit in
 *     front of the order is that the order cannot quietly go out with a
 *     guessed size. So "needs a size" is a real gate, not a warning label,
 *     and the fix is one click back into the Fit Advisor.
 */
export default function BagPanel() {
  const { state, dispatch, bagTotals, t } = useJourney();
  const { bag } = state;

  const ask = (text: string) => {
    const send = (window as unknown as {
      __handleUserMessage?: (t: string) => void;
    }).__handleUserMessage;
    send?.(text);
  };

  if (!bag.length) {
    return (
      <div className="clarify-panel">
        <div className="clarify-panel__eyebrow">{t('bag.eyebrow')}</div>
        <h2 className="clarify-panel__heading">{t('bag.heading')}</h2>
        <p className="clarify-panel__desc">{t('bag.empty')}</p>
      </div>
    );
  }

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">{t('bag.eyebrow')}</div>
          <h2 className="clarify-panel__heading">{t('bag.heading')}</h2>
          <p className="clarify-panel__desc">{t('bag.desc')}</p>

          <div className="bag-list">
            {bag.map(line => (
              <div
                key={line.id}
                className={`bag-line ${line.size ? '' : 'bag-line--unsized'}`}
              >
                <div className="bag-line__main">
                  <div className="bag-line__name">{line.name}</div>
                  {line.reason && <div className="bag-line__reason">{line.reason}</div>}

                  {line.size ? (
                    <div className="bag-line__size">
                      <span className="bag-line__size-tag">
                        {t('bag.size')} {line.size}
                      </span>
                      {line.sizeRationale && (
                        <span className="bag-line__size-why">{line.sizeRationale}</span>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="bag-line__size-cta"
                      onClick={() => ask(`What size should I take in the ${line.name}?`)}
                    >
                      {t('bag.needsSize')} — {t('bag.sizeThis')}
                    </button>
                  )}
                </div>

                <div className="bag-line__side">
                  <div className="bag-line__price">
                    {formatAUD(line.price * line.quantity)}
                  </div>
                  <div className="bag-qty">
                    <button
                      type="button"
                      aria-label="decrease"
                      onClick={() =>
                        dispatch({
                          type: 'SET_BAG_LINE_QTY',
                          lineId: line.id,
                          quantity: line.quantity - 1,
                        })
                      }
                    >
                      −
                    </button>
                    <span>{line.quantity}</span>
                    <button
                      type="button"
                      aria-label="increase"
                      onClick={() =>
                        dispatch({
                          type: 'SET_BAG_LINE_QTY',
                          lineId: line.id,
                          quantity: line.quantity + 1,
                        })
                      }
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    className="bag-line__remove"
                    onClick={() => dispatch({ type: 'REMOVE_FROM_BAG', lineId: line.id })}
                  >
                    {t('bag.remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="clarify-panel__footer">
        <div className="bag-total-row">
          <span className="bag-total-row__label">
            {t('bag.subtotal')} · {bagTotals.itemCount} {t('bag.items')}
          </span>
          <span className="bag-total-row__value">{formatAUD(bagTotals.subtotal)}</span>
        </div>

        {bagTotals.unsized > 0 && (
          <div className="bag-blocked">
            {bagTotals.unsized === 1 ? t('bag.blocked') : t('bag.blockedPlural')}
          </div>
        )}

        <button
          className="clarify-build-btn"
          disabled={bagTotals.unsized > 0}
          onClick={() => ask('I am happy with my bag — please place the order.')}
        >
          {t('bag.checkout')}
        </button>
      </div>
    </div>
  );
}
