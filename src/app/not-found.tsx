import Link from 'next/link';

export const metadata = {
  title: 'Not found — JourneyAX',
};

/**
 * 404. Points at the journeys that exist rather than dead-ending — the staff
 * routes are omitted on purpose, since a signed-out visitor landing here has
 * no use for them.
 */
export default function NotFound() {
  return (
    <main className="fault-shell">
      <div className="fault-card">
        <p className="fault-card__brand">CAROMA · MADE FOR LIFE</p>
        <h1 className="fault-card__title">That page does not exist.</h1>
        <p className="fault-card__body">
          It may have moved, or the link may be wrong.
        </p>

        <div className="fault-card__actions">
          <Link className="login-submit" href="/">Bathroom configurator</Link>
          <Link className="tryon-secondary" href="/shop">Personal shopper</Link>
        </div>
      </div>
    </main>
  );
}
