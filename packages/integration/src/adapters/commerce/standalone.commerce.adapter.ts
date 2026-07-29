/**
 * StandaloneCommerceAdapter — the DEFAULT commerce backend.
 *
 * Implements CommercePort by calling JourneyAX's OWN internal `product-service`
 * (RAG search over Mongo). This is `PLATFORM_MODE=standalone`: brands with no
 * external commerce platform run entirely on JourneyAX.
 *
 * This is the adapter the agent uses TODAY (it just calls product-service
 * directly right now — this class is where that call belongs so the agent stops
 * knowing service URLs).
 *
 * TODO: move the raw fetch currently in agent.service.ts into `searchProducts`
 * here, and have the agent depend on CommercePort instead.
 */
import {
  AdapterContext,
  AdapterMeta,
  CommercePort,
  Money,
  ProductRef,
  ProductSearchQuery,
} from '../../ports';

export class StandaloneCommerceAdapter implements CommercePort {
  readonly meta: AdapterMeta = { domain: 'commerce', platform: 'standalone' };

  constructor(
    private readonly productServiceUrl = process.env.PRODUCT_SERVICE_URL ||
      'http://localhost:8083',
  ) {}

  async searchProducts(ctx: AdapterContext, q: ProductSearchQuery): Promise<ProductRef[]> {
    const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
      body: JSON.stringify({
        query: q.query,
        brand: ctx.tenantId,
        type: q.type,
        category: q.category,
        limit: q.limit ?? 8,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // product-service returns { found, results:[{ sku,title,price,specs,imageUrl,url,... }] }
    return (data.results ?? []).map((r: any): ProductRef => ({
      sku: r.sku,
      name: r.title,
      category: r.type,
      collection: r.collection,
      price: r.price != null ? this.toMoney(r.price) : undefined,
      imageUrl: r.imageUrl,
      specs: r.specs,
      url: r.url,
    }));
  }

  async getProduct(ctx: AdapterContext, sku: string): Promise<ProductRef | null> {
    const results = await this.searchProducts(ctx, { query: sku, limit: 1 });
    return results[0] ?? null;
  }

  async getPricing(_ctx: AdapterContext, _sku: string): Promise<Money> {
    // Standalone pricing lives in the product record; contract pricing is N/A here.
    // TODO: read from catalog once pricing is authoritative in Mongo.
    return { amountCents: 0, currency: 'AUD' };
  }

  async checkInventory(_ctx: AdapterContext, _sku: string) {
    // Standalone has no live stock feed yet.
    return { inStock: true };
  }

  async createCart(_ctx: AdapterContext, _items: { sku: string; quantity: number }[]) {
    // TODO: persist a cart in the (future) order-service.
    return { cartId: `CART-${Date.now()}` };
  }

  async createCheckout(_ctx: AdapterContext, cartId: string) {
    // TODO: hand off to payment adapter; standalone returns an internal checkout.
    return { checkoutUrl: `/checkout/${cartId}` };
  }

  /** AUD dollars (float, from legacy catalog) → integer cents. */
  private toMoney(dollars: number): Money {
    return { amountCents: Math.round(dollars * 100), currency: 'AUD' };
  }
}
