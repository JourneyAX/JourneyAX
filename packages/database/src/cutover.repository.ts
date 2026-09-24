import { Db, MongoClient } from 'mongodb';
import {
  COLLECTION_TENANT_CUTOVERS,
  COLLECTION_CUTOVER_AUDIT_LOGS,
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_BUSINESS_PACK_POINTERS,
  DurableCutoverRecord,
  CutoverAuditLogRecord,
  EnvironmentId,
} from './types';

export interface PromoteCutoverParams {
  status: 'migrated' | 'canary' | 'unmigrated' | 'rollback';
  approvedReleaseVersion: string;
  approvedReleaseChecksum: string;
  expectedRevision: number; // strictly required! 0 for initial
  canaryPercentage?: number; // 0 - 100
  approvedBy: string;
  rollbackTargetVersion?: string;
  notes?: string;
}

export class CutoverValidationError extends Error {
  constructor(message: string, public readonly code: string = 'VALIDATION_FAILED') {
    super(message);
    this.name = 'CutoverValidationError';
  }
}

export class CutoverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoverConflictError';
  }
}

export class CutoverRepository {
  constructor(
    private dbProvider: () => Promise<{ db: Db; client: MongoClient }>
  ) {}

  /**
   * Retrieves the authoritative durable cutover record for a tenant and environment.
   * Fails closed if not found or if database fails in production.
   */
  async getCutoverRecord(
    tenantId: string,
    environmentId: string = 'production'
  ): Promise<DurableCutoverRecord | null> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase();

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
      if (process.env.NODE_ENV === 'production') {
        // Fail closed in production
        return null;
      }
      throw err;
    }
  }

  /**
   * Promotes or updates a cutover record inside a strict MongoDB session transaction.
   *
   * Enforces:
   * 1. Validate tenant and environment.
   * 2. Load referenced Business Pack release.
   * 3. Verify version and checksum.
   * 4. Verify active pointer in business_pack_pointers.
   * 5. Require expectedRevision.
   * 6. Update using a revision-constrained filter.
   * 7. Write audit record in the same transaction.
   * 8. Fail if the revision changed (CAS mismatch).
   */
  async promoteCutover(
    tenantId: string,
    environmentId: EnvironmentId,
    params: PromoteCutoverParams
  ): Promise<DurableCutoverRecord> {
    return this.promoteCutoverTransactionally(tenantId, environmentId, params);
  }

  async promoteCutoverTransactionally(
    tenantId: string,
    environmentId: EnvironmentId,
    params: PromoteCutoverParams
  ): Promise<DurableCutoverRecord> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase() as EnvironmentId;

    if (!normTenant) {
      throw new CutoverValidationError('tenantId is required', 'TENANT_REQUIRED');
    }
    if (!params.approvedReleaseVersion || !params.approvedReleaseChecksum) {
      throw new CutoverValidationError(
        'approvedReleaseVersion and approvedReleaseChecksum are required',
        'RELEASE_INFO_REQUIRED'
      );
    }
    if (typeof params.expectedRevision !== 'number') {
      throw new CutoverValidationError(
        'expectedRevision is strictly required for revision-based compare-and-swap',
        'EXPECTED_REVISION_REQUIRED'
      );
    }

    const { db, client } = await this.dbProvider();
    const session = client.startSession();

    try {
      let resultRecord: DurableCutoverRecord | null = null;

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
          throw new CutoverValidationError(
            `Referenced Business Pack release v${params.approvedReleaseVersion} not found for tenant '${normTenant}' (${normEnv})`,
            'RELEASE_NOT_FOUND'
          );
        }

        // 3. Verify version and checksum
        const actualChecksum = releaseDoc.checksum || releaseDoc.manifest?.checksum;
        if (actualChecksum !== params.approvedReleaseChecksum) {
          throw new CutoverValidationError(
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
          throw new CutoverValidationError(
            `No active Business Pack pointer found for tenant '${normTenant}' (${normEnv})`,
            'POINTER_NOT_FOUND'
          );
        }
        const pointerVersion = pointerDoc.activeReleaseVersion || pointerDoc.activeVersion;
        if (pointerVersion !== params.approvedReleaseVersion) {
          throw new CutoverValidationError(
            `Pointer activeVersion mismatch: pointer points to version '${pointerVersion}', but approved release version is '${params.approvedReleaseVersion}'`,
            'POINTER_VERSION_MISMATCH'
          );
        }
        const pointerChecksum = pointerDoc.activeReleaseChecksum || pointerDoc.checksum;
        if (pointerChecksum && pointerChecksum !== params.approvedReleaseChecksum) {
          throw new CutoverValidationError(
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
          throw new CutoverConflictError(
            `Cutover revision conflict: current revision is ${currentRevision}, expected ${params.expectedRevision}`
          );
        }

        const nextRevision = currentRevision + 1;
        const now = new Date();

        const updatedDoc: DurableCutoverRecord = {
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
            throw new CutoverConflictError(
              `Concurrent cutover modification detected (CAS filter failed for revision ${params.expectedRevision})`
            );
          }
        } else {
          await db.collection(COLLECTION_TENANT_CUTOVERS).insertOne(updatedDoc as any, { session });
        }

        // 7. Write audit record in the same transaction
        const auditDoc: CutoverAuditLogRecord = {
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
    } finally {
      await session.endSession();
    }
  }
}
