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
  isAgentMode?: boolean;
  keywords?: string[];
  productType?: string;
  size?: string;
  treatment?: string;
  rValue?: string;
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

export interface StructuredSearchSpecs {
  size?: string;
  sizeVariants?: string[];
  treatment?: string;
  treatmentVariants?: string[];
  rValue?: string;
  rValueVariants?: string[];
  brand?: string;
  productType?: string;
  keywords?: string[];
}

export interface QueryToken {
  stem: string;
  regex: RegExp;
  synonyms?: string[];
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveEquivalentSizes(rawSize: string, glossaryIndex?: Map<string, string[]>): string[] {
  if (!rawSize) return [];
  const clean = rawSize.trim().toLowerCase().replace(/\s+/g, ' ');
  const variants = new Set<string>();
  variants.add(clean);
  variants.add(clean.replace(/\s+/g, ''));

  const imperialToMetric: Record<string, { canonical: string; nominal: string; gauged: string; imperialVariants: string[] }> = {
    '4x2': {
      canonical: '100x50',
      nominal: '100 x 50',
      gauged: '90 x 45',
      imperialVariants: ['4x2', '4 x 2', '4 by 2', '2x4', '2 x 4'],
    },
    '6x2': {
      canonical: '150x50',
      nominal: '150 x 50',
      gauged: '140 x 45',
      imperialVariants: ['6x2', '6 x 2', '6 by 2'],
    },
    '3x2': {
      canonical: '75x50',
      nominal: '75 x 50',
      gauged: '70 x 45',
      imperialVariants: ['3x2', '3 x 2', '3 by 2'],
    },
    '8x2': {
      canonical: '200x50',
      nominal: '200 x 50',
      gauged: '190 x 45',
      imperialVariants: ['8x2', '8 x 2', '8 by 2'],
    },
    '4x4': {
      canonical: '100x100',
      nominal: '100 x 100',
      gauged: '88 x 88',
      imperialVariants: ['4x4', '4 x 4'],
    },
    '10x2': {
      canonical: '250x50',
      nominal: '250 x 50',
      gauged: '240 x 45',
      imperialVariants: ['10x2', '10 x 2'],
    },
    '12x2': {
      canonical: '300x50',
      nominal: '300 x 50',
      gauged: '290 x 45',
      imperialVariants: ['12x2', '12 x 2'],
    },
  };

  const impKey = clean.replace(/\s*(?:by|x|\*|×)\s*/i, 'x');
  if (imperialToMetric[impKey]) {
    const entry = imperialToMetric[impKey];
    for (const iv of entry.imperialVariants) variants.add(iv);
    variants.add(entry.canonical);
    variants.add(entry.nominal);
    variants.add(`${entry.canonical}mm`);
    variants.add(`${entry.nominal}mm`);
    variants.add(entry.gauged.replace(/\s+/g, ''));
    variants.add(entry.gauged);
    variants.add(`${entry.gauged.replace(/\s+/g, '')}mm`);
    variants.add(`${entry.gauged}mm`);
  }

  const metricMatch = clean.match(/^(\d{2,4})\s*[xX*×]\s*(\d{2,4})(?:\s*[xX*×]\s*(\d{2,4}))?(?:\s*mm)?$/);
  if (metricMatch) {
    const w = metricMatch[1];
    const h = metricMatch[2];
    const d = metricMatch[3];
    const noSpace = d ? `${w}x${h}x${d}` : `${w}x${h}`;
    const withSpace = d ? `${w} x ${h} x ${d}` : `${w} x ${h}`;
    variants.add(noSpace);
    variants.add(withSpace);
    variants.add(`${noSpace}mm`);
    variants.add(`${withSpace}mm`);

    for (const entry of Object.values(imperialToMetric)) {
      if (
        entry.canonical === noSpace ||
        entry.gauged.replace(/\s+/g, '') === noSpace ||
        entry.nominal === withSpace ||
        entry.gauged === withSpace
      ) {
        for (const iv of entry.imperialVariants) variants.add(iv);
        variants.add(entry.canonical);
        variants.add(entry.nominal);
        variants.add(`${entry.canonical}mm`);
        variants.add(`${entry.nominal}mm`);
        variants.add(entry.gauged.replace(/\s+/g, ''));
        variants.add(entry.gauged);
        variants.add(`${entry.gauged.replace(/\s+/g, '')}mm`);
        variants.add(`${entry.gauged}mm`);
      }
    }
  }

  if (glossaryIndex) {
    for (const v of Array.from(variants)) {
      const syns = glossaryIndex.get(v.toLowerCase());
      if (syns) {
        for (const s of syns) variants.add(s.toLowerCase());
      }
    }
  }

  return Array.from(variants);
}

export function resolveEquivalentTreatments(rawTreatment: string, glossaryIndex?: Map<string, string[]>): string[] {
  if (!rawTreatment) return [];
  const clean = rawTreatment.trim();
  const variants = new Set<string>();
  variants.add(clean);

  const hMatch = clean.match(/^H\s*([1-6])(?:\.([1-2]))?$/i);
  if (hMatch) {
    const major = hMatch[1];
    const minor = hMatch[2];
    if (minor) {
      variants.add(`H${major}.${minor}`);
      variants.add(`H${major}${minor}`);
      variants.add(`H${major} ${minor}`);
      variants.add(`H${major}-${minor}`);
      variants.add(`H ${major}.${minor}`);
    } else {
      variants.add(`H${major}`);
      variants.add(`H ${major}`);
      variants.add(`H-${major}`);
    }
  } else if (/^cca$/i.test(clean)) {
    variants.add('CCA');
    variants.add('C.C.A.');
  } else if (/^boron$/i.test(clean)) {
    variants.add('Boron');
  } else if (/^untreated|ut$/i.test(clean)) {
    variants.add('Untreated');
    variants.add('UT');
    variants.add('Non-Treated');
  }

  if (glossaryIndex) {
    for (const v of Array.from(variants)) {
      const syns = glossaryIndex.get(v.toLowerCase());
      if (syns) {
        for (const s of syns) variants.add(s);
      }
    }
  }

  return Array.from(variants);
}

export function resolveEquivalentRValues(rawRValue: string, glossaryIndex?: Map<string, string[]>): string[] {
  if (!rawRValue) return [];
  const clean = rawRValue.trim();
  const variants = new Set<string>();
  variants.add(clean);

  const rMatch = clean.match(/^R\s*([0-9])(?:\.([0-9]))?$/i);
  if (rMatch) {
    const major = rMatch[1];
    const minor = rMatch[2];
    if (minor) {
      variants.add(`R${major}.${minor}`);
      variants.add(`R${major}${minor}`);
      variants.add(`R ${major}.${minor}`);
      variants.add(`R${major}-${minor}`);
      variants.add(`R ${major} ${minor}`);
    } else {
      variants.add(`R${major}`);
      variants.add(`R ${major}`);
      variants.add(`R-${major}`);
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

  return Array.from(variants);
}

export function extractSearchSpecs(params: {
  query?: string;
  keywords?: string[];
  productType?: string;
  size?: string;
  treatment?: string;
  rValue?: string;
  brand?: string;
  glossaryIndex?: Map<string, string[]>;
}): StructuredSearchSpecs {
  const fullText = [params.query, ...(params.keywords || [])].filter(Boolean).join(' ');

  let size = params.size?.trim();
  if (!size && fullText) {
    const metric = fullText.match(/\b(\d{2,4})\s*[xX*×]\s*(\d{2,4})(?:\s*[xX*×]\s*(\d{2,4}))?(?:\s*mm)?\b/i);
    if (metric) {
      size = metric[0];
    } else {
      const imperial = fullText.match(/\b([2-9]|10|12)\s*[xX*×]\s*([1-9]|10|12)\b/i);
      if (imperial) {
        size = imperial[0];
      }
    }
  }

  let treatment = params.treatment?.trim();
  if (!treatment && fullText) {
    const treat = fullText.match(/\b(H[1-6](?:\.[1-2])?|CCA|Boron|LOSP|Untreated)\b/i);
    if (treat) {
      treatment = treat[0];
    }
  }

  let rValue = params.rValue?.trim();
  if (!rValue && fullText) {
    const rMatch = fullText.match(/\b(R\s*[0-9](?:\.[0-9])?)\b/i);
    if (rMatch) {
      rValue = rMatch[0].replace(/\s+/g, '');
    }
  }

  const sizeVariants = size ? resolveEquivalentSizes(size, params.glossaryIndex) : undefined;
  const treatmentVariants = treatment ? resolveEquivalentTreatments(treatment, params.glossaryIndex) : undefined;
  const rValueVariants = rValue ? resolveEquivalentRValues(rValue, params.glossaryIndex) : undefined;

  const keywords: string[] = [];
  if (params.keywords && params.keywords.length > 0) {
    keywords.push(...params.keywords);
  } else if (params.productType) {
    keywords.push(params.productType);
  } else if (params.query) {
    let residual = params.query;
    if (size) residual = residual.replace(size, ' ');
    if (treatment) residual = residual.replace(new RegExp(`\\b${escapeRegex(treatment)}\\b`, 'i'), ' ');
    if (rValue) residual = residual.replace(new RegExp(`\\b${escapeRegex(rValue)}\\b`, 'i'), ' ');
    const words = residual.trim().split(/\s+/).filter((w) => w.length > 1);
    if (words.length > 0) {
      keywords.push(...words);
    }
  }

  return {
    size,
    sizeVariants,
    treatment,
    treatmentVariants,
    rValue,
    rValueVariants,
    brand: params.brand?.trim(),
    productType: params.productType?.trim(),
    keywords: keywords.length > 0 ? keywords : undefined,
  };
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

    const specs = isAgent ? extractSearchSpecs({
      query,
      keywords: input.keywords,
      productType: input.productType,
      size: input.size,
      treatment: input.treatment,
      rValue: input.rValue,
      brand: input.brand,
      glossaryIndex,
    }) : undefined;

    // Top-level input keys that the tenant mapping declares as attributes behave as attribute filters.
    const declaredFilterKeys = Object.keys(mapping.attributeAliases);
    const reservedStructuredKeys = new Set(['size', 'treatment', 'rValue', 'brand', 'keywords', 'productType']);
    const attributeFilters: Record<string, any> = {
      ...(input.attributeFilters || {}),
      ...Object.fromEntries(declaredFilterKeys
        .filter((key) => !isAgent || !reservedStructuredKeys.has(key))
        .filter((key) => (input as any)[key] !== undefined && (input as any)[key] !== null && (input as any)[key] !== '')
        .map((key) => [key, (input as any)[key]])),
    };

    let docs: any[] = [];
    const tokens = (!isAgent && query) ? tokenizeQuery(query, glossaryIndex, stopWords) : [];
    const textOf = (doc: any, paths: string[]): string => paths
      .map((path) => readPath(doc, path))
      .map((value) => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value)))
      .join(' ')
      .toLowerCase();

    const sizeRegex = specs?.sizeVariants?.length
      ? new RegExp(`(?:^|[^a-z0-9])(?:${specs.sizeVariants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i')
      : undefined;

    const treatmentRegex = specs?.treatmentVariants?.length
      ? new RegExp(`(?:^|[^a-z0-9])(?:${specs.treatmentVariants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i')
      : undefined;

    const rValueRegex = specs?.rValueVariants?.length
      ? new RegExp(`(?:^|[^a-z0-9])(?:${specs.rValueVariants.map(escapeRegex).join('|')})(?:[^a-z0-9]|$)`, 'i')
      : undefined;

    if (this.inMemoryProducts) {
      if (isAgent) {
        docs = this.inMemoryProducts.filter((p) => {
          const owner = mapping.tenantFields.map((path) => readPath(p, path)).find((value) => value !== undefined);
          if (owner !== undefined && owner !== tenantId) return false;
          if (classifyAvailability(p, mapping) === 'excluded') return false;
          if (category && !textOf(p, mapping.categoryPaths).includes(category.toLowerCase())) return false;
          if (!categoryScopeMatches(mapping, { categoryIds, categoryPaths, excludeCategoryIds }, p)) return false;

          if (specs?.brand) {
            const cleanBrand = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            const brandTarget = cleanBrand(specs.brand);
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

          if (sizeRegex) {
            const title = textOf(p, mapping.titlePaths);
            const search = textOf(p, mapping.searchPaths);
            const attr = readAttribute(p, 'size', mapping) || p.size || p.attributes?.size;
            const matchesSize = sizeRegex.test(title) || sizeRegex.test(search) || (attr && sizeRegex.test(String(attr)));
            if (!matchesSize) return false;
          }

          if (treatmentRegex) {
            const title = textOf(p, mapping.titlePaths);
            const search = textOf(p, mapping.searchPaths);
            const attr = readAttribute(p, 'treatment', mapping) || p.treatment || p.attributes?.treatment;
            const matchesTreatment = treatmentRegex.test(title) || treatmentRegex.test(search) || (attr && treatmentRegex.test(String(attr)));
            if (!matchesTreatment) return false;
          }

          if (rValueRegex) {
            const title = textOf(p, mapping.titlePaths);
            const search = textOf(p, mapping.searchPaths);
            const attr = readAttribute(p, 'rValue', mapping) || p.rValue || p.attributes?.rValue;
            const matchesR = rValueRegex.test(title) || rValueRegex.test(search) || (attr && rValueRegex.test(String(attr)));
            if (!matchesR) return false;
          }

          if (specs?.keywords && specs.keywords.length > 0) {
            const search = textOf(p, mapping.searchPaths);
            const title = textOf(p, mapping.titlePaths);
            const cat = textOf(p, mapping.categoryPaths);
            const allText = `${title} ${cat} ${search}`.toLowerCase();
            for (const kw of specs.keywords) {
              const kwLower = kw.toLowerCase().trim();
              if (!kwLower) continue;
              if (!allText.includes(kwLower)) {
                const syns = glossaryIndex.get(kwLower);
                const hasSyn = syns && syns.some((s) => allText.includes(s.toLowerCase()));
                if (!hasSyn) {
                  const words = kwLower.split(/\s+/).filter(Boolean);
                  if (words.length > 1) {
                    const allWordsMatch = words.every((w) => allText.includes(w) || (glossaryIndex.get(w)?.some((s) => allText.includes(s.toLowerCase()))));
                    if (!allWordsMatch) return false;
                  } else {
                    return false;
                  }
                }
              }
            }
          }

          return true;
        });
        // In agent mode, no JS scoring comparator: database / natural order preserved
      } else {
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

        if (isAgent) {
          if (specs?.brand) {
            const brandPattern = escapeRegex(specs.brand).replace(/\s+/g, '[^a-zA-Z0-9]*');
            const brandRegex = new RegExp(brandPattern, 'i');
            and.push({
              $or: [
                ...anyOf(mapping.brandPaths, brandRegex),
                ...anyOf(mapping.searchPaths, brandRegex),
                ...anyOf(mapping.titlePaths, brandRegex),
              ],
            });
          }
          if (sizeRegex) {
            and.push({
              $or: [
                ...anyOf(mapping.titlePaths, sizeRegex),
                ...anyOf(mapping.searchPaths, sizeRegex),
                ...mapping.attributeContainers.map((c) => ({ [`${c}.size`]: sizeRegex })),
                { size: sizeRegex },
              ],
            });
          }
          if (treatmentRegex) {
            and.push({
              $or: [
                ...anyOf(mapping.titlePaths, treatmentRegex),
                ...anyOf(mapping.searchPaths, treatmentRegex),
                ...mapping.attributeContainers.map((c) => ({ [`${c}.treatment`]: treatmentRegex })),
                { treatment: treatmentRegex },
              ],
            });
          }
          if (rValueRegex) {
            and.push({
              $or: [
                ...anyOf(mapping.titlePaths, rValueRegex),
                ...anyOf(mapping.searchPaths, rValueRegex),
                ...mapping.attributeContainers.map((c) => ({ [`${c}.rValue`]: rValueRegex })),
                { rValue: rValueRegex },
              ],
            });
          }
          if (specs?.keywords && specs.keywords.length > 0) {
            for (const kw of specs.keywords) {
              const kwClean = kw.trim();
              if (!kwClean) continue;
              const syns = glossaryIndex.get(kwClean.toLowerCase()) || [];
              const patterns = [escapeRegex(kwClean), ...syns.map(escapeRegex)];
              const kwRegex = new RegExp(`\\b(?:${patterns.join('|')})`, 'i');
              and.push({ $or: anyOf(mapping.searchPaths, kwRegex) });
            }
          }
          if (and.length === 0) delete filter.$and;

          docs = await db.collection(COLLECTION_PRODUCTS)
            .find(filter)
            .limit(mapping.candidateLimit)
            .toArray();
          // In agent mode, no JS scoring comparators applied!
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
