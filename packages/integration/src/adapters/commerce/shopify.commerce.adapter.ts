/**
 * ShopifyCommerceAdapter — external commerce platform (skeleton).
 *
 * Implements CommercePort against the Shopify Admin/Storefront API. Selected
 * when a tenant's `integration_connections` sets commerce platform = 'shopify'.
 *
 * This proves the extensibility promise: the agent code is unchanged; only this
 * file knows Shopify exists. Fill each method with real Shopify calls using
 * `ctx.connection` (store URL + token). Everything is stubbed for now.
 */
import {
  AdapterContext,
  AdapterMeta,
  CommercePort,
  Money,
  ProductRef,
  ProductSearchQuery,
} from '../../ports';

export class ShopifyCommerceAdapter implements CommercePort {
  readonly meta: AdapterMeta = { domain: 'commerce', platform: 'shopify' };

  async searchProducts(_ctx: AdapterContext, _q: ProductSearchQuery): Promise<ProductRef[]> {
    // TODO: GET /admin/api/2024-10/products.json?title=... (or Storefront GraphQL search)
    throw new Error('ShopifyCommerceAdapter.searchProducts not implemented');
  }

  async getProduct(_ctx: AdapterContext, _sku: string): Promise<ProductRef | null> {
    // TODO: GET product by handle/variant SKU
    throw new Error('ShopifyCommerceAdapter.getProduct not implemented');
  }

  async getPricing(_ctx: AdapterContext, _sku: string): Promise<Money> {
    // TODO: variant price → integer cents
    throw new Error('ShopifyCommerceAdapter.getPricing not implemented');
  }

  async checkInventory(
    _ctx: AdapterContext,
    _sku: string,
  ): Promise<{ inStock: boolean; quantity?: number }> {
    // TODO: InventoryLevel API
    throw new Error('ShopifyCommerceAdapter.checkInventory not implemented');
  }

  async createCart(
    _ctx: AdapterContext,
    _items: { sku: string; quantity: number }[],
  ): Promise<{ cartId: string }> {
    // TODO: Storefront cartCreate mutation
    throw new Error('ShopifyCommerceAdapter.createCart not implemented');
  }

  async createCheckout(
    _ctx: AdapterContext,
    _cartId: string,
  ): Promise<{ checkoutUrl: string; externalOrderId?: string }> {
    // TODO: return cart.checkoutUrl
    throw new Error('ShopifyCommerceAdapter.createCheckout not implemented');
  }
}
