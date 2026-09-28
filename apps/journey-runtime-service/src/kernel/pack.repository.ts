import * as path from 'path';
import { BusinessPackLoader, BusinessPackRelease } from '@journeyax/business-pack';
import { EnvironmentId } from '@journeyax/journey-core';

export class PackRepository {
  private loader: BusinessPackLoader;

  constructor(packsRoot?: string, db?: any) {
    this.loader = new BusinessPackLoader({
      localPacksRoot: packsRoot || path.resolve(__dirname, '../../../../packs'),
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
