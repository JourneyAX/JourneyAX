/**
 * Step one: the coach has clicked their private link.
 *
 * Resolves the invite token to a coach and emails them a six-digit code.
 * Returns only a *masked* address — enough for the coach to recognise their
 * own mailbox, not enough for someone holding a forwarded link to learn a new
 * one.
 */

import { resolveInvite } from '@/lib/coach/invite';
import { issueCode, RESEND_COOLDOWN_SECONDS } from '@/lib/coach/codes';
import { maskEmail } from '@/lib/coach/directory';
import { send, lastMessageFor } from '@/lib/coach/mailer';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';

/** Tight: this endpoint causes an email to be sent. */
const LIMIT = { windowMs: 60_000, max: 6 };

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const guarded = await guard<{ token?: unknown }>(req, { scope: 'coach-start', rule: LIMIT });
  if (isFailure(guarded)) return guarded.response;

  const { token } = guarded.body;
  if (typeof token !== 'string' || !token) {
    return errorResponse(400, 'missing_token', 'This link is missing its access token.');
  }

  const coach = resolveInvite(token);
  if (!coach) {
    // One message for expired, forged, and revoked. Distinguishing them would
    // tell someone probing tokens which of their guesses were once real.
    return errorResponse(
      401, 'invalid_link',
      'This link is no longer valid. Ask Momentec to send you a new one.',
    );
  }

  const issued = issueCode(coach.id);

  if ('retryAfterSeconds' in issued) {
    // The still-valid code stays readable in development. Suppressing it here
    // meant a reload during the cooldown left no way to see the code at all —
    // the previous one had scrolled away and a new one would not be issued.
    // `lastMessageFor` returns null in production, so nothing leaks there.
    return Response.json(
      {
        error: {
          code: 'code_recently_sent',
          message: `A code was just sent. You can request another in ${issued.retryAfterSeconds}s.`,
        },
        maskedEmail: maskEmail(coach.email),
        devPreview: lastMessageFor(coach.email)?.body ?? null,
      },
      { status: 429, headers: { 'Retry-After': String(issued.retryAfterSeconds) } },
    );
  }

  send({
    to: coach.email,
    subject: 'Your Momentec reorder code',
    body:
      `Hi ${coach.name},\n\n` +
      `Your confirmation code is ${issued.code}\n\n` +
      `It expires in ${Math.round(issued.expiresInSeconds / 60)} minutes. ` +
      `If you did not request this, you can ignore this email.`,
  });

  return Response.json({
    maskedEmail: maskEmail(coach.email),
    expiresInSeconds: issued.expiresInSeconds,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
    // Development affordance so the flow is demonstrable without a mail
    // provider. `lastMessageFor` returns null in production, so a real
    // deployment cannot leak a code here even if this field is left in.
    devPreview: lastMessageFor(coach.email)?.body ?? null,
  });
}
