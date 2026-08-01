import { Injectable } from '@nestjs/common';
import { SERVICE_REGISTRY, resolveService } from './gateway.registry';
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
    const headers = await client.getRequestHeaders();
    // getRequestHeaders() returns a plain Record<string,string>, so direct access is fine
    const raw: Record<string, string> = headers as unknown as Record<string, string>;
    const token = (raw['Authorization'] || raw['authorization'] || '')
      .replace('Bearer ', '')
      .trim();

    if (token) {
      // Cache for 55 minutes (tokens live 60 min)
      tokenCache.set(audience, { token, expiresAt: now + 55 * 60 * 1000 });
      return token;
    }
  } catch {
    // Not on GCP (local dev) or SA doesn't have the necessary role yet.
    // Fail silently — the downstream will return 403 if it's private,
    // which is the correct behavior to surface during setup.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Headers the gateway must pass through to services: the identity claims the
 * AuthGuard verified (so each service can enforce permissions itself) plus the
 * internal service key for trusted server-side callers. Without these the
 * per-service authorization layer is blind.
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
 *
 * If we obtained a Google ID token, it goes in Authorization so Cloud Run
 * validates it and permits the call into the private service.
 *
 * If we're in local dev (no GCP metadata server), we fall back to forwarding
 * the original Bearer token so that local services can still verify the user.
 */
function authorizationHeader(
  googleIdToken: string | undefined,
  originalAuthHeader: string | undefined,
): Record<string, string> {
  if (googleIdToken) {
    return { Authorization: `Bearer ${googleIdToken}` };
  }
  // Local / non-GCP fallback: forward the user's JWT directly
  if (originalAuthHeader) {
    return { Authorization: originalAuthHeader };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Gateway Service
// ---------------------------------------------------------------------------

/**
 * Gateway Service — handles the actual proxying logic.
 * Resolves which backend to hit, forwards the request, returns the response.
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

    const downstreamUrl = `${resolved.baseUrl}${path}`;
    console.log(`[Gateway] Routing → ${downstreamUrl}`);

    // Mint a Google ID token for the downstream Cloud Run service.
    // audience = base URL of the service (e.g. https://project-service-xxx.run.app)
    const googleIdToken = await getIdToken(resolved.baseUrl);

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': headers['x-tenant-id'] || 'caroma',
        'X-Gateway-Request-ID': `gw-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        // Google ID token (or user JWT fallback) authenticates this hop to Cloud Run
        ...authorizationHeader(googleIdToken, headers['authorization']),
        // Verified identity claims for downstream app-level authz
        ...identityHeaders(headers),
      },
    };

    if (method !== 'GET' && method !== 'HEAD' && body && Object.keys(body).length > 0) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(downstreamUrl, fetchOptions);
    const data = await response.json().catch(() => ({}));

    return {
      status: response.status,
      data,
      headers: {
        'X-Served-By': resolved.baseUrl,
        'X-Gateway': 'journeyax-api-gateway',
      },
    };
  }

  /**
   * Proxy a Server-Sent Events (streaming) request. Unlike proxyRequest, this
   * does NOT buffer — it pipes the downstream event stream straight to `res`.
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
