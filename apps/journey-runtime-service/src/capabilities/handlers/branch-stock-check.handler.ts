import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface BranchStockCheckInput {
  sku?: string;
  branch?: string;
  skus?: string[];
}

export class BranchStockCheckHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryStock?: Record<string, any>) {}

  async execute(input: BranchStockCheckInput, ctx: ExecutionContext): Promise<any> {
    const branch = input.branch;
    const sku = input.sku || input.skus?.[0];

    if (!sku || !branch) {
      return {
        branch: branch || '',
        sku: sku || '',
        inStock: false,
        quantity: 0,
        status: 'Unavailable',
        fulfillmentType: 'unavailable',
        confirmedAt: new Date().toISOString(),
        error: 'Branch and SKU are required for stock check',
      };
    }

    if (this.inMemoryStock) {
      const stock = this.inMemoryStock[sku];
      if (!stock) {
        return {
          branch,
          sku,
          inStock: false,
          quantity: 0,
          status: 'Out of Stock',
          fulfillmentType: 'unavailable',
          confirmedAt: new Date().toISOString(),
        };
      }
      return {
        branch,
        sku,
        inStock: stock.inStock !== false,
        quantity: stock.quantity ?? 0,
        fulfillmentType: stock.fulfillmentType || 'standard_collection',
        confirmedAt: new Date().toISOString(),
      };
    }

    // Production handler queries tenant-scoped inventory connector
    const productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    try {
      const url = `${productServiceUrl}/api/v1/${encodeURIComponent(ctx.tenantId)}/products/inventory?sku=${encodeURIComponent(sku)}&branch=${encodeURIComponent(branch)}`;
      const res = await fetch(url, { headers: { 'x-tenant-id': ctx.tenantId } });
      if (!res.ok) {
        return {
          branch,
          sku,
          inStock: false,
          quantity: 0,
          status: 'Unavailable',
          fulfillmentType: 'unavailable',
          confirmedAt: new Date().toISOString(),
          error: `Connector returned HTTP ${res.status}`,
        };
      }
      const data: any = await res.json();
      const bInfo = Array.isArray(data.branches)
        ? data.branches.find((b: any) => b.branchName === branch || b.branchCode === branch)
        : null;
      return {
        branch,
        sku,
        inStock: bInfo ? Boolean(bInfo.inStock ?? (bInfo.stockQty > 0)) : false,
        quantity: bInfo?.stockQty ?? 0,
        fulfillmentType: bInfo?.clickAndCollectReady ? 'click_and_collect' : 'standard_delivery',
        confirmedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        branch,
        sku,
        inStock: false,
        quantity: 0,
        status: 'Unavailable',
        fulfillmentType: 'unavailable',
        confirmedAt: new Date().toISOString(),
        error: err.message || 'Inventory connector unavailable',
      };
    }
  }
}
