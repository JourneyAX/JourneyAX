import { resolveServiceUrl } from '@journeyax/shared-types';
import sourceStatuses from './branch-stock-statuses.json';
/**
 * Tenant-Scoped Branch Stock & Fulfillment Lookup Service
 *
 * Connects directly to tenant-scoped inventory connectors / catalogue feeds.
 * Never derives stock from an SKU hash.
 * Fails closed on connector outage or missing items (no fabricated stock).
 */

export interface BranchStockInfo {
  branchCode: string;
  branchName: string;
  region: string;
  address?: string;
  phone?: string;
  openingHours?: string;
  stockQty: number;
  status: 'In Stock' | 'Low Stock' | 'Order on Request';
  clickAndCollectReady: boolean;
  collectionTimeframe: string;
  hiabDeliveryAvailable?: boolean;
}

export interface BranchStockResponse {
  ok: boolean;
  sku: string;
  productTitle: string;
  requestedBranch?: string;
  branches: BranchStockInfo[];
  error?: string;
}

export class BranchStockService {

  /**
   * Retrieves real inventory and fulfillment facts for an SKU across tenant branches.
   * Strictly tenant-scoped; never fabricates stock or branches.
   */
  static async getStockForSku(
    tenantId: string,
    sku: string,
    productTitle: string = 'Item',
    preferredBranch?: string
  ): Promise<BranchStockResponse> {
    const tid = (tenantId || '').toLowerCase().trim();
    if (!tid || !sku) {
      return {
        ok: false,
        sku: sku || '',
        productTitle,
        branches: [],
        error: 'TenantId and SKU are required',
      };
    }

    try {
      if (!process.env.PRODUCT_SERVICE_URL) throw new Error('Inventory source is not configured');
      const productServiceUrl = resolveServiceUrl('PRODUCT_SERVICE_URL', process.env.PRODUCT_SERVICE_URL, '');
      const url = `${productServiceUrl}/api/v1/${encodeURIComponent(tid)}/products/inventory?sku=${encodeURIComponent(sku)}${preferredBranch ? `&branch=${encodeURIComponent(preferredBranch)}` : ''}`;
      const res = await fetch(url, {
        headers: { 'x-tenant-id': tid },
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });

      if (!res.ok) {
        return {
          ok: false,
          sku,
          productTitle,
          requestedBranch: preferredBranch,
          branches: [],
          error: `Inventory connector returned HTTP ${res.status}`,
        };
      }

      const data: any = await res.json();
      if (data.sample === true || /demo|sample|fixture/i.test(String(data.source ?? ''))) throw new Error('Demo inventory cannot confirm branch availability');
      if (data.tenantId !== tid || String(data.sku) !== sku || !data.source || !Array.isArray(data.branches)) throw new Error('Inventory source scope or provenance is missing');
      const branches = data.branches.filter((entry: any) => !preferredBranch || entry.branchCode === preferredBranch || entry.branchName === preferredBranch);
      if (!branches.length || branches.some((entry: any) => !Number.isFinite(entry.stockQty) || entry.stockQty < 0 || !sourceStatuses.includes(entry.status) || typeof entry.clickAndCollectReady !== 'boolean' || (entry.clickAndCollectReady && entry.stockQty <= 0))) throw new Error('Verified inventory facts are unavailable');
      return {
        ok: data.ok !== false,
        sku,
        productTitle: data.productTitle || productTitle,
        requestedBranch: preferredBranch,
        branches,
        ...(data.error ? { error: data.error } : {}),
      };
    } catch (err: any) {
      // Outage or network failure: fail closed, never return fabricated stock
      return {
        ok: false,
        sku,
        productTitle,
        requestedBranch: preferredBranch,
        branches: [],
        error: `Inventory connector unavailable: ${err?.message || 'network error'}`,
      };
    }
  }
}
