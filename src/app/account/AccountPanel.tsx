'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface Me {
  authenticated: boolean;
  username?: string;
  role?: string;
  mfaEnabled?: boolean;
  mustChangePassword?: boolean;
  recoveryCodesRemaining?: number;
  canManageAccount?: boolean;
}

/**
 * Password and MFA management.
 *
 * Everything here needs a writable user directory. When the app is running on
 * the read-only environment directory the controls are hidden and the reason
 * is stated, rather than offering buttons that would fail.
 */
export default function AccountPanel() {
  const router = useRouter();
  const forced = useSearchParams().get('forced') === '1';

  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // MFA enrolment, held only until it is activated.
  const [enrolSecret, setEnrolSecret] = useState<string | null>(null);
  const [enrolUri, setEnrolUri] = useState<string | null>(null);
  const [enrolCode, setEnrolCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/auth/me');
    const body: Me = await res.json();
    if (!body.authenticated) { router.push('/login?next=/account'); return; }
    setMe(body);
  }, [router]);

  // Load once on mount. `cancelled` stops a late response writing state into
  // an unmounted component — the request outlives a quick navigation away.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/auth/me');
      const body: Me = await res.json();
      if (cancelled) return;
      if (!body.authenticated) { router.push('/login?next=/account'); return; }
      setMe(body);
    })();
    return () => { cancelled = true; };
  }, [router]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error?.message ?? 'Could not change your password.'); return; }

      setCurrentPassword(''); setNewPassword('');
      setNotice('Password changed. Any other sessions have been signed out.');
      await refresh();
    } finally { setBusy(false); }
  }

  async function beginEnrol() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/auth/mfa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error?.message ?? 'Could not start enrolment.'); return; }
      setEnrolSecret(body.secret);
      setEnrolUri(body.otpauthUri);
    } finally { setBusy(false); }
  }

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: enrolCode }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error?.message ?? 'Could not activate MFA.'); return; }

      setEnrolSecret(null); setEnrolUri(null); setEnrolCode('');
      setRecoveryCodes(body.recoveryCodes);
      setNotice('MFA is on. Save these recovery codes — they are shown only once.');
      await refresh();
    } finally { setBusy(false); }
  }

  async function removeMfa() {
    const password = window.prompt('Confirm your password to turn MFA off:');
    if (!password) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error?.message ?? 'Could not remove MFA.'); return; }
      setNotice('MFA is off.');
      await refresh();
    } finally { setBusy(false); }
  }

  async function signOutEverywhere() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    });
    router.push('/login');
  }

  if (!me) return null;

  return (
    <div className="login-card account-card">
      <p className="login-card__brand">MOMENTEC</p>
      <h1 className="login-card__title">Your account</h1>
      <p className="login-card__sub">
        {me.username} · {me.role}
        {me.mfaEnabled ? ' · MFA on' : ' · MFA off'}
      </p>

      {forced && me.mustChangePassword && (
        <p className="login-error" role="alert">
          You are using a temporary password. Choose a new one before continuing.
        </p>
      )}

      {notice && <p className="account-notice" role="status">{notice}</p>}
      {error && <p className="login-error" role="alert">{error}</p>}

      {recoveryCodes && (
        <div className="account-codes">
          <p className="account-codes__warn">Save these now. They will not be shown again.</p>
          <ul>{recoveryCodes.map(c => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      {!me.canManageAccount ? (
        <p className="login-note">
          This deployment uses a read-only account directory, so passwords and MFA
          cannot be changed here. Set <code>JOURNEYAX_USER_STORE</code> to enable it.
        </p>
      ) : (
        <>
          <form className="account-section" onSubmit={changePassword}>
            <h2 className="account-section__title">Change password</h2>
            <label className="login-field">
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)} required />
            </label>
            <label className="login-field">
              <span>New password</span>
              <input type="password" autoComplete="new-password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} required minLength={12} />
            </label>
            <button className="login-submit" type="submit" disabled={busy}>Change password</button>
          </form>

          <div className="account-section">
            <h2 className="account-section__title">Two-factor authentication</h2>

            {me.mfaEnabled && (
              <>
                <p className="login-note">
                  On. {me.recoveryCodesRemaining ?? 0} recovery code(s) left.
                </p>
                <button className="tryon-secondary" type="button" onClick={removeMfa} disabled={busy}>
                  Turn MFA off
                </button>
              </>
            )}

            {!me.mfaEnabled && !enrolSecret && (
              <button className="login-submit" type="button" onClick={beginEnrol} disabled={busy}>
                Set up MFA
              </button>
            )}

            {enrolSecret && (
              <form onSubmit={activate}>
                <p className="login-note">
                  Add this to your authenticator app, then enter the code it shows.
                </p>
                <p className="account-secret">{enrolSecret}</p>
                {enrolUri && <p className="account-uri">{enrolUri}</p>}
                <label className="login-field">
                  <span>Code from your app</span>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code"
                    value={enrolCode} onChange={e => setEnrolCode(e.target.value)}
                    placeholder="000000" required />
                </label>
                <button className="login-submit" type="submit" disabled={busy}>Activate</button>
              </form>
            )}
          </div>
        </>
      )}

      <div className="account-section">
        <button className="tryon-secondary" type="button" onClick={signOutEverywhere}>
          Sign out on every device
        </button>
      </div>
    </div>
  );
}
