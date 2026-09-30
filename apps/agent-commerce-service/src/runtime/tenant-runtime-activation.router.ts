import { Injectable, Optional, Inject, ServiceUnavailableException } from '@nestjs/common';
import { isInCanaryBucket } from '@journeyax/journey-core';
import { computePackChecksum, BusinessPackRelease } from '@journeyax/business-pack';
import {
  ReleaseActivationRepository,
  ReleaseActivationRecord,
  ReleaseActivationRepositoryUnavailableError,
  CutoverRepository,
  DurableCutoverRecord,
} from '@journeyax/database';

export type ActivationDecisionAction = 'CANONICAL' | 'LEGACY' | 'BLOCKED';

export interface ActivationDecision {
  action: ActivationDecisionAction;
  reason: string;
  statusCode?: number;
  record?: ReleaseActivationRecord;
  routingKey?: string;
}

export type ReleaseLoader = (
  tenantId: string,
  environmentId: string
) => Promise<BusinessPackRelease | null>;

/**
 * TenantRuntimeActivationRouter
 * (Enterprise: Release Activation & Traffic Policy)
 *
 * Authoritative release activation routing decision engine backed by durable `tenant_cutovers`.
 * Governed decisions:
 * - No activation record / explicitly unmigrated → LEGACY.
 * - Approved migrated release → CANONICAL.
 * - Approved canary → deterministic CANONICAL or LEGACY using stable hash-based canary policy.
 * - Repository failure, malformed record, checksum/version mismatch, or invalid status → BLOCKED/503.
 *
 * Invariant: NEVER converts an infrastructure, connection, or integrity error into legacy execution.
 */
@Injectable()
export class TenantRuntimeActivationRouter {
  private activationRepo: ReleaseActivationRepository | null = null;
  private releaseLoader?: ReleaseLoader;
  private readonly runtimeUrl: string;

  constructor(
    @Optional() @Inject('RELEASE_ACTIVATION_REPOSITORY') activationRepo?: ReleaseActivationRepository,
    @Optional() @Inject('CUTOVER_REPOSITORY') cutoverRepo?: ReleaseActivationRepository
  ) {
    if (activationRepo) {
      this.activationRepo = activationRepo;
    } else if (cutoverRepo) {
      this.activationRepo = cutoverRepo;
    }
    this.runtimeUrl =
      process.env.JOURNEY_RUNTIME_SERVICE_URL ||
      process.env.JOURNEY_RUNTIME_URL ||
      process.env.RUNTIME_SERVICE_URL ||
      'http://localhost:3012';
  }

  setReleaseActivationRepository(repo: ReleaseActivationRepository): void {
    this.activationRepo = repo;
  }

  /**
   * Backward-compatibility alias for setReleaseActivationRepository.
   * @deprecated Use setReleaseActivationRepository instead.
   */
  setCutoverRepository(repo: ReleaseActivationRepository): void {
    this.setReleaseActivationRepository(repo);
  }

  setReleaseLoader(loader: ReleaseLoader): void {
    this.releaseLoader = loader;
  }

  /**
   * Resolves the authoritative release activation decision for a tenant + environment + workspace.
   */
  async resolveActivation(
    tenantId: string,
    environmentId: string = 'production',
    stableKey?: string
  ): Promise<ActivationDecision> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase();
    const routingKey = stableKey || normTenant;

    if (!normTenant) {
      return {
        action: 'BLOCKED',
        statusCode: 503,
        reason: 'tenantId is required for release activation routing',
      };
    }

    let record: ReleaseActivationRecord | null = null;

    // 1. Authoritative durable lookup
    try {
      if (this.activationRepo) {
        if (typeof this.activationRepo.getReleaseActivation === 'function') {
          record = await this.activationRepo.getReleaseActivation(normTenant, normEnv);
        } else if (typeof (this.activationRepo as any).getCutoverRecord === 'function') {
          record = await (this.activationRepo as any).getCutoverRecord(normTenant, normEnv);
        }
      } else if (process.env.MONGODB_URI) {
        const { connectToDatabase, ReleaseActivationRepository: RepoClass } = await import('@journeyax/database');
        const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
        this.activationRepo = new RepoClass(async () => {
          const { client, db } = await connectToDatabase(process.env.MONGODB_URI!, dbName);
          return { client, db };
        });
        record = await this.activationRepo.getReleaseActivation(normTenant, normEnv);
      } else {
        // Fallback to Journey Runtime /release-activation query
        record = await this.fetchReleaseActivationFromRuntimeService(normTenant, normEnv);
      }
    } catch (err: any) {
      // Infrastructure or database failure must fail closed with 503 — NEVER fall back to legacy
      return {
        action: 'BLOCKED',
        statusCode: 503,
        reason: `[ReleaseActivation] Release activation repository lookup failed for tenant '${normTenant}': ${err.message}`,
      };
    }

    // 2. No record or explicitly unmigrated → LEGACY
    if (!record || record.status === 'unmigrated') {
      return {
        action: 'LEGACY',
        reason: record
          ? `Tenant '${normTenant}' explicitly marked 'unmigrated'`
          : `No release activation record found for tenant '${normTenant}'`,
      };
    }

    // 3. Security integrity check: tenant binding
    if (record.tenantId !== normTenant) {
      return {
        action: 'BLOCKED',
        statusCode: 503,
        reason: `[ReleaseActivation] Tenant mismatch: record.tenantId '${record.tenantId}' != '${normTenant}'`,
      };
    }

    // 4. Status validation
    if (record.status !== 'migrated' && record.status !== 'canary') {
      return {
        action: 'BLOCKED',
        statusCode: 503,
        reason: `[ReleaseActivation] Invalid release activation traffic policy status '${record.status}'. Allowed: migrated, canary, unmigrated`,
      };
    }

    // 5. Release integrity check (if loader is available)
    if (this.releaseLoader) {
      try {
        const release = await this.releaseLoader(normTenant, normEnv);
        if (!release) {
          return {
            action: 'BLOCKED',
            statusCode: 503,
            reason: `[ReleaseActivation] Missing approved Business Pack release for tenant '${normTenant}'`,
          };
        }

        if (
          record.approvedReleaseVersion &&
          release.manifest?.version !== record.approvedReleaseVersion
        ) {
          return {
            action: 'BLOCKED',
            statusCode: 503,
            reason: `[ReleaseActivation] Version mismatch: release activation approves v'${record.approvedReleaseVersion}' but active pointer is v'${release.manifest?.version}'`,
          };
        }

        if (record.approvedReleaseChecksum) {
          const liveChecksum = computePackChecksum(release);
          if (record.approvedReleaseChecksum !== liveChecksum) {
            return {
              action: 'BLOCKED',
              statusCode: 503,
              reason: `[ReleaseActivation] Checksum mismatch: approved '${record.approvedReleaseChecksum}' != computed '${liveChecksum}'`,
            };
          }
        }
      } catch (err: any) {
        return {
          action: 'BLOCKED',
          statusCode: 503,
          reason: `[ReleaseActivation] Release verification failed: ${err.message}`,
        };
      }
    }

    // 6. Approved migrated release → CANONICAL
    if (record.status === 'migrated') {
      return {
        action: 'CANONICAL',
        record,
        routingKey,
        reason: `[TrafficPolicy] Approved migrated release (v${record.approvedReleaseVersion || 'unknown'})`,
      };
    }

    // 7. Approved canary → deterministic CANONICAL or LEGACY
    if (record.status === 'canary') {
      const canaryPct = Number(record.canaryPercentage ?? 0);
      const inCanary = isInCanaryBucket(normTenant, normEnv, routingKey, canaryPct);
      if (inCanary) {
        return {
          action: 'CANONICAL',
          record,
          routingKey,
          reason: `[CanaryPolicy] Workspace '${routingKey}' assigned to ${canaryPct}% canary bucket`,
        };
      } else {
        return {
          action: 'LEGACY',
          reason: `[CanaryPolicy] Workspace '${routingKey}' outside ${canaryPct}% canary bucket (served by legacy)`,
        };
      }
    }

    return {
      action: 'BLOCKED',
      statusCode: 503,
      reason: '[ReleaseActivation] Unhandled activation branch',
    };
  }

  async fetchReleaseActivationFromRuntimeService(
    tenantId: string,
    environmentId: string
  ): Promise<ReleaseActivationRecord | null> {
    const primaryUrl = `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(environmentId)}/runtime/release-activation`;
    const fallbackUrl = `${this.runtimeUrl}/api/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(environmentId)}/runtime/cutover`;
    const headers: Record<string, string> = {
      'X-Tenant-ID': tenantId,
      ...(process.env.INTERNAL_API_KEY ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY } : {}),
    };

    let res = await fetch(primaryUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 404) {
      // Fallback to deprecated compatibility alias /cutover
      res = await fetch(fallbackUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 404) {
        return null;
      }
    }

    if (!res.ok) {
      throw new Error(`Runtime service returned ${res.status}: ${res.statusText}`);
    }

    return (await res.json()) as ReleaseActivationRecord;
  }

  /**
   * Backward-compatibility alias for fetchReleaseActivationFromRuntimeService.
   * @deprecated Use fetchReleaseActivationFromRuntimeService instead.
   */
  async fetchCutoverFromRuntimeService(
    tenantId: string,
    environmentId: string
  ): Promise<DurableCutoverRecord | null> {
    return this.fetchReleaseActivationFromRuntimeService(tenantId, environmentId);
  }
}
