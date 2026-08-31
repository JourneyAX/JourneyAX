'use client';

import { useJourney } from '@/context/JourneyContext';

export default function SizeRecommendationPanel() {
  const { state } = useJourney();
  const rec = state.sizeRecommendation;
  const send = (t: string) => (window as any).__journeySend?.(t);
  if (!rec) return null;

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Fitment guide</div>
          <h2 className="clarify-panel__heading">
            {rec.recommendedSize ? `Recommended size: ${rec.recommendedSize}` : 'Sizing'}
          </h2>

          <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 8, lineHeight: 1.5 }}>{rec.message}</div>

          {rec.recommendedSize && (
            <div className="product-card" style={{ marginTop: 20, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontWeight: 800, fontSize: 22, color: 'var(--text)' }}>{rec.recommendedSize}</div>
              </div>
              {rec.availableSizes?.length ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                  We stock: {rec.availableSizes.join(', ')}
                </div>
              ) : null}
              {rec.bandSource === 'standard-us-apparel' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>
                  Placed on a standard US size band — the size ITSELF is one we really stock, but the
                  measurement-to-size band is a general convention, not this brand's own chart.
                </div>
              )}
            </div>
          )}

          {!rec.recommendedSize && rec.availableSizes?.length ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 14 }}>
              We stock: {rec.availableSizes.join(', ')}
            </div>
          ) : null}
        </div>
      </div>
      <div className="clarify-panel__footer">
        <button
          className="clarify-build-btn"
          onClick={() => send(rec.recommendedSize ? `Great, add it in size ${rec.recommendedSize}.` : 'Let me tell you my usual size a different way.')}
        >
          {rec.recommendedSize ? 'Continue with this size →' : 'Try again →'}
        </button>
      </div>
    </div>
  );
}
