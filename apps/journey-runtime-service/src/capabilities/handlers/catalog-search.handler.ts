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
  type AttributeDefinition,
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
  isAgentMode?: boolean;
  /** When a search finds nothing, loosen the keywords (any of them) before dropping the product type. */
  relaxKeywordsFirst?: boolean;
  keywords?: string[];
  productType?: string;
  brand?: string;
  query?: string;
  /** One product by its exact identifier (any of the mapping's identifier fields): nothing else is returned and no text is searched. */
  sku?: string;
  category?: string;
  categoryIds?: string[];
  /** Hierarchy scopes (department → group → category); a product matches when its category path starts with one. */
  categoryPaths?: string[][];
  excludeCategoryIds?: string[];
  maxResults?: number;
  /** A wide sample of the matching products, for working out what they differ by, not for showing to a customer. */
  facetSample?: boolean;
  minPriceCents?: number;
  maxPriceCents?: number;
  inStockOnly?: boolean;
  requiredCertifications?: string[];
  attributes?: Record<string, any>;
  attributeFilters?: Record<string, any>;
  attributeDefinitions?: Record<string, AttributeDefinition>;
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
  [key: string]: any;
}

export interface StructuredSearchSpecs {
  attributes: Record<string, string>;
  attributeVariants: Record<string, string[]>;
  brand?: string;
  productType?: string;
  keywords?: string[];
  [key: string]: any;
}

export interface QueryToken {
  stem: string;
  regex: RegExp;
  synonyms?: string[];
}

import { connectorWordsForLocale, stemPatternForLocale } from './locale-stemmer';
import { CatalogueIndexRegistry, openCatalogueDatabase } from '../catalogue-index';
import { MemoryProductCollection, UnsupportedFilter } from '../catalogue-filter';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Locale-keyed plural and suffix stemming pattern for regex creation.
 * Uses the pack's primaryLocale (or provided locale). An unknown locale has no stemming.
 */
export function stemPattern(word: string, locale: string = 'en'): string {
  return stemPatternForLocale(word, locale);
}



/**
 * Normalizes an attribute value according to the pack attribute definition normalizer.
 */
/** Largest sample a facet request may read; ordinary searches stay at 50. */
const FACET_SAMPLE_LIMIT = 800;

export function normalizeAttributeValue(val: string, normalizer?: string): string {
  if (!val) return '';
  const clean = val.trim();
  switch (normalizer) {
    case 'lowercase':
      return clean.toLowerCase();
    case 'uppercase':
      return clean.toUpperCase();
    case 'remove_spaces':
      return clean.replace(/\s+/g, '');
    case 'metric_dimension':
      return clean.toLowerCase().replace(/\s*(?:by|x|\*|×)\s*/i, 'x').replace(/\s+/g, '');
    default:
      return clean;
  }
}

/**
 * Resolves equivalent forms for an attribute value using the pack's equivalenceTable and glossary.
 */
export function resolveAttributeEquivalence(
  attrName: string,
  rawValue: string,
  attrDef?: AttributeDefinition,
  glossaryIndex?: Map<string, string[]>
): string[] {
  if (!rawValue) return [];
  const variants = new Set<string>();
  const clean = rawValue.trim();
  variants.add(clean);

  const norm = normalizeAttributeValue(clean, attrDef?.normalizer);
  if (norm) variants.add(norm);

  const table = attrDef?.equivalenceTable;
  if (table && typeof table === 'object') {
    for (const [key, cluster] of Object.entries(table)) {
      if (Array.isArray(cluster)) {
        const matchesKey =
          key.toLowerCase() === clean.toLowerCase() ||
          key.toLowerCase().replace(/\s+/g, '') === norm.toLowerCase();
        const matchesCluster = cluster.some(
          (c) => c.toLowerCase() === clean.toLowerCase() || c.toLowerCase().replace(/\s+/g, '') === norm.toLowerCase()
        );
        if (matchesKey || matchesCluster) {
          variants.add(key);
          for (const v of cluster) variants.add(v);
        }
      }
    }
  }

  if (attrDef?.normalizer === 'metric_dimension' || attrDef?.normalizer === 'remove_spaces') {
    for (const v of Array.from(variants)) {
      const dimMatch = v.match(/^(\d{2,4})\s*[xX*×]\s*(\d{2,4})(?:\s*mm)?$/i);
      if (dimMatch) {
        const [, w, h] = dimMatch;
        variants.add(`${w}x${h}`);
        variants.add(`${w} x ${h}`);
        variants.add(`${w}x${h}mm`);
        variants.add(`${w} x ${h}mm`);
      }
    }
  }

  if (glossaryIndex) {
    for (const v of Array.from(variants)) {
      const syns = glossaryIndex.get(v.toLowerCase());
      if (syns) {
        for (const s of syns) variants.add(s);
      }
    }
  }

  return Array.from(variants).sort((a, b) => b.length - a.length);
}

/**
 * Extracts structured attributes generically using patterns and equivalence definitions from pack data.
 */
export function extractSearchSpecs(params: {
  query?: string;
  keywords?: string[];
  productType?: string;
  brand?: string;
  attributes?: Record<string, any>;
  attributeDefinitions?: Record<string, AttributeDefinition>;
  glossaryIndex?: Map<string, string[]>;
  [key: string]: any;
}): StructuredSearchSpecs {
  const fullText = [params.query, ...(params.keywords || [])].filter(Boolean).join(' ');
  const hasDefs = (d: any): d is Record<string, AttributeDefinition> =>
    d && typeof d === 'object' && Object.keys(d).length > 0;
  const attrDefs = hasDefs(params.attributeDefinitions)
    ? params.attributeDefinitions
    : {};
  const rawAttrs: Record<string, any> = {
    ...(params.attributes || {}),
  };

  for (const k of Object.keys(attrDefs)) {
    if (params[k] && !rawAttrs[k]) {
      rawAttrs[k] = String(params[k]);
    }
  }

  // Task S2: An attribute that has no definition is never a hard filter: treat its value as plain keywords.
  const definedAttrs: Record<string, string> = {};
  const undefinedAttrKeywords: string[] = [];

  for (const [k, v] of Object.entries(rawAttrs)) {
    if (v != null && v !== '') {
      if (attrDefs[k]) {
        definedAttrs[k] = String(v).trim();
      } else {
        undefinedAttrKeywords.push(String(v).trim());
      }
    }
  }

  let residual = params.query || '';

  for (const [attrName, def] of Object.entries(attrDefs)) {
    let current = definedAttrs[attrName]?.trim();
    if (!current && fullText && Array.isArray(def.extractionPatterns)) {
      for (const pattern of def.extractionPatterns) {
        try {
          const match = fullText.match(new RegExp(pattern, 'i'));
          if (match) {
            current = (match[1] || match[0]).trim();
            break;
          }
        } catch {
          // ignore pattern syntax error
        }
      }
    }

    if (current) {
      const norm = normalizeAttributeValue(current, def.normalizer);
      definedAttrs[attrName] = norm;
      residual = residual.replace(new RegExp(`\\b${escapeRegex(current)}\\b`, 'i'), ' ');
    }
  }

  const attributeVariants: Record<string, string[]> = {};
  for (const [attrName, val] of Object.entries(definedAttrs)) {
    if (val) {
      attributeVariants[attrName] = resolveAttributeEquivalence(
        attrName,
        val,
        attrDefs[attrName],
        params.glossaryIndex
      );
    }
  }

  const keywords: string[] = [];
  if (params.keywords && params.keywords.length > 0) {
    keywords.push(...params.keywords);
  } else if (params.productType) {
    keywords.push(params.productType);
  } else if (params.query) {
    const words = residual.trim().split(/\s+/).filter((w) => w.length > 1);
    if (words.length > 0) {
      keywords.push(...words);
    }
  }
  if (undefinedAttrKeywords.length > 0) {
    keywords.push(...undefinedAttrKeywords);
  }

  const result: StructuredSearchSpecs = {
    attributes: definedAttrs,
    attributeVariants,
    brand: params.brand?.trim(),
    productType: params.productType?.trim(),
    keywords: keywords.length > 0 ? [...new Set(keywords)] : undefined,
  };

  for (const [k, v] of Object.entries(definedAttrs)) {
    result[k] = v;
    result[`${k}Variants`] = attributeVariants[k];
  }

  return result;
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
        if (Array.isArray(syns)) addCluster([key, ...(syns as string[])]);
      }
    }
    if (vocab.glossary && typeof vocab.glossary === 'object') {
      for (const [key, syns] of Object.entries(vocab.glossary)) {
        if (Array.isArray(syns)) addCluster([key, ...(syns as string[])]);
      }
    }
    if (Array.isArray(vocab.terms)) {
      for (const item of vocab.terms) {
        if (item) addCluster([item.term, item.canonical, ...(item.synonyms || [])]);
      }
    }
    if (vocab.slotSynonyms && typeof vocab.slotSynonyms === 'object') {
      for (const [key, syns] of Object.entries(vocab.slotSynonyms)) {
        if (Array.isArray(syns)) addCluster([key, ...(syns as string[])]);
      }
    }
    if (Array.isArray(vocab.dimensions)) {
      for (const d of vocab.dimensions) {
        if (Array.isArray(d)) addCluster(d);
        else if (d && typeof d === 'object') addCluster([d.canonical, ...(d.variants || d.synonyms || [])]);
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

export function tokenizeQuery(
  query: string,
  glossaryIndex?: Map<string, string[]>,
  stopWords?: Set<string> | string[]
): QueryToken[] {
  const tokens: QueryToken[] = [];
  const lowerQuery = query.toLowerCase();
  const matchedPhrases = new Set<string>();

  const stopSet = stopWords instanceof Set
    ? stopWords
    : new Set(Array.isArray(stopWords) ? stopWords.map((s) => String(s).toLowerCase().trim()) : []);

  if (glossaryIndex) {
    const sortedPhrases = Array.from(glossaryIndex.keys()).sort((a, b) => b.length - a.length);
    for (const phrase of sortedPhrases) {
      const syns = glossaryIndex.get(phrase) || [];
      const phraseRegex = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(phrase)}(?:[^a-z0-9]|$)`, 'i');
      if (phraseRegex.test(lowerQuery)) {
        const alreadyCovered = tokens.some((tk) => tk.stem === phrase || tk.synonyms?.includes(phrase));
        if (!alreadyCovered) {
          matchedPhrases.add(phrase);
          const clean = escapeRegex(phrase);
          const validSyns = syns.map((s) => escapeRegex(s)).filter(Boolean);
          const patterns = [clean, ...validSyns].sort((a, b) => b.length - a.length);
          tokens.push({
            stem: phrase,
            regex: new RegExp(`\\b(?:${patterns.join('|')})(?:s|es)?\\b`, 'i'),
            synonyms: syns,
          });
        }
      }
    }
  }

  // Preserve dimensional patterns (e.g. "100 x 50" -> "100x50", "4 x 2" -> "4x2")
  const normalizedQuery = query.replace(/(\d+)\s*[xX*×]\s*(\d+)/g, '$1x$2');

  // Split preserving dots in codes like H3.2, R2.6, H1.2
  const rawWords = normalizedQuery
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9.]+|[^a-z0-9.]+$/gi, '').toLowerCase())
    .filter(Boolean);

  const words = rawWords.filter((w) => {
    if (stopSet.has(w)) return false;
    // Preserve tokens with digits (e.g. H3.2, R2.6, 90x45, 4x2) or length > 2
    return w.length > 2 || /\d/.test(w);
  });

  for (const w of words) {
    const isPartOfMatched = Array.from(matchedPhrases).some((p) => p.includes(' ') && p.split(/\s+/).includes(w));
    if (isPartOfMatched || matchedPhrases.has(w)) continue;

    const clean = escapeRegex(w);
    // Never strip 's' if the token contains digits
    const stem = clean.length > 3 && clean.endsWith('s') && !/\d/.test(clean) ? clean.slice(0, -1) : clean;
    const syns = glossaryIndex ? (glossaryIndex.get(w) || glossaryIndex.get(stem) || []) : [];
    const validSyns = syns.map((s) => escapeRegex(s)).filter(Boolean);
    const patterns = [stem, clean, ...validSyns].sort((a, b) => b.length - a.length);
    tokens.push({
      stem,
      regex: new RegExp(`\\b(?:${patterns.join('|')})(?:s|es)?\\b`, 'i'),
      synonyms: syns,
    });
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

export class CatalogSearchHandler implements NativeCapabilityHandler {
  private readonly okfConceptCache = new Map<string, Array<{ name?: string; synonyms?: string[]; customerPhrases?: string[] }>>();
  /** The distinct category texts a tenant's catalogue holds, per field (a few hundred values, read from an index). */
  private readonly categoryValueCache = new Map<string, { at: number; values: Record<string, string[]> }>();
  private static readonly CATEGORY_VALUE_TTL_MS = 10 * 60 * 1000;

  private async distinctCategoryValues(products: { distinct: (field: string, filter?: any) => Promise<any[]> }, key: string, tenantFilter: any, fields: string[]): Promise<Record<string, string[]>> {
    const cached = this.categoryValueCache.get(key);
    if (cached && Date.now() - cached.at < CatalogSearchHandler.CATEGORY_VALUE_TTL_MS) return cached.values;
    const values: Record<string, string[]> = {};
    await Promise.all(fields.map(async (field) => {
      const found = await products.distinct(field, tenantFilter);
      values[field] = found.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0);
    }));
    this.categoryValueCache.set(key, { at: Date.now(), values });
    return values;
  }

  constructor(
    private readonly inMemoryProducts?: any[],
    /** Injected database (the runtime's own handle); falls back to MONGODB_URI when absent. */
    private readonly dbProvider?: () => Promise<any>,
    private readonly vectorSearcher?: VectorSearchFunction,
  ) {}

  private readonly indexCollections = new WeakMap<any[], MemoryProductCollection>();
  /**
   * Group counts for the range overview. Each is a pattern count over the catalogue (seconds of database work), the counts move only
   * when the catalogue is reloaded, and every broad question asks for a dozen of them, so they are kept for a while.
   */
  private readonly countCache = new Map<string, { at: number; count: number }>();
  private static readonly COUNT_TTL_MS = 30 * 60 * 1000;
  private static readonly COUNT_CACHE_MAX = 2000;

  /** The tenant's in-memory catalogue copy as a collection, when CATALOGUE_INDEX is on and the copy is loaded; otherwise undefined. */
  private indexedProducts(tenantId: string, mapping: ResolvedCatalogMapping): MemoryProductCollection | undefined {
    if (this.inMemoryProducts) return undefined;
    const docs = CatalogueIndexRegistry.shared().productsFor({ tenantId, mapping, getDb: () => openCatalogueDatabase(this.dbProvider) });
    if (!docs) return undefined;
    let collection = this.indexCollections.get(docs);
    if (!collection) { collection = new MemoryProductCollection(docs); this.indexCollections.set(docs, collection); }
    return collection;
  }

  /**
   * The products collection to query: the in-memory copy when there is one, falling back to the database for a filter the copy
   * cannot evaluate, so the answer is always the database's.
   */
  private productCollection(db: any, index: MemoryProductCollection | undefined, onIndexUse?: () => void): any {
    const real = () => db.collection(COLLECTION_PRODUCTS);
    if (!index) return real();
    const viaIndex = async <T>(run: (source: any) => Promise<T>): Promise<T> => {
      try {
        const answer = await run(index);
        onIndexUse?.();
        return answer;
      } catch (err) {
        if (!(err instanceof UnsupportedFilter)) throw err;
        console.warn(`[CatalogueIndex] ${err.message}; asking the database`);
        return run(real());
      }
    };
    return {
      find: (filter: any) => ({
        limit: (count: number) => ({ toArray: () => viaIndex((source) => source.find(filter).limit(count).toArray()) }),
        toArray: () => viaIndex((source) => source.find(filter).toArray()),
      }),
      countDocuments: (filter: any) => viaIndex((source) => source.countDocuments(filter)),
      distinct: (field: string, filter: any) => viaIndex((source) => source.distinct(field, filter)),
    };
  }

  /**
   * How many products sit under each category path (a path covers everything below it), counted with the same tenant, availability
   * and scope rules a search applies. Used to describe a range to the customer; it returns counts only.
   */
  async countInCategoryPaths(paths: string[][], ctx: ExecutionContext): Promise<number[]> {
    let mapping: ResolvedCatalogMapping;
    try {
      mapping = resolveCatalogMapping(ctx.packSettings?.catalogMapping);
    } catch {
      return paths.map(() => 0);
    }
    const tenantId = ctx.tenantId;
    const scopes = paths.map((path) => cleanCategoryPaths([path]));

    if (this.inMemoryProducts) {
      const visible = this.inMemoryProducts.filter((p) => {
        const owner = mapping.tenantFields.map((field) => readPath(p, field)).find((value) => value !== undefined);
        return !(owner !== undefined && owner !== tenantId) && classifyAvailability(p, mapping) !== 'excluded';
      });
      return scopes.map((categoryPaths) =>
        categoryPaths.length === 0
          ? 0
          : visible.filter((p) => categoryScopeMatches(mapping, { categoryIds: [], categoryPaths, excludeCategoryIds: [] }, p)).length);
    }

    const uri = process.env.MONGODB_URI;
    if (!this.dbProvider && !uri) return paths.map(() => 0);
    try {
      const db = this.dbProvider
        ? await this.dbProvider()
        : (await connectToDatabase(uri!, process.env.MONGODB_DB_NAME || 'journeyx')).db;
      const products = this.productCollection(db, this.indexedProducts(tenantId, mapping));
      return await Promise.all(scopes.map(async (categoryPaths) => {
        if (categoryPaths.length === 0) return 0;
        const key = `${tenantId}\u0001${JSON.stringify(categoryPaths)}`;
        const hit = this.countCache.get(key);
        if (hit && Date.now() - hit.at < CatalogSearchHandler.COUNT_TTL_MS) return hit.count;
        const { filter, and } = buildCatalogueBaseFilter(mapping, tenantId);
        const scoped: any = { ...filter, $and: [...and, ...buildCategoryScopeClauses(mapping, { categoryIds: [], categoryPaths, excludeCategoryIds: [] })] };
        const count: number = await products.countDocuments(scoped);
        if (this.countCache.size >= CatalogSearchHandler.COUNT_CACHE_MAX) this.countCache.delete(this.countCache.keys().next().value as string);
        this.countCache.set(key, { at: Date.now(), count });
        return count;
      }));
    } catch (err: any) {
      console.warn(`[CatalogSearchHandler] category count failed: ${err?.message || err}`);
      return paths.map(() => 0);
    }
  }

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
    const exactId = typeof input.sku === 'string' ? input.sku.trim() : '';
    let servedFromIndex = false;
    const category = input.category || input.productType || '';
    const categoryIds = Array.isArray(input.categoryIds) ? input.categoryIds.filter(Boolean) : [];
    const categoryPaths = cleanCategoryPaths(input.categoryPaths);
    // A scope that was supplied but is unusable must narrow to nothing, never silently widen to the whole catalogue.
    if (Array.isArray(input.categoryPaths) && input.categoryPaths.length > 0 && categoryPaths.length === 0 && categoryIds.length === 0) {
      return { items: [], total: 0, error: 'invalid_category_scope' };
    }
    const excludeCategoryIds = Array.isArray(input.excludeCategoryIds) ? input.excludeCategoryIds.filter(Boolean) : [];
    const limit = Math.min(input.maxResults || 10, input.facetSample ? FACET_SAMPLE_LIMIT : 50);

    // Dynamic glossary expansion from tenant's OKF release or pack vocabulary
    let okfConcepts = (ctx as any).okfConcepts || (ctx as any).okfRelease?.concepts || (ctx as any).okfContent?.concepts;
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

    const isAgent = Boolean(
      input.isAgentMode ||
      (ctx as any).isAgentMode ||
      (ctx as any).release?.extensions?.agentMode === true ||
      (ctx as any).release?.extensions?.agentMode?.enabled === true ||
      (ctx as any).release?.extensions?.dialoguePolicy?.agentMode === true
    );

    const rawStopWords =
      (ctx as any)?.conversationPolicy?.stopWords ||
      (ctx as any)?.packSettings?.conversationPolicy?.stopWords ||
      (ctx as any)?.release?.conversationPolicy?.stopWords;
    const stopWords = Array.isArray(rawStopWords)
      ? new Set<string>(rawStopWords.map((w: string) => String(w).toLowerCase().trim()))
      : rawStopWords instanceof Set
        ? rawStopWords
        : undefined;

    const hasDefs = (d: any): d is Record<string, AttributeDefinition> =>
      d && typeof d === 'object' && Object.keys(d).length > 0;

    const attrDefs: Record<string, AttributeDefinition> =
      (hasDefs(input.attributeDefinitions) ? input.attributeDefinitions : undefined) ||
      (hasDefs((mapping as any).attributeDefinitions) ? (mapping as any).attributeDefinitions : undefined) ||
      (hasDefs((ctx as any)?.release?.catalogMapping?.attributeDefinitions) ? (ctx as any).release.catalogMapping.attributeDefinitions : undefined) ||
      (hasDefs((ctx as any)?.packSettings?.catalogMapping?.attributeDefinitions) ? (ctx as any).packSettings.catalogMapping.attributeDefinitions : undefined) ||
      {};

    const rawInputAttrs: Record<string, any> = {
      ...(input.attributes || {}),
      ...(input.attributeFilters || {}),
      ...Object.fromEntries(
        Object.keys(attrDefs)
          .filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '')
          .map((k) => [k, input[k]])
      ),
    };

    const specs = isAgent ? extractSearchSpecs({
      query,
      keywords: input.keywords,
      productType: input.productType,
      brand: input.brand,
      attributes: rawInputAttrs,
      attributeDefinitions: attrDefs,
      glossaryIndex,
    }) : undefined;

    // Top-level input keys that the tenant mapping declares as attributes behave as attribute filters.
    const declaredFilterKeys = Object.keys(mapping.attributeAliases);
    const reservedStructuredKeys = new Set([
      'brand', 'keywords', 'productType',
      ...Object.keys(attrDefs),
    ]);
    const attributeFilters: Record<string, any> = isAgent
      ? {}
      : {
          ...(input.attributeFilters || {}),
          ...Object.fromEntries(declaredFilterKeys
            .filter((key) => !reservedStructuredKeys.has(key))
            .filter((key) => (input as any)[key] !== undefined && (input as any)[key] !== null && (input as any)[key] !== '')
            .map((key) => [key, (input as any)[key]])),
        };

    const primaryLocale =
      (ctx as any)?.release?.profile?.primaryLocale ||
      (ctx as any)?.packSettings?.profile?.primaryLocale ||
      (ctx as any)?.release?.primaryLocale ||
      (ctx as any)?.packSettings?.primaryLocale ||
      (ctx as any)?.locale ||
      input.locale ||
      'en';
    const stem = (w: string) => stemPatternForLocale(w, primaryLocale);

    // A product type the model names ("PVC pipe fittings", "clothesline") rarely equals the catalogue's category text ("PVC Pipe & Fittings",
    // "Clotheslines"). Match when every word of it appears in the text, whatever the punctuation, plural or word order.
    // A product type names a department as readily as a shelf ("plasterboard" is the parent of "Standard Board"), so it is
    // looked for in the category's own text and in every level of its path.
    const typePaths = [...new Set([...mapping.categoryPaths, ...mapping.categoryHierarchyPaths])];
    const connectorWords = connectorWordsForLocale(primaryLocale);
    const typeWordsOf = (value: string): string[] =>
      value.toLowerCase().replace(/[®™]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !connectorWords.has(w));
    const typeMatchers = (value: string): RegExp[] => typeWordsOf(value).map((w) => new RegExp(`\\b${stem(w)}`, 'i'));
    const typeMatches = (value: string, haystack: string): boolean => {
      const matchers = typeMatchers(value);
      return matchers.length === 0 ? haystack.includes(value.toLowerCase()) : matchers.every((rx) => rx.test(haystack));
    };

    const fetchCandidates = async (
      activeSpecs?: StructuredSearchSpecs,
      activeCategory?: string,
      kwMode: 'all' | 'any' = 'all',
      options: { filterInStock?: boolean; allowTokenDisjunction?: boolean; keywordsInMemory?: boolean } = {}
    ): Promise<any[]> => {
      let docs: any[] = [];
      const tokens = (!isAgent && query) ? tokenizeQuery(query, glossaryIndex, stopWords) : [];
      const textOf = (doc: any, paths: string[]): string => paths
        .map((path) => readPath(doc, path))
        .map((value) => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value)))
        .join(' ')
        .toLowerCase();

      if (this.inMemoryProducts) {
        if (isAgent) {
          const wordRegexCache = new Map<string, RegExp[]>();
          const getWordRegexes = (w: string): RegExp[] => {
            const wClean = w.toLowerCase().replace(/[®™]/g, '').trim();
            if (!wClean) return [];
            let cached = wordRegexCache.get(wClean);
            if (!cached) {
              const syns = glossaryIndex.get(wClean) || [];
              const patterns = [stem(wClean), ...syns.map(stem)].filter(Boolean);
              cached = patterns.map((pat) => new RegExp(`\\b${pat}\\b`, 'i'));
              wordRegexCache.set(wClean, cached);
            }
            return cached;
          };

          const attrRegexMap = new Map<string, RegExp>();
          if (activeSpecs?.attributeVariants) {
            for (const [attrName, variants] of Object.entries(activeSpecs.attributeVariants)) {
              if (variants && variants.length > 0) {
                attrRegexMap.set(
                  attrName,
                  new RegExp(`(?:^|[^a-z0-9])(?:${variants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i')
                );
              }
            }
          }

          docs = this.inMemoryProducts.filter((p) => {
            const owner = mapping.tenantFields.map((path) => readPath(p, path)).find((value) => value !== undefined);
            if (owner !== undefined && owner !== tenantId) return false;
            if (classifyAvailability(p, mapping) === 'excluded') return false;
            if (activeCategory && !typeMatches(activeCategory, textOf(p, typePaths)) && !typeMatches(activeCategory, textOf(p, mapping.titlePaths))) return false;
            if (!categoryScopeMatches(mapping, { categoryIds, categoryPaths, excludeCategoryIds }, p)) return false;
            if (exactId && !mapping.identifierPaths.some((path) => String(readPath(p, path) ?? '') === exactId)) return false;

            if (activeSpecs?.brand) {
              const cleanBrand = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
              const brandTarget = cleanBrand(activeSpecs.brand);
              const brandText = textOf(p, mapping.brandPaths);
              const brandAttr = readAttribute(p, 'brand', mapping);
              const title = textOf(p, mapping.titlePaths);
              const search = textOf(p, mapping.searchPaths);
              const brandMatch =
                cleanBrand(brandText).includes(brandTarget) ||
                (brandAttr && cleanBrand(String(brandAttr)).includes(brandTarget)) ||
                cleanBrand(title).includes(brandTarget) ||
                cleanBrand(search).includes(brandTarget);
              if (!brandMatch) return false;
            }

            if (activeSpecs?.attributeVariants) {
              for (const [attrName, variants] of Object.entries(activeSpecs.attributeVariants)) {
                if (!variants || variants.length === 0) continue;
                // Fast path: Check stored pre-extracted attribute on product first!
                const storedAttr = p.attributes?.[attrName] ?? p[attrName] ?? readAttribute(p, attrName, mapping);
                if (storedAttr != null && storedAttr !== '') {
                  const storedNorm = String(storedAttr).trim().toLowerCase().replace(/\s+/g, '');
                  const matchesStored = variants.some((v) => v.toLowerCase().replace(/\s+/g, '') === storedNorm);
                  if (matchesStored) continue;
                }
                const regex = attrRegexMap.get(attrName);
                if (regex) {
                  const title = textOf(p, mapping.titlePaths);
                  const search = textOf(p, mapping.searchPaths);
                  const attr = readAttribute(p, attrName, mapping) || p[attrName] || p.attributes?.[attrName];
                  const matchesAttr = regex.test(title) || regex.test(search) || (attr != null && regex.test(String(attr)));
                  if (!matchesAttr) return false;
                }
              }
            }

            if (activeSpecs?.keywords && activeSpecs.keywords.length > 0) {
              const search = textOf(p, mapping.searchPaths);
              const title = textOf(p, mapping.titlePaths);
              const cat = textOf(p, mapping.categoryPaths);
              const brand = textOf(p, mapping.brandPaths);
              const allText = `${title} ${cat} ${brand} ${search}`.toLowerCase().replace(/[®™]/g, '');

              const matchesWord = (w: string): boolean => {
                const rxs = getWordRegexes(w);
                return rxs.some((rx) => rx.test(allText));
              };

              const matchesKw = (kw: string): boolean => {
                const kwClean = kw.toLowerCase().replace(/[®™]/g, '').trim();
                if (!kwClean) return false;
                if (allText.includes(kwClean)) return true;
                const syns = glossaryIndex.get(kwClean);
                if (syns && syns.some((s) => allText.includes(s.toLowerCase()))) return true;
                const words = kwClean.split(/\s+/).filter(Boolean);
                if (words.length > 1) {
                  return words.every(matchesWord);
                }
                return matchesWord(kwClean);
              };

              if (options.allowTokenDisjunction) {
                const words = activeSpecs.keywords
                  .flatMap((kw) => kw.replace(/[®™]/g, '').split(/\s+/))
                  .map((w) => w.trim())
                  .filter((w) => w.length > 2);
                if (words.length > 0 && !words.some(matchesWord)) return false;
              } else if (kwMode === 'all') {
                for (const kw of activeSpecs.keywords) {
                  if (!matchesKw(kw)) return false;
                }
              } else {
                const hasAny = activeSpecs.keywords.some(matchesKw);
                if (!hasAny) return false;
              }
            }

            return true;
          });
        } else {
          docs = this.inMemoryProducts.filter((p) => {
            const owner = mapping.tenantFields.map((path) => readPath(p, path)).find((value) => value !== undefined);
            if (owner !== undefined && owner !== tenantId) return false;
            if (classifyAvailability(p, mapping) === 'excluded') return false;
            if (activeCategory && !typeMatches(activeCategory, textOf(p, typePaths))) return false;
            if (!categoryScopeMatches(mapping, { categoryIds, categoryPaths, excludeCategoryIds }, p)) return false;
            if (exactId && !mapping.identifierPaths.some((path) => String(readPath(p, path) ?? '') === exactId)) return false;
            if (query && !exactId) {
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
        }
      } else {
        const uri = process.env.MONGODB_URI;
        if (!uri && !this.dbProvider) {
          return [];
        }

        try {
          if (!db) {
            db = this.dbProvider
              ? await this.dbProvider()
              : (await connectToDatabase(uri!, process.env.MONGODB_DB_NAME || 'journeyx')).db;
          }

          const { filter, and } = buildCatalogueBaseFilter(mapping, tenantId);
          const products = this.productCollection(db, this.indexedProducts(tenantId, mapping), () => { servedFromIndex = true; });
          const anyOf = (paths: string[], matcher: any) => paths.map((path) => ({ [path]: matcher }));
          const strongSearchPaths = (): string[] => [...new Set([
            ...mapping.titlePaths, ...mapping.brandPaths, ...mapping.categoryPaths, ...mapping.categoryHierarchyPaths, ...mapping.identifierPaths,
          ])];

          let typeClause: Record<string, unknown> | undefined;
          if (activeCategory) {
            const words = typeWordsOf(activeCategory);
            const regex = words.length > 0
              ? new RegExp(words.map((w) => `(?=.*\\b${stem(w)})`).join(''), 'i')
              : new RegExp(escapeRegex(activeCategory), 'i');
            typeClause = {
              $or: [
                ...anyOf(typePaths, regex),
                ...anyOf(mapping.titlePaths, regex),
              ],
            };
            and.push(typeClause);
          }
          and.push(...buildCategoryScopeClauses(mapping, { categoryIds, categoryPaths, excludeCategoryIds }));

          if (isAgent && exactId) {
            // A product asked for by its identifier is that product and nothing else: the keyword search below would ignore the
            // identifier and answer with whatever comes first. Ask for the identifier alone first (the field the database indexes),
            // then for any identifier field if that finds nothing.
            const quick = await products
              .find({ [mapping.tenantFields[0]]: tenantId, [mapping.identifierPaths[0]]: exactId, ...(and.length > 0 ? { $and: [...and] } : {}) })
              .limit(mapping.candidateLimit)
              .toArray();
            docs = quick.length > 0
              ? quick
              : await products
                .find({ ...filter, $and: [...and, { $or: mapping.identifierPaths.map((path) => ({ [path]: exactId })) }] })
                .limit(mapping.candidateLimit)
                .toArray();
          } else if (isAgent) {
            if (activeSpecs?.brand) {
              const brandPattern = escapeRegex(activeSpecs.brand).replace(/\s+/g, '[^a-zA-Z0-9]*');
              const brandRegex = new RegExp(brandPattern, 'i');
              and.push({
                $or: [
                  ...anyOf(mapping.brandPaths, brandRegex),
                  ...anyOf(mapping.searchPaths, brandRegex),
                  ...anyOf(mapping.titlePaths, brandRegex),
                ],
              });
            }
            if (activeSpecs?.attributeVariants) {
              for (const [attrName, variants] of Object.entries(activeSpecs.attributeVariants)) {
                if (!variants || variants.length === 0) continue;
                const regex = new RegExp(`(?:^|[^a-z0-9])(?:${variants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i');
                and.push({
                  $or: [
                    { [`attributes.${attrName}`]: { $in: variants } },
                    { [attrName]: { $in: variants } },
                    { [`attributes.${attrName}`]: regex },
                    { [attrName]: regex },
                    ...mapping.attributeContainers.map((c) => ({ [`${c}.${attrName}`]: regex })),
                    ...anyOf(mapping.titlePaths, regex),
                    ...anyOf(mapping.searchPaths, regex),
                  ],
                });
              }
            }
            // The clauses that require the keywords (every one, or any, per kwMode) to appear in `paths`.
            const keywordList = activeSpecs?.keywords || [];
            const keywordClausesFor = (paths: string[]): any[] => {
              const kwClauses: any[] = [];
              if (keywordList.length === 0) return kwClauses;
              const buildWordMatcher = (w: string) => {
                const wClean = w.toLowerCase().replace(/[®™]/g, '').trim();
                const syns = glossaryIndex.get(wClean) || [];
                const patterns = [stem(wClean), ...syns.map(stem)].filter(Boolean);
                const rx = new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'i');
                return { $or: anyOf(paths, rx) };
              };

              if (options.allowTokenDisjunction) {
                const words = keywordList
                  .flatMap((kw) => kw.replace(/[®™]/g, '').split(/\s+/))
                  .map((w) => w.trim())
                  .filter((w) => w.length > 2);
                for (const w of words) {
                  kwClauses.push(buildWordMatcher(w));
                }
              } else {
                for (const kw of keywordList) {
                  const kwClean = kw.trim();
                  if (!kwClean) continue;
                  const syns = glossaryIndex.get(kwClean.toLowerCase()) || [];
                  const words = kwClean.replace(/[®™]/g, '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
                  if (words.length > 1) {
                    const wordClauses = words.map(buildWordMatcher);
                    const phrasePatterns = [escapeRegex(kwClean.replace(/[®™]/g, '')), ...syns.map((s) => escapeRegex(s.replace(/[®™]/g, '')))];
                    const phraseRegex = new RegExp(`\\b(?:${phrasePatterns.join('|')})`, 'i');
                    kwClauses.push({
                      $or: [
                        { $and: wordClauses },
                        ...anyOf(paths, phraseRegex),
                      ],
                    });
                  } else {
                    const patterns = [stem(kwClean), ...syns.map(stem)].filter(Boolean);
                    const kwRegex = new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'i');
                    kwClauses.push({ $or: anyOf(paths, kwRegex) });
                  }
                }
              }

              return kwClauses.length === 0 ? [] : kwMode === 'all' ? kwClauses : [{ $or: kwClauses }];
            };

            const runFind = (extra: any[], limit: number = mapping.candidateLimit, base: any[] = and) => {
              const clauses = [...base, ...extra];
              const scoped: any = { ...filter };
              if (clauses.length > 0) scoped.$and = clauses; else delete scoped.$and;
              return products.find(scoped).limit(limit).toArray();
            };

            if (keywordList.length === 0) {
              docs = await runFind([]);
            } else if (options.keywordsInMemory) {
              // Matching loose words against every product's description makes the database read all of them (seconds). The product
              // type narrows the shelf cheaply, so take that shelf and look for the words in the products themselves.
              // The shelf is every category whose text names the type; matching those exact values is far cheaper than a pattern over
              // every product. Only if no category names it does the pattern over titles and paths decide.
              let shelfClauses: any[] | undefined;
              if (activeCategory && typeClause) {
                const categoryValues = await this.distinctCategoryValues(products, `${tenantId}:${COLLECTION_PRODUCTS}`, { $or: filter.$or }, typePaths);
                const named = typePaths
                  .map((field) => ({ field, values: (categoryValues[field] || []).filter((value) => typeMatches(activeCategory, value.toLowerCase())) }))
                  .filter((entry) => entry.values.length > 0);
                if (named.length > 0) shelfClauses = [{ $or: named.map((entry) => ({ [entry.field]: { $in: entry.values } })) }];
              }
              const shelfLimit = mapping.candidateLimit * 4;
              const shelf = shelfClauses
                ? await runFind(shelfClauses, shelfLimit, and.filter((clause) => clause !== typeClause))
                : await runFind([], shelfLimit);
              const wordMatchers = [...new Set(keywordList
                .flatMap((kw) => kw.replace(/[®™]/g, '').split(/\s+/))
                .map((w) => w.trim().toLowerCase())
                .filter((w) => w.length > 2))]
                .map((w) => new RegExp(`\\b(?:${[stem(w), ...(glossaryIndex.get(w) || []).map(stem)].filter(Boolean).join('|')})\\b`, 'i'));
              const textPaths = [...new Set([...strongSearchPaths(), ...mapping.searchPaths])];
              docs = shelf.filter((doc) => {
                const text = textOf(doc, textPaths);
                return wordMatchers.some((rx) => rx.test(text));
              }).slice(0, mapping.candidateLimit);
            } else {
              // Only the first `candidateLimit` hits are ranked, so which fields count decides what can be found at all. A word that is
              // common in descriptions and keyword lists ("plasterboard", a brand) would fill the limit with incidental matches and
              // push out the products it names in their title, brand or category. Look in those fields first, then fill the rest
              // from every searchable field.
              const strongPaths = strongSearchPaths();
              const [strongDocs, anyFieldDocs] = await Promise.all([
                runFind(keywordClausesFor(strongPaths)),
                runFind(keywordClausesFor(mapping.searchPaths)),
              ]);
              const keyOf = (doc: any) => String(doc?._id ?? doc?.parentSku ?? doc?.sku);
              const seen = new Set(strongDocs.map(keyOf));
              docs = [...strongDocs];
              for (const doc of anyFieldDocs) {
                if (docs.length >= mapping.candidateLimit) break;
                if (!seen.has(keyOf(doc))) docs.push(doc);
              }
            }
          } else {
            let quickDocs: any[] | undefined;
            if (exactId) {
              // The first identifier field with the tenant field is the one the database indexes: ask for that alone first, because a
              // filter that names every identifier field cannot use the index and reads the whole catalogue.
              const quick = await products
                .find({ [mapping.tenantFields[0]]: tenantId, [mapping.identifierPaths[0]]: exactId, ...(and.length > 0 ? { $and: [...and] } : {}) })
                .limit(mapping.candidateLimit)
                .toArray();
              if (quick.length > 0) quickDocs = quick;
              else and.push({ $or: mapping.identifierPaths.map((path) => ({ [path]: exactId })) });
            } else if (query) {
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

            docs = quickDocs ?? await products
              .find(filter)
              .limit(mapping.candidateLimit)
              .toArray();

            if (tokens.length > 0 && docs.length > 0) {
              docs.sort((a, b) => scoreDocumentRelevance(b, tokens, mapping) - scoreDocumentRelevance(a, tokens, mapping));
            }
          }
        } catch (err: any) {
          console.warn('[CatalogSearchHandler] Failed to query catalog:', err.message);
          return [];
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
          if (!isAgent) {
            kwScoreMap.set(key, scoreDocumentRelevance(doc, tokens, mapping));
          }
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
          if (isAgent) {
            return { doc, finalScore: rrf };
          }
          const kwScore = kwScoreMap.get(key) || scoreDocumentRelevance(doc, tokens, mapping);
          const finalScore = rrf * 1000 + kwScore;
          return { doc, finalScore };
        });

        fused.sort((a, b) => b.finalScore - a.finalScore);
        docs = fused.map((f) => f.doc);
      }

      // Agent searches carry their words as keywords, not as a free-text query, so nothing ranked them: the best matches could sit
      // anywhere in the candidates. Rank by how many of the asked words each product matches, counting a word that few candidates
      // contain (a size, a brand) for more than one nearly all of them contain (a treatment, a material).
      if (isAgent && activeSpecs?.keywords && activeSpecs.keywords.length > 0 && docs.length > 1) {
        const words = [...new Set(activeSpecs.keywords
          .flatMap((kw) => kw.replace(/[®™]/g, '').split(/\s+/))
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w.length > 1 && !(stopWords && (stopWords as Set<string>).has?.(w))))];
        if (words.length > 0) {
          const regexes = words.map((w) => {
            const alternatives = [stem(w), ...(glossaryIndex.get(w) || []).map(stem)].filter(Boolean);
            return new RegExp(`\\b(?:${alternatives.join('|')})`, 'i');
          });
          const rows = docs.map((d) => ({
            d,
            name: textOf(d, mapping.titlePaths),
            // What the product is and who makes it (its shelf, every level above it, its brand) counts as much as where it sits.
            cat: textOf(d, [...typePaths, ...mapping.brandPaths]),
            rest: textOf(d, mapping.searchPaths),
          }));
          const weights = regexes.map((rx) => {
            const df = rows.filter((r) => rx.test(`${r.name} ${r.cat} ${r.rest}`)).length;
            return Math.log((rows.length + 1) / (df + 0.5));
          });
          const scored = rows.map((r) => ({
            d: r.d,
            s: regexes.reduce((sum, rx, i) => sum + (rx.test(r.name) ? 3 : rx.test(r.cat) ? 2 : rx.test(r.rest) ? 1 : 0) * weights[i], 0),
          }));
          scored.sort((x, y) => y.s - x.s);
          docs = scored.map((x) => x.d);
        }
      }

      const requestedCurrency = input.currency ? input.currency.toUpperCase() : undefined;
      return docs
        .map((doc: any) => {
          const normalized = normalizeCatalogProduct(doc, mapping, { title: 'Product', category: 'General' });
          return {
            ...normalized.attributes,
            sku: normalized.sku,
            title: normalized.title,
            name: normalized.title,
            brand: doc.brand || doc.Brand || readAttribute(doc, 'brand', mapping) || (normalized.attributes as any)?.brand || (normalized.attributes as any)?.Brand || undefined,
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
            ...(normalized.categoryTrail.length > 0 ? { categoryTrail: normalized.categoryTrail } : {}),
            ...(normalized.accessorySkus.length > 0 ? { accessorySkus: normalized.accessorySkus } : {}),
            ...(normalized.highlights.length > 0 ? { highlights: normalized.highlights } : {}),
            ...(normalized.cautions.length > 0 ? { cautions: normalized.cautions } : {}),
            ...(normalized.rating !== undefined ? { rating: normalized.rating } : {}),
            ...(normalized.ratingCount !== undefined ? { ratingCount: normalized.ratingCount } : {}),
            ...(normalized.branchesAvailable !== undefined ? { branchesAvailable: normalized.branchesAvailable } : {}),
            ...(normalized.branchesTotal !== undefined ? { branchesTotal: normalized.branchesTotal } : {}),
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
          const shouldFilterStock = options.filterInStock ?? Boolean(input.inStockOnly);
          if (shouldFilterStock && item.inStock !== true) return false;
          for (const [k, expectedVal] of Object.entries(attributeFilters)) {
            if (isAgent && reservedStructuredKeys.has(k)) continue;
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
    };

    let items = await fetchCandidates(specs, category, 'all');
    const relaxedConstraints: string[] = [];

    // Step 0: Relax inStockOnly (if requested but returned 0 items, e.g. feed does not track stock or branch-only stock)
    if (items.length === 0 && input.inStockOnly) {
      const relaxedStock = await fetchCandidates(specs, category, 'all', { filterInStock: false });
      if (relaxedStock.length > 0) {
        items = relaxedStock;
        relaxedConstraints.push('inStockOnly');
      }
    }

    // Task S2: Graceful degradation, generic.
    // If a search returns no results, relax the least important constraints in order
    // (attributes, then product type, then keywords), keep the vector and keyword fallback,
    // and return which constraints were relaxed so the AI can tell the customer.
    // Only when relaxation also fails may the tool say nothing was found.
    if (items.length === 0 && (specs || category || input.inStockOnly)) {
      const hasKeywords = Boolean(specs?.keywords && specs.keywords.length > 0);
      const hasType = Boolean(category || specs?.productType);
      const canRelaxAttributes = hasKeywords || hasType;
      const noStockFilter = { filterInStock: false };

      // Step 1: Relax attributes (only if there are keywords or product type anchoring the search)
      if (canRelaxAttributes && specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
        const noAttrSpecs: StructuredSearchSpecs = {
          ...specs,
          attributes: {},
          attributeVariants: {},
        };
        const relaxedItems = await fetchCandidates(noAttrSpecs, category, 'all', noStockFilter);
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (input.inStockOnly && !relaxedConstraints.includes('inStockOnly')) {
            relaxedConstraints.push('inStockOnly');
          }
          relaxedConstraints.push('attributes');
        }
      }

      // Step 1b (on request): loosen the keywords to "any of them" but KEEP the product type. A type is a steadier anchor than a
      // phrase the customer's own words made up ("bathroom wall"), and dropping it returns products from unrelated shelves.
      if (items.length === 0 && input.relaxKeywordsFirst && hasType && hasKeywords) {
        const typeKeptSpecs: StructuredSearchSpecs = { ...specs, attributes: {}, attributeVariants: {} };
        const relaxedItems = await fetchCandidates(typeKeptSpecs, category, 'any', { filterInStock: false, allowTokenDisjunction: true, keywordsInMemory: true });
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (input.inStockOnly && !relaxedConstraints.includes('inStockOnly')) {
            relaxedConstraints.push('inStockOnly');
          }
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          relaxedConstraints.push('keywords');
        }
      }

      // Step 2: Relax product type / category (only if there are keywords anchoring the search)
      if (items.length === 0 && hasType && hasKeywords) {
        const noTypeKeywords = specs?.keywords?.filter((k) =>
          !specs.productType || k.toLowerCase() !== specs.productType.toLowerCase()
        );
        const noTypeSpecs: StructuredSearchSpecs = {
          ...(specs
            ? {
                ...specs,
                attributes: {},
                attributeVariants: {},
                productType: undefined,
                keywords: noTypeKeywords && noTypeKeywords.length > 0 ? noTypeKeywords : undefined,
              }
            : { attributes: {}, attributeVariants: {} }),
        };
        const relaxedItems = await fetchCandidates(noTypeSpecs, undefined, 'all', noStockFilter);
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (input.inStockOnly && !relaxedConstraints.includes('inStockOnly')) {
            relaxedConstraints.push('inStockOnly');
          }
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          relaxedConstraints.push('productType');
        }
      }

      // Step 3: Relax keywords to 'any'
      if (items.length === 0 && hasKeywords) {
        const anyKwSpecs: StructuredSearchSpecs = {
          ...(specs
            ? {
                ...specs,
                attributes: {},
                attributeVariants: {},
                productType: undefined,
              }
            : { attributes: {}, attributeVariants: {} }),
        };
        const relaxedItems = await fetchCandidates(anyKwSpecs, undefined, 'any', noStockFilter);
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (input.inStockOnly && !relaxedConstraints.includes('inStockOnly')) {
            relaxedConstraints.push('inStockOnly');
          }
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          if (hasType) {
            relaxedConstraints.push('productType');
          }
          relaxedConstraints.push('keywords');
        }
      }

      // Step 4: Relax compound keywords to individual token disjunction
      if (items.length === 0 && hasKeywords) {
        const tokenSpecs: StructuredSearchSpecs = {
          ...(specs
            ? {
                ...specs,
                attributes: {},
                attributeVariants: {},
                productType: undefined,
              }
            : { attributes: {}, attributeVariants: {} }),
        };
        const relaxedItems = await fetchCandidates(tokenSpecs, undefined, 'any', {
          filterInStock: false,
          allowTokenDisjunction: true,
        });
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (input.inStockOnly && !relaxedConstraints.includes('inStockOnly')) {
            relaxedConstraints.push('inStockOnly');
          }
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          if (hasType) {
            relaxedConstraints.push('productType');
          }
          if (!relaxedConstraints.includes('keywords')) {
            relaxedConstraints.push('keywords');
          }
        }
      }
    }

    const stockFilterDropped = relaxedConstraints.includes('inStockOnly');

    return {
      items,
      total: items.length,
      ...(relaxedConstraints.length > 0 ? { relaxedConstraints } : {}),
      ...(stockFilterDropped ? { stockFilterDropped: true } : {}),
      ...(servedFromIndex ? { source: 'index' } : {}),
    };
  }
}
