/**
 * Request proxy — the file convention formerly called `middleware.ts`.
 * (Renamed in Next 16; it defaults to the Node.js runtime now.)
 *
 * Does two things, both deliberately cheap:
 *
 *   1. Keeps unauthenticated people out of the staff pages, by reading the
 *      session cookie only.
 *   2. Issues an anonymous session to shoppers who do not have one, so rate
 *      limiting can key on a browser instead of a shared IP.
 *
 * This is NOT the security boundary. The Next docs are explicit that a proxy
 * runs on prefetches and must not perform data-layer checks; an attacker can
 * also call an API route directly and never touch it. The real check is
 * `requireStaff` inside each protected route handler. This layer exists so
 * people get a sensible redirect rather than a bare 401.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  cookieOptions,
  createAnonymousSession,
  decodeSession,
} from '@/lib/auth/session';

/** Pages only staff may see. API routes enforce this themselves as well. */
const STAFF_PATHS = ['/csr', '/fit', '/account'];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Signature and expiry only — deliberately NOT the revocation check.
  //
  // This is not laziness, and it is not a free choice. Next bundles the proxy
  // separately from route handlers, so module-level state is a *different
  // instance* here: the in-memory revocation store this file would consult is
  // not the one the login route writes to. Checking revocation here silently
  // does nothing. ("You should not attempt relying on shared modules or
  // globals" — the proxy docs, meant literally.)
  //
  // Revocation is therefore enforced where the state lives: `requireStaff` in
  // the route handlers, and `/api/auth/me`, which clears a dead cookie so the
  // browser stops presenting it.
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);

  // ── Staff gate ───────────────────────────────────────────────────────
  if (STAFF_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    // `role` is what grants access — an anonymous session must not pass.
    if (!session?.role) {
      const login = new URL('/login', req.url);
      // Send them back where they were going once they have signed in.
      login.searchParams.set('next', pathname + search);

      const res = NextResponse.redirect(login);
      // Clear a stale or revoked cookie on the way out. Belt and braces
      // against any future path that could re-enter the loop above.
      if (req.cookies.has(SESSION_COOKIE) && !session) {
        res.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
      }
      return res;
    }
  }

  // ── Signed-in staff have no reason to see the login form ─────────────
  //
  // Skipped when `next` is present. A client that was bounced here *because*
  // its session turned out to be dead arrives with `?next=`, and the cookie
  // still looks valid to this optimistic check — bouncing it back would be an
  // infinite loop between the page it cannot use and the form it needs.
  if (pathname === '/login' && session?.role && !req.nextUrl.searchParams.has('next')) {
    return NextResponse.redirect(new URL('/csr', req.url));
  }

  // ── Anonymous session for everyone else ──────────────────────────────
  const res = NextResponse.next();

  // Never touch the cookie on the auth routes. Those handlers set the session
  // themselves, and issuing an anonymous one here puts a second Set-Cookie for
  // the same name on the response — whichever the browser keeps is a coin
  // toss, and a successful sign-in can end up storing the anonymous cookie.
  const managesItsOwnSession = pathname.startsWith('/api/auth/');

  if (!session && !managesItsOwnSession) {
    const { token, maxAge } = createAnonymousSession();
    res.cookies.set(SESSION_COOKIE, token, cookieOptions(maxAge));
  }
  return res;
}

export const config = {
  // Without a matcher this runs on every request including static assets,
  // which would issue a cookie for every image and stylesheet.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|css|js|woff2?)$).*)',
  ],
};
