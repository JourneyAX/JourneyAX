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

@Injectable()
export class CutoverProxyService {
  private readonly runtimeUrl: string;

  constructor() {
    this.runtimeUrl =
      process.env.JOURNEY_RUNTIME_SERVICE_URL ||
      process.env.RUNTIME_SERVICE_URL ||
      'http://localhost:3009';
  }

  /**
   * Resolves the cutover decision for a tenant + environment + workspace.
   *
   * Returns `NOT_MIGRATED` only when the tenant has no cutover record or is
   * explicitly `unmigrated`. All other failures throw — they MUST NOT fall
   * back to legacy logic.
   */
  async resolveCutover(
    tenantId: string,
    environmentId: string,
    stableKey: string,
    timeoutMs = 3000
  ): Promise<'canonical' | 'legacy'> {
    let res: Response;

    // All errors except 404 propagate — never silently fall to legacy.
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
      // Timeout, ECONNREFUSED, ECONNRESET, DNS failure — all fatal.
      throw new Error(
        `[CutoverProxy] Cutover registry unreachable for tenant='${tenantId}' env='${environmentId}': ${networkErr.message}`
      );
    }

    // 404 → no record → unmigrated tenant, safe to continue legacy.
    if (res.status === 404) {
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
    const normTenant = tenantId.trim().toLowerCase();
    if (record.tenantId.trim().toLowerCase() !== normTenant) {
      throw new Error(
        `[CutoverProxy] Cross-tenant binding violation: record.tenantId='${record.tenantId}' ≠ request tenant='${tenantId}'`
      );
    }

    const canaryPercentage = Number(record.canaryPercentage ?? 0);
    return resolveRuntimeRouting(
      record.status,
      canaryPercentage,
      normTenant,
      environmentId.trim().toLowerCase(),
      stableKey
    );
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
