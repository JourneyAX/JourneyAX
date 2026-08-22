'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

/**
 * Staff sign-in.
 *
 * Two steps when the account has MFA: the password is submitted first, the
 * server answers `mfaRequired`, and the form resubmits everything with the
 * code attached. The password is held in component state across that step
 * rather than exchanged for a temporary token — one fewer credential to mint,
 * transport and expire.
 *
 * Error text is whatever the server sent, which is deliberately identical for
 * an unknown username and a wrong password. The UI must not be more helpful
 * than the API about which half was wrong.
 */
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Only allow relative paths through. An open redirect here would let an
   * attacker send a signed-in CSR to a lookalike site via the ?next param.
   */
  const nextPath = (() => {
    const raw = params.get('next');
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/csr';
    return raw;
  })();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const payload: Record<string, string> = { username, password };
      if (needsMfa) {
        if (useRecovery) payload.recoveryCode = code;
        else payload.code = code;
      }

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error?.message ?? 'Could not sign you in.');
        return;
      }

      // Password accepted, second factor still outstanding.
      if (body?.mfaRequired) {
        setNeedsMfa(true);
        setCode('');
        return;
      }

      if (body?.usedRecoveryCode) {
        // Worth interrupting for: recovery codes are single-use and finite.
        const left = body.recoveryCodesRemaining ?? 0;
        alert(`Recovery code used. You have ${left} left. Set up a new device soon.`);
      }

      // A temporary password must be changed before anything else.
      router.push(body?.mustChangePassword ? '/account?forced=1' : nextPath);
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-card" onSubmit={onSubmit}>
      <p className="login-card__brand">MOMENTEC</p>
      <h1 className="login-card__title">{needsMfa ? 'One more step' : 'Staff sign-in'}</h1>
      <p className="login-card__sub">
        {needsMfa
          ? useRecovery
            ? 'Enter one of the recovery codes you saved when you set up MFA.'
            : 'Enter the six-digit code from your authenticator app.'
          : 'The reorder desk and size review are staff-only.'}
      </p>

      {!needsMfa && (
        <>
          <label className="login-field">
            <span>Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              autoFocus
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </label>
        </>
      )}

      {needsMfa && (
        <>
          <label className="login-field">
            <span>{useRecovery ? 'Recovery code' : 'Authentication code'}</span>
            <input
              type="text"
              name={useRecovery ? 'recovery-code' : 'one-time-code'}
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'}
              required
              autoFocus
            />
          </label>

          <button
            type="button"
            className="login-linkbtn"
            onClick={() => { setUseRecovery(v => !v); setCode(''); setError(null); }}
          >
            {useRecovery ? 'Use my authenticator app instead' : 'I have lost my device'}
          </button>
        </>
      )}

      {error && <p className="login-error" role="alert">{error}</p>}

      <button className="login-submit" type="submit" disabled={busy}>
        {busy ? 'Checking…' : needsMfa ? 'Verify' : 'Sign in'}
      </button>

      <p className="login-note">
        Shopping? The <Link href="/shop">personal shopper</Link> and{' '}
        <Link href="/">bathroom configurator</Link> need no account.
      </p>
    </form>
  );
}
