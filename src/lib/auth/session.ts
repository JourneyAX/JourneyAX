/**
 * Signed, stateless sessions.
 *
 * A session is a JSON payload plus an HMAC-SHA256 signature, carried in an
 * HttpOnly cookie. Stateless because there is no session store yet; the
 * signature is what makes the cookie unforgeable, and the embedded expiry is
 * what makes it expire.
 *
 * Two kinds of session exist:
 *
 *   staff      — a real, authenticated person. Gates /csr and /fit.
 *   anonymous  — an unauthenticated shopper. Carries no privileges at all;
 *                it exists so rate limiting can key on a browser rather than
 *                an IP, which a whole office or school shares.
 *
 * An anonymous session must never satisfy an authorisation check. `requireUser`
 * is the only thing that grants access, and it rejects anything without a role.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger';
import { isRevoked } from './session-store';

const log = logger('auth/session');

export const SESSION_COOKIE = 'jax_session';
/** Staff sessions last a working day, then require a fresh login. */
export const STAFF_TTL_SECONDS = 60 * 60 * 8;
/** Anonymous sessions are just a stable id; they may live much longer. */
export const ANON_TTL_SECONDS = 60 * 60 * 24 * 30;

export type Role = 'csr' | 'admin';

export interface SessionPayload {
  /** Subject: a username for staff, a random id for anonymous visitors. */
  sub: string;
  /** Absent means anonymous. Presence is what grants access. */
  role?: Role;
  /** Issued-at and expiry, both Unix seconds. */
  iat: number;
  exp: number;
  /** Unique session id, so this one session can be revoked by name. */
  jti?: string;
  /** True once MFA has been satisfied for this session. */
  mfa?: boolean;
}

/**
 * The signing secret.
 *
 * Refuses to fall back to a development default in production — a predictable
 * secret means anyone can mint a staff cookie, which is worse than no auth at
 * all because it looks secure.
 */
function secret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // Development only, and loud about it.
  log.warn('SESSION_SECRET unset — using an insecure development secret');
  return 'dev-only-insecure-secret-do-not-use-in-production';
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

/** Serialise and sign a payload. */
export function encodeSession(payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Verify and decode a token.
 *
 * Returns null for anything that is not a valid, unexpired, correctly signed
 * session. Callers treat null as "not logged in" — there is no partial trust.
 */
export function decodeSession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload?.sub !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.role !== undefined && payload.role !== 'csr' && payload.role !== 'admin') return null;

  return payload;
}

export function createStaffSession(
  username: string,
  role: Role,
  options: { mfa?: boolean } = {},
): { token: string; maxAge: number; jti: string } {
  const iat = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  return {
    token: encodeSession({
      sub: username, role, iat, exp: iat + STAFF_TTL_SECONDS, jti, mfa: options.mfa,
    }),
    maxAge: STAFF_TTL_SECONDS,
    jti,
  };
}

export function createAnonymousSession(): { token: string; maxAge: number; jti: string } {
  const iat = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  return {
    token: encodeSession({ sub: `anon-${randomUUID()}`, iat, exp: iat + ANON_TTL_SECONDS, jti }),
    maxAge: ANON_TTL_SECONDS,
    jti,
  };
}

/** Cookie attributes. `secure` is off in development so localhost works. */
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
 * Verify a token *and* check it has not been revoked.
 *
 * Kept separate from `decodeSession` on purpose. `decodeSession` is pure
 * signature-and-expiry maths and is what `proxy.ts` uses, because the Next
 * docs require a proxy to do an optimistic cookie check and not consult
 * shared state. This is the authoritative check, used everywhere that
 * actually grants access.
 */
export function verifySession(token: string | undefined | null): SessionPayload | null {
  const payload = decodeSession(token);
  if (!payload) return null;

  // Anonymous sessions carry no privileges, so revocation does not apply —
  // and checking would wrongly reject pre-existing anonymous cookies.
  if (!payload.role) return payload;

  if (isRevoked(payload)) return null;
  return payload;
}

/** Read and verify the session from a raw Request, including revocation. */
export function sessionFromRequest(req: Request): SessionPayload | null {
  const header = req.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    return verifySession(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

/** True only for an authenticated staff session. */
export function isStaff(session: SessionPayload | null): boolean {
  return !!session?.role;
}

/**
 * True when the session is fully authenticated.
 *
 * A staff session created before an MFA challenge was answered carries
 * `mfa: false`; it must not be treated as signed in.
 */
export function isFullyAuthenticated(session: SessionPayload | null): boolean {
  return !!session?.role && session.mfa !== false;
}
