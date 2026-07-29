'use client';

import { useJourney } from '@/context/JourneyContext';

// Hoisted out of the component (react-hooks/static-components): defining a
// component inside render remounts it every pass. Pure presentational row.
const Row = ({ label, value }: { label: string; value?: string }) =>
  value ? (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 3, lineHeight: 1.5 }}>{value}</div>
    </div>
  ) : null;

export default function WarrantyPanel() {
  const { state } = useJourney();
  const w = state.warranty;
  const send = (t: string) => (window as any).__journeySend?.(t);
  if (!w) return null;

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Warranty &amp; guarantee</div>
          <h2 className="clarify-panel__heading">{w.productName ? `${w.productName} — warranty` : 'Warranty & guarantee'}</h2>

          <Row label="Standard warranty" value={w.standardWarranty} />
          <Row label="Conditions" value={w.conditions} />
          <Row label="DIY vs plumber" value={w.installationNote} />

          {w.documentUrl && (
            <a href={w.documentUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 16, fontSize: 12.5, fontWeight: 700, color: 'var(--text)', textDecoration: 'underline' }}>
              View official warranty document →
            </a>
          )}

          {w.extendedPackage && (
            <div className="product-card" style={{ marginTop: 20, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>{w.extendedPackage.name}</div>
                {typeof w.extendedPackage.price === 'number' && <div style={{ fontWeight: 800, color: 'var(--text)' }}>+${w.extendedPackage.price}</div>}
              </div>
              {w.extendedPackage.summary && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>{w.extendedPackage.summary}</div>}
              <button className="clarify-build-btn" style={{ marginTop: 12, width: '100%' }} onClick={() => send(`Add the ${w.extendedPackage!.name} to my quote.`)}>
                Add to quote
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="clarify-panel__footer">
        <button className="clarify-build-btn" onClick={() => send('Understood on the warranty — please build my quote now.')}>
          Continue to quote →
        </button>
      </div>
    </div>
  );
}
