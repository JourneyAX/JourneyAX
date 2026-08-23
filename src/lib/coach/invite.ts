/**
 * The private link Momentec emails to a coach.
 *
 * The token identifies *which* coach the link is for. It is not by itself
 * proof of identity — a forwarded email, a shared screen or a mailbox someone
 * else can read would all hand it to the wrong person. That is precisely why
 * clicking it triggers a six-digit code rather than signing anyone in: the
 * link proves Momentec sent it, the code proves the recipient controls the
 * mailbox. Either alone is weak; together they are reasonable for order
 * history.
 */

import { encodeSigned, decodeSigned, nowSeconds } from './crypto';
import { findCoachById, type CoachRecord } from './directory';

/**
 * Thirty days. Long enough to survive a coach ignoring the email over a
 * school holiday, short enough that a link found in an old inbox two seasons
 * later has expired.
 */
export const INVITE_TTL_SECONDS = 60 * 60 * 24 * 30;

interface InvitePayload {
  /** Coach id, as it appears in the directory. */
  cid: string;
  iat: number;
  exp: number;
  /** Marks the token kind, so a session cookie can never be used as an invite. */
  k: 'invite';
}

export function createInviteToken(coachId: string, ttlSeconds = INVITE_TTL_SECONDS): string {
  const iat = nowSeconds();
  return encodeSigned<InvitePayload>({ cid: coachId, iat, exp: iat + ttlSeconds, k: 'invite' });
}

/**
 * Verify a token and resolve it to a live coach record.
 *
 * Returns null when the signature fails, the token has expired, it is the
 * wrong kind, or the coach is no longer in the directory. That last case
 * matters: revoking someone is done by removing them from the roster, and it
 * has to invalidate links already sitting in their inbox.
 */
export function resolveInvite(token: string | undefined | null): CoachRecord | null {
  const payload = decodeSigned<InvitePayload>(token);
  if (!payload) return null;
  if (payload.k !== 'invite') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds()) return null;
  if (typeof payload.cid !== 'string') return null;

  return findCoachById(payload.cid);
}

/** Build the full URL to email. `baseUrl` has no trailing slash. */
export function inviteUrl(baseUrl: string, coachId: string): string {
  const token = createInviteToken(coachId);
  return `${baseUrl.replace(/\/+$/, '')}/reorder/access?token=${encodeURIComponent(token)}`;
}
