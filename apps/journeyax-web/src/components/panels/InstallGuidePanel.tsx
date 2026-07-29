'use client';

import { useJourney } from '@/context/JourneyContext';

export default function InstallGuidePanel() {
  const { state } = useJourney();
  const g = state.installGuide;
  const send = (t: string) => (window as any).__journeySend?.(t);
  if (!g) return null;

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Installation</div>
          <h2 className="clarify-panel__heading">{g.productName ? `Installing your ${g.productName}` : 'Installation guides'}</h2>
          {g.summary && <p className="clarify-panel__desc">{g.summary}</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            {(g.guides || []).map((doc, i) => (
              <div key={doc.url + i} className="product-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 48, borderRadius: 6, background: 'var(--surface-2, rgba(0,0,0,0.05))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>PDF</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>{doc.title}</div>
                  {doc.kind && <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{doc.kind}</div>}
                </div>
                <a href={doc.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', textDecoration: 'underline', whiteSpace: 'nowrap' }}>View</a>
                <a href={doc.url} download style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>Download</a>
              </div>
            ))}
            {!g.guides?.length && <p style={{ color: 'var(--text-muted)' }}>No official install document was found for this product.</p>}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 14 }}>
            Guidance is based on Caroma's official documents. For plumbing-connected work, a licensed plumber is recommended.
          </p>
        </div>
      </div>
      <div className="clarify-panel__footer">
        <button className="clarify-build-btn" onClick={() => send("Thanks — I've reviewed the install guide. What parts do I need, and continue.")}>
          I've reviewed this — continue →
        </button>
      </div>
    </div>
  );
}
