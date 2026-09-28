import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface BranchStockCheckInput {
  sku?: string;
  branch?: string;
  skus?: string[];
}

export class BranchStockCheckHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryStock?: Record<string, any>) {}

  async execute(input: BranchStockCheckInput, ctx: ExecutionContext): Promise<any> {
    const branch = input.branch || 'Mt Wellington';
    const sku = input.sku || input.skus?.[0] || 'GENERAL-SKU';

    const stock = this.inMemoryStock?.[sku] || {
      inStock: true,
      quantity: 48,
      leadTimeMinutes: 60,
    };

    return {
      branch,
      sku,
      inStock: stock.inStock !== false,
      quantity: stock.quantity ?? 48,
      fulfillmentType: '60_minute_click_and_collect',
      confirmedAt: new Date().toISOString(),
    };
  }
}
