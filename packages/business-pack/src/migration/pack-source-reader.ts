import * as fs from 'fs';
import * as path from 'path';
import { BusinessPackRelease, BusinessPackReleaseSchema } from '../schemas/business-pack.schema';
import { validateBusinessPack } from '../validator';

export interface MigrationReaderOptions {
  sourceDir: string;
  expectedTenantId?: string;
  environmentId?: 'dev' | 'test' | 'staging' | 'production';
}

/**
 * MigrationPackSourceReader
 *
 * Dedicated CLI-only migration tooling reader for ingesting legacy filesystem pack directories.
 * Strictly isolated from runtime request paths.
 *
 * Enforces:
 * 1. Explicit sourceDir parameter must be supplied (no implicit defaults, no process.env discovery).
 * 2. Source directory must physically exist.
 * 3. Validation against BusinessPackReleaseSchema and domain validators.
 */
export class MigrationPackSourceReader {
  /**
   * Reads a legacy pack directory from an explicit filesystem path.
   * Throws if sourceDir is omitted, non-existent, or invalid.
   */
  static readPackFromExplicitDir(options: MigrationReaderOptions): BusinessPackRelease {
    const { sourceDir, expectedTenantId, environmentId = 'production' } = options;

    if (!sourceDir || typeof sourceDir !== 'string' || sourceDir.trim().length === 0) {
      throw new Error(
        '[MigrationPackSourceReader] An explicit external sourceDir must be provided. Implicit filesystem discovery is forbidden.'
      );
    }

    const resolvedPath = path.resolve(sourceDir.trim());
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `[MigrationPackSourceReader] Specified source directory does not exist: '${resolvedPath}'`
      );
    }

    const manifestPath = path.join(resolvedPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `[MigrationPackSourceReader] No manifest.json found in specified directory: '${resolvedPath}'`
      );
    }

    let rawManifest: any;
    try {
      rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err: any) {
      throw new Error(
        `[MigrationPackSourceReader] Failed to parse manifest.json at '${manifestPath}': ${err.message}`
      );
    }

    if (expectedTenantId && rawManifest.tenantId !== expectedTenantId) {
      throw new Error(
        `[MigrationPackSourceReader] Tenant mismatch: expected '${expectedTenantId}', found '${rawManifest.tenantId}' in '${manifestPath}'`
      );
    }

    const tenantId = rawManifest.tenantId;

    const readJson = (file: string, fallback: any = {}) => {
      const p = path.join(resolvedPath, file);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
    };

    const readJsonArray = (dirName: string) => {
      const dir = path.join(resolvedPath, dirName);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    };

    const modelPolicy = readJson('model-policy.json', null);
    if (!modelPolicy) {
      throw new Error(
        `[MigrationPackSourceReader] Mandatory 'model-policy.json' is missing in '${resolvedPath}'`
      );
    }

    const candidate = {
      manifest: {
        ...rawManifest,
        environmentId: rawManifest.environmentId || environmentId,
      },
      profile: readJson('business-profile.json', { companyName: tenantId, industry: 'General' }),
      vocabulary: readJson('vocabulary.json', { terms: [], acronyms: {}, slotSynonyms: {} }),
      entities: readJson('entities.json', { entities: [] }),
      conversationPolicy: readJson('conversation-policy.json', {}),
      modelPolicy,
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
      extensions: {
        ...(readJson('extensions/space-planner.json', null)
          ? { spacePlanner: readJson('extensions/space-planner.json', null) }
          : readJson('experience/space-planner.json', null)
          ? { spacePlanner: readJson('experience/space-planner.json', null) }
          : {}),
        ...readJson('extensions.json', {}),
      },
    };

    const parsed = BusinessPackReleaseSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `[MigrationPackSourceReader] Schema validation failed for '${tenantId}' from '${resolvedPath}': ${JSON.stringify(
          parsed.error.format()
        )}`
      );
    }

    const validation = validateBusinessPack(parsed.data);
    if (!validation.valid) {
      const errors = validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `[${i.path}] ${i.message}`)
        .join('; ');
      throw new Error(
        `[MigrationPackSourceReader] Domain validation failed for '${tenantId}' from '${resolvedPath}': ${errors}`
      );
    }

    return parsed.data;
  }
}
