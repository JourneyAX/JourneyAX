/**
 * The coach's session, once they have proved the mailbox.
 *
 * Carries the coach id and nothing about which schools they may see. That is
 * the important part: schools are re-read from the directory on every
 * request, so removing a school takes effect immediately rather than whenever
 * the cookie happens to expire. A cookie that carried its own permissions
 * would be a stale copy of the access rules, and stale access rules are how
 * someone keeps seeing a school they were removed from.
 */

import { randomUUID } from 'node:crypto';
import { encodeSigned, decodeSigned, nowSeconds } from './crypto';
import { isRevoked } from './revocation';
import { findCoachById, type CoachRecord } from './directory';

export const COACH_COOKIE = 'jax_coach';
/** A working day. Coaches use this occasionally, not all day. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

interface SessionPayload {
  cid: string;
  iat: number;
  exp: number;
  k: 'session';
  /** Session id, so this one session can be revoked by name on sign-out. */
  jti: string;
}

export function createCoachSession(coachId: string): { token: string; maxAge: number } {
  const iat = nowSeconds();
  return {
    token: encodeSigned<SessionPayload>({
      cid: coachId, iat, exp: iat + SESSION_TTL_SECONDS, k: 'session', jti: randomUUID(),
    }),
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** The session's id and expiry, for revoking it. Null if not a valid session. */
export function sessionHandle(token: string | undefined | null): { jti: string; exp: number } | null {
  const payload = decodeSigned<SessionPayload>(token);
  if (!payload || payload.k !== 'session' || typeof payload.jti !== 'string') return null;
  return { jti: payload.jti, exp: payload.exp };
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

/**
 * Resolve a session token to a live coach.
 *
 * Returns null if the signature fails, it has expired, it is the wrong token
 * kind, or the coach has been removed from the directory.
 */
export function resolveCoachSession(token: string | undefined | null): CoachRecord | null {
  const payload = decodeSigned<SessionPayload>(token);
  if (!payload) return null;
  // An invite token must never be accepted as a session — the whole point of
  // the code step is that holding the link is not enough.
  if (payload.k !== 'session') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds()) return null;
  if (typeof payload.cid !== 'string') return null;
  // Signed out, so the token is dead even though it still verifies.
  if (isRevoked(payload.jti)) return null;

  return findCoachById(payload.cid);
}

/** Read the coach session straight off a Request. */
export function coachFromRequest(req: Request): CoachRecord | null {
  const header = req.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COACH_COOKIE) continue;
    return resolveCoachSession(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}
