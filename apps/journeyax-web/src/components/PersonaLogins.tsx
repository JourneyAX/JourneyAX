'use client';

/**
 * "Try the demo as…": one button per demo persona on the sign-in screen. A button signs in as that person (the server holds the
 * password; see lib/auth/demoLogins.ts), so a demo can be shown as a customer service adviser, a branch counter or a trade customer in
 * one click. Nothing is drawn when the server offers no demo logins.
 */
import type { PublicDemoLogin } from '@/lib/auth/demoLogins';

export default function PersonaLogins({ logins, busyId, accent, onPick }: {
  logins: PublicDemoLogin[];
  /** The button being signed in with, if any; every button waits while one is. */
  busyId: string;
  accent: string;
  onPick: (id: string) => void;
}) {
  if (logins.length === 0) return null;
  const groups = (['Staff', 'Customers'] as const).map((group) => ({ group, items: logins.filter((login) => login.group === group) })).filter((entry) => entry.items.length > 0);
  return (
    <section aria-label="Try the demo as a persona" style={{ width: '100%', maxWidth: 560, background: '#FFFFFF', border: '1px solid #E4DFD4', padding: '24px 28px 20px', boxSizing: 'border-box' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: '#0A0A0A' }}>Try the demo as…</h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6B655B' }}>No password needed. Each button signs in as a demo person, with the rights of their team.</p>
      {groups.map(({ group, items }) => (
        <div key={group} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8A8274', marginBottom: 8 }}>{group === 'Staff' ? 'Colleagues' : 'Customers'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
            {items.map((login) => (
              <button
                key={login.id}
                type="button"
                data-persona={login.id}
                disabled={busyId !== ''}
                onClick={() => onPick(login.id)}
                style={{ textAlign: 'left', padding: '10px 12px', background: busyId === login.id ? '#F1ECE2' : '#FAF8F4', border: `1px solid ${busyId === login.id ? accent : '#E4DFD4'}`, borderRadius: 8, cursor: busyId !== '' ? 'wait' : 'pointer', color: '#1B1812', opacity: busyId !== '' && busyId !== login.id ? 0.55 : 1 }}
              >
                <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{busyId === login.id ? 'Signing in…' : login.label}</span>
                {login.description && <span style={{ display: 'block', marginTop: 2, fontSize: 12.5, lineHeight: 1.4, color: '#6B655B' }}>{login.description}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
