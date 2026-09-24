import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export interface PricingValidateInput {
  skus: string[];
  currency?: string;
}

export class PricingValidateHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryProducts?: any[]) {}

  async execute(input: PricingValidateInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const skus = Array.isArray(input.skus) ? input.skus : [];
    const requestedCurrency = input.currency || 'USD';

    if (skus.length === 0) {
      return {
        valid: false,
        totalCents: 0,
        currency: requestedCurrency,
        items: [],
        reason: 'No SKUs provided for validation',
      };
    }

    let docs: any[] = [];

    if (this.inMemoryProducts) {
      docs = this.inMemoryProducts.filter((p) => {
        if (p.projectId && p.projectId !== tenantId) return false;
        return skus.includes(p.sku) || skus.includes(p.parentSku);
      });
    } else {
      const uri = process.env.MONGODB_URI;
      if (!uri) {
        return {
          valid: false,
          totalCents: 0,
          currency: requestedCurrency,
          items: [],
          error: 'Database connection required for pricing validation',
        };
      }

      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
        docs = await db.collection(COLLECTION_PRODUCTS)
          .find({
            projectId: tenantId,
            $or: [
              { sku: { $in: skus } },
              { parentSku: { $in: skus } },
            ],
          })
          .toArray();
      } catch (err: any) {
        console.warn('[PricingValidateHandler] Validation error:', err.message);
        return {
          valid: false,
          totalCents: 0,
          currency: requestedCurrency,
          error: err.message,
        };
      }
    }

    const items = skus.map((sku) => {
      const found = docs.find((d: any) => d.sku === sku || d.parentSku === sku);
      if (!found) {
        return {
          sku,
          priceCents: 0,
          currency: requestedCurrency,
          inStock: false,
          found: false,
        };
      }
      const priceAmount = found.price?.amount || (typeof found.price === 'number' ? found.price : 0);
      const priceCents = found.priceCents || Math.round(priceAmount * 100);
      const inStock =
        typeof found.inStock === 'boolean'
          ? found.inStock
          : found.stock?.inStock != null
          ? found.stock.inStock
          : found.inventory?.availableUnits != null
          ? found.inventory.availableUnits > 0
          : false;

      return {
        sku,
        name: found.name || found.title || sku,
        priceCents,
        currency: (found.price?.currency || found.currency || requestedCurrency).toUpperCase(),
        inStock,
        found: true,
      };
    });

    const distinctCurrencies = Array.from(new Set(items.filter((i) => i.found).map((i) => i.currency)));
    if (distinctCurrencies.length > 1) {
      return {
        valid: false,
        totalCents: 0,
        currency: distinctCurrencies[0],
        items,
        reason: `Multi-currency cart items detected without authoritative FX conversion: ${distinctCurrencies.join(', ')}`,
      };
    }

    const allFound = items.every((i) => i.found);
    const allInStock = items.every((i) => i.inStock);
    const totalCents = items.reduce((sum, i) => sum + i.priceCents, 0);

    return {
      valid: allFound && allInStock,
      totalCents,
      currency: distinctCurrencies[0] || requestedCurrency,
      items,
      details: {
        allFound,
        allInStock,
      },
    };
  }
}

