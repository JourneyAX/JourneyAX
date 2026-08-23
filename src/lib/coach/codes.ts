/**
 * Six-digit email confirmation codes.
 *
 * A six-digit code is only a million possibilities, so the code itself is not
 * where the security lives — the limits are. Three properties do the work:
 *
 *   short expiry     a code is useless ten minutes later
 *   attempt ceiling  five wrong guesses burns the code, not just the attempt
 *   single use       a correct code cannot be replayed
 *
 * Without all three, six digits is guessable. With them, an attacker gets
 * five tries per issued code and issuing is itself rate-limited.
 *
 * Codes are stored hashed. A store readable by an attacker (a log, a heap
 * dump, a shared cache) must not hand them a working code.
 *
 * In-process by default: codes are lost on restart and not shared between
 * instances, so a coach mid-verification during a deploy simply requests a
 * new code. Swap `store` for Redis before running more than one instance.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_ATTEMPTS = 5;
/** Refuse to send a fresh code more often than this, per coach. */
export const RESEND_COOLDOWN_SECONDS = 30;

interface CodeEntry {
  hash: string;
  expiresAt: number;
  attempts: number;
  issuedAt: number;
}

const store = new Map<string, CodeEntry>();

let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const cutoff = Math.floor(now / 1000);
  for (const [key, entry] of store) {
    if (entry.expiresAt <= cutoff) store.delete(key);
  }
}

/**
 * Plain SHA-256, deliberately not scrypt.
 *
 * A password hash is slow so that an offline attack on a *long-lived* secret
 * is expensive. This secret lives ten minutes, is used at most five times,
 * and is verified on a request path — slowness here would buy nothing and
 * cost latency on every attempt.
 */
function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Cryptographically uniform. Math.random would be predictable. */
function generate(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface IssuedCode {
  code: string;
  expiresInSeconds: number;
}

export interface IssueRefusal {
  retryAfterSeconds: number;
}

/**
 * Issue a code for a coach, or refuse if one was issued moments ago.
 *
 * The cooldown stops a stolen link being used to bombard someone's mailbox.
 */
export function issueCode(coachId: string): IssuedCode | IssueRefusal {
  sweep();
  const now = Math.floor(Date.now() / 1000);

  const existing = store.get(coachId);
  if (existing && now - existing.issuedAt < RESEND_COOLDOWN_SECONDS) {
    return { retryAfterSeconds: RESEND_COOLDOWN_SECONDS - (now - existing.issuedAt) };
  }

  const code = generate();
  store.set(coachId, {
    hash: hash(code),
    expiresAt: now + CODE_TTL_SECONDS,
    attempts: 0,
    issuedAt: now,
  });

  return { code, expiresInSeconds: CODE_TTL_SECONDS };
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-code' | 'expired' | 'too-many-attempts' | 'mismatch'; attemptsLeft: number };

/**
 * Check a submitted code.
 *
 * A correct code is consumed on success, and a code that runs out of attempts
 * is destroyed rather than left to be guessed at further.
 */
export function verifyCode(coachId: string, submitted: string): VerifyOutcome {
  sweep();
  const now = Math.floor(Date.now() / 1000);
  const entry = store.get(coachId);

  if (!entry) return { ok: false, reason: 'no-code', attemptsLeft: 0 };

  if (entry.expiresAt <= now) {
    store.delete(coachId);
    return { ok: false, reason: 'expired', attemptsLeft: 0 };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    store.delete(coachId);
    return { ok: false, reason: 'too-many-attempts', attemptsLeft: 0 };
  }

  const cleaned = submitted.replace(/[\s-]/g, '');
  entry.attempts += 1;

  const a = Buffer.from(hash(cleaned));
  const b = Buffer.from(entry.hash);
  const matches = a.length === b.length && timingSafeEqual(a, b);

  if (!matches) {
    const attemptsLeft = MAX_ATTEMPTS - entry.attempts;
    // Burn the code once the ceiling is reached, rather than leaving a
    // known-valid secret sitting in the store.
    if (attemptsLeft <= 0) store.delete(coachId);
    else store.set(coachId, entry);
    return { ok: false, reason: 'mismatch', attemptsLeft: Math.max(0, attemptsLeft) };
  }

  // Single use.
  store.delete(coachId);
  return { ok: true };
}

/** Test seam. */
export function __resetCodes() {
  store.clear();
  lastSweep = Date.now();
}
