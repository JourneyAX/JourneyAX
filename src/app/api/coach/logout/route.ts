/**
 * Sign out.
 *
 * Clears the cookie AND revokes the session id, so a token copied off the
 * machine beforehand stops working immediately. Before revocation existed
 * this route only cleared the cookie, and the old token stayed valid for its
 * full twelve hours — which on a shared school computer is the session the
 * next person inherits.
 */

import { cookies } from 'next/headers';
import { COACH_COOKIE, cookieOptions, sessionHandle } from '@/lib/coach/session';
import { revoke } from '@/lib/coach/revocation';

export async function POST() {
  const store = await cookies();

  const handle = sessionHandle(store.get(COACH_COOKIE)?.value);
  if (handle) revoke(handle.jti, handle.exp);

  store.set(COACH_COOKIE, '', cookieOptions(0));
  return Response.json({ ok: true });
}
