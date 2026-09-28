import { BusinessPackLoader } from './loader';
import { BusinessPackRelease } from './schemas/business-pack.schema';
import { EnvironmentId } from '@journeyax/journey-core';

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

function resolveDefaultPacksRoot(): string {
  if (typeof process !== 'undefined' && process.env?.PACKS_ROOT) {
    return process.env.PACKS_ROOT;
  }
  const { fs, path } = getNodeModules();
  if (!fs || !path || typeof process === 'undefined') {
    return '';
  }
  const candidates = [
    path.resolve(process.cwd(), 'packs'),
    path.resolve(process.cwd(), '..', '..', 'packs'),
    path.resolve(__dirname, '..', '..', '..', 'packs'),
    path.resolve(__dirname, '..', '..', '..', '..', 'packs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore filesystem check errors
    }
  }
  return path.resolve(process.cwd(), 'packs');
}

export class PackRepository {
  private loader: BusinessPackLoader;

  constructor(packsRoot?: string, db?: any) {
    this.loader = new BusinessPackLoader({
      localPacksRoot: packsRoot || resolveDefaultPacksRoot(),
      db,
    });
  }

  async loadActivePack(
    tenantId: string,
    environmentId: EnvironmentId = 'production',
    version?: string
  ): Promise<BusinessPackRelease> {
    return this.loader.loadPublished(tenantId, environmentId, version);
  }

  async hasActivePack(
    tenantId: string,
    environmentId: EnvironmentId = 'production'
  ): Promise<boolean> {
    return this.loader.hasPublishedPackAsync(tenantId, environmentId);
  }

  invalidate(tenantId?: string): void {
    this.loader.invalidate(tenantId);
  }
}
