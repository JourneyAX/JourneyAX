'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Until this existed, any render-time exception in a panel took the whole
 * page to blank white — no message, no way back, and nothing in the logs
 * except a client-side stack the user never reports. A configurator that
 * disappears mid-quote is worse than one that admits it broke.
 *
 * Deliberately does not show `error.message`: it is an internal string, and
 * the useful identifier for support is `digest`, which Next assigns and also
 * writes to the server log.
 */
export default function JourneyError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  // Renamed from `reset` in Next 16.2 — `reset` re-renders without re-fetching,
  // which is rarely what you want here.
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // The place to hand off to an error tracker when one exists.
    console.error('[journey] render failed', error);
  }, [error]);

  return (
    <main className="fault-shell">
      <div className="fault-card">
        <p className="fault-card__brand">CAROMA · MADE FOR LIFE</p>
        <h1 className="fault-card__title">Something went wrong on our side.</h1>
        <p className="fault-card__body">
          Your conversation is still here. Try again, and if it keeps happening,
          start a new one — nothing has been ordered.
        </p>

        <div className="fault-card__actions">
          <button className="login-submit" type="button" onClick={() => unstable_retry()}>
            Try again
          </button>
          {/*
            Deliberately a plain anchor, not next/link. A soft navigation keeps
            the client-side state that just crashed; a full document load is the
            only way to be sure "start a new conversation" actually starts one.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="tryon-secondary" href="/">Start a new conversation</a>
        </div>

        {error.digest && (
          <p className="fault-card__ref">
            Reference <code>{error.digest}</code> — quote this if you contact us.
          </p>
        )}
      </div>
    </main>
  );
}
