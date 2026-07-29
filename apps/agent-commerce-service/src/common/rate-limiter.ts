/**
 * In-memory sliding-window rate limiter (P0-05 — abuse & cost controls).
 *
 * Deliberately dependency-free so it works in the POC without Redis. The API is
 * shaped so it can be swapped for a Redis/Upstash-backed store later without
 * touching the guard: `hit(key)` → { allowed, remaining, retryAfterMs }.
 *
 * Each key (an IP, or a tenant+session) keeps a ring of recent hit timestamps;
 * on every hit we drop timestamps older than the window and compare the count
 * to the ceiling. A single process holds the state — for multi-instance deploys
 * this must move to a shared store, but it correctly caps a single node and is
 * verifiable by bursting curl against one running service.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number): RateDecision {
    this.maybePrune(now);
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      const retryAfterMs = Math.max(0, arr[0] + this.windowMs - now);
      this.hits.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: true, remaining: this.limit - arr.length, retryAfterMs: 0 };
  }

  /** Drop cold keys occasionally so the map doesn't grow unbounded. */
  private maybePrune(now: number) {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    const cutoff = now - this.windowMs;
    for (const [k, arr] of this.hits) {
      const live = arr.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(k);
      else this.hits.set(k, live);
    }
  }
}
