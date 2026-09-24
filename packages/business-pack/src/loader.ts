import { BusinessPackRelease, BusinessPackReleaseSchema } from './schemas/business-pack.schema';
import { validateBusinessPack } from './validator';
import { computePackChecksum } from './publisher';

const COLLECTION_BUSINESS_PACK_RELEASES = 'business_pack_releases';
const COLLECTION_BUSINESS_PACK_POINTERS = 'business_pack_pointers';

function getNodeModules(): { fs: any; path: any; mongodb: any } {
  if (typeof window !== 'undefined') {
    return { fs: null, path: null, mongodb: null };
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
    return { fs: req('fs'), path: req('path'), mongodb };
  } catch {
    return { fs: null, path: null, mongodb: null };
  }
}

export interface PackLoaderOptions {
  mongoDbUri?: string;
  localPacksRoot?: string;
  db?: any;
}

export class BusinessPackLoader {
  private cache = new Map<string, { pack: BusinessPackRelease; loadedAt: number }>();
  private cacheTtlMs = 60_000 * 5; // 5 minutes cache for published versions

  constructor(private options: PackLoaderOptions = {}) {}

  /**
   * Loads an immutable published Business Pack by tenantId and optional version.
   * If version is omitted, loads the currently active release for the specified environment.
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

    // 1. Try loading from MongoDB business_pack_releases & pointers
    const mongoPack = await this.loadFromMongo(tenantId, environmentId, version);
    if (mongoPack) {
      this.cache.set(cacheKey, { pack: mongoPack, loadedAt: Date.now() });
      return mongoPack;
    }

    // 2. Fall back to local filesystem ONLY in non-production development/test environments
    if (process.env.NODE_ENV !== 'production') {
      const pack = await this.loadFromDisk(tenantId, environmentId, version);
      if (pack) {
        this.cache.set(cacheKey, { pack, loadedAt: Date.now() });
        return pack;
      }
    }

    throw new Error(
      `[BusinessPackLoader] No published Business Pack found for tenant='${tenantId}', env='${environmentId}', version='${version || 'latest'}'`
    );
  }

  /**
   * Loads the pack directly from MongoDB collections.
   */
  async loadFromMongo(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production',
    version?: string
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

      if (!targetVersion) {
        // Resolve active pointer from business_pack_pointers
        const pointerCol = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
        const pointer = await pointerCol.findOne({ tenantId, environmentId });
        if (pointer?.activeVersion) {
          targetVersion = pointer.activeVersion;
        }
      }

      if (!targetVersion) return null;

      const releasesCol = db.collection(COLLECTION_BUSINESS_PACK_RELEASES);
      const releaseDoc = await releasesCol.findOne(
        { tenantId, environmentId, version: targetVersion },
        { projection: { _id: 0 } }
      );

      if (!releaseDoc) return null;

      const parsed = BusinessPackReleaseSchema.safeParse(releaseDoc);
      if (!parsed.success) {
        console.error(`[BusinessPackLoader] Schema mismatch in Mongo release for '${tenantId}':`, parsed.error.format());
        return null;
      }

      // Checksum integrity check: verify release document has mandatory non-blank checksum and matches content
      const rawChecksum = typeof releaseDoc.checksum === 'string' ? releaseDoc.checksum.trim() : '';
      if (!rawChecksum) {
        console.error(
          `[BusinessPackLoader] Mandatory release checksum missing or blank for Mongo release '${tenantId}' (${environmentId}) v${targetVersion}`
        );
        return null;
      }

      const computed = computePackChecksum(parsed.data);
      if (computed !== rawChecksum) {
        console.error(
          `[BusinessPackLoader] Checksum mismatch for '${tenantId}' (${environmentId}) v${targetVersion}: record='${rawChecksum}' computed='${computed}'`
        );
        return null;
      }

      const validation = validateBusinessPack(parsed.data);
      if (!validation.valid) {
        console.error(`[BusinessPackLoader] Validation failed for Mongo release '${tenantId}':`, validation.issues);
        return null;
      }

      return parsed.data;
    } catch (err: any) {
      console.warn(`[BusinessPackLoader] Mongo load error for '${tenantId}':`, err.message);
      return null;
    }
  }

  /**
   * Invalidate cached releases (e.g. on config.published event)
   */
  invalidate(tenantId?: string): void {
    if (!tenantId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Asynchronously checks whether a published pack exists in cache, in MongoDB pointers, or on disk (dev).
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
        if (pointer?.activeVersion) {
          return true;
        }
      } catch (err: any) {
        console.warn(`[BusinessPackLoader] MongoDB pointer check warning for '${tenantId}':`, err.message);
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
          if (pointer?.activeVersion) {
            return true;
          }
        } catch (err: any) {
          console.warn(`[BusinessPackLoader] MongoDB pointer check warning for '${tenantId}':`, err.message);
        }
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      return this.hasPublishedPack(tenantId, environmentId);
    }
    return false;
  }

  /**
   * Synchronously checks whether a published pack is cached (or present on disk in local development).
   */
  hasPublishedPack(
    tenantId: string,
    environmentId: 'dev' | 'test' | 'staging' | 'production' = 'production'
  ): boolean {
    const cacheKey = `${tenantId}:${environmentId}:latest`;
    if (this.cache.has(cacheKey)) return true;

    // In production, Docker containers do not ship packs/ directory; do not fall back to disk
    if (process.env.NODE_ENV === 'production') {
      return false;
    }

    const { fs, path } = getNodeModules();
    if (!fs || !path) return false;

    const searchDirs = [
      this.options.localPacksRoot,
      path.resolve(process.cwd(), 'packs', tenantId),
      path.resolve(process.cwd(), '..', '..', 'packs', tenantId),
      path.resolve(__dirname, '..', '..', '..', 'packs', tenantId),
    ].filter(Boolean) as string[];

    for (const baseDir of searchDirs) {
      const manifestPath = path.join(baseDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (rawManifest.tenantId === tenantId) {
            return true;
          }
        } catch {
          // ignore corrupted files in check
        }
      }
    }
    return false;
  }

  /**
   * Loads pack candidate from local disk (development / initial seeding fallback)
   */
  async loadFromDisk(
    tenantId: string,
    environmentId: string,
    version?: string
  ): Promise<BusinessPackRelease | null> {
    const { fs, path } = getNodeModules();
    if (!fs || !path) return null;

    const searchDirs = [
      this.options.localPacksRoot,
      path.resolve(process.cwd(), 'packs', tenantId),
      path.resolve(process.cwd(), '..', '..', 'packs', tenantId),
      path.resolve(__dirname, '..', '..', '..', 'packs', tenantId),
    ].filter(Boolean) as string[];

    for (const baseDir of searchDirs) {
      const manifestPath = path.join(baseDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        if (rawManifest.tenantId !== tenantId) {
          continue;
        }
        if (rawManifest.environmentId && rawManifest.environmentId !== environmentId) {
          continue;
        }
        if (version && rawManifest.version !== version) {
          continue;
        }

        const readJson = (file: string, fallback: any = {}) => {
          const p = path.join(baseDir, file);
          return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
        };

        const readJsonArray = (dirName: string) => {
          const dir = path.join(baseDir, dirName);
          if (!fs.existsSync(dir)) return [];
          return fs
            .readdirSync(dir)
            .filter((f: string) => f.endsWith('.json'))
            .map((f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        };

        const packCandidate = {
          manifest: rawManifest,
          profile: readJson('business-profile.json', { companyName: tenantId, industry: 'General' }),
          vocabulary: readJson('vocabulary.json', { terms: [], acronyms: {}, slotSynonyms: {} }),
          entities: readJson('entities.json', { entities: [] }),
          conversationPolicy: readJson('conversation-policy.json', {}),
          modelPolicy: readJson('model-policy.json', {
            policies: [
              {
                policyId: 'standard_turn',
                candidates: [{ provider: 'openai', model: 'gpt-4o-mini', priority: 1 }],
                dataResidency: 'au',
                maxInputTokens: 20000,
                maxOutputTokens: 2000,
                fallbackAllowed: true,
              },
            ],
          }),
          agents: readJsonArray('agents'),
          journeys: readJsonArray('journeys'),
          rules: readJsonArray('rules'),
          capabilities: readJson('capabilities/bindings.json', {
            toolDefinitions: [],
            toolBindings: [],
            stageBindings: [],
          }),
          experience: readJson('experience/cards-and-theme.json', {}),
          evaluations: readJsonArray('evaluations'),
        };

        const parsed = BusinessPackReleaseSchema.safeParse(packCandidate);
        if (!parsed.success) {
          const errorMsg = `[BusinessPackLoader] Schema mismatch loading pack '${tenantId}': ${JSON.stringify(parsed.error.format())}`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }

        const validation = validateBusinessPack(parsed.data);
        if (!validation.valid) {
          const errors = validation.issues
            .filter((i) => i.severity === 'error')
            .map((i) => `[${i.path}] ${i.message}`)
            .join('; ');
          const errorMsg = `[BusinessPackLoader] Validation failed (fail-closed) for pack '${tenantId}': ${errors}`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }

        if (validation.issues.length > 0) {
          console.warn(`[BusinessPackLoader] Validation warnings for pack '${tenantId}':`, validation.issues);
        }

        return parsed.data;
      }
    }

    return null;
  }
}
