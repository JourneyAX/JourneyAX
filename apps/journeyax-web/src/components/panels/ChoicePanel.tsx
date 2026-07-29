'use client';

import { useJourney } from '@/context/JourneyContext';

export default function ChoicePanel() {
  const { state, dispatch } = useJourney();
  const choice = state.choice;
  const send = (t: string) => (window as any).__journeySend?.(t);

  if (!choice) return null;

  const pick = (id: string, label: string) => {
    dispatch({ type: 'SELECT_CHOICE', value: id });
    send(`I choose: ${label}.`);
  };

  return (
    <div className="clarify-panel">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">One quick decision</div>
          <h2 className="clarify-panel__heading">{choice.title}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
            {choice.options.map((o) => {
              const active = choice.selected === o.id;
              return (
                <button
                  key={o.id}
                  onClick={() => pick(o.id, o.label)}
                  style={{
                    textAlign: 'left', padding: 16, borderRadius: 12, cursor: 'pointer',
                    border: active ? '2px solid var(--text)' : '1px solid var(--border)',
                    background: active ? 'var(--surface-2, rgba(0,0,0,0.03))' : 'var(--surface, #fff)',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{o.label}</div>
                  {o.description && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{o.description}</div>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
