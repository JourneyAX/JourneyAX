/**
 * Time-based one-time passwords (RFC 6238).
 *
 * Implemented directly on `node:crypto` rather than pulling in a dependency:
 * the algorithm is thirty lines, and an auth dependency is a supply-chain
 * risk you carry forever.
 *
 * Compatible with Google Authenticator, 1Password, Authy and Microsoft
 * Authenticator — i.e. HMAC-SHA1, 6 digits, 30-second steps. SHA1 is the
 * correct choice here despite its reputation: it is the interoperable default,
 * and TOTP's security rests on the shared secret and the 30-second window
 * rather than on collision resistance.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/**
 * Accept the immediately preceding and following step as well as the current
 * one. Covers clock drift between the phone and the server. Wider than ±1 is
 * a meaningful weakening — it multiplies the codes valid at any instant.
 */
export const TOTP_WINDOW = 1;

// ── base32 (RFC 4648, no padding) — what authenticator apps expect ─────
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  // Tolerate the spaces and lowercase people paste in from a phone screen.
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter value for a given moment. Exposed so callers can track replay. */
export function stepFor(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** Compute the code for one specific step. */
export function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);

  // Counter as a big-endian 64-bit value.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function currentCode(secret: string, at: Date = new Date()): string {
  return codeForStep(secret, stepFor(at));
}

export interface VerifyResult {
  valid: boolean;
  /** The step the code matched. Store it to prevent the code being reused. */
  step?: number;
}

/**
 * Verify a submitted code.
 *
 * `lastUsedStep` blocks replay: a code stays mathematically valid for its
 * whole 30-second window, so without this an attacker who shoulder-surfs or
 * intercepts one code can use it again within that window.
 */
export function verifyCode(
  secret: string,
  submitted: string,
  options: { at?: Date; lastUsedStep?: number } = {},
): VerifyResult {
  const cleaned = submitted.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };

  const current = stepFor(options.at ?? new Date());

  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const step = current + drift;

    // Refuse a step at or before one already spent.
    if (options.lastUsedStep !== undefined && step <= options.lastUsedStep) continue;

    let expected: string;
    try {
      expected = codeForStep(secret, step);
    } catch {
      return { valid: false };
    }

    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, step };
    }
  }

  return { valid: false };
}

/**
 * The `otpauth://` URI an authenticator app scans or accepts by hand.
 *
 * The secret appears in this string, so it must only ever be shown to the
 * account's owner during enrolment, and never logged.
 */
export function otpauthUri(secret: string, username: string, issuer = 'JourneyAX'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ─────────────────────────────────────────────────────
/**
 * Single-use codes for when the phone is lost.
 *
 * Without these, losing a phone means an administrator has to intervene —
 * which in a small team usually means MFA gets switched off entirely.
 * Stored hashed, exactly like passwords.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    // Crockford-ish: no vowels, so no accidental words, and unambiguous.
    const raw = base32Encode(randomBytes(10)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
