/**
 * Change your own password.
 *
 * Requires the current password even though the caller is already signed in:
 * a session left open on an unattended machine must not be enough to take
 * the account over permanently.
 *
 * On success every other session for the account is revoked. A password
 * change is the standard response to "someone may have my credentials", and
 * it would be worthless if the intruder's existing session survived it.
 */

import { cookies } from 'next/headers';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';

import { requireStaff, isUnauthorised } from '@/lib/auth/guard';
import { findUser, updateUser, directoryIsWritable } from '@/lib/auth/users';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';
import { checkPassword } from '@/lib/auth/password-policy';
import { revokeAllFor } from '@/lib/auth/session-store';
import { createStaffSession, cookieOptions, SESSION_COOKIE } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

const log = logger('api/auth/password');

/** Tighter than the general compute limit — this verifies a password. */
const LIMIT = { windowMs: 60_000, max: 10 };

export async function POST(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard<{ currentPassword?: unknown; newPassword?: unknown }>(
    req, { scope: 'password', rule: LIMIT },
  );
  if (isFailure(guarded)) return guarded.response;

  if (!directoryIsWritable()) {
    // Say so plainly rather than accepting the change and discarding it.
    return errorResponse(
      501, 'directory_read_only',
      'Passwords cannot be changed here. Set JOURNEYAX_USER_STORE to enable account management.',
    );
  }

  const { currentPassword, newPassword } = guarded.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return errorResponse(400, 'invalid_body', 'Both the current and new password are required.');
  }

  const user = await findUser(auth.session.sub);
  if (!user) return errorResponse(401, 'not_authenticated', 'Sign in to continue.');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    log.warn(`password change refused — wrong current password for ${user.username}`);
    return errorResponse(403, 'wrong_password', 'Your current password was not correct.');
  }

  if (newPassword === currentPassword) {
    return errorResponse(400, 'password_unchanged', 'Choose a password you have not just used.');
  }

  const policy = checkPassword(newPassword, user.username);
  if (!policy.ok) {
    return errorResponse(400, 'weak_password', policy.problems.join(' '), { problems: policy.problems });
  }

  await updateUser(user.username, {
    passwordHash: await hashPassword(newPassword),
    passwordChangedAt: new Date().toISOString(),
    mustChangePassword: false,
  });

  // Issue the replacement first so it can be named in the exemption, then
  // revoke everything else. Doing it the other way round would revoke the
  // replacement too — both share the same issued-at second.
  const { token, maxAge, jti } = createStaffSession(
    user.username, user.role, { mfa: !!user.totpSecret },
  );
  revokeAllFor(user.username, { exceptJti: jti });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(maxAge));

  log.info(`password changed for ${user.username}; other sessions revoked`);
  return Response.json({ ok: true, otherSessionsRevoked: true });
}
