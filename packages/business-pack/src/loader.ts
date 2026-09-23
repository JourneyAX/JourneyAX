import { BusinessPackRelease, BusinessPackReleaseSchema } from './schemas/business-pack.schema';
import { validateBusinessPack } from './validator';
function getNodeModules(): { fs: any; path: any } {
  if (typeof window !== 'undefined') {
    return { fs: null, path: null };
  }
  try {
    const globalObj = globalThis as any;
    const req = typeof globalObj.__non_webpack_require__ !== 'undefined'
      ? globalObj.__non_webpack_require__
      : eval('require');
    return { fs: req('fs'), path: req('path') };
  } catch {
    return { fs: null, path: null };
  }
}

export interface PackLoaderOptions {
  mongoDbUri?: string;
  localPacksRoot?: string;
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

    // 1. Try local filesystem if configured or exists
    const pack = await this.loadFromDisk(tenantId, environmentId, version);
    if (pack) {
      this.cache.set(cacheKey, { pack, loadedAt: Date.now() });
      return pack;
    }

    throw new Error(
      `[BusinessPackLoader] No published Business Pack found for tenant='${tenantId}', env='${environmentId}', version='${version || 'latest'}'`
    );
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

  private async loadFromDisk(
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
        try {
          const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (version && rawManifest.version !== version) continue;

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
          if (parsed.success) {
            const validation = validateBusinessPack(parsed.data);
            if (validation.valid) {
              return parsed.data;
            } else {
              console.warn(`[BusinessPackLoader] Validation warnings for pack ${tenantId}:`, validation.issues);
              return parsed.data;
            }
          } else {
            console.error(`[BusinessPackLoader] Schema mismatch loading pack ${tenantId}:`, parsed.error.format());
          }
        } catch (e: any) {
          console.warn(`[BusinessPackLoader] Error reading pack from ${baseDir}:`, e.message);
        }
      }
    }

    return null;
  }
}
