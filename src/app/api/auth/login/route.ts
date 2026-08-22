/**
 * Staff sign-in.
 *
 * Three gates, in order: IP rate limit, per-account lockout, then the
 * password, then MFA if the account has it.
 *
 * MFA is answered in the *same* request rather than by issuing a
 * half-authenticated "pending" token. A pending token is another credential
 * to mint, transport and expire, and it is exactly the thing people forget to
 * scope — so the client simply resubmits with the code attached.
 */

import { cookies } from 'next/headers';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';
import { authenticate, directoryIsEmpty, updateUser, directoryIsWritable } from '@/lib/auth/users';
import { createStaffSession, cookieOptions, SESSION_COOKIE } from '@/lib/auth/session';
import { checkLock, recordFailure, recordSuccess } from '@/lib/auth/lockout';
import { verifyCode, normalizeRecoveryCode } from '@/lib/auth/totp';
import { verifyPassword } from '@/lib/auth/passwords';
import { logger } from '@/lib/logger';

const log = logger('api/auth/login');

/** Ten attempts a minute per IP. Lockout handles the per-account case. */
const LOGIN_LIMIT = { windowMs: 60_000, max: 10 };
const MAX_FIELD = 200;

function lockedResponse(retryAfter: number) {
  return Response.json(
    {
      error: {
        code: 'account_locked',
        message: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      },
    },
    { status: 423, headers: { 'Retry-After': String(retryAfter) } },
  );
}

export async function POST(req: Request) {
  const guarded = await guard<{
    username?: unknown; password?: unknown; code?: unknown; recoveryCode?: unknown;
  }>(req, { scope: 'login', rule: LOGIN_LIMIT });
  if (isFailure(guarded)) return guarded.response;

  const { username, password, code, recoveryCode } = guarded.body;

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return errorResponse(400, 'invalid_credentials_format', 'Username and password are required.');
  }
  if (username.length > MAX_FIELD || password.length > MAX_FIELD) {
    return errorResponse(400, 'invalid_credentials_format', 'Username or password is too long.');
  }

  if (await directoryIsEmpty()) {
    log.error('login attempted but no staff accounts are configured');
    return errorResponse(503, 'no_accounts', 'No staff accounts are configured yet.');
  }

  // ── Lockout, before the password is even checked ─────────────────────
  const lock = checkLock(username);
  if (lock.locked) return lockedResponse(lock.retryAfter);

  const user = await authenticate(username, password);
  if (!user) {
    const after = recordFailure(username);
    log.warn('failed sign-in attempt');
    if (after.locked) return lockedResponse(after.retryAfter);
    // One message for both "no such user" and "wrong password".
    return errorResponse(401, 'invalid_credentials', 'That username and password did not match.');
  }

  // ── MFA, when the account has it activated ───────────────────────────
  let usedRecoveryCode = false;

  if (user.totpSecret) {
    const hasCode = typeof code === 'string' && code.trim().length > 0;
    const hasRecovery = typeof recoveryCode === 'string' && recoveryCode.trim().length > 0;

    if (!hasCode && !hasRecovery) {
      // The password was right — say so, so the form can ask for the code.
      // This does not leak anything an attacker with the password lacks.
      return Response.json({ mfaRequired: true }, { status: 200 });
    }

    if (hasRecovery) {
      const submitted = normalizeRecoveryCode(recoveryCode as string);
      const hashes = user.recoveryCodeHashes ?? [];

      let matchedIndex = -1;
      for (let i = 0; i < hashes.length; i++) {
        if (await verifyPassword(submitted, hashes[i])) { matchedIndex = i; break; }
      }

      if (matchedIndex === -1) {
        const after = recordFailure(username);
        if (after.locked) return lockedResponse(after.retryAfter);
        return errorResponse(401, 'invalid_mfa', 'That code was not recognised.');
      }

      // Single use — burn it before issuing the session.
      const remaining = hashes.filter((_, i) => i !== matchedIndex);
      await updateUser(user.username, { recoveryCodeHashes: remaining });
      usedRecoveryCode = true;
      log.warn(`recovery code used for ${user.username}; ${remaining.length} left`);
    } else {
      const result = verifyCode(user.totpSecret, code as string, { lastUsedStep: user.totpLastStep });
      if (!result.valid) {
        const after = recordFailure(username);
        if (after.locked) return lockedResponse(after.retryAfter);
        // Mention reuse: a code already spent is rejected even though it still
        // looks current on the phone, and that is otherwise baffling.
        return errorResponse(
          401, 'invalid_mfa',
          'That code was not recognised. If you have just used it, wait for the next one.',
        );
      }
      // Record the spent step so the same code cannot be replayed.
      await updateUser(user.username, { totpLastStep: result.step });
    }
  }

  recordSuccess(username);

  const { token, maxAge } = createStaffSession(user.username, user.role, { mfa: !!user.totpSecret });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(maxAge));

  log.info(`signed in: ${user.username} (${user.role})`);

  return Response.json({
    username: user.username,
    role: user.role,
    mfaEnabled: !!user.totpSecret,
    // The client routes to the change-password screen instead of the desk.
    mustChangePassword: !!user.mustChangePassword,
    usedRecoveryCode,
    recoveryCodesRemaining: usedRecoveryCode ? (user.recoveryCodeHashes?.length ?? 1) - 1 : undefined,
    canManageAccount: directoryIsWritable(),
  });
}
