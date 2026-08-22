/**
 * MFA enrolment, activation and removal.
 *
 *   GET    — current status
 *   POST   — begin enrolment: issue a secret and the otpauth:// URI
 *   PUT    — activate: prove the secret works, receive recovery codes
 *   DELETE — remove MFA (requires the current password)
 *
 * A secret issued by POST is stored as `pendingTotpSecret` and grants nothing
 * until PUT proves the user can generate a code from it. Writing it straight
 * to `totpSecret` would lock somebody out of their own account the moment
 * they closed the tab mid-enrolment.
 */

import { guard, isFailure, errorResponse } from '@/lib/api-guard';
import { requireStaff, isUnauthorised } from '@/lib/auth/guard';
import { findUser, updateUser, directoryIsWritable } from '@/lib/auth/users';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';
import { generateSecret, otpauthUri, verifyCode, generateRecoveryCodes, normalizeRecoveryCode } from '@/lib/auth/totp';
import { revokeAllFor } from '@/lib/auth/session-store';
import { logger } from '@/lib/logger';

const log = logger('api/auth/mfa');

const LIMIT = { windowMs: 60_000, max: 15 };

function readOnly() {
  return errorResponse(
    501, 'directory_read_only',
    'MFA cannot be managed here. Set JOURNEYAX_USER_STORE to enable account management.',
  );
}

export const dynamic = 'force-dynamic';

// ── Status ─────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const user = await findUser(auth.session.sub);
  if (!user) return errorResponse(401, 'not_authenticated', 'Sign in to continue.');

  return Response.json({
    enabled: !!user.totpSecret,
    pending: !!user.pendingTotpSecret,
    activatedAt: user.totpActivatedAt ?? null,
    recoveryCodesRemaining: user.recoveryCodeHashes?.length ?? 0,
    canManage: directoryIsWritable(),
  });
}

// ── Begin enrolment ────────────────────────────────────────────────────
export async function POST(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard(req, { scope: 'mfa', rule: LIMIT });
  if (isFailure(guarded)) return guarded.response;

  if (!directoryIsWritable()) return readOnly();

  const user = await findUser(auth.session.sub);
  if (!user) return errorResponse(401, 'not_authenticated', 'Sign in to continue.');

  if (user.totpSecret) {
    return errorResponse(409, 'already_enrolled', 'MFA is already on. Remove it first to re-enrol.');
  }

  const secret = generateSecret();
  await updateUser(user.username, { pendingTotpSecret: secret });

  // The secret is returned exactly once, to its owner, and never logged.
  return Response.json({
    secret,
    otpauthUri: otpauthUri(secret, user.username),
  });
}

// ── Activate ───────────────────────────────────────────────────────────
export async function PUT(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard<{ code?: unknown }>(req, { scope: 'mfa', rule: LIMIT });
  if (isFailure(guarded)) return guarded.response;

  if (!directoryIsWritable()) return readOnly();

  const user = await findUser(auth.session.sub);
  if (!user) return errorResponse(401, 'not_authenticated', 'Sign in to continue.');

  if (!user.pendingTotpSecret) {
    return errorResponse(409, 'no_pending_enrolment', 'Start enrolment before activating.');
  }

  const { code } = guarded.body;
  if (typeof code !== 'string') {
    return errorResponse(400, 'invalid_body', 'A six-digit code is required.');
  }

  const result = verifyCode(user.pendingTotpSecret, code);
  if (!result.valid) {
    return errorResponse(400, 'invalid_mfa', 'That code was not recognised. Check your device clock.');
  }

  // Recovery codes are shown once here and stored only as hashes.
  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await Promise.all(
    recoveryCodes.map(c => hashPassword(normalizeRecoveryCode(c))),
  );

  await updateUser(user.username, {
    totpSecret: user.pendingTotpSecret,
    pendingTotpSecret: undefined,
    totpActivatedAt: new Date().toISOString(),
    totpLastStep: result.step,
    recoveryCodeHashes,
  });

  // Turning MFA on is a security upgrade, so sessions established under the
  // weaker guarantee are revoked — except the one doing the enrolling.
  //
  // Exempting the current session is not politeness. Activation just consumed
  // this TOTP step, so a forced re-login would reject the code still on the
  // user's screen and only accept the next one, up to 30 seconds later. That
  // reads as "MFA is broken" at precisely the moment someone is deciding
  // whether to trust it.
  revokeAllFor(user.username, { exceptJti: auth.session.jti });

  log.info(`MFA activated for ${user.username}`);
  return Response.json({ ok: true, recoveryCodes, otherSessionsRevoked: true });
}

// ── Remove ─────────────────────────────────────────────────────────────
export async function DELETE(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard<{ password?: unknown }>(req, { scope: 'mfa', rule: LIMIT });
  if (isFailure(guarded)) return guarded.response;

  if (!directoryIsWritable()) return readOnly();

  const user = await findUser(auth.session.sub);
  if (!user) return errorResponse(401, 'not_authenticated', 'Sign in to continue.');

  const { password } = guarded.body;
  // Removing a second factor is a downgrade — re-prove the first one.
  if (typeof password !== 'string' || !(await verifyPassword(password, user.passwordHash))) {
    return errorResponse(403, 'wrong_password', 'Your password was not correct.');
  }

  await updateUser(user.username, {
    totpSecret: undefined,
    pendingTotpSecret: undefined,
    totpActivatedAt: undefined,
    totpLastStep: undefined,
    recoveryCodeHashes: [],
  });

  log.warn(`MFA removed for ${user.username}`);
  return Response.json({ ok: true });
}
