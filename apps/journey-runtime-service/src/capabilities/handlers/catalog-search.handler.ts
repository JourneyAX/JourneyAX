import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export interface CatalogSearchInput {
  query?: string;
  category?: string;
  maxResults?: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  inStockOnly?: boolean;
  requiredCertifications?: string[];
  toeType?: 'composite' | 'steel' | 'soft' | string;
  garmentWeight?: 'lightweight' | 'midweight' | 'heavyweight' | string;
  currency?: string;
  requireAuthoritativePrice?: boolean;
}

export class CatalogSearchHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryProducts?: any[]) {}

  async execute(input: CatalogSearchInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const query = input.query || '';
    const category = input.category || '';
    const limit = Math.min(input.maxResults || 10, 50);

    let docs: any[] = [];

    if (this.inMemoryProducts) {
      docs = this.inMemoryProducts.filter((p) => {
        if (p.projectId && p.projectId !== tenantId) return false;
        if (category) {
          const catMatch =
            (p.category && p.category.toLowerCase().includes(category.toLowerCase())) ||
            (p.type && p.type.toLowerCase().includes(category.toLowerCase()));
          if (!catMatch) return false;
        }
        if (query) {
          const q = query.toLowerCase();
          const match =
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.title && p.title.toLowerCase().includes(q)) ||
            (p.description && p.description.toLowerCase().includes(q)) ||
            (p.sku && p.sku.toLowerCase().includes(q)) ||
            (p.parentSku && p.parentSku.toLowerCase().includes(q));
          if (!match) return false;
        }
        return true;
      });
    } else {
      const uri = process.env.MONGODB_URI;
      if (!uri) {
        return { items: [], total: 0 };
      }

      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');

        const filter: Record<string, any> = {
          projectId: tenantId,
        };

        if (category) {
          const escapedCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          filter.$or = [
            { category: new RegExp(escapedCategory, 'i') },
            { type: new RegExp(escapedCategory, 'i') },
          ];
        }

        if (query) {
          const queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          const textConditions = [
            { name: queryRegex },
            { title: queryRegex },
            { description: queryRegex },
            { sku: queryRegex },
            { parentSku: queryRegex },
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

        if (input.toeType?.toLowerCase() === 'composite') {
          const compositeClause = {
            $or: [
              { 'safety.toeProtection': 'composite' },
              { toeType: 'composite' },
              { name: /composite/i },
              { description: /composite/i },
            ],
            name: { $not: /steel toe/i },
          };
          if (filter.$and) {
            filter.$and.push(compositeClause);
          } else {
            filter.$and = [compositeClause];
          }
        }

        docs = await db.collection(COLLECTION_PRODUCTS)
          .find(filter)
          .limit(limit * 2)
          .toArray();
      } catch (err: any) {
        console.warn('[CatalogSearchHandler] Failed to query catalog:', err.message);
        return { items: [], total: 0, error: err.message };
      }
    }

    const items = docs
      .map((doc: any) => {
        // Authoritative price extraction without zero-dollar fabrication
        let priceCents: number | null = null;
        if (typeof doc.priceCents === 'number' && doc.priceCents > 0) {
          priceCents = doc.priceCents;
        } else if (typeof doc.price?.amount === 'number' && doc.price.amount > 0) {
          priceCents = Math.round(doc.price.amount * 100);
        } else if (typeof doc.price === 'number' && doc.price > 0) {
          priceCents = Math.round(doc.price * 100);
        }

        const rawCurrency = doc.price?.currency || doc.currency;
        const currency = rawCurrency ? String(rawCurrency).toUpperCase() : (input.currency ? input.currency.toUpperCase() : null);

        const inStock =
          typeof doc.inStock === 'boolean'
            ? doc.inStock
            : doc.stock?.inStock != null
            ? doc.stock.inStock
            : doc.inventory?.availableUnits != null
            ? doc.inventory.availableUnits > 0
            : undefined;

        // Structured safety toe resolution: steel toe must never be classified as composite
        const rawToe = doc.safety?.toeProtection || doc.toeType || '';
        const toeProtection =
          rawToe.toLowerCase() === 'composite' || (/composite/i.test(doc.name || '') && !/steel/i.test(doc.name || ''))
            ? 'composite'
            : rawToe.toLowerCase() === 'steel' || /steel/i.test(doc.name || '')
            ? 'steel'
            : 'soft';

        // Structured garment weight resolution
        const rawWeight = doc.garment?.weightClass || doc.weightClass || doc.garmentWeight || '';
        const garmentWeight =
          rawWeight.toLowerCase() === 'lightweight' || /lightweight|summer/i.test(doc.name || '')
            ? 'lightweight'
            : rawWeight.toLowerCase() === 'heavyweight' || /heavyweight|winter|thermal/i.test(doc.name || '')
            ? 'heavyweight'
            : 'midweight';

        const certifications: string[] =
          doc.safety?.certifications ||
          (Array.isArray(doc.certifications) ? doc.certifications : []);

        return {
          sku: doc.parentSku || doc.sku || doc.id || String(doc._id),
          name: doc.name || doc.title || 'Product',
          description: doc.description || '',
          category: doc.category || doc.type || 'General',
          priceCents,
          currency,
          inStock,
          toeProtection,
          garmentWeight,
          availableQuantity: doc.stock?.availableQuantity ?? doc.inventory?.availableUnits,
          certifications,
          imageUrl: doc.imageUrl || doc.images?.[0]?.url || '',
        };
      })
      .filter((item) => {
        // Enforce authoritative pricing: exclude if price is missing/non-positive and price limits or authoritative flag is required
        if (item.priceCents == null || item.priceCents <= 0) {
          if (input.requireAuthoritativePrice || input.minPriceCents != null || input.maxPriceCents != null) {
            return false;
          }
        }
        // Strict budget and price bounds enforcement
        if (input.minPriceCents != null && (item.priceCents == null || item.priceCents < input.minPriceCents)) {
          return false;
        }
        if (input.maxPriceCents != null && (item.priceCents == null || item.priceCents > input.maxPriceCents)) {
          return false;
        }
        // Currency matching
        if (input.currency && item.currency && item.currency !== input.currency.toUpperCase()) {
          return false;
        }
        // In-stock enforcement
        if (input.inStockOnly && item.inStock !== true) {
          return false;
        }
        // Structured toe protection: Steel toe MUST NEVER match composite toe
        if (input.toeType) {
          if (input.toeType.toLowerCase() === 'composite') {
            if (item.toeProtection !== 'composite') return false;
          } else if (input.toeType.toLowerCase() === 'steel') {
            if (item.toeProtection !== 'steel') return false;
          } else {
            if (item.toeProtection?.toLowerCase() !== input.toeType.toLowerCase()) return false;
          }
        }
        // Structured garment weight
        if (input.garmentWeight && item.garmentWeight?.toLowerCase() !== input.garmentWeight.toLowerCase()) {
          return false;
        }
        // Required certifications
        if (input.requiredCertifications && input.requiredCertifications.length > 0) {
          const hasAll = input.requiredCertifications.every((cert) =>
            item.certifications.some((c) => c.toLowerCase() === cert.toLowerCase())
          );
          if (!hasAll) return false;
        }
        return true;
      })
      .slice(0, limit);

    return {
      items,
      total: items.length,
    };
  }
}

