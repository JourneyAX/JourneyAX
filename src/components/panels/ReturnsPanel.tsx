'use client';

import { useJourney } from '@/context/JourneyContext';
import { RETURN_REASONS, sizeDeltaFromReason } from '@/lib/shop-types';
import { GARMENT_SPECS, sizesOf } from '@/services/fit/garment-specs';

/**
 * Returns and exchanges — the step that closes the loop.
 *
 * A returns screen that only issues refunds is a cost centre. The reason this
 * one exists is the last stage of the journey: *learn*. The fit engine
 * already has a return-signal evaluator that moves a future recommendation
 * up or down a size based on why something came back, so a return captured
 * here is worth more than the refund it processes.
 *
 * The honesty constraint: only "too small" and "too big" say anything about
 * size. Returning something because the colour was wrong must not nudge a
 * size recommendation, and the panel must not claim it learned something when
 * it did not — a shopper who is told "noted for next time" after returning
 * for style, and then gets the same size suggestion, has caught us lying.
 */
export default function ReturnsPanel() {
  const { state, dispatch, t } = useJourney();
  const { bag, returnCase } = state;
  const eligible = bag.filter(l => !!l.size);

  const ask = (text: string) => {
    const send = (window as unknown as {
      __handleUserMessage?: (t: string) => void;
    }).__handleUserMessage;
    send?.(text);
  };

  /** The size an exchange should ship in, one step in the indicated direction. */
  const exchangeSizeFor = (): string | undefined => {
    const line = returnCase.line;
    const delta = sizeDeltaFromReason(returnCase.reason);
    if (!line?.size || delta === 0) return undefined;
    const spec = GARMENT_SPECS.find(g => g.styleId === line.sku);
    if (!spec) return undefined;
    const scale = sizesOf(spec);
    const at = scale.indexOf(line.size);
    if (at < 0) return undefined;
    return scale[Math.min(scale.length - 1, Math.max(0, at + delta))];
  };

  const nextSize = exchangeSizeFor();

  if (!eligible.length) {
    return (
      <div className="clarify-panel">
        <div className="clarify-panel__eyebrow">{t('return.eyebrow')}</div>
        <h2 className="clarify-panel__heading">{t('return.heading')}</h2>
        <p className="clarify-panel__desc">{t('return.nothingToReturn')}</p>
      </div>
    );
  }

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">{t('return.eyebrow')}</div>
          <h2 className="clarify-panel__heading">{t('return.heading')}</h2>
          <p className="clarify-panel__desc">{t('return.desc')}</p>

          {/* 1 · which item */}
          <div className="ret-group">
            {eligible.map(line => (
              <button
                key={line.id}
                type="button"
                className={`ret-item ${returnCase.line?.id === line.id ? 'ret-item--on' : ''}`}
                onClick={() => dispatch({ type: 'SET_RETURN_LINE', lineId: line.id })}
              >
                <span className="ret-item__name">{line.name}</span>
                <span className="ret-item__size">
                  {t('bag.size')} {line.size}
                </span>
              </button>
            ))}
          </div>

          {/* 2 · why */}
          {returnCase.line && returnCase.stage !== 'resolved' && (
            <>
              <div className="ret-subhead">{t('return.chooseReason')}</div>
              <div className="ret-reasons">
                {RETURN_REASONS.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    className={`clarify-pill ${returnCase.reason === r.id ? 'clarify-pill--selected' : ''}`}
                    onClick={() => dispatch({ type: 'SET_RETURN_REASON', reason: r.id })}
                  >
                    {t(r.labelKey)}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* 3 · outcome */}
          {returnCase.stage === 'resolved' && (
            <div className="ret-resolved">
              <div className="ret-resolved__title">{t('return.resolved')}</div>
              <div className="ret-resolved__detail">
                {returnCase.resolution === 'exchange' && returnCase.exchangeSize
                  ? `${t('return.exchangeFor')} ${returnCase.exchangeSize}`
                  : t('return.refund')}
              </div>
              {/* Only claim to have learned when a size signal actually moved. */}
              <div className="ret-resolved__learn">
                {returnCase.fedToFitEngine ? t('return.learned') : t('return.notLearned')}
              </div>
            </div>
          )}
        </div>
      </div>

      {returnCase.line && returnCase.reason && returnCase.stage !== 'resolved' && (
        <div className="clarify-panel__footer ret-actions">
          {nextSize && (
            <button
              className="clarify-build-btn"
              onClick={() => {
                dispatch({ type: 'RESOLVE_RETURN', resolution: 'exchange', exchangeSize: nextSize });
                ask(
                  `I am returning the ${returnCase.line!.name} in size ${returnCase.line!.size} `
                  + `because it was ${returnCase.reason === 'too-small' ? 'too small' : 'too big'}. `
                  + `Please send size ${nextSize} instead and remember this for my next size.`
                );
              }}
            >
              {t('return.exchange')} — {nextSize}
            </button>
          )}
          <button
            className="tryon-secondary"
            onClick={() => {
              dispatch({ type: 'RESOLVE_RETURN', resolution: 'refund' });
              ask(
                `I am returning the ${returnCase.line!.name} and would like a refund. `
                + `Reason: ${returnCase.reason}.`
              );
            }}
          >
            {t('return.refund')}
          </button>
        </div>
      )}
    </div>
  );
}
