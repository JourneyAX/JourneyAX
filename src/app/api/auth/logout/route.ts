/**
 * Sign out.
 *
 * Clears the cookie *and* revokes the session id, so a token already copied
 * off the machine stops working immediately. Before revocation existed this
 * route only cleared the cookie, and a stolen token stayed valid for its full
 * eight hours.
 *
 * `{ everywhere: true }` revokes every session the account holds — the right
 * answer to "I think I left myself signed in somewhere".
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE, cookieOptions, sessionFromRequest } from '@/lib/auth/session';
import { revokeToken, revokeAllFor } from '@/lib/auth/session-store';
import { logger } from '@/lib/logger';

const log = logger('api/auth/logout');

export async function POST(req: Request) {
  const session = sessionFromRequest(req);

  // Read the flag defensively — a sign-out must succeed even if the body is
  // empty, malformed, or absent entirely.
  let everywhere = false;
  try {
    const body = await req.json();
    everywhere = body?.everywhere === true;
  } catch {
    // No body: an ordinary single-session sign-out.
  }

  if (session?.role) {
    if (everywhere) {
      revokeAllFor(session.sub);
      log.info(`signed out everywhere: ${session.sub}`);
    } else if (session.jti) {
      revokeToken(session.jti, session.exp);
      log.info(`signed out: ${session.sub}`);
    }
  }

  (await cookies()).set(SESSION_COOKIE, '', cookieOptions(0));
  return Response.json({ ok: true, everywhere });
}
