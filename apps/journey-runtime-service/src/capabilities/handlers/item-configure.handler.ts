import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export interface ItemConfigureInput {
  itemId?: string;
  sku?: string;
  category?: string;
  quantity?: number;
  options?: Record<string, any>;
}

export interface ItemConfiguratorAdapter {
  configureItem(input: ItemConfigureInput, ctx: ExecutionContext): Promise<any>;
}

export class ItemConfigureHandler implements NativeCapabilityHandler {
  constructor(
    private readonly configuratorAdapter?: ItemConfiguratorAdapter,
    private readonly inMemoryCatalog?: any[]
  ) {}

  async execute(input: ItemConfigureInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const itemId = input.itemId || input.sku;

    if (!itemId) {
      throw new Error('[ItemConfigureHandler] itemId or sku is required for item configuration');
    }

    // 1. Explicitly configured tenant-scoped configurator adapter
    if (this.configuratorAdapter) {
      return this.configuratorAdapter.configureItem(input, ctx);
    }

    // 2. Injected test fixture catalog
    if (this.inMemoryCatalog) {
      const item = this.inMemoryCatalog.find((it) => it.sku === itemId || it.itemId === itemId);
      if (!item) {
        throw new Error(`[ItemConfigureHandler] Item '${itemId}' not found in catalog snapshot`);
      }
      return {
        configuredItem: {
          itemId,
          options: input.options || {},
          status: 'configured',
          configuredAt: new Date().toISOString(),
        },
        status: 'success',
      };
    }

    // 3. Durable, authoritative platform repository
    const uri = process.env.MONGODB_URI;
    if (uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const item = await db.collection(COLLECTION_PRODUCTS).findOne({
        projectId: tenantId,
        $or: [{ sku: itemId }, { parentSku: itemId }, { id: itemId }],
      });

      if (!item) {
        throw new Error(`[ItemConfigureHandler] SKU '${itemId}' does not exist in catalog for tenant '${tenantId}'`);
      }

      return {
        configuredItem: {
          itemId,
          title: item.title || item.name,
          options: input.options || {},
          status: 'configured',
          configuredAt: new Date().toISOString(),
        },
        status: 'success',
      };
    }

    // 4. Missing bindings must fail closed
    throw new Error(
      `[ItemConfigureHandler] Missing authoritative configurator adapter or item repository for tenant '${tenantId}' - failing closed`
    );
  }
}
