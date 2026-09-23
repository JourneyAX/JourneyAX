import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

export interface CatalogSearchInput {
  query?: string;
  category?: string;
  maxResults?: number;
  minPriceCents?: number;
  maxPriceCents?: number;
}

export class CatalogSearchHandler implements NativeCapabilityHandler {
  async execute(input: CatalogSearchInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const query = input.query || '';
    const category = input.category || '';
    const limit = Math.min(input.maxResults || 10, 50);

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      return { items: [], total: 0 };
    }

    try {
      const { db } = await connectToDatabase(uri, 'journeyx');

      const filter: Record<string, any> = {
        projectId: tenantId,
      };

      if (category) {
        filter.$or = [
          { category: new RegExp(category, 'i') },
          { type: new RegExp(category, 'i') },
        ];
      }

      if (query) {
        const queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const textConditions = [
          { name: queryRegex },
          { title: queryRegex },
          { description: queryRegex },
          { sku: queryRegex },
          { 'attributes.value': queryRegex },
        ];

        if (filter.$or) {
          filter.$and = [
            { $or: filter.$or },
            { $or: textConditions },
          ];
          delete filter.$or;
        } else {
          filter.$or = textConditions;
        }
      }

      const docs = await db.collection('products')
        .find(filter)
        .limit(limit)
        .toArray();

      const items = docs.map((doc: any) => {
        const priceAmount = doc.price?.amount || (typeof doc.price === 'number' ? doc.price : 0);
        const priceCents = doc.priceCents || Math.round(priceAmount * 100);
        return {
          sku: doc.sku || doc.id || String(doc._id),
          name: doc.name || doc.title || 'Product',
          description: doc.description || '',
          category: doc.category || doc.type || 'General',
          priceCents,
          currency: doc.currency || 'AUD',
          inStock: doc.inStock !== false,
          imageUrl: doc.imageUrl || doc.images?.[0]?.url || '',
        };
      });

      return {
        items,
        total: items.length,
      };
    } catch (err: any) {
      console.warn('[CatalogSearchHandler] Failed to query catalog:', err.message);
      return { items: [], total: 0, error: err.message };
    }
  }
}
