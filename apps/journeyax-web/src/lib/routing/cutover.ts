import * as crypto from 'crypto';

export type TenantCutoverState = 'migrated' | 'unmigrated' | 'rollback';

export interface TenantRoutingDecision {
  useRuntime: boolean;
  cutoverState: TenantCutoverState;
  reason: string;
}

export interface CutoverResolverOptions {
  gatewayUrl?: string;
  internalServiceKey?: string;
  workspaceId?: string;
  bucketingKey?: string;
}

export interface DurableCutoverRecord {
  tenantId: string;
  environmentId: string;
  status: 'migrated' | 'canary' | 'unmigrated' | 'rollback';
  approvedReleaseChecksum: string;
  approvedReleaseVersion: string;
  canaryPercentage?: number;
  revision: number;
  approvedBy: string;
  promotedAt: Date | string;
  rollbackTargetVersion?: string;
  notes?: string;
  updatedAt: Date | string;
}

/**
 * Deterministic hash-based canary bucketing (0 - 99).
 * Ensures a fixed percentage of users or sessions are routed to runtime
 * without randomness or 100% false routing.
 */
export function computeCanaryBucket(key: string): number {
  const hash = crypto.createHash('sha256').update(key).digest();
  return hash.readUInt32BE(0) % 100;
}

/**
 * Calculates the stable canary bucket using tenantId + environmentId + workspaceId.
 * Never uses timestamps or randomness so decisions are 100% stable for a workspace.
 */
export function calculateCanaryBucket(tenantId: string, environmentId: string, workspaceId: string): number {
  const normWorkspace = (workspaceId || '').trim();
  if (!normWorkspace) {
    throw new Error('Non-empty workspace/session identifier is required for canary bucketing');
  }
  const key = `${(tenantId || '').trim().toLowerCase()}:${(environmentId || 'production').trim().toLowerCase()}:${normWorkspace}`;
  return computeCanaryBucket(key);
}

/**
 * Server-owned routing decision.
 * Determines whether a tenant/environment request must route to canonical journey-runtime-service
 * or to legacy commerce.
 *
 * GOVERNANCE:
 * 'tenant_cutovers' is the ONLY production cutover authority.
 * Hardcoded in-memory registries are strictly forbidden in production.
 * Any network error, MongoDB failure, or missing approval record MUST fail closed to legacy commerce.
 */
export async function resolveTenantRouting(
  tenantId: string,
  environmentId = 'production',
  options: CutoverResolverOptions = {}
): Promise<TenantRoutingDecision> {
  const normTenant = (tenantId || '').trim().toLowerCase();

  // 1. Explicit environment variable override for tenant cutover state
  const envKey = `TENANT_CUTOVER_${normTenant.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const envOverride = process.env[envKey]?.trim().toLowerCase();

  if (envOverride === 'rollback') {
    return {
      useRuntime: false,
      cutoverState: 'rollback',
      reason: `Deliberate rollback pointer active for tenant '${normTenant}' via ${envKey}`,
    };
  }

  if (envOverride === 'unmigrated') {
    return {
      useRuntime: false,
      cutoverState: 'unmigrated',
      reason: `Tenant '${normTenant}' explicitly designated unmigrated via ${envKey}`,
    };
  }

  if (envOverride === 'migrated') {
    return {
      useRuntime: true,
      cutoverState: 'migrated',
      reason: `Tenant '${normTenant}' explicitly marked migrated via ${envKey}`,
    };
  }

  // 2. Global deliberate rollback flag
  if (process.env.RUNTIME_GLOBAL_ROLLBACK === 'true') {
    return {
      useRuntime: false,
      cutoverState: 'rollback',
      reason: 'Global rollback active: RUNTIME_GLOBAL_ROLLBACK=true',
    };
  }

  // 3. Global runtime disable flag
  if (process.env.ENABLE_JOURNEY_RUNTIME === 'false') {
    return {
      useRuntime: false,
      cutoverState: 'unmigrated',
      reason: 'Runtime globally disabled via ENABLE_JOURNEY_RUNTIME=false',
    };
  }

  // 4. Server-side authoritative check against runtime service cutover registry (backed by tenant_cutovers)
  const gatewayUrl = options.gatewayUrl || process.env.GATEWAY_URL || 'http://localhost:3010';
  const internalKey = options.internalServiceKey || process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_API_KEY;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const headers: Record<string, string> = {
      'X-Tenant-ID': normTenant,
    };
    if (internalKey) headers['X-Internal-Key'] = internalKey;

    const cutoverUrl = `${gatewayUrl}/api/v1/${normTenant}/${environmentId}/runtime/cutover`;
    const resp = await fetch(cutoverUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (resp.ok) {
      const record: DurableCutoverRecord = await resp.json();
      if (record && record.status) {
        if (record.status === 'rollback') {
          return {
            useRuntime: false,
            cutoverState: 'rollback',
            reason: `Durable rollback active for tenant '${normTenant}' (target: ${record.rollbackTargetVersion || 'legacy'})`,
          };
        }
        if (record.status === 'migrated') {
          return {
            useRuntime: true,
            cutoverState: 'migrated',
            reason: `Authoritative durable cutover record verified in tenant_cutovers (v${record.approvedReleaseVersion}, rev ${record.revision})`,
          };
        }
        if (record.status === 'canary') {
          const pct = Math.max(0, Math.min(100, record.canaryPercentage ?? 0));
          const wsId = (options.workspaceId || '').trim();
          const customKey = options.bucketingKey?.trim();
          if (!wsId && !customKey) {
            return {
              useRuntime: false,
              cutoverState: 'unmigrated',
              reason: 'Non-empty workspace/session identifier is required for canary bucketing; failing closed to legacy commerce',
            };
          }
          const bucketingKey = customKey || `${normTenant}:${environmentId.toLowerCase()}:${wsId}`;
          const bucket = computeCanaryBucket(bucketingKey);
          const isSelected = bucket < pct;
          return {
            useRuntime: isSelected,
            cutoverState: isSelected ? 'migrated' : 'unmigrated',
            reason: `Deterministic canary active (${pct}%): bucket ${bucket} is ${isSelected ? 'selected' : 'not selected'}`,
          };
        }
      }
    }
  } catch (err: any) {
    // Fail closed on network/database failure
    return {
      useRuntime: false,
      cutoverState: 'unmigrated',
      reason: `Cutover service unreachable or failed (${err.message}); fail closed to legacy commerce`,
    };
  }

  // Missing record or unmigrated status fails closed
  return {
    useRuntime: false,
    cutoverState: 'unmigrated',
    reason: `Tenant '${normTenant}' has no approved durable cutover record in environment '${environmentId}'; retaining legacy commerce`,
  };
}
