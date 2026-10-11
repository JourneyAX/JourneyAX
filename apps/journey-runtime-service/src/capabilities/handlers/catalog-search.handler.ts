import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export interface CatalogSearchInput {
  query?: string;
  category?: string;
  categoryIds?: string[];
  excludeCategoryIds?: string[];
  maxResults?: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  inStockOnly?: boolean;
  requiredCertifications?: string[];
  attributeFilters?: Record<string, any>;
  currency?: string;
  requireAuthoritativePrice?: boolean;
  groups?: Array<{
    conceptId: string;
    label: string;
    categoryIds: string[];
    excludeCategoryIds?: string[];
    maxItems?: number;
  }>;
}

const STOP_WORDS = new Set([
  'want', 'need', 'with', 'from', 'this', 'that', 'have', 'make', 'doing', 'does',
  'will', 'would', 'could', 'should', 'about', 'into', 'over', 'room', 'complete',
  'makeover', 'please', 'help', 'and', 'the', 'for', 'are', 'you', 'can', 'our'
]);

interface QueryToken {
  stem: string;
  regex: RegExp;
}

function tokenizeQuery(query: string): QueryToken[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return words.map((w) => {
    const clean = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stem = clean.length > 3 && clean.endsWith('s') ? clean.slice(0, -1) : clean;
    return {
      stem,
      regex: new RegExp(`\\b${stem}(?:s|es)?\\b`, 'i'),
    };
  });
}

function scoreDocumentRelevance(doc: any, tokens: QueryToken[]): number {
  if (!tokens || tokens.length === 0) return 0;
  let score = 0;
  const name = (doc.name || doc.title || '').toLowerCase();
  const brand = (doc.brandCode || doc.brand || '').toLowerCase();
  const category = (doc.category || doc.type || '').toLowerCase();
  const categoryPath = Array.isArray(doc.categoryPath)
    ? doc.categoryPath.join(' ').toLowerCase()
    : String(doc.categoryPath || '').toLowerCase();
  const desc = (doc.description || '').toLowerCase();

  for (const t of tokens) {
    if (new RegExp(`^${t.stem}\\b`, 'i').test(name)) score += 200;
    if (category.includes(t.stem) || t.regex.test(category)) score += 150;
    if (t.regex.test(name)) score += 100;
    if (t.regex.test(brand)) score += 80;
    if (t.regex.test(categoryPath)) score += 60;
    if (t.regex.test(desc)) score += 10;
  }
  return score;
}

export class CatalogSearchHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryProducts?: any[]) {}

  async execute(input: CatalogSearchInput, ctx: ExecutionContext): Promise<any> {
    if (input.groups?.length) {
      const groups = [];
      const seen = new Set<string>();
      const flattened: any[] = [];
      for (const group of input.groups) {
        const result = await this.execute({
          ...input,
          groups: undefined,
          categoryIds: group.categoryIds,
          excludeCategoryIds: group.excludeCategoryIds || [],
          maxResults: group.maxItems || Math.min(input.maxResults || 2, 10),
        }, ctx);
        const items = (result.items || []).filter((item: any) => {
          if (seen.has(item.sku)) return false;
          seen.add(item.sku);
          flattened.push(item);
          return true;
        });
        groups.push({ conceptId: group.conceptId, label: group.label, items, total: items.length });
      }
      return { items: flattened, total: flattened.length, groups };
    }

    const tenantId = ctx.tenantId;
    const query = input.query || '';
    const category = input.category || '';
    const categoryIds = Array.isArray(input.categoryIds) ? input.categoryIds.filter(Boolean) : [];
    const excludeCategoryIds = Array.isArray(input.excludeCategoryIds) ? input.excludeCategoryIds.filter(Boolean) : [];
    const limit = Math.min(input.maxResults || 10, 50);

    const attributeFilters: Record<string, any> = {
      ...(input.attributeFilters || {}),
      ...((input as any).toeType ? { toeType: (input as any).toeType } : {}),
      ...((input as any).garmentWeight ? { garmentWeight: (input as any).garmentWeight } : {}),
    };

    let docs: any[] = [];
    const tokens = query ? tokenizeQuery(query) : [];

    if (this.inMemoryProducts) {
      docs = this.inMemoryProducts.filter((p) => {
        if (p.projectId && p.projectId !== tenantId) return false;
        if (p.discontinued === true || String(p.status || p.lifecycle?.status || '').toLowerCase() === 'discontinued') return false;
        if (category) {
          const catMatch =
            (p.category && p.category.toLowerCase().includes(category.toLowerCase())) ||
            (p.type && p.type.toLowerCase().includes(category.toLowerCase()));
          if (!catMatch) return false;
        }
        const categoryText = `${p.categoryId || ''} ${p.category || ''} ${p.type || ''} ${Array.isArray(p.categoryPath) ? p.categoryPath.join(' ') : p.categoryPath || ''}`.toLowerCase();
        if (categoryIds.length > 0 && !categoryIds.some((id) => categoryText.includes(id.toLowerCase()))) return false;
        if (excludeCategoryIds.some((id) => categoryText.includes(id.toLowerCase()))) return false;
        if (query) {
          if (tokens.length > 0) {
            const text = `${p.name || ''} ${p.title || ''} ${p.brandCode || p.brand || ''} ${p.category || ''} ${p.description || ''} ${p.sku || ''} ${p.parentSku || ''}`.toLowerCase();
            const matches = tokens.some((t) => t.regex.test(text));
            if (!matches) return false;
          } else {
            const q = query.toLowerCase();
            const text = `${p.name || ''} ${p.title || ''} ${p.description || ''} ${p.sku || ''} ${p.category || ''}`.toLowerCase();
            if (!text.includes(q)) return false;
          }
        }
        return true;
      });

      if (tokens.length > 0 && docs.length > 0) {
        docs.sort((a, b) => scoreDocumentRelevance(b, tokens) - scoreDocumentRelevance(a, tokens));
      }
    } else {
      const uri = process.env.MONGODB_URI;
      if (!uri) {
        return { items: [], total: 0, error: 'Database connection required for catalog search' };
      }

      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');

        const filter: Record<string, any> = {
          $or: [{ projectId: tenantId }, { tenantId }],
          $and: [{
            $nor: [
              { discontinued: true },
              { status: /^discontinued$/i },
              { 'lifecycle.status': /^discontinued$/i },
            ],
          }],
        };

        if (category) {
          const escapedCategory = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          filter.$and = [
            ...(filter.$and || []),
            {
              $or: [
                { category: new RegExp(escapedCategory, 'i') },
                { type: new RegExp(escapedCategory, 'i') },
              ],
            },
          ];
        }

        if (categoryIds.length > 0) {
          const scopedCategories = categoryIds.map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
          const scopeClause = {
            $or: [
              { categoryId: { $in: scopedCategories } },
              { category: { $in: scopedCategories } },
              { type: { $in: scopedCategories } },
              { categoryPath: { $in: scopedCategories } },
            ],
          };
          filter.$and = [...(filter.$and || []), scopeClause];
        }

        if (excludeCategoryIds.length > 0) {
          const excludedCategories = excludeCategoryIds.map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
          filter.$and = [
            ...(filter.$and || []),
            {
              $nor: [
                { categoryId: { $in: excludedCategories } },
                { category: { $in: excludedCategories } },
                { type: { $in: excludedCategories } },
                { categoryPath: { $in: excludedCategories } },
              ],
            },
          ];
        }

        if (query) {
          const textConditions: any[] = [];
          if (tokens.length > 0) {
            for (const t of tokens) {
              textConditions.push(
                { name: t.regex },
                { title: t.regex },
                { brandCode: t.regex },
                { brand: t.regex },
                { category: t.regex },
                { categoryPath: t.regex },
                { description: t.regex },
                { sku: t.regex },
                { parentSku: t.regex },
                { 'attributes.value': t.regex },
                { 'metadata.domainKeywords': t.regex }
              );
            }
          } else {
            const queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            textConditions.push(
              { name: queryRegex },
              { title: queryRegex },
              { description: queryRegex },
              { sku: queryRegex },
              { parentSku: queryRegex },
              { 'attributes.value': queryRegex },
              { 'metadata.domainKeywords': queryRegex }
            );
          }

          if (filter.$and) {
            filter.$and.push({ $or: textConditions });
          } else {
            filter.$and = [{ $or: textConditions }];
          }
        }

        if (Object.keys(attributeFilters).length > 0) {
          for (const [filterKey, filterVal] of Object.entries(attributeFilters)) {
            const regex = new RegExp(`^${String(filterVal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
            const filterClause = {
              $or: [
                { [`attributes.${filterKey}`]: regex },
                { [`safety.${filterKey}`]: regex },
                { [filterKey]: regex },
              ],
            };
            if (filter.$and) {
              filter.$and.push(filterClause);
            } else {
              filter.$and = [filterClause];
            }
          }
        }

        docs = await db.collection(COLLECTION_PRODUCTS)
          .find(filter)
          .limit(150)
          .toArray();

        // Sort by generic relevance score across tokens, brand, name, and category
        if (tokens.length > 0 && docs.length > 0) {
          docs.sort((a, b) => scoreDocumentRelevance(b, tokens) - scoreDocumentRelevance(a, tokens));
        }
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
        } else if (typeof doc.priceUSD?.min === 'number' && doc.priceUSD.min > 0) {
          priceCents = Math.round(doc.priceUSD.min * 100);
        } else if (typeof doc.variants?.[0]?.msrpUSD === 'number' && doc.variants[0].msrpUSD > 0) {
          priceCents = Math.round(doc.variants[0].msrpUSD * 100);
        }

        const rawCurrency = doc.price?.currency || doc.currency;
        const currency = rawCurrency
          ? String(rawCurrency).toUpperCase()
          : input.currency
          ? input.currency.toUpperCase()
          : undefined;

        const inStock =
          typeof doc.inStock === 'boolean'
            ? doc.inStock
            : typeof doc.availability === 'boolean'
            ? doc.availability
            : doc.stock?.inStock != null
            ? doc.stock.inStock
            : (typeof doc.stock?.availableBranchCount === 'number' && doc.stock.availableBranchCount > 0)
            ? true
            : doc.inventory?.availableUnits != null
            ? doc.inventory.availableUnits > 0
            : undefined;

        // Structured attributes aggregation across doc properties
        const attributes: Record<string, any> = {
          ...(doc.attributes || {}),
          ...(doc.safety || {}),
          ...(doc.specifications || {}),
        };
        for (const [k, v] of Object.entries(doc)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            if (!(k in attributes)) attributes[k] = v;
          }
        }

        const certifications: string[] =
          doc.safety?.certifications ||
          (Array.isArray(doc.certifications) ? doc.certifications : []);

        const finalSku = doc.parentSku || doc.sku || doc.id || String(doc._id);
        const imageUrl =
          doc.imageUrl ||
          (typeof doc.images?.[0] === 'string' ? doc.images[0] : doc.images?.[0]?.url) ||
          doc.variants?.[0]?.mainImage ||
          '';

        const title = doc.name || doc.title || 'Product';
        const price = priceCents != null ? priceCents / 100 : (doc.variants?.[0]?.msrpUSD || doc.priceUSD?.min || undefined);

        return {
          ...attributes,
          sku: finalSku,
          title,
          name: title,
          description: doc.description || '',
          category: doc.category || doc.type || 'General',
          priceCents,
          price,
          currency,
          inStock,
          attributes,
          availableQuantity: doc.stock?.availableQuantity ?? doc.inventory?.availableUnits,
          certifications,
          imageUrl,
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
        // Generic pack-declared attribute filters
        if (Object.keys(attributeFilters).length > 0) {
          for (const [k, expectedVal] of Object.entries(attributeFilters)) {
            const expectedStr = String(expectedVal).trim().toLowerCase();
            const actualVal =
              (item as any)[k] ??
              (item.attributes as any)?.[k] ??
              (k === 'toeType' ? (item as any).toeProtection : undefined);
            if (actualVal === undefined || actualVal === null) return false;
            const actualStr = String(actualVal).trim().toLowerCase();
            if (expectedStr === 'composite' && /steel/i.test(actualStr)) return false;
            if (actualStr !== expectedStr) return false;
          }
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
