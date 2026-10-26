import { Injectable } from '@nestjs/common';
import { SERVICE_REGISTRY, resolveService, parseRoute } from './gateway.registry';
import { GoogleAuth } from 'google-auth-library';
import * as crypto from 'crypto';
import {
  signGatewayAssertion,
  gatewayRoleFor,
  GatewayRole,
} from '@journeyax/database';
import { isStaffRole, ADMIN_GROUP, isPlatformTenantId, checkSelfServiceTenant } from '@journeyax/shared-types';
import { GroupDirectory } from './group-directory';

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
 * Whether GCP service-to-service auth is disabled for this process.
 * Set DISABLE_GCP_AUTH=true in local dev to suppress all getIdToken attempts
 * and their associated noise. On Cloud Run, leave this unset (or false).
 */
const GCP_AUTH_DISABLED =
  process.env.DISABLE_GCP_AUTH === 'true' ||
  process.env.NODE_ENV === 'development';

/** Returns true when the audience is a local-only URL — never needs a GCP token. */
function isLocalAudience(audience: string): boolean {
  try {
    const { hostname } = new URL(audience);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Return a Google-signed ID token for the given Cloud Run service URL.
 * Tokens are cached per audience for ~55 minutes (they expire at 60).
 *
 * Local dev: returns undefined immediately and silently for localhost targets.
 * GCP: mints an ID token using the runtime service account (ADC).  The SA
 *   must hold roles/run.invoker on every downstream Cloud Run service — see
 *   docs/deployment-plan.md §IAM for the exact gcloud commands.
 */
async function getIdToken(audience: string): Promise<string | undefined> {
  // Skip entirely for localhost targets or when explicitly disabled.
  // This removes the noisy `invalid_grant` warning in local dev.
  if (isLocalAudience(audience) || GCP_AUTH_DISABLED) {
    return undefined;
  }

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
    // SA missing roles/run.invoker or ADC not configured — surface clearly.
    console.error(
      `[gateway-auth] ❌ getIdToken failed for ${audience}: ${err?.message}. ` +
      `Ensure the gateway SA has roles/run.invoker on this service.`,
    );
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
    'x-idempotency-key',
    'idempotency-key',
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
  const [pathname, qs] = path.split('?');
  // For analytics paths the projectId query param is part of the data identity —
  // include it in the key so /insights?projectId=caroma ≠ /insights?projectId=mms.
  // We sort params so key is stable regardless of param order.
  const keySuffix = qs
    ? '?' + qs.split('&').sort().join('&')
    : '';
  return `resp:${tenantId}:${pathname}${keySuffix}`;
}

function ttlForPath(path: string): number {
  const { domain } = parseRoute(path);
  return domain ? (CACHE_TTL[domain] ?? DEFAULT_TTL) : DEFAULT_TTL;
}

/**
 * Domains whose answers depend on who is asking. The cache key is the tenant and the path only, so one person's answer would be handed to
 * the next person who asked for the same path (the connector menu showed staff systems to a login that should not see them). The prefix
 * list above cannot catch these: a tenant-scoped path starts with the tenant (`/api/v1/placemakers/commerce/...`), not with the domain.
 */
const NO_CACHE_DOMAINS: ReadonlySet<string> = new Set(['commerce', 'runtime']);

/** Is this the open registration route? Tolerates a query string, repeated or trailing slashes and capital letters, which the web server would route the same way. */
export function isRegistrationPath(path: string): boolean {
  return path.split(/[?#]/)[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase() === '/api/v1/auth/register';
}

export function isCacheable(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (NO_CACHE_PREFIXES.some(p => path.startsWith(p))) return false;
  const { domain } = parseRoute(path);
  if (domain && NO_CACHE_DOMAINS.has(domain)) return false;
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
  /** Looks up a member of staff's groups (the project member's teams) so they can be signed into the identity assertion. */
  private readonly groupDirectory = new GroupDirectory({
    baseUrl: () => SERVICE_REGISTRY['projects'],
    headers: async (base) => ({
      ...(process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {}),
      ...authorizationHeader(await getIdToken(base), undefined),
    }),
  });

  /**
   * The signed identity every downstream call carries: the person's role and, for a member of staff, their groups. Nothing here comes
   * from a header the browser could set: the role is the one the auth guard put there after verifying the token, and the groups are
   * looked up. Empty when no signing secret is configured.
   */
  private async assertionHeaders(tenantId: string, environmentId: string, headers: Record<string, any>): Promise<Record<string, string>> {
    const secret = process.env.GATEWAY_ASSERTION_SECRET;
    if (!secret) return {};
    const role: GatewayRole = gatewayRoleFor(headers['x-user-role'] || headers['x-principal-role']);
    const fromTeams = isStaffRole(role) ? await this.groupDirectory.groupsFor(tenantId, String(headers['x-user-email'] || '')) : [];
    // The platform admin is not in any project team (it is not a project member, and its login name is not an email), so access rows that
    // are written per team would shut it out. It belongs to `administrators` by role. The name is reserved: a team called Administrators
    // does not put anyone in that group, so nobody can reach admin-level rows by naming a team.
    const teamGroups = fromTeams.filter((group) => group !== ADMIN_GROUP);
    const groups = role === 'admin' ? [ADMIN_GROUP, ...teamGroups] : teamGroups;
    return {
      'X-Gateway-Assertion': signGatewayAssertion(
        {
          tenantId,
          environmentId,
          sub: String(headers['x-user-id'] || headers['x-principal-id'] || headers['x-user-email'] || 'anonymous'),
          role,
          groups,
        },
        secret
      ),
    };
  }

  /**
   * Validate that a tenant is active. Caches the result to avoid spamming the project service.
   * The platform's own tenants always pass; anything else must be a project the project service knows.
   */
  private async validateTenant(tenantId: string): Promise<boolean> {
    if (isPlatformTenantId(tenantId)) return true;
    return this.isActiveProject(tenantId);
  }

  /**
   * Is there a project with this id? The project service answers for it (cached for a minute). Unlike `validateTenant`, the platform's
   * own tenants get no free pass here: they are not projects.
   */
  private async isActiveProject(tenantId: string): Promise<boolean> {
    const key = `tenant_status:${tenantId}`;
    const cached = await cacheGet(key);
    if (cached !== null) {
      return cached.active === true;
    }

    const projectServiceUrl = SERVICE_REGISTRY['projects'];
    if (!projectServiceUrl) return true;

    try {
      const googleIdToken = await getIdToken(projectServiceUrl);
      const res = await fetch(`${projectServiceUrl}/api/v1/projects/${encodeURIComponent(tenantId)}/published`, {
        headers: {
          'X-Tenant-ID': tenantId,
          ...authorizationHeader(googleIdToken, undefined)
        }
      });
      if (!res.ok) {
        cacheSet(key, { active: false }, 60); // fire-and-forget
        return false;
      }
      const data = await res.json();
      // If the API returns published config, it means it's active. 
      // It returns fallback draft if not published. We just check if it returned 200 OK.
      cacheSet(key, { active: true }, 60);
      return true;
    } catch (e) {
      console.warn(`[Gateway] Error validating tenant ${tenantId}:`, (e as Error).message);
      if (process.env.NODE_ENV === 'production') {
        return false; // Fail closed in production
      }
      return true;
    }
  }

  /**
   * The open sign-up (`POST /api/v1/auth/register`, no token needed) as it leaves the gateway: only email, password, tenantId and
   * fullName are forwarded (a `role` or any other field is dropped), and the tenant must be a real customer-facing project, not one of
   * the platform's own or a name nobody has created. The sign-in service enforces the role and tenant rules again on its own; this
   * adds the one check only the gateway can make, whether the project exists.
   */
  private async checkOpenSignUp(body: unknown): Promise<{ status: 'ok'; body: Record<string, unknown> } | { status: 'refused'; message: string }> {
    const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const tenant = checkSelfServiceTenant(input.tenantId);
    if (tenant.status === 'refused') {
      return { status: 'refused', message: tenant.reason === 'missing' ? 'email, password, tenantId, and fullName are required.' : 'tenantId must name a customer-facing project.' };
    }
    if (!(await this.isActiveProject(tenant.tenantId))) {
      return { status: 'refused', message: 'tenantId must name a customer-facing project.' };
    }
    return { status: 'ok', body: { email: input.email, password: input.password, tenantId: tenant.tenantId, fullName: input.fullName } };
  }

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

    const { projectId, domain } = parseRoute(path);
    const queryMatch = path.match(/[?&]projectId=([^&]+)/);
    const queryProjectId = queryMatch ? decodeURIComponent(queryMatch[1]) : null;
    const effectiveProjectId = projectId || queryProjectId;
    const tenantId = effectiveProjectId || String(headers['x-tenant-id'] || '');

    // ── Open sign-up: a plain customer in a real project, nothing else ───
    if (method.toUpperCase() === 'POST' && isRegistrationPath(path)) {
      const checked = await this.checkOpenSignUp(body);
      if (checked.status === 'refused') {
        return { status: 400, data: { error: 'Bad Request', message: checked.message } };
      }
      body = checked.body;
    }

    // ── Edge Validation ──────────────────────────────────────────────────
    if (domain !== 'auth' && domain !== 'projects' && domain !== 'organizations') {
      if (!tenantId) {
        return {
          status: 400,
          data: { error: 'Bad Request', message: 'Tenant identifier is required (URL projectId or x-tenant-id header).' },
        };
      }
      const isValid = await this.validateTenant(tenantId);
      if (!isValid) {
        return {
          status: 403,
          data: { error: 'Forbidden', message: 'Project does not exist or is disabled.' },
        };
      }
    }

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
    let downstreamPath = path;
    const parsed = parseRoute(path);
    if (parsed.domain === 'runtime' && parsed.projectId && parsed.environmentId) {
      const segs = path.split('?')[0].split('/').filter(Boolean);
      const queryStr = path.includes('?') ? `?${path.split('?')[1]}` : '';
      if (segs.length >= 4 && segs[3] === 'runtime') {
        const rest = segs.slice(4).join('/');
        downstreamPath = `/api/v1/${parsed.projectId}/${parsed.environmentId}/runtime${rest ? `/${rest}` : ''}${queryStr}`;
      }
    }

    const downstreamUrl = `${resolved.baseUrl}${downstreamPath}`;
    console.log(`[Gateway] Routing → ${downstreamUrl}`);

    // Mint a Google ID token for the downstream Cloud Run service.
    // audience = base URL of the service (e.g. https://project-service-xxx.run.app)
    const googleIdToken = await getIdToken(resolved.baseUrl);

    const gatewayHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenantId,
      'X-Gateway-Request-ID': `gw-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...authorizationHeader(googleIdToken, headers['authorization']),
      ...identityHeaders(headers),
    };

    const assertionSecret = process.env.GATEWAY_ASSERTION_SECRET;

    if (assertionSecret) {
      Object.assign(gatewayHeaders, await this.assertionHeaders(tenantId, parsed.environmentId || 'production', headers));
    } else if (process.env.NODE_ENV === 'production' && parsed.domain === 'runtime') {
      throw new Error('GATEWAY_ASSERTION_SECRET must be configured in production for runtime calls.');
    }

    const fetchOptions: RequestInit = {
      method,
      headers: gatewayHeaders,
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

    const { projectId, domain } = parseRoute(path);
    const queryMatch = path.match(/[?&]projectId=([^&]+)/);
    const queryProjectId = queryMatch ? decodeURIComponent(queryMatch[1]) : null;
    const effectiveProjectId = projectId || queryProjectId;
    const tenantId = effectiveProjectId || String(headers['x-tenant-id'] || '');

    // ── Edge Validation ──────────────────────────────────────────────────
    if (domain !== 'auth' && domain !== 'projects' && domain !== 'organizations') {
      if (!tenantId) {
        res.status(400).json({ error: 'Bad Request', message: 'Tenant identifier is required (URL projectId or x-tenant-id header).' });
        return;
      }
      const isValid = await this.validateTenant(tenantId);
      if (!isValid) {
        res.status(403).json({ error: 'Forbidden', message: 'Project does not exist or is disabled.' });
        return;
      }
    }

    const googleIdToken = await getIdToken(resolved.baseUrl);
    // The streaming path signs the same identity as the plain one: without it the runtime would treat every streamed turn as a shopper's.
    const signedIdentity = tenantId ? await this.assertionHeaders(tenantId, parseRoute(path).environmentId || 'production', headers) : {};

    const upstream = await fetch(downstreamUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenantId,
        ...authorizationHeader(googleIdToken, headers['authorization']),
        ...identityHeaders(headers),
        ...signedIdentity,
      },
      body: method !== 'GET' && body ? JSON.stringify(body) : undefined,
    });

    // A refusal or a failure upstream is not a stream: it keeps its status and its JSON body. Declaring it text/event-stream
    // with a 200 would hand the browser a body it cannot parse and hide the failure from every monitor.
    if (!upstream.ok) {
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.end(await upstream.text().catch(() => ''));
      return;
    }

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
   * Uses Google ID tokens so private Cloud Run services respond correctly.
   */
  async checkHealth(): Promise<Record<string, { status: string; url: string }>> {
    const results: Record<string, { status: string; url: string }> = {};

    for (const [domain, baseUrl] of Object.entries(SERVICE_REGISTRY)) {
      if (baseUrl.includes('localhost')) {
        results[domain] = { status: 'not-deployed', url: baseUrl };
        continue;
      }
      try {
        const healthUrl = `${baseUrl}/api/v1/${domain}/health`;
        const idToken = await getIdToken(baseUrl);
        const headers: Record<string, string> = {};
        if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

        const response = await fetch(healthUrl, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        results[domain] = {
          status: response.ok ? 'healthy' : 'degraded',
          url: baseUrl,
        };
      } catch {
        results[domain] = { status: 'unreachable', url: baseUrl };
      }
    }

    return results;
  }
}
