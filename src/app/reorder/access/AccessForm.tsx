'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

type Stage = 'checking' | 'sending' | 'code' | 'done' | 'dead-link';

/**
 * The coach's way in: they arrive here from the private link Momentec
 * emailed, and confirm the mailbox with a six-digit code.
 *
 * The token stays in component state and is posted in the body rather than
 * being carried onward in the URL, so it does not end up in browser history
 * or a Referer header once the coach navigates on.
 */
export default function AccessForm() {
  const token = useSearchParams().get('token') ?? '';

  // A missing token is knowable at render time, so derive it rather than
  // setting state from an effect.
  const [stage, setStage] = useState<Stage>(token ? 'sending' : 'dead-link');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    token ? null : 'This link is missing its access token.',
  );
  const [devPreview, setDevPreview] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  const requestCode = useCallback(async (): Promise<void> => {
    const res = await fetch('/api/coach/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => null);

    if (res.status === 429) {
      // A code is still in flight and still valid — show it rather than
      // stranding the user with no way to read it.
      setResendIn(Number(res.headers.get('Retry-After')) || 30);
      setMasked(body?.maskedEmail ?? '');
      setDevPreview(body?.devPreview ?? null);
      setStage('code');
      setError(body?.error?.message ?? null);
      return;
    }
    if (!res.ok) {
      setStage('dead-link');
      setError(body?.error?.message ?? 'This link is no longer valid.');
      return;
    }

    setMasked(body.maskedEmail ?? '');
    setDevPreview(body.devPreview ?? null);
    setResendIn(body.resendAfterSeconds ?? 30);
    setStage('code');
  }, [token]);

  // Ask for a code as soon as the coach lands, so the common path is
  // "open email, read code, type it" with no extra click.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) return;
    // The rule cannot tell a synchronous setState cascade from an ordinary
    // fetch-on-mount. Every state update inside requestCode happens after an
    // await, which is the pattern the rule exists to distinguish from.
    // Requesting the code on arrival is the whole point of this screen: the
    // coach clicked a link in their email and should not have to click again.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void requestCode();
  }, [token, requestCode]);

  // Count the resend cooldown down so the button explains itself.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const res = await fetch('/api/coach/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, code }),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      setError(body?.error?.message ?? 'That did not work. Try again.');
      setCode('');
      return;
    }

    setStage('done');
    // A hard navigation, not router.push + router.refresh(). The soft
    // navigation was observed sending the browser straight back to this
    // access page immediately after landing on /reorder — reproducible,
    // twice, in the server log. A full page load picks up the fresh cookie
    // unambiguously and leaves no soft-navigation history entry to bounce
    // back into.
    window.location.assign('/reorder');
  }

  if (stage === 'dead-link') {
    return (
      <div className="ca-card">
        <p className="ca-brand">MOMENTEC</p>
        <h1 className="ca-title">This link has expired</h1>
        <p className="ca-body">{error}</p>
        <p className="ca-note">
          Links are personal and time-limited. Ask your Momentec contact to send a new one.
        </p>
      </div>
    );
  }

  return (
    <form className="ca-card" onSubmit={submit}>
      <p className="ca-brand">MOMENTEC</p>
      <h1 className="ca-title">Confirm it&rsquo;s you</h1>
      <p className="ca-body">
        {stage === 'sending'
          ? 'Sending a six-digit code…'
          : masked
            ? <>We sent a six-digit code to <strong>{masked}</strong>. Enter it below.</>
            /* Reached when a code was already in flight (resend cooldown), so
               this request never returned the address. Saying "sent to ." with
               an empty space reads as a bug. */
            : <>Enter the six-digit code from the email we just sent you.</>}
      </p>

      <label className="ca-field">
        <span>Six-digit code</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          disabled={stage !== 'code'}
          required
          autoFocus
        />
      </label>

      {error && <p className="ca-error" role="alert">{error}</p>}

      <button className="ca-submit" type="submit" disabled={stage !== 'code' || code.length !== 6}>
        {stage === 'done' ? 'Signed in' : 'Confirm'}
      </button>

      <button
        type="button"
        className="ca-resend"
        onClick={() => { setError(null); setStage('sending'); void requestCode(); }}
        disabled={resendIn > 0 || stage === 'sending'}
      >
        {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
      </button>

      {devPreview && (
        <div className="ca-dev">
          <p className="ca-dev__label">
            No mail provider is configured, so nothing was actually emailed.
            This panel is development-only and never appears in production.
          </p>
          <pre>{devPreview}</pre>
        </div>
      )}
    </form>
  );
}
