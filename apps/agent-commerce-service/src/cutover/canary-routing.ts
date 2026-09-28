/**
 * canary-routing.ts
 *
 * Shared, deterministic canary-bucket computation for the JourneyAX Runtime.
 *
 * The same function is used by:
 *   - RuntimeService.assertCutoverApproved (inline gate for /runtime/turn)
 *   - CutoverProxyService (compatibility routing in agent-commerce-service)
 *
 * GOVERNANCE
 * ----------
 * - The bucket is stable: same inputs → same bucket, across restarts and replicas.
 * - The bucket is tenant+env+workspace-scoped so different workspaces split evenly.
 * - No randomness. No session-state.
 * - canaryPercentage=0 → never selected.
 * - canaryPercentage=100 → always selected.
 * - The algorithm is a simple FNV-like 32-bit fold over HMAC-SHA256 truncated to
 *   the bucket range, giving a uniform distribution without floating point drift.
 */

import { createHash } from 'crypto';

/**
 * Computes a deterministic [0, 99] bucket for a given routing key and returns
 * true if the bucket falls within [0, canaryPercentage).
 *
 * @param tenantId      - tenant identifier (normalised to lowercase)
 * @param environmentId - environment identifier (e.g. 'production')
 * @param stableKey     - workspace or session ID that anchors the sticky assignment
 * @param canaryPercentage - integer 0–100 from the DurableCutoverRecord
 */
export function isInCanaryBucket(
  tenantId: string,
  environmentId: string,
  stableKey: string,
  canaryPercentage: number
): boolean {
  if (canaryPercentage <= 0) return false;
  if (canaryPercentage >= 100) return true;

  // Stable hash: SHA-256 over pipe-separated key, fold to [0, 99]
  const raw = createHash('sha256')
    .update(`${tenantId}|${environmentId}|${stableKey}`)
    .digest();

  // Read first 4 bytes as big-endian uint32, modulo 100
  const bucket = raw.readUInt32BE(0) % 100;
  return bucket < canaryPercentage;
}

/**
 * Returns the routing decision for a given cutover record and request.
 *
 * - 'migrated'  → always execute on canonical runtime
 * - 'canary'    → execute on canonical runtime if bucket < canaryPercentage
 * - anything else → not routed to runtime
 */
export function resolveRuntimeRouting(
  status: string,
  canaryPercentage: number,
  tenantId: string,
  environmentId: string,
  stableKey: string
): 'canonical' | 'legacy' {
  if (status === 'migrated') return 'canonical';
  if (status === 'canary') {
    return isInCanaryBucket(tenantId, environmentId, stableKey, canaryPercentage)
      ? 'canonical'
      : 'legacy';
  }
  return 'legacy';
}
