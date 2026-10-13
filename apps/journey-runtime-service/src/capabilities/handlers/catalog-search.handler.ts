import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';
import { categoryPathCovers } from '@journeyax/knowledge';
import {
  classifyAvailability,
  normalizeCatalogProduct,
  readAttribute,
  readPath,
  resolveCatalogMapping,
  type ResolvedCatalogMapping,
} from '@journeyax/business-pack';

export interface CatalogSearchInput {
  query?: string;
  category?: string;
  categoryIds?: string[];
  /** Hierarchy scopes (department → group → category); a product matches when its category path starts with one. */
  categoryPaths?: string[][];
  excludeCategoryIds?: string[];
  maxResults?: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  inStockOnly?: boolean;
  requiredCertifications?: string[];
  attributeFilters?: Record<string, any>;
  currency?: string;
  requireAuthoritativePrice?: boolean;
  /** Every query word must match (instead of any), for existence probes such as classifying a bare noun. */
  matchAllTokens?: boolean;
  groups?: Array<{
    conceptId: string;
    label: string;
    categoryIds: string[];
    categoryPaths?: string[][];
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

export function tokenizeQuery(query: string): QueryToken[] {
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

function scoreDocumentRelevance(doc: any, tokens: QueryToken[], mapping: ResolvedCatalogMapping): number {
  if (!tokens || tokens.length === 0) return 0;
  const text = (paths: string[]): string => paths
    .map((path) => readPath(doc, path))
    .map((value) => (Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : ''))
    .join(' ')
    .toLowerCase();
  const name = text(mapping.titlePaths);
  const brand = text(mapping.brandPaths);
  const category = text(mapping.categoryPaths);
  const categoryPath = text(mapping.categoryHierarchyPaths);
  const desc = text(mapping.descriptionPaths);

  let score = 0;
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

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only well-formed paths (non-empty string segments) are honoured; anything else is ignored, never widened. */
function cleanPaths(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((path): path is string[] => Array.isArray(path) && path.length > 0 && path.every((segment) => typeof segment === 'string' && segment.trim().length > 0))
    .map((path) => path.map((segment) => segment.trim()));
}

export class CatalogSearchHandler implements NativeCapabilityHandler {
  constructor(
    private readonly inMemoryProducts?: any[],
    /** Injected database (the runtime's own handle); falls back to MONGODB_URI when absent. */
    private readonly dbProvider?: () => Promise<any>,
  ) {}

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
          categoryPaths: group.categoryPaths || [],
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

    let mapping: ResolvedCatalogMapping;
    try {
      mapping = resolveCatalogMapping(ctx.packSettings?.catalogMapping);
    } catch (err: any) {
      console.warn('[CatalogSearchHandler] Invalid catalog mapping in pack:', err.message);
      return { items: [], total: 0, error: 'Catalog mapping in the Business Pack is invalid' };
    }

    const tenantId = ctx.tenantId;
    const query = input.query || '';
    const category = input.category || '';
    const categoryIds = Array.isArray(input.categoryIds) ? input.categoryIds.filter(Boolean) : [];
    const categoryPaths = cleanPaths(input.categoryPaths);
    // A scope that was supplied but is unusable must narrow to nothing, never silently widen to the whole catalogue.
    if (Array.isArray(input.categoryPaths) && input.categoryPaths.length > 0 && categoryPaths.length === 0 && categoryIds.length === 0) {
      return { items: [], total: 0, error: 'invalid_category_scope' };
    }
    const excludeCategoryIds = Array.isArray(input.excludeCategoryIds) ? input.excludeCategoryIds.filter(Boolean) : [];
    const limit = Math.min(input.maxResults || 10, 50);

    // Top-level input keys that the tenant mapping declares as attributes behave as attribute filters.
    const declaredFilterKeys = Object.keys(mapping.attributeAliases);
    const attributeFilters: Record<string, any> = {
      ...(input.attributeFilters || {}),
      ...Object.fromEntries(declaredFilterKeys
        .filter((key) => (input as any)[key] !== undefined && (input as any)[key] !== null && (input as any)[key] !== '')
        .map((key) => [key, (input as any)[key]])),
    };

    let docs: any[] = [];
    const tokens = query ? tokenizeQuery(query) : [];
    const textOf = (doc: any, paths: string[]): string => paths
      .map((path) => readPath(doc, path))
      .map((value) => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value)))
      .join(' ')
      .toLowerCase();

    if (this.inMemoryProducts) {
      docs = this.inMemoryProducts.filter((p) => {
        const owner = mapping.tenantFields.map((path) => readPath(p, path)).find((value) => value !== undefined);
        if (owner !== undefined && owner !== tenantId) return false;
        if (classifyAvailability(p, mapping) === 'excluded') return false;
        if (category && !textOf(p, mapping.categoryPaths).includes(category.toLowerCase())) return false;
        const categoryText = textOf(p, mapping.categoryScopePaths);
        if (categoryIds.length > 0 || categoryPaths.length > 0) {
          const byName = categoryIds.some((id) => categoryText.includes(id.toLowerCase()));
          const byPath = mapping.categoryHierarchyPaths.some((hierarchy) => {
            const value = readPath(p, hierarchy);
            return Array.isArray(value) && categoryPaths.some((scope) => categoryPathCovers(scope, value.map(String)));
          });
          if (!byName && !byPath) return false;
        }
        if (excludeCategoryIds.some((id) => categoryText.includes(id.toLowerCase()))) return false;
        if (query) {
          const text = textOf(p, mapping.searchPaths);
          if (tokens.length > 0) {
            const hit = (t: QueryToken) => t.regex.test(text);
            if (!(input.matchAllTokens ? tokens.every(hit) : tokens.some(hit))) return false;
          } else if (!text.includes(query.toLowerCase())) {
            return false;
          }
        }
        return true;
      });

      if (tokens.length > 0 && docs.length > 0) {
        docs.sort((a, b) => scoreDocumentRelevance(b, tokens, mapping) - scoreDocumentRelevance(a, tokens, mapping));
      }
    } else {
      const uri = process.env.MONGODB_URI;
      if (!uri && !this.dbProvider) {
        return { items: [], total: 0, error: 'Database connection required for catalog search' };
      }

      try {
        const db = this.dbProvider
          ? await this.dbProvider()
          : (await connectToDatabase(uri!, process.env.MONGODB_DB_NAME || 'journeyx')).db;

        const excluded = [
          ...mapping.availability.excludeFlagPaths.map((path) => ({ [path]: true })),
          ...mapping.availability.statusPaths.flatMap((path) =>
            mapping.availability.excludedStatuses.map((status) => ({ [path]: new RegExp(`^${escapeRegex(status)}$`, 'i') }))),
        ];
        const filter: Record<string, any> = {
          $or: mapping.tenantFields.map((path) => ({ [path]: tenantId })),
          $and: excluded.length > 0 ? [{ $nor: excluded }] : [],
        };
        const and: any[] = filter.$and;
        const anyOf = (paths: string[], matcher: any) => paths.map((path) => ({ [path]: matcher }));

        if (category) {
          const regex = new RegExp(escapeRegex(category), 'i');
          and.push({ $or: anyOf(mapping.categoryPaths, regex) });
        }
        if (categoryIds.length > 0 || categoryPaths.length > 0) {
          const scoped = categoryIds.map((value) => new RegExp(escapeRegex(value), 'i'));
          // A path scope is an exact, anchored match on each hierarchy segment, so a same-named category elsewhere is not selected.
          const byPath = categoryPaths.flatMap((scope) => mapping.categoryHierarchyPaths.map((hierarchy) => Object.fromEntries(
            scope.map((segment, index) => [`${hierarchy}.${index}`, new RegExp(`^${escapeRegex(segment)}$`, 'i')]))));
          and.push({ $or: [...(scoped.length ? anyOf(mapping.categoryScopePaths, { $in: scoped }) : []), ...byPath] });
        }
        if (excludeCategoryIds.length > 0) {
          const excludedCategories = excludeCategoryIds.map((value) => new RegExp(escapeRegex(value), 'i'));
          and.push({ $nor: anyOf(mapping.categoryScopePaths, { $in: excludedCategories }) });
        }
        if (query) {
          const matchers = tokens.length > 0
            ? tokens.map((t) => t.regex)
            : [new RegExp(escapeRegex(query), 'i')];
          if (input.matchAllTokens && tokens.length > 0) {
            for (const regex of matchers) and.push({ $or: anyOf(mapping.searchPaths, regex) });
          } else {
            and.push({ $or: matchers.flatMap((regex) => anyOf(mapping.searchPaths, regex)) });
          }
        }
        for (const [filterKey, filterVal] of Object.entries(attributeFilters)) {
          const regex = new RegExp(`^${escapeRegex(String(filterVal))}$`, 'i');
          const keys = [filterKey, ...(mapping.attributeAliases[filterKey] || [])];
          and.push({
            $or: keys.flatMap((key) => [
              ...mapping.attributeContainers.map((container) => ({ [`${container}.${key}`]: regex })),
              { [key]: regex },
            ]),
          });
        }
        if (and.length === 0) delete filter.$and;

        docs = await db.collection(COLLECTION_PRODUCTS)
          .find(filter)
          .limit(mapping.candidateLimit)
          .toArray();

        if (tokens.length > 0 && docs.length > 0) {
          docs.sort((a, b) => scoreDocumentRelevance(b, tokens, mapping) - scoreDocumentRelevance(a, tokens, mapping));
        }
      } catch (err: any) {
        console.warn('[CatalogSearchHandler] Failed to query catalog:', err.message);
        return { items: [], total: 0, error: err.message };
      }
    }

    const requestedCurrency = input.currency ? input.currency.toUpperCase() : undefined;
    const items = docs
      .map((doc: any) => {
        const normalized = normalizeCatalogProduct(doc, mapping, { title: 'Product', category: 'General' });
        return {
          ...normalized.attributes,
          sku: normalized.sku,
          title: normalized.title,
          name: normalized.title,
          description: normalized.description,
          category: normalized.category,
          priceCents: normalized.priceCents,
          price: normalized.price,
          // Only a currency the product (or the tenant mapping) declared; the request currency is a filter, never a label.
          currency: normalized.currency,
          currencyUndeclared: normalized.currencyUndeclared,
          inStock: normalized.inStock,
          attributes: normalized.attributes,
          availableQuantity: normalized.availableQuantity,
          certifications: normalized.certifications,
          imageUrl: normalized.imageUrl,
        };
      })
      .filter((item: any) => {
        const unpriced = item.priceCents == null || item.priceCents <= 0;
        if (unpriced && (input.requireAuthoritativePrice || input.minPriceCents != null || input.maxPriceCents != null)) {
          return false;
        }
        if (input.minPriceCents != null && (item.priceCents == null || item.priceCents < input.minPriceCents)) return false;
        if (input.maxPriceCents != null && (item.priceCents == null || item.priceCents > input.maxPriceCents)) return false;
        // A price in another or an unknown currency can never satisfy a currency-constrained request.
        if (requestedCurrency && !unpriced && item.currency !== requestedCurrency) return false;
        if (input.inStockOnly && item.inStock !== true) return false;
        for (const [k, expectedVal] of Object.entries(attributeFilters)) {
          const actualVal = readAttribute(item, k, mapping);
          if (actualVal === undefined || actualVal === null) return false;
          if (String(actualVal).trim().toLowerCase() !== String(expectedVal).trim().toLowerCase()) return false;
        }
        if (input.requiredCertifications && input.requiredCertifications.length > 0) {
          const hasAll = input.requiredCertifications.every((cert) =>
            item.certifications.some((c: string) => c.toLowerCase() === cert.toLowerCase())
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
