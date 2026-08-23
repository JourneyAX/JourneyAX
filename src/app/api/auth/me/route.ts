/**
 * Who am I?
 *
 * Used by the staff pages to render a name, an MFA prompt and a sign-out
 * control. Returns 200 with `authenticated: false` rather than a 401, because
 * "not signed in" is a normal answer to this question, not an error.
 */

import { cookies } from 'next/headers';
import { sessionFromRequest, decodeSession, cookieOptions, SESSION_COOKIE } from '@/lib/auth/session';
import { findUser, directoryIsWritable } from '@/lib/auth/users';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = sessionFromRequest(req);

  // An anonymous session is not an identity — report it as signed out. A
  // revoked session lands here too, since sessionFromRequest rejects it.
  if (!session?.role) {
    // If the browser is still holding a cookie that *looks* like a staff
    // session but no longer is — revoked, most often — clear it. The proxy
    // cannot: it is bundled separately and cannot see the revocation store,
    // so it would keep waving the dead cookie through to staff pages.
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE)?.value;
    if (raw && decodeSession(raw)?.role) {
      store.set(SESSION_COOKIE, '', cookieOptions(0));
    }
    return Response.json({ authenticated: false });
  }

  const user = await findUser(session.sub);

  return Response.json({
    authenticated: true,
    username: session.sub,
    role: session.role,
    expiresAt: new Date(session.exp * 1000).toISOString(),
    mfaEnabled: !!user?.totpSecret,
    mustChangePassword: !!user?.mustChangePassword,
    recoveryCodesRemaining: user?.recoveryCodeHashes?.length ?? 0,
    // Drives whether the account screen offers anything at all.
    canManageAccount: directoryIsWritable(),
  });
}
