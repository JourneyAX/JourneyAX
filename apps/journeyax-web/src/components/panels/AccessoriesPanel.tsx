'use client';

import { useJourney } from '@/context/JourneyContext';
import type { AccessoryItem } from '@/lib/types';

const GROUP_META: Record<AccessoryItem['group'], { label: string; hint: string }> = {
  required: { label: 'Required to install', hint: 'You need these' },
  recommended: { label: 'Recommended', hint: 'Strongly suggested' },
  optional: { label: 'Optional add-ons', hint: 'Nice to have' },
};

export default function AccessoriesPanel() {
  const { state } = useJourney();
  const items = state.accessories || [];
  const groups: AccessoryItem['group'][] = ['required', 'recommended', 'optional'];

  const send = (t: string) => (window as any).__journeySend?.(t);

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Accessories &amp; parts</div>
          <h2 className="clarify-panel__heading">Complete your setup</h2>
          <p className="clarify-panel__desc">Matching accessories and the parts needed to install your selection.</p>

          {groups.map((g) => {
            const rows = items.filter((i) => i.group === g);
            if (!rows.length) return null;
            return (
              <div key={g} style={{ marginTop: 18 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{GROUP_META[g].label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{GROUP_META[g].hint}</span>
                </div>
                {rows.map((a, i) => (
                  <div key={a.sku || a.name + i} className="product-card" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12 }}>
                      {a.imageUrl && <img src={a.imageUrl} alt={a.name} style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 8 }} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>{a.name}</div>
                        {a.reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.reason}</div>}
                      </div>
                      {typeof a.price === 'number' && <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>${a.price}</div>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {!items.length && <p style={{ color: 'var(--text-muted)', marginTop: 16 }}>No accessories to show yet.</p>}
        </div>
      </div>
      <div className="clarify-panel__footer" style={{ display: 'flex', gap: 10 }}>
        <button className="clarify-build-btn" style={{ flex: 1 }} onClick={() => send('These accessories look good — add them and continue.')}>
          Add these &amp; continue →
        </button>
        <button className="clarify-build-btn" style={{ flex: 1, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }} onClick={() => send('Skip the optional accessories, just continue.')}>
          Skip optional
        </button>
      </div>
    </div>
  );
}
