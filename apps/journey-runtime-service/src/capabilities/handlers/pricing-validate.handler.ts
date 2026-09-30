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
    const packCurrency = (ctx as any)?.pricing?.currency || (ctx as any)?.currency;
    const authoritativePackCurrency = packCurrency ? String(packCurrency).toUpperCase() : undefined;

    if (skus.length === 0) {
      return {
        valid: false,
        totalCents: 0,
        currency: authoritativePackCurrency,
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
          currency: authoritativePackCurrency,
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
          currency: authoritativePackCurrency,
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
          currency: authoritativePackCurrency,
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

      const rawItemCurr = found.price?.currency || found.currency;
      const itemCurr = rawItemCurr ? String(rawItemCurr).toUpperCase() : authoritativePackCurrency;

      return {
        sku,
        name: found.name || found.title || sku,
        priceCents,
        currency: itemCurr,
        inStock,
        found: true,
      };
    });

    const distinctCurrencies = Array.from(
      new Set(items.filter((i) => i.found && i.currency).map((i) => i.currency))
    );

    // Authoritative currency comes ONLY from catalogue records or Business Pack pricing policy
    const authoritativeCurrency = distinctCurrencies[0] || authoritativePackCurrency;

    // Fail closed: Missing authoritative currency across catalogue and pack policy (input.currency cannot be sole authority)
    if (!authoritativeCurrency) {
      return {
        valid: false,
        totalCents: 0,
        items,
        reason: 'Missing authoritative currency in pricing policy and catalogue records - failing closed (input.currency cannot be sole authority)',
      };
    }

    // Fail closed: Multi-currency cart items without conversion
    if (distinctCurrencies.length > 1) {
      return {
        valid: false,
        totalCents: 0,
        currency: distinctCurrencies[0],
        items,
        reason: `Multi-currency cart items detected without authoritative FX conversion: ${distinctCurrencies.join(', ')}`,
      };
    }

    // Fail closed: Conflicting currency between requested constraint and authoritative currency
    if (input.currency && input.currency.toUpperCase() !== authoritativeCurrency) {
      return {
        valid: false,
        totalCents: 0,
        currency: authoritativeCurrency,
        items,
        reason: `Conflicting currency: caller requested '${input.currency.toUpperCase()}' but authoritative records require '${authoritativeCurrency}'`,
      };
    }

    const allFound = items.every((i) => i.found);
    const allInStock = items.every((i) => i.inStock);
    const totalCents = items.reduce((sum, i) => sum + i.priceCents, 0);

    return {
      valid: allFound && allInStock,
      totalCents,
      currency: authoritativeCurrency,
      items,
      details: {
        allFound,
        allInStock,
      },
    };
  }
}

