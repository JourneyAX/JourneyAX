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
  keywords?: string[];
  productType?: string;
  brand?: string;
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

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



/**
 * Normalizes an attribute value according to the pack attribute definition normalizer.
 */
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
    const category = input.category || input.productType || '';
    const categoryIds = Array.isArray(input.categoryIds) ? input.categoryIds.filter(Boolean) : [];
    const categoryPaths = cleanCategoryPaths(input.categoryPaths);
    // A scope that was supplied but is unusable must narrow to nothing, never silently widen to the whole catalogue.
    if (Array.isArray(input.categoryPaths) && input.categoryPaths.length > 0 && categoryPaths.length === 0 && categoryIds.length === 0) {
      return { items: [], total: 0, error: 'invalid_category_scope' };
    }
    const excludeCategoryIds = Array.isArray(input.excludeCategoryIds) ? input.excludeCategoryIds.filter(Boolean) : [];
    const limit = Math.min(input.maxResults || 10, 50);

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

    const fetchCandidates = async (
      activeSpecs?: StructuredSearchSpecs,
      activeCategory?: string,
      kwMode: 'all' | 'any' = 'all'
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
          docs = this.inMemoryProducts.filter((p) => {
            const owner = mapping.tenantFields.map((path) => readPath(p, path)).find((value) => value !== undefined);
            if (owner !== undefined && owner !== tenantId) return false;
            if (classifyAvailability(p, mapping) === 'excluded') return false;
            if (activeCategory && !textOf(p, mapping.categoryPaths).includes(activeCategory.toLowerCase()) && !textOf(p, mapping.titlePaths).includes(activeCategory.toLowerCase())) return false;
            if (!categoryScopeMatches(mapping, { categoryIds, categoryPaths, excludeCategoryIds }, p)) return false;

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
                const regex = new RegExp(`(?:^|[^a-z0-9])(?:${variants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i');
                const title = textOf(p, mapping.titlePaths);
                const search = textOf(p, mapping.searchPaths);
                const attr = readAttribute(p, attrName, mapping) || p[attrName] || p.attributes?.[attrName];
                const matchesAttr = regex.test(title) || regex.test(search) || (attr != null && regex.test(String(attr)));
                if (!matchesAttr) return false;
              }
            }

            if (activeSpecs?.keywords && activeSpecs.keywords.length > 0) {
              const search = textOf(p, mapping.searchPaths);
              const title = textOf(p, mapping.titlePaths);
              const cat = textOf(p, mapping.categoryPaths);
              const allText = `${title} ${cat} ${search}`.toLowerCase();

              const matchesKw = (kw: string): boolean => {
                const kwLower = kw.toLowerCase().trim();
                if (!kwLower) return false;
                if (allText.includes(kwLower)) return true;
                const syns = glossaryIndex.get(kwLower);
                if (syns && syns.some((s) => allText.includes(s.toLowerCase()))) return true;
                const words = kwLower.split(/\s+/).filter(Boolean);
                if (words.length > 1) {
                  return words.every((w) => allText.includes(w) || (glossaryIndex.get(w)?.some((s) => allText.includes(s.toLowerCase()))));
                }
                return false;
              };

              if (kwMode === 'all') {
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
            if (activeCategory && !textOf(p, mapping.categoryPaths).includes(activeCategory.toLowerCase())) return false;
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
          const anyOf = (paths: string[], matcher: any) => paths.map((path) => ({ [path]: matcher }));

          if (activeCategory) {
            const regex = new RegExp(escapeRegex(activeCategory), 'i');
            and.push({
              $or: [
                ...anyOf(mapping.categoryPaths, regex),
                ...anyOf(mapping.titlePaths, regex),
              ],
            });
          }
          and.push(...buildCategoryScopeClauses(mapping, { categoryIds, categoryPaths, excludeCategoryIds }));

          if (isAgent) {
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
                    ...anyOf(mapping.titlePaths, regex),
                    ...anyOf(mapping.searchPaths, regex),
                    ...mapping.attributeContainers.map((c) => ({ [`${c}.${attrName}`]: regex })),
                    { [attrName]: regex },
                  ],
                });
              }
            }
            if (activeSpecs?.keywords && activeSpecs.keywords.length > 0) {
              const kwClauses: any[] = [];
              for (const kw of activeSpecs.keywords) {
                const kwClean = kw.trim();
                if (!kwClean) continue;
                const syns = glossaryIndex.get(kwClean.toLowerCase()) || [];
                const patterns = [escapeRegex(kwClean), ...syns.map(escapeRegex)];
                const kwRegex = new RegExp(`\\b(?:${patterns.join('|')})`, 'i');
                kwClauses.push({ $or: anyOf(mapping.searchPaths, kwRegex) });
              }
              if (kwClauses.length > 0) {
                if (kwMode === 'all') {
                  and.push(...kwClauses);
                } else {
                  and.push({ $or: kwClauses.flatMap((c) => c.$or) });
                }
              }
            }
            if (and.length === 0) delete filter.$and;

            docs = await db.collection(COLLECTION_PRODUCTS)
              .find(filter)
              .limit(mapping.candidateLimit)
              .toArray();
          } else {
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

      const requestedCurrency = input.currency ? input.currency.toUpperCase() : undefined;
      return docs
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

    // Task S2: Graceful degradation, generic.
    // If a search returns no results, relax the least important constraints in order
    // (attributes, then product type, then keywords), keep the vector and keyword fallback,
    // and return which constraints were relaxed so the AI can tell the customer.
    // Only when relaxation also fails may the tool say nothing was found.
    if (items.length === 0 && (specs || category)) {
      const hasKeywords = Boolean(specs?.keywords && specs.keywords.length > 0);
      const hasType = Boolean(category || specs?.productType);
      const canRelaxAttributes = hasKeywords || hasType;

      // Step 1: Relax attributes (only if there are keywords or product type anchoring the search)
      if (canRelaxAttributes && specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
        const noAttrSpecs: StructuredSearchSpecs = {
          ...specs,
          attributes: {},
          attributeVariants: {},
        };
        const relaxedItems = await fetchCandidates(noAttrSpecs, category, 'all');
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          relaxedConstraints.push('attributes');
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
        const relaxedItems = await fetchCandidates(noTypeSpecs, undefined, 'all');
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          relaxedConstraints.push('productType');
        }
      }

      // Step 3: Relax keywords
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
        const relaxedItems = await fetchCandidates(anyKwSpecs, undefined, 'any');
        if (relaxedItems.length > 0) {
          items = relaxedItems;
          if (specs?.attributeVariants && Object.keys(specs.attributeVariants).length > 0) {
            relaxedConstraints.push('attributes');
          }
          if (hasType) {
            relaxedConstraints.push('productType');
          }
          relaxedConstraints.push('keywords');
        }
      }
    }

    return {
      items,
      total: items.length,
      ...(relaxedConstraints.length > 0 ? { relaxedConstraints } : {}),
    };
  }
}
