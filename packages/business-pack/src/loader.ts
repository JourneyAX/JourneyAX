import { BusinessPackRelease } from './schemas/business-pack.schema';
import { tryVerifyPersistedBusinessPackRelease } from './release-verifier';

const COLLECTION_BUSINESS_PACK_RELEASES = 'business_pack_releases';
const COLLECTION_BUSINESS_PACK_POINTERS = 'business_pack_pointers';

function getNodeModules(): { mongodb: any } {
  if (typeof window !== 'undefined') {
    return { mongodb: null };
  }
  try {
    const globalObj = globalThis as any;
    const req = typeof globalObj.__non_webpack_require__ !== 'undefined'
      ? globalObj.__non_webpack_require__
      : eval('require');
    let mongodb = null;
    try {
      mongodb = req('mongodb');
    } catch {
      // mongodb package not available in client environment
    }
    return { mongodb };
  } catch {
    return { mongodb: null };
  }
}

export interface PackLoaderOptions {
  mongoDbUri?: string;
  db?: any;
}

export interface VerifiedBusinessPackMetadata {
  tenantId: string;
  environmentId: string;
  version: string;
  checksum: string;
}

const VERIFIED_RELEASE_METADATA = Symbol.for('@journeyax/business-pack/verified-release-metadata');

/**
 * Reads verifier-produced metadata without adding envelope fields to checksum-bearing content.
 * The property is non-enumerable, so serialization and checksum computation remain unchanged.
 */
export function getVerifiedBusinessPackMetadata(
  pack: BusinessPackRelease
): VerifiedBusinessPackMetadata | undefined {
  return (pack as any)?.[VERIFIED_RELEASE_METADATA];
}

function attachVerifiedMetadata(
  pack: BusinessPackRelease,
  metadata: VerifiedBusinessPackMetadata
): BusinessPackRelease {
  Object.defineProperty(pack, VERIFIED_RELEASE_METADATA, {
    value: Object.freeze({ ...metadata }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return pack;
}

export class BusinessPackLoader {
  private static activeInstances = new Set<BusinessPackLoader>();
  private cache = new Map<string, { pack: BusinessPackRelease; loadedAt: number }>();
  private cacheTtlMs = 60_000 * 5; // 5 minutes cache for published versions

  constructor(private options: PackLoaderOptions = {}) {
    BusinessPackLoader.activeInstances.add(this);
  }

  /**
   * Invalidate cached releases across all active loader instances.
   */
  static invalidateAll(tenantId?: string, environmentId?: string): void {
    for (const inst of BusinessPackLoader.activeInstances) {
      inst.invalidate(tenantId, environmentId);
    }
  }

  /**
   * Loads an immutable published Business Pack by tenantId and optional version.
   * If version is omitted, loads the currently active release for the specified environment.
   *
   * Database-only published release loader:
   * Backoffice draft -> validation/compiler -> immutable database release -> active pointer -> runtime
   *
   * Fails closed if the pointer or release is missing or invalid.
   * Never inspects the filesystem.
   * Never silently falls back to migration data.
   */
  async loadPublished(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production' = 'production',
    version?: string
  ): Promise<BusinessPackRelease> {
    const cacheKey = `${tenantId}:${environmentId}:${version || 'latest'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.pack;
    }

    // 1. Authoritative lookup from MongoDB business_pack_releases & pointers
    const mongoPack = await this.loadFromMongo(tenantId, environmentId, version);
    if (mongoPack) {
      this.cache.set(cacheKey, { pack: mongoPack, loadedAt: Date.now() });
      return mongoPack;
    }

    // Fail closed: No filesystem fallback permitted
    throw new Error(
      `[BusinessPackLoader] No published Business Pack found for tenant='${tenantId}', env='${environmentId}', version='${version || 'latest'}'`
    );
  }

  /**
   * Loads the exact immutable release pinned to an existing workspace.
   * This deliberately does not consult the active pointer: promotions affect new
   * workspaces only. Withdrawn/revoked or checksum-mismatched releases fail closed.
   */
  async loadPinned(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production',
    version: string,
    checksum: string
  ): Promise<BusinessPackRelease> {
    const normalizedChecksum = (checksum || '').trim();
    if (!version || !normalizedChecksum) {
      throw new Error('[BusinessPackLoader] Pinned version and checksum are required');
    }
    const cacheKey = `${tenantId}:${environmentId}:${version}:${normalizedChecksum}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) return cached.pack;

    const pack = await this.loadFromMongo(tenantId, environmentId, version, normalizedChecksum);
    if (!pack) {
      throw new Error(
        `[BusinessPackLoader] Pinned Business Pack unavailable or invalid for tenant='${tenantId}', env='${environmentId}', version='${version}'`
      );
    }
    this.cache.set(cacheKey, { pack, loadedAt: Date.now() });
    return pack;
  }

  /**
   * Loads the pack directly from MongoDB collections.
   */
  async loadFromMongo(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production',
    version?: string,
    expectedChecksum?: string
  ): Promise<BusinessPackRelease | null> {
    let db: any;

    if (this.options.db) {
      db = this.options.db;
    } else {
      const { mongodb } = getNodeModules();
      if (!mongodb) return null;

      const uri = this.options.mongoDbUri || process.env.MONGODB_URI;
      if (!uri) return null;

      try {
        const client = new mongodb.MongoClient(uri);
        await client.connect();
        db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');
      } catch (err: any) {
        console.warn(`[BusinessPackLoader] Mongo connection error for '${tenantId}':`, err.message);
        return null;
      }
    }

    try {
      let targetVersion = version;
      let pointerChecksum: string | undefined = expectedChecksum?.trim();

      if (expectedChecksum !== undefined && !pointerChecksum) {
        console.error(
          `[BusinessPackLoader] Pinned checksum for '${tenantId}' (${environmentId}) v${version || '<missing>'} is blank`
        );
        return null;
      }

      if (!targetVersion) {
        // Resolve active pointer from business_pack_pointers
        const pointerCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
        const pointer = await pointerCol.findOne({ tenantId, environmentId });
        const activeVersion = pointer?.activeVersionId || pointer?.activeVersion;
        if (activeVersion) {
          targetVersion = String(activeVersion);
          pointerChecksum = typeof pointer?.checksum === 'string' ? pointer.checksum.trim() : '';
          if (!pointerChecksum) {
            console.error(
              `[BusinessPackLoader] Active pointer for '${tenantId}' (${environmentId}) lacks a mandatory checksum`
            );
            return null;
          }
        }
      }

      if (!targetVersion) return null;

      const releasesCol = db.collection(COLLECTION_BUSINESS_PACK_RELEASES);
      const releaseDoc = await releasesCol.findOne(
        { tenantId, environmentId, version: targetVersion },
        { projection: { _id: 0 } }
      );

      if (!releaseDoc) return null;

      // Authoritative verifier: envelope, legacy normalization, schema, semantics, checksum,
      // pointer agreement and tenant/environment/version identity. Fail closed (null) on any error.
      const verification = tryVerifyPersistedBusinessPackRelease(releaseDoc, {
        tenantId,
        environmentId,
        version: targetVersion,
        pointerChecksum,
      });
      if (verification.ok === false) {
        console.error(
          `[BusinessPackLoader] Release rejected (${verification.error.reason}) for '${tenantId}' (${environmentId}) v${targetVersion}: ${verification.error.message}`
        );
        return null;
      }
      const parsed = {
        data: attachVerifiedMetadata(verification.release.content, {
          tenantId,
          environmentId,
          version: targetVersion,
          checksum: verification.release.checksum,
        }),
      };
      const rawChecksum = verification.release.checksum;

      // Sanitized audit logging (never logs secrets)
      const modelPolicyId =
        (parsed.data.modelPolicy as any)?.id ||
        parsed.data.modelPolicy?.defaultPolicy ||
        'unspecified';
      console.log(
        `[BusinessPackLoader] Loaded active release: source=database tenant='${tenantId}' env='${environmentId}' version='${targetVersion}' checksum='${rawChecksum.slice(0, 16)}...' modelPolicyId='${modelPolicyId}'`
      );

      return parsed.data;
    } catch (err: any) {
      console.warn(`[BusinessPackLoader] Mongo load error for '${tenantId}':`, err.message);
      return null;
    }
  }

  /**
   * Invalidate cached releases (e.g. on business_pack.published or rollback event)
   */
  invalidate(tenantId?: string, environmentId?: string): void {
    if (!tenantId) {
      this.cache.clear();
      return;
    }
    const prefix = environmentId ? `${tenantId}:${environmentId}:` : `${tenantId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) || (!environmentId && key.startsWith(`${tenantId}:`))) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Asynchronously checks whether a published pack exists in cache or in MongoDB pointers.
   */
  async hasPublishedPackAsync(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production' = 'production'
  ): Promise<boolean> {
    const cacheKey = `${tenantId}:${environmentId}:latest`;
    if (this.cache.has(cacheKey)) return true;

    if (this.options.db) {
      try {
        const pointerCol = this.options.db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
        const pointer = await pointerCol.findOne({ tenantId, environmentId });
        return Boolean(
          (pointer?.activeVersionId || pointer?.activeVersion) &&
          typeof pointer?.checksum === 'string' &&
          pointer.checksum.trim()
        );
      } catch (err: any) {
        console.warn(`[BusinessPackLoader] MongoDB pointer check warning for '${tenantId}':`, err.message);
        return false;
      }
    } else {
      const { mongodb } = getNodeModules();
      const uri = this.options.mongoDbUri || process.env.MONGODB_URI;
      if (mongodb && uri) {
        try {
          const client = new mongodb.MongoClient(uri);
          await client.connect();
          const db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');
          const pointerCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
          const pointer = await pointerCol.findOne({ tenantId, environmentId });
          return Boolean(
            (pointer?.activeVersionId || pointer?.activeVersion) &&
            typeof pointer?.checksum === 'string' &&
            pointer.checksum.trim()
          );
        } catch (err: any) {
          console.warn(`[BusinessPackLoader] MongoDB pointer check warning for '${tenantId}':`, err.message);
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Synchronously checks whether a published pack is present in memory cache.
   */
  hasPublishedPack(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production' = 'production'
  ): boolean {
    const cacheKey = `${tenantId}:${environmentId}:latest`;
    return this.cache.has(cacheKey);
  }
}
