/**
 * Project-scoped read cache.
 *
 * Console screens re-derive the same aggregates every time they are opened —
 * counting sessions, counting documents, listing the catalogue — and the
 * console is a tool people tab through, not a page they load once. Without a
 * cache, going back to a tab you looked at a minute ago costs the full round
 * trip again.
 *
 * Two rules keep it honest:
 *   - Every key is scoped to ONE project. A cached answer can never be served
 *     across the tenant boundary, which is the same isolation the data layer
 *     enforces.
 *   - Anything that edits a project drops that project's keys, so the console
 *     never shows a figure the database no longer agrees with.
 *
 * Redis is used when REDIS_URL is set — several service processes then share
 * one cache, and it survives a restart. With no Redis configured it falls back
 * to an in-process store, so a developer (or a demo laptop) needs no extra
 * infrastructure and behaviour is identical, just per-process.
 */

export interface CacheOptions {
  /** Seconds to keep the value. Clamped to a week — see MAX_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Skip the cache and recompute (used by an explicit Refresh). */
  force?: boolean;
}

/** A week. Nothing here is worth serving staler than the demo cycle it supports. */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 300;

interface Entry {
  value: string;
  expiresAt: number;
}

/** Ceiling on the in-process store so a long-lived server cannot grow forever. */
const MEMORY_MAX_ENTRIES = 2000;

const memory = new Map<string, Entry>();

/* One shared promise per in-flight key.
 *
 * The console mounts several components that each ask for the same figures at
 * once — the catalogue was measured fetching identically three times per visit.
 * Without this, a cache miss lets every one of those callers run the expensive
 * work simultaneously, so the cache does nothing precisely when the load is
 * heaviest. They now wait on the first call instead. */
const inFlight = new Map<string, Promise<any>>();

/* ── Redis (optional) ───────────────────────────────────────────────────── */

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  scan(cursor: string, ...args: any[]): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<unknown>;
};

let redisClient: RedisLike | null = null;
let redisTried = false;

async function redis(): Promise<RedisLike | null> {
  if (redisClient || redisTried) return redisClient;
  redisTried = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // Imported lazily so the package carries no runtime cost — and no
    // connection attempt — for anyone who has not configured Redis.
    const mod: any = await import('ioredis');
    const Redis = mod.default || mod;
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      // A cache must never be able to take the request down with it.
      enableOfflineQueue: false,
    });
    client.on('error', (e: Error) => {
      console.warn('[cache] redis error, falling back to memory:', e.message);
    });
    redisClient = client;
  } catch (e) {
    console.warn('[cache] ioredis unavailable, using in-process cache:', (e as Error).message);
    redisClient = null;
  }
  return redisClient;
}

/* ── Keys ───────────────────────────────────────────────────────────────── */

/** `jax:<project>:<name>` — the project segment is what makes bulk drop possible. */
export function cacheKey(projectId: string, name: string, params?: Record<string, unknown>): string {
  const p = (projectId || 'unknown').toLowerCase();
  const suffix = params
    ? ':' + Object.keys(params).sort().map((k) => `${k}=${String(params[k] ?? '')}`).join('&')
    : '';
  return `jax:${p}:${name}${suffix}`;
}

/* ── Core ───────────────────────────────────────────────────────────────── */

function readMemory(key: string): string | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function writeMemory(key: string, value: string, ttlSeconds: number): void {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    // Oldest insertion first — good enough for a bounded set of console keys.
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/**
 * Return the cached value for `key`, or compute it with `fn` and cache that.
 *
 * `fn` runs at most once per key at a time, however many callers arrive.
 * A cache failure is never fatal: on any error the value is simply computed.
 */
export async function getOrSet<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CacheOptions = {},
): Promise<T> {
  const ttl = Math.min(Math.max(1, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS), MAX_TTL_SECONDS);

  if (!opts.force) {
    try {
      const client = await redis();
      const raw = client ? await client.get(key) : readMemory(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {
      /* fall through and compute */
    }
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
  }

  const work = (async () => {
    const value = await fn();
    try {
      const raw = JSON.stringify(value);
      const client = await redis();
      if (client) await client.set(key, raw, 'EX', ttl);
      else writeMemory(key, raw, ttl);
    } catch {
      /* a value we cannot cache is still a value we can return */
    }
    return value;
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop everything cached for one project.
 *
 * Call this wherever a project changes — publish, config edit, ingest — so a
 * stale aggregate can never outlive the change that invalidated it.
 */
export async function invalidateProject(projectId: string): Promise<void> {
  const prefix = `jax:${(projectId || '').toLowerCase()}:`;
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  for (const key of [...inFlight.keys()]) if (key.startsWith(prefix)) inFlight.delete(key);
  try {
    const client = await redis();
    if (!client) return;
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
  } catch (e) {
    console.warn('[cache] invalidate failed:', (e as Error).message);
  }
}

/** Whether a shared cache is in use — surfaced in ops/health output. */
export async function cacheBackend(): Promise<'redis' | 'memory'> {
  return (await redis()) ? 'redis' : 'memory';
}
