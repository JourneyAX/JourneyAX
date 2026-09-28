/**
 * cutover-proxy.service.ts
 *
 * Small, focused compatibility-routing component for the JourneyAX Runtime.
 *
 * PURPOSE
 * -------
 * The agent-commerce-service acts as the legacy adapter for unmigrated tenants.
 * When a tenant has been cut over (status='migrated') or is in canary (status='canary'),
 * requests must be proxied to the canonical journey-runtime-service instead of
 * executing legacy commerce logic.
 *
 * This service owns:
 *   1. Cutover-record lookup from the runtime registry (GET /cutover endpoint).
 *   2. Canary-bucket routing using the shared deterministic algorithm.
 *   3. Turn-proxy HTTP call to journey-runtime-service.
 *   4. Fail-closed error policy (only 404/no-record may fall back to legacy).
 *
 * GOVERNANCE
 * ----------
 * - This file MUST NOT grow beyond compatibility routing.
 * - No tenant business logic, no reasoning models, no session management here.
 * - agent.service.ts stays frozen; it delegates to this service without alteration.
 *
 * FAIL-CLOSED POLICY
 * ------------------
 * | Cutover lookup result          | Action                          |
 * |--------------------------------|---------------------------------|
 * | 404 / no record                | Continue to legacy (unmigrated) |
 * | status='unmigrated'            | Continue to legacy              |
 * | status='migrated'              | Proxy to runtime                |
 * | status='canary', in bucket     | Proxy to runtime                |
 * | status='canary', not in bucket | Continue to legacy              |
 * | Timeout                        | Throw — NEVER execute legacy    |
 * | Database / network error       | Throw — NEVER execute legacy    |
 * | Malformed record               | Throw — NEVER execute legacy    |
 * | Checksum mismatch              | Throw — NEVER execute legacy    |
 * | Runtime proxy failure          | Throw — NEVER execute legacy    |
 */

import { Injectable } from '@nestjs/common';
import { resolveRuntimeRouting } from '@journeyax/journey-core';


export interface CutoverDecision {
  /** Whether this request must be proxied to the canonical runtime. */
  proxied: false;
}

export interface CutoverProxy {
  proxied: true;
  result: any;
}

export type CutoverRoutingResult = CutoverDecision | CutoverProxy;

/** Sentinel returned when a tenant has no cutover record (unmigrated). */
export const NOT_MIGRATED: CutoverDecision = { proxied: false };

export const DEFAULT_RUNTIME_SERVICE_URL = 'http://localhost:3012';

interface CutoverCacheEntry {
  decision: 'canonical' | 'legacy';
  status?: string;
  cachedAt: number;
}

@Injectable()
export class CutoverProxyService {
  private readonly runtimeUrl: string;
  private readonly cutoverCache = new Map<string, CutoverCacheEntry>();
  private readonly lastKnownStatus = new Map<string, string>();
  private cacheTtlMs: number = 30_000;

  constructor(overrideUrl?: string) {
    this.runtimeUrl =
      overrideUrl ||
      process.env.JOURNEY_RUNTIME_SERVICE_URL ||
      process.env.JOURNEY_RUNTIME_URL ||
      process.env.RUNTIME_SERVICE_URL ||
      DEFAULT_RUNTIME_SERVICE_URL;
  }

  /** Clears the in-memory cache and last-known status (for testing). */
  clearCache(): void {
    this.cutoverCache.clear();
    this.lastKnownStatus.clear();
  }

  /** Sets the cache TTL (for testing). */
  setCacheTtl(ms: number): void {
    this.cacheTtlMs = ms;
  }

  /**
   * Resolves the cutover decision for a tenant + environment + workspace.
   *
   * Returns `legacy` only when the tenant has a verified runtime 404 / no record or
   * is unmigrated, or when registry is unreachable and tenant has NEVER been seen migrated.
   * Tenants known to be migrated/canary fail closed when registry is unreachable.
   */
  async resolveCutover(
    tenantId: string,
    environmentId: string,
    stableKey: string,
    timeoutMs = 3000
  ): Promise<'canonical' | 'legacy'> {
    const normTenant = tenantId.trim().toLowerCase();
    const normEnv = environmentId.trim().toLowerCase();
    const cacheKey = `${normTenant}:${normEnv}`;
    const now = Date.now();

    // 1. Check in-memory cache with TTL
    const cached = this.cutoverCache.get(cacheKey);
    if (cached && now - cached.cachedAt < this.cacheTtlMs) {
      return cached.decision;
    }

    let res: Response;

    try {
      res = await fetch(
        `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(environmentId)}/runtime/cutover`,
        {
          method: 'GET',
          headers: {
            'X-Tenant-ID': tenantId,
            ...(process.env.INTERNAL_API_KEY
              ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY }
              : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
    } catch (networkErr: any) {
      const lastStatus = this.lastKnownStatus.get(cacheKey);
      if (lastStatus === 'migrated' || lastStatus === 'canary') {
        // Known migrated/canary tenants must FAIL CLOSED to prevent legacy data corruption
        throw new Error(
          `[CutoverProxy] Cutover registry unreachable for tenant='${tenantId}' env='${environmentId}' (status='${lastStatus}'): failing closed: ${networkErr.message}`
        );
      }

      // Tenant has NEVER been seen migrated: continue on legacy and log loudly
      console.error(
        `[CutoverProxy] ⚠️ CUTOVER REGISTRY UNREACHABLE for tenant='${tenantId}' env='${environmentId}'. ` +
        `Tenant has never been seen migrated; continuing on legacy commerce engine. Network error: ${networkErr.message}`
      );
      return 'legacy';
    }

    // 2. Strict 404 handling: only treat 404 as "no record" when it comes from the runtime's own response shape
    if (res.status === 404) {
      let notFoundBody: any = null;
      try {
        notFoundBody = await res.json();
      } catch {
        // Non-JSON response (e.g. Next.js HTML error page from wrong port)
        throw new Error(
          `[CutoverProxy] Malformed 404 response from non-runtime service for tenant='${tenantId}' env='${environmentId}': expected JSON error payload`
        );
      }

      const isRuntimeNotFound =
        notFoundBody &&
        notFoundBody.statusCode === 404 &&
        typeof notFoundBody.message === 'string' &&
        notFoundBody.message.includes('No durable cutover record found');

      if (!isRuntimeNotFound) {
        throw new Error(
          `[CutoverProxy] Rejected 404 from unexpected service for tenant='${tenantId}' env='${environmentId}': missing runtime cutover marker in payload`
        );
      }

      // Verified runtime 404: cache "no cutover record" answer with short TTL
      this.lastKnownStatus.set(cacheKey, 'unmigrated');
      this.cutoverCache.set(cacheKey, {
        decision: 'legacy',
        status: 'unmigrated',
        cachedAt: now,
      });
      return 'legacy';
    }

    if (!res.ok) {
      throw new Error(
        `[CutoverProxy] Cutover registry returned unexpected status ${res.status} for tenant='${tenantId}' env='${environmentId}'`
      );
    }

    let record: any;
    try {
      record = await res.json();
    } catch {
      throw new Error(
        `[CutoverProxy] Malformed JSON in cutover record for tenant='${tenantId}' env='${environmentId}'`
      );
    }

    // Validate required fields — malformed record fails closed.
    if (
      !record ||
      typeof record.status !== 'string' ||
      typeof record.tenantId !== 'string' ||
      typeof record.approvedReleaseChecksum !== 'string' ||
      record.approvedReleaseChecksum.length < 32
    ) {
      throw new Error(
        `[CutoverProxy] Malformed cutover record for tenant='${tenantId}' env='${environmentId}': ` +
        `missing required fields (tenantId, status, approvedReleaseChecksum)`
      );
    }

    // Cross-tenant binding — reject cross-tenant records.
    if (record.tenantId.trim().toLowerCase() !== normTenant) {
      throw new Error(
        `[CutoverProxy] Cross-tenant binding violation: record.tenantId='${record.tenantId}' ≠ request tenant='${tenantId}'`
      );
    }

    const canaryPercentage = Number(record.canaryPercentage ?? 0);
    const decision = resolveRuntimeRouting(
      record.status,
      canaryPercentage,
      normTenant,
      normEnv,
      stableKey
    );

    // Update cache and last-known status
    this.lastKnownStatus.set(cacheKey, record.status);
    this.cutoverCache.set(cacheKey, {
      decision,
      status: record.status,
      cachedAt: now,
    });

    return decision;
  }

  /**
   * Proxies a turn request to the canonical journey-runtime-service.
   * Throws on any non-2xx response — NEVER falls back to legacy.
   */
  async proxyTurn(
    tenantId: string,
    environmentId: string,
    request: any,
    sessionId: string
  ): Promise<any> {
    const userMsg =
      request.message ||
      (request.messages && request.messages.length > 0
        ? request.messages[request.messages.length - 1]?.content
        : '');

    const { randomUUID } = await import('crypto');
    const callerTurnId =
      request.turnId ||
      (request as any).turn?.turnId ||
      (request as any).correlationId ||
      randomUUID();
    const correlationId = (request as any).correlationId || callerTurnId;
    const idempotencyKey = request.idempotencyKey || request.toolIdempotencyKey;

    let res: Response;
    try {
      res = await fetch(
        `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(environmentId)}/runtime/turn`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-ID': tenantId,
            ...(process.env.INTERNAL_API_KEY
              ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY }
              : {}),
          },
          body: JSON.stringify({
            workspaceId: sessionId,
            sessionId,
            turnId: callerTurnId,
            correlationId,
            idempotencyKey,
            principalId: request.customerId || request.demoPrincipalId || 'anonymous',
            message: userMsg,
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
    } catch (networkErr: any) {
      throw new Error(
        `[CutoverProxy] Runtime service unreachable during turn proxy for tenant='${tenantId}': ${networkErr.message}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[CutoverProxy] Runtime service returned ${res.status} during turn proxy for tenant='${tenantId}': ${body.slice(0, 200)}`
      );
    }

    const turnResult = await res.json();
    return this.adaptTurnResult(request, sessionId, turnResult);
  }

  /**
   * Adapts the canonical TurnResult into the legacy commerce response shape.
   * This is a pure transformation — no side effects.
   */
  private adaptTurnResult(request: any, sessionId: string, turnResult: any): any {
    return {
      sessionId,
      message: {
        role: 'assistant',
        content: turnResult.assistantMessage || '',
      },
      conversation: [
        ...(request.messages || []),
        { role: 'assistant', content: turnResult.assistantMessage || '' },
      ],
      uiActions: (turnResult.uiInstructions || []).map((inst: any) => ({
        name: 'presentCard',
        arguments: {
          card: {
            id: inst.actionId || `${inst.component}-${Date.now()}`,
            cardType: inst.component,
            state: inst.props,
          },
        },
        card: {
          cardType: inst.component,
          state: inst.props,
        },
      })),
      trace: [
        {
          step: 'runtime_service_proxy',
          detail: `stage=${turnResult.trace?.stage} · decision=${turnResult.decision?.type}`,
        },
      ],
    };
  }

  /**
   * Convenience: resolve cutover and proxy if canonical, or return null to
   * signal the caller to continue with legacy.
   *
   * Throws on any error that is NOT a clean "no record" decision.
   */
  async routeOrLegacy(
    tenantId: string,
    environmentId: string,
    stableKey: string,
    request: any,
    sessionId: string
  ): Promise<any | null> {
    const route = await this.resolveCutover(tenantId, environmentId, stableKey);
    if (route === 'legacy') return null;

    return this.proxyTurn(tenantId, environmentId, request, sessionId);
  }
}
