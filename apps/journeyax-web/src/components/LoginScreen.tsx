'use client';

/**
 * Storefront sign-in gate. Shown instead of the chat + panel whenever there is
 * no valid session — anonymous access is off until the token path is proven.
 * Themed from the tenant config (logo, brand colour) so PlaceMakers, Caroma,
 * A&F each get their own sign-in, not a generic one.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { PublicDemoLogin } from '@/lib/auth/demoLogins';
import PersonaLogins from './PersonaLogins';
import { useAuth } from '@/context/AuthContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function LoginScreen() {
  const { login, loginAs } = useAuth();
  const cfg = useStorefrontConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // On a demo the server offers a button for each demo persona (see lib/auth/demoLogins.ts); otherwise this stays empty.
  const [personas, setPersonas] = useState<PublicDemoLogin[]>([]);
  const [personaBusy, setPersonaBusy] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/demo-logins', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { logins: [] }))
      .then((data) => { if (!cancelled && Array.isArray(data?.logins)) setPersonas(data.logins); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const signInAsPersona = async (id: string) => {
    setError(null);
    setPersonaBusy(id);
    const r = await loginAs(id);
    setPersonaBusy('');
    if (!r.success) setError(r.message || 'Sign-in failed.');
  };

  const brand = cfg.companyName || 'JourneyAX';
  const accent = cfg.theme?.primaryColor || '#00AEC7';
  const sidebar = cfg.theme?.sidebarColor || '#0B2A56';
  const logo = cfg.theme?.logoUrl;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await login(email.trim(), password);
    setBusy(false);
    if (!r.success) setError(r.message || 'Sign-in failed.');
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: '2fr 3fr', fontFamily: cfg.theme?.fontFamily || 'inherit' }}>
      <div style={{ background: sidebar, color: '#FFFFFF', padding: '48px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div>
          {logo ? (
            <img src={logo} alt={brand} style={{ height: 36, width: 'auto' }} />
          ) : (
            <div style={{ fontSize: 22, fontWeight: 700 }}>{brand}</div>
          )}
        </div>
        <div>
          <div style={{ fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', color: accent, fontWeight: 700, marginBottom: 12 }}>
            {brand}
          </div>
          <h1 style={{ fontSize: 34, lineHeight: 1.15, margin: '0 0 14px', fontWeight: 700 }}>
            {cfg.labels?.headerTitle || 'Your project, planned in one conversation.'}
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.78)', margin: 0, maxWidth: 420 }}>
            Sign in to talk to your {brand} consultant — real catalogue, real stock, one complete quote.
          </p>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>JourneyAX · Agent Experience</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, background: '#F4F1EC', padding: 32, overflowY: 'auto' }}>
        <form onSubmit={onSubmit} style={{ width: '100%', maxWidth: 400, background: '#FFFFFF', border: '1px solid #E4DFD4', padding: '36px 36px 30px', boxShadow: '0 12px 40px rgba(11,42,86,0.08)' }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: '#0A0A0A' }}>Sign in</h2>
          <p style={{ margin: '0 0 24px', fontSize: 13.5, color: '#6B655B' }}>Use your {brand} account to continue.</p>

          <label htmlFor="login-email" style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4A453C', marginBottom: 6 }}>Email</label>
          <input
            id="login-email"
            name="email"
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15, border: '1px solid #cbd5e1', borderRadius: 8, marginBottom: 16, outline: 'none' }}
          />

          <label htmlFor="login-password" style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4A453C', marginBottom: 6 }}>Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15, border: '1px solid #cbd5e1', borderRadius: 8, marginBottom: 20, outline: 'none' }}
          />

          {error && (
            <div role="alert" style={{ fontSize: 13, color: '#B00020', marginBottom: 14, fontWeight: 600 }}>{error}</div>
          )}

          <button
            id="login-submit"
            type="submit"
            disabled={busy}
            style={{ width: '100%', padding: '14px 18px', fontSize: 15, fontWeight: 700, color: '#0A0A0A', background: accent, border: 'none', borderRadius: 8, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 }}
          >
            {busy ? 'Signing in…' : 'Sign in →'}
          </button>

          <button
            id="quick-login-btn"
            type="button"
            onClick={async () => {
              setEmail('admin');
              setPassword('admin');
              setBusy(true);
              const r = await login('admin', 'admin');
              setBusy(false);
              if (!r.success) setError(r.message || 'Sign-in failed.');
            }}
            style={{
              marginTop: 10,
              width: '100%',
              padding: '10px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: '#334155',
              background: '#f1f5f9',
              border: '1px dashed #94a3b8',
              borderRadius: 8,
              cursor: 'pointer'
            }}
          >
            ⚡ Quick Demo Sign-in (admin / admin)
          </button>

          {process.env.NODE_ENV !== 'production' && (
            <p style={{ margin: '14px 0 0', fontSize: 12, color: '#A29A8B', textAlign: 'center' }}>
              Dev credentials: admin / admin
            </p>
          )}
        </form>
        <PersonaLogins logins={personas} busyId={personaBusy} accent={accent} onPick={signInAsPersona} />
      </div>
    </div>
  );
}
