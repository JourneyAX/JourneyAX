'use client';

import { useJourney } from '@/context/JourneyContext';
import FitSilhouette from '@/components/fit/FitSilhouette';
import { GARMENT_SPECS } from '@/services/fit/garment-specs';

/**
 * Virtual try-on.
 *
 * The single most important decision in this panel is what it refuses to be.
 * Try-on is the *visual confidence layer* — it shows drape, length and
 * proportion so the shopper can picture the garment. It is not the fit
 * engine. ASOS says exactly this on their own try-on, and the research deck
 * calls treating generative try-on as a fit guarantee the classic mistake.
 *
 * So:
 *   · the size shown always comes from the Fit Advisor, never from here;
 *   · the disclaimer is part of the panel, not a footnote;
 *   · if we have no body estimate we say so rather than drawing a stock
 *     mannequin and implying it is them.
 *
 * The drawing itself reuses FitSilhouette, which is already honest about its
 * own exaggeration: ease is drawn larger than life for legibility while the
 * quoted inches stay true.
 */
export default function TryOnPanel() {
  const { state, dispatch, t } = useJourney();
  const view = state.tryOn;
  const choice = state.fitChoice;

  const ask = (text: string) => {
    const send = (window as unknown as {
      __handleUserMessage?: (t: string) => void;
    }).__handleUserMessage;
    send?.(text);
  };

  if (!view) {
    return (
      <div className="clarify-panel">
        <div className="clarify-panel__eyebrow">{t('tryon.eyebrow')}</div>
        <h2 className="clarify-panel__heading">{t('tryon.heading')}</h2>
        <p className="clarify-panel__desc">{t('tryon.desc')}</p>
      </div>
    );
  }

  const spec = GARMENT_SPECS.find(g => g.styleId === view.styleId);
  const canDraw = !!(spec && choice?.body && choice?.zones?.length);

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">{t('tryon.eyebrow')}</div>
          <h2 className="clarify-panel__heading">{t('tryon.heading')}</h2>
          <p className="clarify-panel__desc">{t('tryon.desc')}</p>

          <div className="tryon-head">
            <span className="tryon-head__style">{view.styleName}</span>
            <span className="tryon-head__size">
              {t('tryon.sizeShown')} {view.size}
            </span>
          </div>

          {canDraw ? (
            <div className="tryon-stage">
              <FitSilhouette
                body={choice!.body!}
                zones={choice!.zones!}
                category={spec!.category}
                chart={spec!.chart}
                size={view.size}
              />
            </div>
          ) : (
            <div className="tryon-empty">
              We need your size from the Fit Advisor before we can show this on you.
            </div>
          )}

          {(view.fitSummary || choice?.summary) && (
            <div className="tryon-summary">{view.fitSummary ?? choice?.summary}</div>
          )}

          <p className="tryon-disclaimer">{t('tryon.disclaimer')}</p>
        </div>
      </div>

      <div className="clarify-panel__footer tryon-actions">
        <button
          className="clarify-build-btn"
          onClick={() => {
            dispatch({ type: 'CLOSE_TRY_ON' });
            ask(
              `I have seen the try-on for the ${view.styleName} in size ${view.size} `
              + 'and I am happy with it. Please add it to my bag.'
            );
          }}
        >
          {t('tryon.keep')}
        </button>
        <button
          className="tryon-secondary"
          onClick={() => ask(`Can I check my size again for the ${view.styleName}?`)}
        >
          {t('tryon.resize')}
        </button>
      </div>
    </div>
  );
}
