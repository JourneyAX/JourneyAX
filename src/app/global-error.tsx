'use client';

/**
 * Last-resort boundary, for failures in the root layout itself.
 *
 * This replaces the root layout when active, so it must supply its own
 * <html> and <body> — and it cannot rely on the app's stylesheet having
 * loaded, which is why the styling here is inline rather than class-based.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#14110E',
          color: '#F7F4EE',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <p style={{ fontSize: 10, letterSpacing: '.22em', opacity: 0.6, margin: 0 }}>
            CAROMA · MADE FOR LIFE
          </p>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: '14px 0 10px' }}>
            This page could not load.
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.75, margin: '0 0 22px' }}>
            Nothing has been ordered. Please try again.
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              background: '#C9A46A',
              color: '#14110E',
              border: 'none',
              borderRadius: 8,
              padding: '11px 22px',
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ fontSize: 11, opacity: 0.5, marginTop: 18 }}>
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
