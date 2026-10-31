import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';
import { buildCatalogueBaseFilter, readPath, resolveCatalogMapping } from '@journeyax/business-pack';

export interface CartUpdateInput {
  items?: any[];
  cartId?: string;
  category?: string;
  quantity?: number;
}

export interface CartConnectorAdapter {
  updateCart(input: CartUpdateInput, ctx: ExecutionContext): Promise<any>;
}

export class CartUpdateHandler implements NativeCapabilityHandler {
  constructor(
    private readonly connectorAdapter?: CartConnectorAdapter,
    private readonly inMemoryCarts?: Map<string, any>
  ) {}

  async execute(input: CartUpdateInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;

    // 1. Explicitly configured tenant-scoped connector adapter
    if (this.connectorAdapter) {
      return this.connectorAdapter.updateCart(input, ctx);
    }

    // 2. Injected test fixture repository
    if (this.inMemoryCarts) {
      const cartId = input.cartId || 'default';
      const existing = this.inMemoryCarts.get(cartId);
      const items = Array.isArray(input.items) ? input.items : (existing?.items || []);
      const updated = {
        cartId,
        projectId: tenantId,
        workspaceId: ctx.workspaceId,
        items,
        totalItems: items.reduce((acc: number, it: any) => acc + (Number(it.quantity) || 1), 0),
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      this.inMemoryCarts.set(cartId, updated);
      return { cart: updated, status: 'success' };
    }

    // 3. Durable, authoritative platform repository
    const uri = process.env.MONGODB_URI;
    if (uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const cartId = input.cartId || `cart-${ctx.workspaceId}`;
      const items = Array.isArray(input.items) ? input.items : [];

      // Validate SKUs against authoritative product catalogue
      const skus = items.map((i: any) => i.sku).filter(Boolean);
      if (skus.length > 0) {
        // The tenant's own catalogue mapping says which fields identify a product and which fields mark its owner; nothing is assumed.
        const mapping = resolveCatalogMapping((ctx as any).packSettings?.catalogMapping ?? (ctx as any).release?.catalogMapping);
        const { filter } = buildCatalogueBaseFilter(mapping, tenantId);
        const verified = await db
          .collection(COLLECTION_PRODUCTS)
          .find({ ...filter, $and: [...(filter.$and || []), { $or: mapping.identifierPaths.map((path) => ({ [path]: { $in: skus } })) }] })
          .toArray();
        const known = new Set<string>();
        for (const doc of verified) for (const path of mapping.identifierPaths) { const value = readPath(doc, path); if (value !== undefined && value !== null) known.add(String(value)); }
        if (!skus.every((sku: string) => known.has(String(sku)))) {
          throw new Error(`[CartUpdateHandler] One or more cart SKUs could not be verified in tenant catalog`);
        }
      }

      const cartRecord = {
        cartId,
        projectId: tenantId,
        workspaceId: ctx.workspaceId,
        items,
        totalItems: items.reduce((acc, it) => acc + (it.quantity || 1), 0),
        status: 'active',
        updatedAt: new Date().toISOString(),
      };

      await db.collection('customer_carts').updateOne(
        { projectId: tenantId, cartId },
        { $set: cartRecord },
        { upsert: true }
      );

      return { cart: cartRecord, status: 'success' };
    }

    // 4. Missing bindings must fail closed
    throw new Error(
      `[CartUpdateHandler] Missing authoritative cart connector adapter or platform repository for tenant '${tenantId}' - failing closed`
    );
  }
}
