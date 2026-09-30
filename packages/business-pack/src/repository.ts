import { BusinessPackLoader, PackLoaderOptions } from './loader';
import { BusinessPackRelease } from './schemas/business-pack.schema';
import { EnvironmentId } from '@journeyax/journey-core';

/**
 * PackRepository
 *
 * Runtime repository providing access to published Business Pack releases.
 * Backed strictly by active immutable database releases; never accesses filesystem packs.
 */
export class PackRepository {
  private loader: BusinessPackLoader;

  constructor(dbOrOptions?: any, db?: any) {
    const database =
      dbOrOptions && typeof dbOrOptions.collection === 'function'
        ? dbOrOptions
        : db && typeof db.collection === 'function'
        ? db
        : dbOrOptions && dbOrOptions.db
        ? dbOrOptions.db
        : undefined;

    const mongoDbUri =
      dbOrOptions && typeof dbOrOptions.mongoDbUri === 'string'
        ? dbOrOptions.mongoDbUri
        : undefined;

    this.loader = new BusinessPackLoader({
      db: database,
      mongoDbUri,
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

  invalidate(tenantId?: string, environmentId?: EnvironmentId): void {
    this.loader.invalidate(tenantId, environmentId);
  }
}
