/**
 * In-memory sliding-window rate limiter.
 *
 * Every chat turn costs real money at OpenAI. Until this existed, a single
 * client in a `while` loop could spend the account's balance without ever
 * authenticating, because the API routes had no notion of who was calling or
 * how often.
 *
 * Deliberately dependency-free and in-process. That means it resets on deploy
 * and does not coordinate across instances — acceptable for a single-instance
 * pilot, and the wrong answer for a horizontally-scaled production service.
 * When this app runs on more than one instance, swap the `hits` map for Redis;
 * nothing outside this file needs to change.
 */

export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests permitted per key per window. */
  max: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window frees up. Used for the Retry-After header. */
  retryAfter: number;
  limit: number;
}

/** Model-backed routes are metered tightly; they are the ones that cost money. */
export const AI_LIMIT: RateLimitRule = { windowMs: 60_000, max: 20 };
/** Pure-computation routes are cheap, so they get a looser ceiling. */
export const COMPUTE_LIMIT: RateLimitRule = { windowMs: 60_000, max: 120 };

/** key -> timestamps of requests inside the current window. */
const hits = new Map<string, number[]>();

/**
 * Drop keys nobody has touched in a while so a long-running process does not
 * accumulate one array per IP forever.
 */
let lastSweep = Date.now();
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    if (times.every(t => now - t > windowMs)) hits.delete(key);
  }
}

export function rateLimit(key: string, rule: RateLimitRule = AI_LIMIT): RateLimitResult {
  const now = Date.now();
  sweep(now, rule.windowMs);

  const times = (hits.get(key) || []).filter(t => now - t < rule.windowMs);

  if (times.length >= rule.max) {
    const oldest = times[0];
    hits.set(key, times);
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((rule.windowMs - (now - oldest)) / 1000)),
      limit: rule.max,
    };
  }

  times.push(now);
  hits.set(key, times);
  return { ok: true, remaining: rule.max - times.length, retryAfter: 0, limit: rule.max };
}

/**
 * Best-effort caller identity.
 *
 * There is no authentication yet, so this is IP-based and therefore spoofable
 * behind a proxy that does not sanitise `x-forwarded-for`. It raises the cost
 * of casual abuse; it is not a security boundary. Replace the key with the
 * authenticated user id as soon as there is one.
 */
export function clientKey(req: Request, scope: string): string {
  const fwd = req.headers.get('x-forwarded-for');
  const ip = fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${ip}`;
}

/** Test seam — the limiter is process-global, so tests must be able to reset it. */
export function __resetRateLimits() {
  hits.clear();
  lastSweep = Date.now();
}
