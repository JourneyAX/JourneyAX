import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS, COLLECTION_OKF_RELEASES } from '@journeyax/database';
import {
  buildCatalogueBaseFilter,
  buildCategoryScopeClauses,
  categoryScopeMatches,
  cleanCategoryPaths,
  classifyAvailability,
  normalizeCatalogProduct,
  readAttribute,
  readPath,
  resolveCatalogMapping,
  type ResolvedCatalogMapping,
} from '@journeyax/business-pack';

export type VectorSearchFunction = (
  query: string,
  options: {
    tenantId: string;
    limit: number;
    categoryIds?: string[];
    categoryPaths?: string[][];
    excludeCategoryIds?: string[];
  }
) => Promise<Array<{ doc: any; score: number }>>;

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
  /**
   * The category scope was chosen by governed knowledge, so the customer's wording must not empty it: the query still
   * narrows the scope, but when it matches nothing the scope's own products are returned instead (`queryRelaxed`).
   */
  scopeAuthoritative?: boolean;
  glossary?: Record<string, string[]>;
  queryEmbedding?: number[];
  vectorSearcher?: VectorSearchFunction;
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

export interface QueryToken {
  stem: string;
  regex: RegExp;
  synonyms?: string[];
}

export function buildGlossaryIndex(sources: {
  glossary?: Record<string, string[]>;
  vocabulary?: any;
  okfConcepts?: Array<{ name?: string; synonyms?: string[]; customerPhrases?: string[] }>;
}): Map<string, string[]> {
  const index = new Map<string, string[]>();

  const addCluster = (terms: (string | undefined)[]) => {
    const cleaned = terms
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 1)
      .map((t) => t.trim().toLowerCase());
    const unique = [...new Set(cleaned)];
    if (unique.length < 2) return;
    for (const term of unique) {
      const others = unique.filter((o) => o !== term);
      const existing = index.get(term) || [];
      index.set(term, [...new Set([...existing, ...others])]);
    }
  };

  if (sources.glossary && typeof sources.glossary === 'object') {
    for (const [key, syns] of Object.entries(sources.glossary)) {
      if (Array.isArray(syns)) addCluster([key, ...syns]);
    }
  }

  const vocab = sources.vocabulary;
  if (vocab && typeof vocab === 'object') {
    if (vocab.synonyms && typeof vocab.synonyms === 'object') {
      for (const [key, syns] of Object.entries(vocab.synonyms)) {
        if (Array.isArray(syns)) addCluster([key, ...syns as string[]]);
      }
    }
    if (vocab.glossary && typeof vocab.glossary === 'object') {
      for (const [key, syns] of Object.entries(vocab.glossary)) {
        if (Array.isArray(syns)) addCluster([key, ...syns as string[]]);
      }
    }
    if (Array.isArray(vocab.terms)) {
      for (const item of vocab.terms) {
        if (item) addCluster([item.term, item.canonical, ...(item.synonyms || [])]);
      }
    }
    if (vocab.slotSynonyms && typeof vocab.slotSynonyms === 'object') {
      for (const syns of Object.values(vocab.slotSynonyms)) {
        if (Array.isArray(syns)) addCluster(syns as string[]);
      }
    }
  }

  if (Array.isArray(sources.okfConcepts)) {
    for (const c of sources.okfConcepts) {
      if (c) addCluster([c.name, ...(c.synonyms || []), ...(c.customerPhrases || [])]);
    }
  }

  return index;
}

export function tokenizeQuery(query: string, glossaryIndex?: Map<string, string[]>): QueryToken[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const tokens: QueryToken[] = [];
  const lowerQuery = query.toLowerCase();

  for (const w of words) {
    const clean = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stem = clean.length > 3 && clean.endsWith('s') ? clean.slice(0, -1) : clean;
    const syns = glossaryIndex ? (glossaryIndex.get(w) || glossaryIndex.get(stem) || []) : [];
    const validSyns = syns.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    const patterns = [stem, ...validSyns];
    tokens.push({
      stem,
      regex: new RegExp(`\\b(?:${patterns.join('|')})(?:s|es)?\\b`, 'i'),
      synonyms: syns,
    });
  }

  if (glossaryIndex) {
    for (const [phrase, syns] of glossaryIndex.entries()) {
      if (phrase.includes(' ') && lowerQuery.includes(phrase)) {
        const clean = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const validSyns = syns.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
        const patterns = [clean, ...validSyns];
        tokens.push({
          stem: phrase,
          regex: new RegExp(`\\b(?:${patterns.join('|')})(?:s|es)?\\b`, 'i'),
          synonyms: syns,
        });
      }
    }
  }

  return tokens;
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

export class CatalogSearchHandler implements NativeCapabilityHandler {
  private readonly okfConceptCache = new Map<string, Array<{ name?: string; synonyms?: string[]; customerPhrases?: string[] }>>();

  constructor(
    private readonly inMemoryProducts?: any[],
    /** Injected database (the runtime's own handle); falls back to MONGODB_URI when absent. */
    private readonly dbProvider?: () => Promise<any>,
    private readonly vectorSearcher?: VectorSearchFunction,
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

    if (input.scopeAuthoritative && input.query && !input.matchAllTokens &&
      ((input.categoryIds?.length ?? 0) > 0 || cleanCategoryPaths(input.categoryPaths).length > 0)) {
      const narrowed = await this.execute({ ...input, scopeAuthoritative: false }, ctx);
      if (narrowed.total > 0 || narrowed.error) return narrowed;
      return { ...(await this.execute({ ...input, query: '', scopeAuthoritative: false }, ctx)), queryRelaxed: true };
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
    const categoryPaths = cleanCategoryPaths(input.categoryPaths);
    // A scope that was supplied but is unusable must narrow to nothing, never silently widen to the whole catalogue.
    if (Array.isArray(input.categoryPaths) && input.categoryPaths.length > 0 && categoryPaths.length === 0 && categoryIds.length === 0) {
      return { items: [], total: 0, error: 'invalid_category_scope' };
    }
    const excludeCategoryIds = Array.isArray(input.excludeCategoryIds) ? input.excludeCategoryIds.filter(Boolean) : [];
    const limit = Math.min(input.maxResults || 10, 50);

    // Dynamic glossary expansion from tenant's OKF release or pack vocabulary
    let okfConcepts = (ctx as any).okfRelease?.concepts || (ctx as any).okfContent?.concepts;
    let db: any = null;
    if (this.dbProvider || (!this.inMemoryProducts && process.env.MONGODB_URI)) {
      try {
        db = this.dbProvider
          ? await this.dbProvider()
          : (await connectToDatabase(process.env.MONGODB_URI!, process.env.MONGODB_DB_NAME || 'journeyx')).db;
      } catch {
        // Database connection error handled below if needed
      }
    }

    if (!okfConcepts && db && (ctx as any).release?.knowledgeModel?.type === 'okf_release') {
      const ref = (ctx as any).release.knowledgeModel;
      const cacheKey = `${tenantId}:${ref.releaseId}`;
      if (this.okfConceptCache.has(cacheKey)) {
        okfConcepts = this.okfConceptCache.get(cacheKey);
      } else {
        try {
          const row = await db.collection(COLLECTION_OKF_RELEASES).findOne({
            tenantId,
            releaseId: ref.releaseId,
          });
          if (row?.content?.concepts) {
            okfConcepts = row.content.concepts;
            this.okfConceptCache.set(cacheKey, okfConcepts);
          }
        } catch {
          // Non-blocking if collection lookup fails
        }
      }
    }

    const glossaryIndex = buildGlossaryIndex({
      glossary: input.glossary || (ctx as any).glossary,
      vocabulary: ctx.packSettings?.vocabulary || (ctx as any).release?.vocabulary || (ctx as any).vocabulary,
      okfConcepts,
    });

    // Top-level input keys that the tenant mapping declares as attributes behave as attribute filters.
    const declaredFilterKeys = Object.keys(mapping.attributeAliases);
    const attributeFilters: Record<string, any> = {
      ...(input.attributeFilters || {}),
      ...Object.fromEntries(declaredFilterKeys
        .filter((key) => (input as any)[key] !== undefined && (input as any)[key] !== null && (input as any)[key] !== '')
        .map((key) => [key, (input as any)[key]])),
    };

    let docs: any[] = [];
    const tokens = query ? tokenizeQuery(query, glossaryIndex) : [];
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
        if (!categoryScopeMatches(mapping, { categoryIds, categoryPaths, excludeCategoryIds }, p)) return false;
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
        if (!db) {
          db = this.dbProvider
            ? await this.dbProvider()
            : (await connectToDatabase(uri!, process.env.MONGODB_DB_NAME || 'journeyx')).db;
        }

        const { filter, and } = buildCatalogueBaseFilter(mapping, tenantId);
        const anyOf = (paths: string[], matcher: any) => paths.map((path) => ({ [path]: matcher }));

        if (category) {
          const regex = new RegExp(escapeRegex(category), 'i');
          and.push({ $or: anyOf(mapping.categoryPaths, regex) });
        }
        and.push(...buildCategoryScopeClauses(mapping, { categoryIds, categoryPaths, excludeCategoryIds }));
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

    // Hybrid retrieval: Atlas vector search through existing product-service logic or equivalent, plus keyword search, then rerank
    let vectorResults: Array<{ doc: any; score: number }> = [];
    const searcher = input.vectorSearcher || (ctx as any).vectorSearcher || this.vectorSearcher;
    if (searcher && query) {
      try {
        vectorResults = await searcher(query, {
          tenantId,
          limit: limit * 2,
          categoryIds,
          categoryPaths,
          excludeCategoryIds,
        });
      } catch (err: any) {
        console.warn('[CatalogSearchHandler] Vector search failed, falling back to keyword only:', err.message);
      }
    } else if (db && input.queryEmbedding && query) {
      try {
        const vectorPipeline: object[] = [
          {
            $vectorSearch: {
              index: 'vector_index',
              path: 'embedding',
              queryVector: input.queryEmbedding,
              numCandidates: Math.max(limit * 3, 20),
              limit: limit * 2,
            },
          },
          { $addFields: { score: { $meta: 'vectorSearchScore' } } },
          { $project: { embedding: 0 } },
        ];
        const rawVec = await db.collection(COLLECTION_PRODUCTS).aggregate(vectorPipeline).toArray();
        vectorResults = rawVec.map((d: any) => ({ doc: d, score: d.score || 0 }));
      } catch {
        // Fallback silently when vector index is not configured
      }
    }

    // Reciprocal Rank Fusion (RRF) reranking when vector results exist
    if (vectorResults.length > 0) {
      const docMap = new Map<string, any>();
      const kwRankMap = new Map<string, number>();
      const vecRankMap = new Map<string, number>();
      const kwScoreMap = new Map<string, number>();

      docs.forEach((doc, rank) => {
        const idPath = mapping.identifierPaths?.[0];
        const key = (idPath ? readPath(doc, idPath) : undefined) || doc.sku || String(doc._id);
        docMap.set(key, doc);
        kwRankMap.set(key, rank);
        kwScoreMap.set(key, scoreDocumentRelevance(doc, tokens, mapping));
      });

      vectorResults.forEach(({ doc, score }, rank) => {
        const idPath = mapping.identifierPaths?.[0];
        const key = (idPath ? readPath(doc, idPath) : undefined) || doc.sku || String(doc._id);
        if (!docMap.has(key)) docMap.set(key, doc);
        vecRankMap.set(key, rank);
      });

      const fused = Array.from(docMap.values()).map((doc) => {
        const idPath = mapping.identifierPaths?.[0];
        const key = (idPath ? readPath(doc, idPath) : undefined) || doc.sku || String(doc._id);
        const kwRank = kwRankMap.has(key) ? kwRankMap.get(key)! : -1;
        const vecRank = vecRankMap.has(key) ? vecRankMap.get(key)! : -1;
        const rrf = (kwRank >= 0 ? 1 / (60 + kwRank) : 0) + (vecRank >= 0 ? 1 / (60 + vecRank) : 0);
        const kwScore = kwScoreMap.get(key) || scoreDocumentRelevance(doc, tokens, mapping);
        const finalScore = rrf * 1000 + kwScore;
        return { doc, finalScore };
      });

      fused.sort((a, b) => b.finalScore - a.finalScore);
      docs = fused.map((f) => f.doc);
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
