import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface ItemConfigureInput {
  itemId?: string;
  sku?: string;
  category?: string;
  quantity?: number;
  options?: Record<string, any>;
}

export class ItemConfigureHandler implements NativeCapabilityHandler {
  async execute(input: ItemConfigureInput, ctx: ExecutionContext): Promise<any> {
    const configuredItem = {
      itemId: input.itemId || input.sku || 'item-std-01',
      category: input.category || 'standard',
      quantity: input.quantity ?? 1,
      options: input.options || {},
      status: 'configured',
      configuredAt: new Date().toISOString(),
    };

    return {
      configuredItem,
      status: 'success',
    };
  }
}
