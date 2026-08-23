/**
 * Shared signing primitives for the coach access flow.
 *
 * Both the emailed invite token and the coach session cookie are HMAC-signed
 * payloads. Neither is encrypted: they carry no secret, and the signature is
 * what makes them unforgeable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signing secret.
 *
 * Refuses a development fallback in production. A predictable secret here
 * means anyone can mint an invite token for any coach and read another
 * school's order history — which is the exact thing this flow exists to
 * prevent, so failing loudly beats starting insecurely.
 */
export function coachSecret(): string {
  const fromEnv = process.env.COACH_LINK_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'COACH_LINK_SECRET must be at least 32 characters in production. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  console.warn('[coach] COACH_LINK_SECRET unset — using an insecure development secret');
  return 'dev-only-insecure-coach-secret-do-not-ship';
}

function sign(data: string): string {
  return createHmac('sha256', coachSecret()).update(data).digest('base64url');
}

/** Serialise a payload and append its signature. */
export function encodeSigned<T>(payload: T): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Verify and decode. Returns null for anything that is not correctly signed
 * and well-formed — callers treat null as "no access", never partial trust.
 */
export function decodeSigned<T>(token: string | undefined | null): T | null {
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));

  // Length first: timingSafeEqual throws on a mismatch.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
