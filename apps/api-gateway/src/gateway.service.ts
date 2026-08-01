import { Injectable } from '@nestjs/common';
import { SERVICE_REGISTRY, resolveService, parseRoute } from './gateway.registry';
import { GoogleAuth } from 'google-auth-library';

// ---------------------------------------------------------------------------
// Google Cloud Run service-to-service ID-token client.
//
// When the gateway runs on Cloud Run it has a runtime service account.
// We use that SA to mint a short-lived Google-signed ID token whose audience
// is the target service URL.  Cloud Run validates this token instead of
// the end-user's JWT — keeping every downstream service fully PRIVATE while
// still allowing the gateway (and only the gateway) to call them.
//
// The end-user's identity (already verified by AuthGuard) travels in the
// x-user-* headers the AuthGuard injects.  Downstream PermissionGuards read
// those headers, not the Authorization header, so app-level authz is intact.
// ---------------------------------------------------------------------------

const auth = new GoogleAuth();

/** Cache: audience → { token, expiresAt } */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Return a Google-signed ID token for the given Cloud Run service URL.
 * Tokens are cached per audience for ~55 minutes (they expire at 60).
 * Falls back gracefully to undefined when not running on Google Cloud
 * (local dev) so the dev experience is unchanged.
 */
async function getIdToken(audience: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = tokenCache.get(audience);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  try {
    const client = await auth.getIdTokenClient(audience);

    // google-auth-library v11 changed getRequestHeaders() to return a native
    // Headers object (headers.get()) rather than a plain object (headers[key]).
    // We support both to stay compatible across versions.
    const headers = await client.getRequestHeaders();
    let token: string | undefined;

    if (typeof (headers as any).get === 'function') {
      // v11+: native Headers object
      token = ((headers as any).get('Authorization') as string | null)
        ?.replace('Bearer ', '').trim() || undefined;
    } else {
      // v10 and earlier: plain object
      const raw = headers as unknown as Record<string, string>;
      token = (raw['Authorization'] || raw['authorization'] || '')
        .replace('Bearer ', '').trim() || undefined;
    }

    // Fallback: fetchIdToken() is available in v11+ and returns the raw token
    // string directly — use it when getRequestHeaders() yields nothing.
    if (!token && typeof (client as any).fetchIdToken === 'function') {
      token = await (client as any).fetchIdToken(audience);
    }

    if (token) {
      // Cache for 55 minutes (tokens live 60 min)
      tokenCache.set(audience, { token, expiresAt: now + 55 * 60 * 1000 });
      console.log(`[gateway-auth] ✅ ID token minted for ${audience}`);
      return token;
    }
    console.warn(`[gateway-auth] ⚠️ Could not extract ID token for ${audience}`);
  } catch (err: any) {
    // Not on GCP (local dev) or SA doesn't have the necessary role yet.
    console.warn(`[gateway-auth] ⚠️ getIdToken failed for ${audience}: ${err?.message}`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Headers the gateway must pass through to services: the identity claims the
 * AuthGuard verified (so each service can enforce permissions itself) plus the
 * internal service key for trusted server-side callers.
 */
function identityHeaders(h: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    'x-user-email',
    'x-user-role',
    'x-user-name',
    'x-user-permissions',
    'x-auth-type',
    'x-internal-key',
  ]) {
    if (h[k]) out[k] = String(h[k]);
  }
  return out;
}

/**
 * Build the Authorization header for the gateway→service hop.
 * Google ID token when on GCP; user JWT fallback for local dev.
 */
function authorizationHeader(
  googleIdToken: string | undefined,
  originalAuthHeader: string | undefined,
): Record<string, string> {
  if (googleIdToken) return { Authorization: `Bearer ${googleIdToken}` };
  if (originalAuthHeader) return { Authorization: originalAuthHeader };
  return {};
}

// ---------------------------------------------------------------------------
// Gateway-edge response cache
//
// Two-level cache: Redis when REDIS_URL is set (shared across all Cloud Run
// instances), in-process LRU otherwise (dev / cold-start fallback).
// Follows the exact same Redis-with-memory-fallback pattern as @journeyax/cache
// so behaviour is predictable and consistent across the system.
//
// Rules:
//   - Only GET requests are cached.
//   - Never cache: /auth/*, /api/v1/commerce/* (agent/chat, SSE streams,
//     personalized session state).
//   - TTL by domain: config/knowledge=300s, products=120s, everything else=60s.
//   - Cache key: `resp:<tenantId>:<normalised-path-without-query>`
//   - Invalidation: any successful POST/PUT/PATCH/DELETE to a domain prefix
//     drops all cached keys for that domain+tenant pair.
//
// IMPORTANT: A cache miss is completely transparent — proxyRequest falls
// through to the downstream service exactly as before. This is purely additive.
// ---------------------------------------------------------------------------

const CACHE_TTL: Record<string, number> = {
  config:    300,  // project config — changes rarely, read on every page
  knowledge: 300,  // brand probe results, knowledge stats
  products:  120,  // catalogue, search results, size charts
  analytics:  60,
  leads:      60,
};
const DEFAULT_TTL = 60; // seconds — catch-all for unlisted domains

/** Routes that must NEVER be cached (personalised, streaming, auth-sensitive). */
const NO_CACHE_PREFIXES = [
  '/auth/',
  '/api/v1/agent',
  '/api/v1/commerce',  // chat/SSE — always real-time
];

interface CacheEntry { value: string; expiresAt: number }

// ── In-process LRU (dev / no-Redis fallback) ───────────────────────────────
const memCache = new Map<string, CacheEntry>();
const MEM_MAX = 1000;

function memGet(key: string): string | null {
  const e = memCache.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { memCache.delete(key); return null; }
  return e.value;
}
function memSet(key: string, value: string, ttlSeconds: number): void {
  if (memCache.size >= MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ── Lazy Redis client ───────────────────────────────────────────────────────
// Same lazy-connect pattern as @journeyax/cache — zero startup cost when
// REDIS_URL is not set; connects on first cache operation when it is.
// Wire REDIS_URL as a Cloud Run env var (pointing at Upstash) to activate.
type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  scan(cursor: string, ...args: any[]): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<unknown>;
};
let redisClient: RedisLike | null = null;
let redisTried = false;

async function redisConn(): Promise<RedisLike | null> {
  if (redisClient || redisTried) return redisClient;
  redisTried = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // Dynamic import keeps ioredis out of the startup path — it's only
    // pulled in when REDIS_URL is actually configured.
    const mod: any = await import('ioredis');
    const Redis = mod.default || mod;
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableOfflineQueue: false,
    });
    client.on('error', (e: Error) =>
      console.warn('[gateway-cache] redis error, falling back to memory:', e.message));
    redisClient = client;
  } catch (e) {
    console.warn('[gateway-cache] ioredis unavailable, using in-process cache:', (e as Error).message);
  }
  return redisClient;
}

// ── Cache helpers ───────────────────────────────────────────────────────────

function buildCacheKey(tenantId: string, path: string): string {
  // Strip query string — we cache by canonical path only
  return `resp:${tenantId}:${path.split('?')[0]}`;
}

function ttlForPath(path: string): number {
  const { domain } = parseRoute(path);
  return domain ? (CACHE_TTL[domain] ?? DEFAULT_TTL) : DEFAULT_TTL;
}

function isCacheable(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (NO_CACHE_PREFIXES.some(p => path.startsWith(p))) return false;
  return true;
}

async function cacheGet(key: string): Promise<any | null> {
  try {
    const redis = await redisConn();
    const raw = redis ? await redis.get(key) : memGet(key);
    if (raw != null) return JSON.parse(raw);
  } catch { /* cache errors are never fatal */ }
  return null;
}

async function cacheSet(key: string, value: any, ttlSeconds: number): Promise<void> {
  try {
    const raw = JSON.stringify(value);
    const redis = await redisConn();
    if (redis) await redis.set(key, raw, 'EX', ttlSeconds);
    else memSet(key, raw, ttlSeconds);
  } catch { /* never fatal */ }
}

async function cacheInvalidateDomain(tenantId: string, domain: string): Promise<void> {
  const tenantPrefix = `resp:${tenantId}:`;
  try {
    const redis = await redisConn();
    if (redis) {
      const pattern = `${tenantPrefix}*/api/v1/*${domain}*`;
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } else {
      for (const k of [...memCache.keys()]) {
        if (k.startsWith(tenantPrefix) && k.includes(domain)) memCache.delete(k);
      }
    }
  } catch { /* never fatal */ }
}

// ---------------------------------------------------------------------------
// Gateway Service
// ---------------------------------------------------------------------------

/**
 * Gateway Service — handles the actual proxying logic.
 * Resolves which backend to hit, forwards the request, returns the response.
 *
 * New in this version: GET responses are served from the edge cache on cache
 * hits; mutating verbs invalidate the domain cache for the tenant. All
 * existing proxy behaviour is unchanged on cache miss.
 */
@Injectable()
export class GatewayService {
  /**
   * Proxy a request to the resolved backend service.
   */
  async proxyRequest(
    method: string,
    path: string,
    headers: Record<string, any>,
    body?: any,
  ): Promise<{ status: number; data: any; headers?: Record<string, string> }> {
    const resolved = resolveService(path);
    if (!resolved) {
      return {
        status: 404,
        data: { error: 'Not Found', message: `No service registered for path: ${path}` },
      };
    }

    const tenantId = String(headers['x-tenant-id'] || 'caroma');
    const { domain } = parseRoute(path);

    // ── Cache read (GET only) ────────────────────────────────────────────
    if (isCacheable(method, path)) {
      const key = buildCacheKey(tenantId, path);
      const hit = await cacheGet(key);
      if (hit !== null) {
        console.log(`[Gateway] Cache HIT → ${path}`);
        return {
          status: 200,
          data: hit,
          headers: {
            'X-Served-By': 'gateway-cache',
            'X-Gateway': 'journeyax-api-gateway',
            'X-Cache': 'HIT',
          },
        };
      }
    }

    // ── Downstream proxy ─────────────────────────────────────────────────
    const downstreamUrl = `${resolved.baseUrl}${path}`;
    console.log(`[Gateway] Routing → ${downstreamUrl}`);

    // Mint a Google ID token for the downstream Cloud Run service.
    // audience = base URL of the service (e.g. https://project-service-xxx.run.app)
    const googleIdToken = await getIdToken(resolved.baseUrl);

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenantId,
        'X-Gateway-Request-ID': `gw-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        ...authorizationHeader(googleIdToken, headers['authorization']),
        ...identityHeaders(headers),
      },
    };

    if (method !== 'GET' && method !== 'HEAD' && body && Object.keys(body).length > 0) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(downstreamUrl, fetchOptions);
    const data = await response.json().catch(() => ({}));

    // ── Cache write (successful GETs only) ──────────────────────────────
    if (isCacheable(method, path) && response.ok) {
      const key = buildCacheKey(tenantId, path);
      const ttl = ttlForPath(path);
      cacheSet(key, data, ttl); // fire-and-forget — never delays the response
    }

    // ── Cache invalidation (mutating verbs) ─────────────────────────────
    // A successful write to /api/v1/products/... clears all product GET cache
    // entries for this tenant so the next read is fresh.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && domain && response.ok) {
      cacheInvalidateDomain(tenantId, domain); // fire-and-forget
    }

    return {
      status: response.status,
      data,
      headers: {
        'X-Served-By': resolved.baseUrl,
        'X-Gateway': 'journeyax-api-gateway',
        'X-Cache': 'MISS',
      },
    };
  }

  /**
   * Proxy a Server-Sent Events (streaming) request.
   * Does NOT buffer — pipes the downstream event stream straight to `res`.
   * SSE streams are never cached.
   */
  async proxyStream(
    method: string,
    path: string,
    headers: Record<string, any>,
    body: any,
    res: any,
  ): Promise<void> {
    const resolved = resolveService(path);
    if (!resolved) {
      res.status(404).end();
      return;
    }
    const downstreamUrl = `${resolved.baseUrl}${path}`;
    console.log(`[Gateway] Streaming → ${downstreamUrl}`);

    const googleIdToken = await getIdToken(resolved.baseUrl);

    const upstream = await fetch(downstreamUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': headers['x-tenant-id'] || 'caroma',
        ...authorizationHeader(googleIdToken, headers['authorization']),
        ...identityHeaders(headers),
      },
      body: method !== 'GET' && body ? JSON.stringify(body) : undefined,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const reader = upstream.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    const decoder = new TextDecoder();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      console.error('[Gateway] Stream pipe error:', (err as Error).message);
    } finally {
      res.end();
    }
  }

  /**
   * Check health of all registered downstream services.
   */
  async checkHealth(): Promise<Record<string, { status: string; url: string }>> {
    const results: Record<string, { status: string; url: string }> = {};

    for (const [prefix, baseUrl] of Object.entries(SERVICE_REGISTRY)) {
      const serviceName = prefix.replace('/api/v1/', '');
      try {
        const healthUrl = `${baseUrl}${prefix}/health`;
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        results[serviceName] = {
          status: response.ok ? 'healthy' : 'degraded',
          url: baseUrl,
        };
      } catch {
        results[serviceName] = {
          status: 'unreachable',
          url: baseUrl,
        };
      }
    }

    return results;
  }
}
