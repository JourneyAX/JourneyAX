/**
 * Account lockout after repeated failed sign-ins.
 *
 * The login route is already rate-limited by IP, but that only slows a single
 * source. Lockout is per-account, so an attacker spreading attempts across
 * many addresses still runs into a wall on the account they are targeting.
 *
 * Deliberately *temporary* rather than permanent. A permanent lock turns any
 * stranger who knows a username into a denial-of-service against that person,
 * and in practice gets disabled by the first administrator it inconveniences.
 *
 * In-process, like the rate limiter: resets on restart, does not coordinate
 * across instances. Move to a shared store at the same time as the limiter.
 */

import { logger } from '@/lib/logger';

const log = logger('auth/lockout');

/** Failures tolerated before the account locks. */
export const MAX_ATTEMPTS = 5;
/** How long a lock lasts. */
export const LOCK_MS = 15 * 60 * 1000;
/** Failures older than this stop counting toward a lock. */
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface Entry {
  failures: number[];
  lockedUntil?: number;
}

const entries = new Map<string, Entry>();

let lastSweep = Date.now();
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, e] of entries) {
    const stale = e.failures.every(t => now - t > ATTEMPT_WINDOW_MS);
    if (stale && (!e.lockedUntil || e.lockedUntil < now)) entries.delete(key);
  }
}

function keyFor(username: string) {
  return username.trim().toLowerCase();
}

export interface LockStatus {
  locked: boolean;
  /** Seconds until the account unlocks. */
  retryAfter: number;
  /** Attempts left before locking. Zero once locked. */
  remaining: number;
}

export function checkLock(username: string, at: number = Date.now()): LockStatus {
  sweep(at);
  const entry = entries.get(keyFor(username));
  if (!entry) return { locked: false, retryAfter: 0, remaining: MAX_ATTEMPTS };

  if (entry.lockedUntil && entry.lockedUntil > at) {
    return {
      locked: true,
      retryAfter: Math.ceil((entry.lockedUntil - at) / 1000),
      remaining: 0,
    };
  }

  const recent = entry.failures.filter(t => at - t < ATTEMPT_WINDOW_MS);
  return { locked: false, retryAfter: 0, remaining: Math.max(0, MAX_ATTEMPTS - recent.length) };
}

/** Record a failed attempt and report the resulting state. */
export function recordFailure(username: string, at: number = Date.now()): LockStatus {
  const key = keyFor(username);
  const entry = entries.get(key) ?? { failures: [] };

  entry.failures = entry.failures.filter(t => at - t < ATTEMPT_WINDOW_MS);
  entry.failures.push(at);

  if (entry.failures.length >= MAX_ATTEMPTS) {
    entry.lockedUntil = at + LOCK_MS;
    entry.failures = [];
    log.warn(`account locked after ${MAX_ATTEMPTS} failed attempts: ${key}`);
  }

  entries.set(key, entry);
  return checkLock(username, at);
}

/** Clear the record. Called on a successful sign-in. */
export function recordSuccess(username: string) {
  entries.delete(keyFor(username));
}

/** Administrative unlock. */
export function clearLock(username: string) {
  entries.delete(keyFor(username));
}

/** Test seam. */
export function __resetLockouts() {
  entries.clear();
  lastSweep = Date.now();
}
