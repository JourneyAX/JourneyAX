/**
 * Step two: the coach enters the six-digit code.
 *
 * Requires BOTH the invite token and the code. Requiring the token again is
 * not redundant — without it, a correct guess alone would be enough, and the
 * code space is only a million wide.
 */

import { cookies } from 'next/headers';
import { resolveInvite } from '@/lib/coach/invite';
import { verifyCode } from '@/lib/coach/codes';
import { createCoachSession, cookieOptions, COACH_COOKIE } from '@/lib/coach/session';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';

const LIMIT = { windowMs: 60_000, max: 12 };

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const guarded = await guard<{ token?: unknown; code?: unknown }>(
    req, { scope: 'coach-verify', rule: LIMIT },
  );
  if (isFailure(guarded)) return guarded.response;

  const { token, code } = guarded.body;

  if (typeof token !== 'string' || !token) {
    return errorResponse(400, 'missing_token', 'This link is missing its access token.');
  }
  if (typeof code !== 'string' || !/^\s*\d{6}\s*$/.test(code)) {
    return errorResponse(400, 'invalid_code_format', 'Enter the six-digit code from your email.');
  }

  const coach = resolveInvite(token);
  if (!coach) {
    return errorResponse(
      401, 'invalid_link',
      'This link is no longer valid. Ask Momentec to send you a new one.',
    );
  }

  const outcome = verifyCode(coach.id, code);

  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'no-code':
        return errorResponse(400, 'no_code', 'Request a code first.');
      case 'expired':
        return errorResponse(400, 'code_expired', 'That code has expired. Request a new one.');
      case 'too-many-attempts':
        return errorResponse(429, 'too_many_attempts', 'Too many attempts. Request a new code.');
      default:
        return errorResponse(
          401, 'code_mismatch',
          outcome.attemptsLeft > 0
            ? `That code is not right. ${outcome.attemptsLeft} attempt(s) left.`
            : 'That code is not right. Request a new one.',
          { attemptsLeft: outcome.attemptsLeft },
        );
    }
  }

  const { token: sessionToken, maxAge } = createCoachSession(coach.id);
  (await cookies()).set(COACH_COOKIE, sessionToken, cookieOptions(maxAge));

  console.log(`[coach] verified: ${coach.name} (${coach.schools.join(', ')})`);

  return Response.json({
    name: coach.name,
    role: coach.role,
    // Echoed so the UI can say which school it is showing. The server does
    // not trust this back — scoping is re-derived from the directory on every
    // request that reads data.
    schools: coach.schools,
  });
}
