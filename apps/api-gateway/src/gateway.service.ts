import { Injectable } from '@nestjs/common';
import { SERVICE_REGISTRY, resolveService } from './gateway.registry';

/**
 * Headers the gateway must pass through to services: the identity claims the
 * AuthGuard verified (so each service can enforce permissions itself) plus the
 * internal service key for trusted server-side callers. Without these the
 * per-service authorization layer is blind.
 */
function identityHeaders(h: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['x-user-email', 'x-user-role', 'x-user-name', 'x-user-permissions', 'x-auth-type', 'x-internal-key']) {
    if (h[k]) out[k] = String(h[k]);
  }
  return out;
}


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
    body?: any
  ): Promise<{ status: number; data: any; headers?: Record<string, string> }> {

    const resolved = resolveService(path);
    if (!resolved) {
      return {
        status: 404,
        data: { error: 'Not Found', message: `No service registered for path: ${path}` },
      };
    }

    // Build the downstream URL: baseUrl + full path
    const downstreamUrl = `${resolved.baseUrl}${path}`;

    console.log(`[Gateway] Routing → ${downstreamUrl}`);

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': headers['x-tenant-id'] || 'caroma',
        'X-Gateway-Request-ID': `gw-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        // Forward auth header if present
        ...(headers['authorization'] ? { 'Authorization': headers['authorization'] } : {}),
        // Forward the VERIFIED identity the AuthGuard just derived — services
        // enforce permissions independently (P0-02 R3) and cannot do so if the
        // gateway drops these. Also pass the internal key for trusted callers.
        ...identityHeaders(headers),
      },
    };

    // Attach body for non-GET requests
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

    const upstream = await fetch(downstreamUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': headers['x-tenant-id'] || 'caroma',
        ...(headers['authorization'] ? { Authorization: headers['authorization'] } : {}),
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
