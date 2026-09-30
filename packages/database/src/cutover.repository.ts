import { Db, MongoClient } from 'mongodb';
import {
  COLLECTION_TENANT_CUTOVERS,
  COLLECTION_RELEASE_ACTIVATIONS,
  COLLECTION_CUTOVER_AUDIT_LOGS,
  COLLECTION_RELEASE_ACTIVATION_AUDIT_LOGS,
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_BUSINESS_PACK_POINTERS,
  DurableCutoverRecord,
  ReleaseActivationRecord,
  CutoverAuditLogRecord,
  ReleaseActivationAuditLogRecord,
  TrafficPolicy,
  EnvironmentId,
} from './types';

export interface PromoteReleaseActivationParams {
  status: TrafficPolicy;
  approvedReleaseVersion: string;
  approvedReleaseChecksum: string;
  expectedRevision: number; // strictly required! 0 for initial
  canaryPercentage?: number; // 0 - 100
  approvedBy: string;
  rollbackTargetVersion?: string;
  notes?: string;
}

// Deprecated alias for backward compatibility
export type PromoteCutoverParams = PromoteReleaseActivationParams;

export class ReleaseActivationValidationError extends Error {
  constructor(message: string, public readonly code: string = 'VALIDATION_FAILED') {
    super(message);
    this.name = 'ReleaseActivationValidationError';
  }
}

// Deprecated alias for backward compatibility
export const CutoverValidationError = ReleaseActivationValidationError;

export class ReleaseActivationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseActivationConflictError';
  }
}

// Deprecated alias for backward compatibility
export const CutoverConflictError = ReleaseActivationConflictError;

export class ReleaseActivationRepositoryUnavailableError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'ReleaseActivationRepositoryUnavailableError';
  }
}

// Deprecated alias for backward compatibility
export const CutoverRepositoryUnavailableError = ReleaseActivationRepositoryUnavailableError;

/**
 * ReleaseActivationRepository
 * (Canonical implementation for Release Activation & Traffic Policy)
 *
 * Durable MongoDB repository managing authoritative release activation records,
 * atomic compare-and-swap (CAS) promotions, and immutable audit logs.
 */
export class ReleaseActivationRepository {
  constructor(
    private dbProvider: () => Promise<{ db: Db; client: MongoClient }>
  ) {}

  /**
   * Retrieves the authoritative durable release activation record for a tenant and environment.
   * - A successful lookup with no activation record returns null.
   * - Any database/provider/connection failure throws ReleaseActivationRepositoryUnavailableError.
   */
  async getReleaseActivation(
    tenantId: string,
    environmentId: string = 'production'
  ): Promise<ReleaseActivationRecord | null> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase();

    // If subclass overrode getCutoverRecord, delegate to preserve compatibility
    if (this.getCutoverRecord !== ReleaseActivationRepository.prototype.getCutoverRecord) {
      return this.getCutoverRecord(normTenant, normEnv);
    }

    try {
      const { db } = await this.dbProvider();
      const doc = await db.collection(COLLECTION_TENANT_CUTOVERS).findOne({
        tenantId: normTenant,
        environmentId: normEnv,
      });

      if (!doc) return null;

      return {
        tenantId: doc.tenantId,
        environmentId: doc.environmentId,
        status: doc.status,
        approvedReleaseChecksum: doc.approvedReleaseChecksum,
        approvedReleaseVersion: doc.approvedReleaseVersion,
        canaryPercentage: doc.canaryPercentage,
        revision: doc.revision,
        approvedBy: doc.approvedBy,
        promotedAt: doc.promotedAt,
        rollbackTargetVersion: doc.rollbackTargetVersion,
        notes: doc.notes,
        updatedAt: doc.updatedAt,
      };
    } catch (err: any) {
      if (
        err instanceof ReleaseActivationValidationError ||
        err instanceof ReleaseActivationConflictError
      ) {
        throw err;
      }
      throw new ReleaseActivationRepositoryUnavailableError(
        `Failed to retrieve release activation record for tenant='${normTenant}' env='${normEnv}': ${err.message}`,
        err
      );
    }
  }

  /**
   * Backward-compatibility alias for getReleaseActivation.
   * @deprecated Use getReleaseActivation instead.
   */
  async getCutoverRecord(
    tenantId: string,
    environmentId: string = 'production'
  ): Promise<DurableCutoverRecord | null> {
    return this.getReleaseActivation(tenantId, environmentId);
  }

  /**
   * Promotes or updates a release activation record inside a strict MongoDB session transaction.
   *
   * Enforces:
   * 1. Validate tenant and environment.
   * 2. Load referenced Business Pack release.
   * 3. Verify version and checksum.
   * 4. Verify active pointer in business_pack_pointers.
   * 5. Require expectedRevision for compare-and-swap (CAS).
   * 6. Update using a revision-constrained filter.
   * 7. Write audit record in the same transaction.
   * 8. Fail if the revision changed (CAS mismatch).
   */
  async promoteReleaseActivation(
    tenantId: string,
    environmentId: EnvironmentId,
    params: PromoteReleaseActivationParams
  ): Promise<ReleaseActivationRecord> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase() as EnvironmentId;

    if (!normTenant) {
      throw new ReleaseActivationValidationError('tenantId is required', 'TENANT_REQUIRED');
    }
    if (!params.approvedReleaseVersion || !params.approvedReleaseChecksum) {
      throw new ReleaseActivationValidationError(
        'approvedReleaseVersion and approvedReleaseChecksum are required',
        'RELEASE_INFO_REQUIRED'
      );
    }
    if (typeof params.expectedRevision !== 'number') {
      throw new ReleaseActivationValidationError(
        'expectedRevision is strictly required for revision-based compare-and-swap',
        'EXPECTED_REVISION_REQUIRED'
      );
    }

    let client: MongoClient;
    let db: Db;
    try {
      const providerRes = await this.dbProvider();
      db = providerRes.db;
      client = providerRes.client;
    } catch (err: any) {
      throw new ReleaseActivationRepositoryUnavailableError(
        `Failed to connect to database provider for promoteReleaseActivation: ${err.message}`,
        err
      );
    }

    const session = client.startSession();

    try {
      let resultRecord: ReleaseActivationRecord | null = null;

      await session.withTransaction(async () => {
        // 1 & 2: Load the referenced Business Pack release
        const releaseDoc = await db.collection(COLLECTION_BUSINESS_PACK_RELEASES).findOne(
          {
            tenantId: normTenant,
            environmentId: normEnv,
            $or: [
              { version: params.approvedReleaseVersion },
              { 'manifest.version': params.approvedReleaseVersion },
            ],
          },
          { session }
        );

        if (!releaseDoc) {
          throw new ReleaseActivationValidationError(
            `Referenced Business Pack release v${params.approvedReleaseVersion} not found for tenant '${normTenant}' (${normEnv})`,
            'RELEASE_NOT_FOUND'
          );
        }

        // 3. Verify version and checksum
        const actualChecksum = releaseDoc.checksum || releaseDoc.manifest?.checksum;
        if (actualChecksum !== params.approvedReleaseChecksum) {
          throw new ReleaseActivationValidationError(
            `Release checksum mismatch: expected '${actualChecksum}', got '${params.approvedReleaseChecksum}'`,
            'CHECKSUM_MISMATCH'
          );
        }

        // 4. Verify active pointer exists in business_pack_pointers and matches approved release exactly
        const pointerDoc = await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).findOne(
          { tenantId: normTenant, environmentId: normEnv },
          { session }
        );
        if (!pointerDoc) {
          throw new ReleaseActivationValidationError(
            `No active Business Pack pointer found for tenant '${normTenant}' (${normEnv})`,
            'POINTER_NOT_FOUND'
          );
        }
        const pointerVersion = pointerDoc.activeReleaseVersion || pointerDoc.activeVersion;
        if (pointerVersion !== params.approvedReleaseVersion) {
          throw new ReleaseActivationValidationError(
            `Pointer activeVersion mismatch: pointer points to version '${pointerVersion}', but approved release version is '${params.approvedReleaseVersion}'`,
            'POINTER_VERSION_MISMATCH'
          );
        }
        const pointerChecksum = pointerDoc.activeReleaseChecksum || pointerDoc.checksum;
        if (!pointerChecksum) {
          throw new ReleaseActivationValidationError(
            `Active Business Pack pointer for tenant '${normTenant}' (${normEnv}) is missing checksum`,
            'POINTER_CHECKSUM_MISSING'
          );
        }
        if (pointerChecksum !== params.approvedReleaseChecksum) {
          throw new ReleaseActivationValidationError(
            `Pointer checksum mismatch: pointer checksum '${pointerChecksum}' does not match approved release checksum '${params.approvedReleaseChecksum}'`,
            'POINTER_CHECKSUM_MISMATCH'
          );
        }

        // 5 & 6. Revision-constrained check & compare-and-swap
        const currentCutover = await db.collection(COLLECTION_TENANT_CUTOVERS).findOne(
          { tenantId: normTenant, environmentId: normEnv },
          { session }
        );

        const currentRevision = currentCutover ? currentCutover.revision : 0;
        if (currentRevision !== params.expectedRevision) {
          throw new ReleaseActivationConflictError(
            `Release activation revision conflict: current revision is ${currentRevision}, expected ${params.expectedRevision}`
          );
        }

        const nextRevision = currentRevision + 1;
        const now = new Date();

        const updatedDoc: ReleaseActivationRecord = {
          tenantId: normTenant,
          environmentId: normEnv,
          status: params.status,
          approvedReleaseChecksum: params.approvedReleaseChecksum,
          approvedReleaseVersion: params.approvedReleaseVersion,
          canaryPercentage: params.canaryPercentage ?? 0,
          revision: nextRevision,
          approvedBy: params.approvedBy,
          promotedAt: now,
          rollbackTargetVersion: params.rollbackTargetVersion,
          notes: params.notes,
          updatedAt: now,
        };

        // Revision-constrained atomic filter
        if (currentCutover) {
          const updateRes = await db.collection(COLLECTION_TENANT_CUTOVERS).updateOne(
            { tenantId: normTenant, environmentId: normEnv, revision: params.expectedRevision },
            { $set: updatedDoc },
            { session }
          );
          if (updateRes.matchedCount === 0) {
            throw new ReleaseActivationConflictError(
              `Concurrent release activation modification detected (CAS filter failed for revision ${params.expectedRevision})`
            );
          }
        } else {
          await db.collection(COLLECTION_TENANT_CUTOVERS).insertOne(updatedDoc as any, { session });
        }

        // 7. Write audit record in the same transaction
        const auditDoc: ReleaseActivationAuditLogRecord = {
          tenantId: normTenant,
          environmentId: normEnv,
          previousStatus: currentCutover?.status || 'unmigrated',
          newStatus: params.status,
          previousRevision: currentRevision,
          newRevision: nextRevision,
          approvedReleaseVersion: params.approvedReleaseVersion,
          approvedReleaseChecksum: params.approvedReleaseChecksum,
          canaryPercentage: params.canaryPercentage ?? 0,
          approvedBy: params.approvedBy,
          notes: params.notes,
          timestamp: now,
        };
        await db.collection(COLLECTION_CUTOVER_AUDIT_LOGS).insertOne(auditDoc as any, { session });

        resultRecord = updatedDoc;
      });

      return resultRecord!;
    } catch (err: any) {
      if (
        err instanceof ReleaseActivationValidationError ||
        err instanceof ReleaseActivationConflictError
      ) {
        throw err;
      }
      throw new ReleaseActivationRepositoryUnavailableError(
        `Failed to promote release activation for tenant='${normTenant}' env='${normEnv}': ${err.message}`,
        err
      );
    } finally {
      await session.endSession();
    }
  }

  /**
   * Backward-compatibility alias for promoteReleaseActivation.
   * @deprecated Use promoteReleaseActivation instead.
   */
  async promoteCutover(
    tenantId: string,
    environmentId: EnvironmentId,
    params: PromoteCutoverParams
  ): Promise<DurableCutoverRecord> {
    return this.promoteReleaseActivation(tenantId, environmentId, params);
  }

  /**
   * Backward-compatibility alias for promoteReleaseActivation.
   * @deprecated Use promoteReleaseActivation instead.
   */
  async promoteCutoverTransactionally(
    tenantId: string,
    environmentId: EnvironmentId,
    params: PromoteCutoverParams
  ): Promise<DurableCutoverRecord> {
    return this.promoteReleaseActivation(tenantId, environmentId, params);
  }
}

// Backward-compatibility alias for CutoverRepository
export const CutoverRepository = ReleaseActivationRepository;
export type CutoverRepository = ReleaseActivationRepository;
