import { UNATTRIBUTED_PRINCIPAL } from '@journeyax/shared-types';
import { randomUUID } from 'crypto';
import type { Db } from 'mongodb';
import {
  BusinessPackRelease,
  BusinessPackReleaseSchema,
  extractPackContent,
} from './schemas/business-pack.schema';
import { validateBusinessPack } from './validator';
import { BusinessPackLoader } from './loader';
import { computePackChecksum } from './checksum';
import {
  ReleaseVerificationFailureReason,
  tryVerifyPersistedBusinessPackRelease,
} from './release-verifier';
import { assertPublishableRoutingPolicy } from './routing-policy';

/** Typed rollback failure carrying the verifier's reason code. */
export class BusinessPackRollbackError extends Error {
  constructor(
    public readonly reason: ReleaseVerificationFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'BusinessPackRollbackError';
  }
}

const COLLECTION_BUSINESS_PACK_RELEASES = 'business_pack_releases';
const COLLECTION_BUSINESS_PACK_POINTERS = 'business_pack_pointers';
const COLLECTION_OUTBOX_EVENTS = 'outbox_events';
const COLLECTION_TENANT_CUTOVERS = 'tenant_cutovers';

export interface PublishOptions {
  publishedBy?: string;
  notes?: string;
  session?: any;
}

export interface RollbackOptions {
  rolledBackBy?: string;
  targetVersion?: string;
  reason?: string;
  session?: any;
}

async function runWithTransaction<T>(
  db: Db,
  options: { session?: any },
  operation: (session?: any) => Promise<T>
): Promise<T> {
  if (options.session) {
    return operation(options.session);
  }
  const client = (db as any).client;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!client || typeof client.startSession !== 'function') {
      throw new Error(
        '[BusinessPackPublisher] Transactional publication required in production: MongoDB client does not support sessions'
      );
    }
    const session = client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await operation(session);
      });
      return result;
    } catch (txErr: any) {
      throw new Error(
        `[BusinessPackPublisher] Transactional publication failed in production: ${txErr.message}`
      );
    } finally {
      await session.endSession();
    }
  }

  // Non-production (local dev / test with replica set or standalone fallback)
  if (client && typeof client.startSession === 'function') {
    const session = client.startSession();
    try {
      let result!: T;
      try {
        await session.withTransaction(async () => {
          result = await operation(session);
        });
        return result;
      } catch (txErr: any) {
        if (/replica set|standalone|Transaction numbers/i.test(txErr.message || '')) {
          return await operation(undefined);
        }
        throw txErr;
      }
    } finally {
      await session.endSession();
    }
  }

  return operation(undefined);
}

export async function publishBusinessPack(
  db: Db,
  packData: unknown,
  options: PublishOptions = {}
): Promise<{ release: BusinessPackRelease; checksum: string; revision: number }> {
  // 1. Strict schema validation
  const parsed = BusinessPackReleaseSchema.safeParse(packData);
  if (!parsed.success) {
    throw new Error(
      `[BusinessPackPublisher] Schema validation failed: ${JSON.stringify(parsed.error.format())}`
    );
  }
  const pack = parsed.data;

  // 2. Strict semantic validation
  const validation = validateBusinessPack(pack);
  if (!validation.valid) {
    const errorDetails = validation.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `[${i.path}] ${i.message}`)
      .join('; ');
    throw new Error(`[BusinessPackPublisher] Pack semantic validation failed: ${errorDetails}`);
  }

  // 2b. Routing policy must be explicit and unambiguous at the canonical publication boundary
  assertPublishableRoutingPolicy(pack);

  // 3. Compute checksum
  const checksum = computePackChecksum(pack);
  const tenantId = pack.manifest.tenantId;
  const environmentId = pack.manifest.environmentId || 'production';
  const version = pack.manifest.version;
  const now = new Date();
  const publishedBy = options.publishedBy || UNATTRIBUTED_PRINCIPAL;

  return runWithTransaction(db, options, async (session) => {
    const sessionOpts = session ? { session } : undefined;

    // 4. Save immutable insert-only release
    const releasesCol = db.collection(COLLECTION_BUSINESS_PACK_RELEASES);
    const existingRelease = await releasesCol.findOne({ tenantId, environmentId, version }, sessionOpts);

    if (existingRelease) {
      if (existingRelease.checksum !== checksum) {
        throw new Error(
          `[BusinessPackPublisher] Immutable release violation: version '${version}' for tenant '${tenantId}' (${environmentId}) is already published with different checksum '${existingRelease.checksum}'. Releases are strictly immutable. You must bump the version to publish modifications.`
        );
      }

      // Never trust the checksum field on an existing document by itself. A
      // tampered release could retain the original checksum and otherwise be
      // promoted (or returned idempotently) without its stored content being
      // re-verified. Verify before any pointer/outbox mutation or early return.
      const existingVerification = tryVerifyPersistedBusinessPackRelease(existingRelease, {
        tenantId,
        environmentId,
        version,
      });
      if (existingVerification.ok === false) {
        throw new Error(
          `[BusinessPackPublisher] Existing release '${version}' for tenant '${tenantId}' (${environmentId}) failed integrity verification: ${existingVerification.error.message}`
        );
      }
      if (existingVerification.release.checksum !== checksum) {
        throw new Error(
          `[BusinessPackPublisher] Immutable release violation: verified existing release checksum '${existingVerification.release.checksum}' does not match incoming checksum '${checksum}'.`
        );
      }

      // If identical release is already the active pointer, return idempotently without bumping revision
      const pointersCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
      const activePointer = await pointersCol.findOne({ tenantId, environmentId }, sessionOpts);
      if (activePointer && activePointer.activeVersion === version && activePointer.checksum === checksum) {
        return { release: pack, checksum, revision: activePointer.revision };
      }
    } else {
      const content = extractPackContent(pack);
      const releaseDoc = {
        tenantId,
        environmentId,
        version,
        versionId: version,
        status: 'published',
        checksum,
        ...content,
        publishedAt: now,
        publishedBy,
      };

      try {
        await releasesCol.insertOne(releaseDoc, sessionOpts);
      } catch (insertErr: any) {
        if (insertErr.code === 11000 || /duplicate key/i.test(insertErr.message)) {
          const doubleCheck = await releasesCol.findOne({ tenantId, environmentId, version }, sessionOpts);
          if (doubleCheck && doubleCheck.checksum !== checksum) {
            throw new Error(
              `[BusinessPackPublisher] Immutable release violation: version '${version}' was concurrently published with different content.`
            );
          }
        } else {
          throw insertErr;
        }
      }
    }

    // 5. Update active pointer with Compare-And-Swap (CAS)
    const pointersCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
    const existingPointer = await pointersCol.findOne({ tenantId, environmentId }, sessionOpts);

    const previousVersion = existingPointer?.activeVersion || null;
    const expectedRevision = existingPointer?.revision ?? 0;
    const revision = expectedRevision + 1;

    if (existingPointer) {
      const casResult = await pointersCol.updateOne(
        { tenantId, environmentId, revision: expectedRevision },
        {
          $set: {
            activeVersion: version,
            activeVersionId: version,
            status: 'active',
            previousVersion,
            revision,
            rollbackAvailable: Boolean(previousVersion),
            promotedAt: now,
            promotedBy: publishedBy,
            checksum,
            notes: options.notes,
          },
          $push: {
            history: {
              $each: [
                {
                  version,
                  checksum,
                  revision,
                  action: 'promoted',
                  promotedAt: now,
                  promotedBy: publishedBy,
                  notes: options.notes,
                },
              ],
              $slice: -20,
            },
          } as any,
        },
        sessionOpts
      );

      if (casResult.matchedCount === 0) {
        throw new Error(
          `[BusinessPackPublisher] CAS promotion conflict: pointer for tenant '${tenantId}' (${environmentId}) was concurrently modified (expected revision ${expectedRevision})`
        );
      }
    } else {
      await pointersCol.insertOne(
        {
          tenantId,
          environmentId,
          activeVersion: version,
          activeVersionId: version,
          status: 'active',
          previousVersion: null,
          revision: 1,
          rollbackAvailable: false,
          promotedAt: now,
          promotedBy: publishedBy,
          checksum,
          notes: options.notes,
          history: [
            {
              version,
              checksum,
              revision: 1,
              action: 'initial_publish',
              promotedAt: now,
              promotedBy: publishedBy,
              notes: options.notes,
            },
          ],
        },
        sessionOpts
      );
    }

    // 5b. Synchronize durable release activation record (tenant_cutovers) if present
    const cutoversCol = db.collection(COLLECTION_TENANT_CUTOVERS);
    const existingCutover = await cutoversCol.findOne({ tenantId, environmentId }, sessionOpts);
    if (existingCutover) {
      await cutoversCol.updateOne(
        { tenantId, environmentId },
        {
          $set: {
            approvedReleaseVersion: version,
            approvedReleaseChecksum: checksum,
            status: existingCutover.status === 'canary' ? 'canary' : 'migrated',
            promotedAt: now,
            promotedBy: publishedBy,
            updatedAt: now,
          },
        },
        sessionOpts
      );
    }

    // 6. Enqueue outbox event for audit and subscribers
    const outboxCol = db.collection(COLLECTION_OUTBOX_EVENTS);
    await outboxCol.insertOne(
      {
        eventId: `evt_${randomUUID()}`,
        tenantId,
        environmentId,
        eventType: 'business_pack.published',
        payload: {
          tenantId,
          environmentId,
          version,
          previousVersion,
          checksum,
          revision,
          publishedBy,
          publishedAt: now.toISOString(),
          notes: options.notes,
        },
        status: 'pending',
        attempts: 0,
        createdAt: now,
      },
      sessionOpts
    );

    // Invalidate any cached packs for this tenant and environment across the system
    BusinessPackLoader.invalidateAll(tenantId, environmentId);

    return { release: pack, checksum, revision };
  });
}

/**
 * Rolls back tenant active pointer to the previous version with atomic CAS and transaction.
 */
export async function rollbackBusinessPack(
  db: Db,
  tenantId: string,
  environmentId = 'production',
  options: RollbackOptions = {}
): Promise<{ activeVersion: string; previousVersion: string; revision: number }> {
  return runWithTransaction(db, options, async (session) => {
    const sessionOpts = session ? { session } : undefined;

    const pointersCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
    const pointer = await pointersCol.findOne({ tenantId, environmentId }, sessionOpts);

    if (!pointer) {
      throw new Error(
        `[BusinessPackPublisher] Rollback failed: no pointer found for tenant '${tenantId}' (${environmentId})`
      );
    }

    const targetVersion = options.targetVersion || pointer.previousVersion;
    if (!targetVersion) {
      throw new Error(
        `[BusinessPackPublisher] Rollback failed: tenant '${tenantId}' (${environmentId}) has no previous version to roll back to`
      );
    }

    // Ensure target release exists and has valid checksum matching content
    const releasesCol = db.collection(COLLECTION_BUSINESS_PACK_RELEASES);
    const targetRelease = await releasesCol.findOne({ tenantId, environmentId, version: targetVersion }, sessionOpts);
    if (!targetRelease) {
      throw new Error(
        `[BusinessPackPublisher] Rollback failed: target release version '${targetVersion}' does not exist for tenant '${tenantId}'`
      );
    }

    // Authoritative verifier: envelope, legacy normalization, schema, semantics, checksum and
    // identity (tenant/environment/version) are all enforced before the pointer is touched.
    const verification = tryVerifyPersistedBusinessPackRelease(targetRelease, {
      tenantId,
      environmentId,
      version: targetVersion,
    });
    if (verification.ok === false) {
      throw new BusinessPackRollbackError(
        verification.error.reason,
        `[BusinessPackPublisher] Rollback failed: target release '${targetVersion}' for tenant '${tenantId}' (${environmentId}) rejected: ${verification.error.message}`
      );
    }
    const verifiedChecksum = verification.release.checksum;

    const expectedRevision = pointer.revision;
    const nextRevision = expectedRevision + 1;
    const now = new Date();
    const rolledBackBy = options.rolledBackBy || UNATTRIBUTED_PRINCIPAL;

    const casResult = await pointersCol.updateOne(
      { tenantId, environmentId, revision: expectedRevision },
      {
        $set: {
          activeVersion: targetVersion,
          activeVersionId: targetVersion,
          status: 'active',
          previousVersion: pointer.activeVersion,
          revision: nextRevision,
          rollbackAvailable: true,
          promotedAt: now,
          promotedBy: rolledBackBy,
          checksum: verifiedChecksum,
          notes: options.reason || `Rolled back to ${targetVersion}`,
        },
        $push: {
          history: {
            $each: [
              {
                version: targetVersion,
                checksum: verifiedChecksum,
                revision: nextRevision,
                action: 'rolled_back',
                promotedAt: now,
                promotedBy: rolledBackBy,
                notes: options.reason,
              },
            ],
            $slice: -20,
          },
        } as any,
      },
      sessionOpts
    );

    if (casResult.matchedCount === 0) {
      throw new Error(
        `[BusinessPackPublisher] CAS rollback conflict: pointer for tenant '${tenantId}' was concurrently modified`
      );
    }

    // Synchronize durable release activation record (tenant_cutovers) on rollback if present
    const cutoversCol = db.collection(COLLECTION_TENANT_CUTOVERS);
    const existingCutover = await cutoversCol.findOne({ tenantId, environmentId }, sessionOpts);
    if (existingCutover) {
      await cutoversCol.updateOne(
        { tenantId, environmentId },
        {
          $set: {
            approvedReleaseVersion: targetVersion,
            approvedReleaseChecksum: verifiedChecksum,
            status: existingCutover.status === 'canary' ? 'canary' : 'migrated',
            promotedAt: now,
            promotedBy: rolledBackBy,
            updatedAt: now,
          },
        },
        sessionOpts
      );
    }

    const outboxCol = db.collection(COLLECTION_OUTBOX_EVENTS);
    await outboxCol.insertOne(
      {
        eventId: `evt_${randomUUID()}`,
        tenantId,
        environmentId,
        eventType: 'business_pack.rolled_back',
        payload: {
          tenantId,
          environmentId,
          activeVersion: targetVersion,
          previousVersion: pointer.activeVersion,
          checksum: verifiedChecksum,
          revision: nextRevision,
          rolledBackBy,
          reason: options.reason,
          rolledBackAt: now.toISOString(),
        },
        status: 'pending',
        attempts: 0,
        createdAt: now,
      },
      sessionOpts
    );

    // Invalidate any cached packs for this tenant and environment across the system
    BusinessPackLoader.invalidateAll(tenantId, environmentId);

    return {
      activeVersion: targetVersion,
      previousVersion: pointer.activeVersion,
      revision: nextRevision,
    };
  });
}
