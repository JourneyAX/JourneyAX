import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

export interface PricingValidateInput {
  skus: string[];
}

export class PricingValidateHandler implements NativeCapabilityHandler {
  async execute(input: PricingValidateInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const skus = Array.isArray(input.skus) ? input.skus : [];

    if (skus.length === 0) {
      return {
        valid: false,
        totalCents: 0,
        currency: 'AUD',
        items: [],
        reason: 'No SKUs provided for validation',
      };
    }

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      // Mock validation when DB is unavailable
      const items = skus.map((sku) => ({
        sku,
        priceCents: 10000,
        inStock: true,
      }));
      return {
        valid: true,
        totalCents: items.reduce((sum, item) => sum + item.priceCents, 0),
        currency: 'AUD',
        items,
      };
    }

    try {
      const { db } = await connectToDatabase(uri, 'journeyx');
      const docs = await db.collection('products')
        .find({
          projectId: tenantId,
          sku: { $in: skus },
        })
        .toArray();

      const items = skus.map((sku) => {
        const found = docs.find((d: any) => d.sku === sku);
        if (!found) {
          return {
            sku,
            priceCents: 0,
            inStock: false,
            found: false,
          };
        }
        const priceAmount = found.price?.amount || (typeof found.price === 'number' ? found.price : 0);
        const priceCents = found.priceCents || Math.round(priceAmount * 100);
        return {
          sku,
          name: found.name || found.title || sku,
          priceCents,
          inStock: found.inStock !== false,
          found: true,
        };
      });

      const allFound = items.every((i) => i.found);
      const allInStock = items.every((i) => i.inStock);
      const totalCents = items.reduce((sum, i) => sum + i.priceCents, 0);

      return {
        valid: allFound && allInStock,
        totalCents,
        currency: 'AUD',
        items,
        details: {
          allFound,
          allInStock,
        },
      };
    } catch (err: any) {
      console.warn('[PricingValidateHandler] Validation error:', err.message);
      return {
        valid: false,
        totalCents: 0,
        currency: 'AUD',
        error: err.message,
      };
    }
  }
}
