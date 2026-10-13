import {
  CatalogMappingSchema, classifyAvailability, extractPrice, extractStock, normalizeCatalogProduct, readPath, resolveCatalogMapping,
  type ResolvedCatalogMapping,
} from './catalog-mapping';

export type MappingIssueSeverity = 'error' | 'warning' | 'info';

export interface MappingIssue {
  severity: MappingIssueSeverity;
  code: string;
  /** The mapping field a person would change to fix it. */
  field: string;
  message: string;
  /** How many sampled products are affected, and what share of the sample that is. */
  affected: number;
  share: number;
  examples: string[];
}

export interface MappingCheckRow {
  sku: string;
  title: string;
  category: string;
  categoryPath: string[];
  priceCents: number | null;
  currency?: string;
  currencyUndeclared: boolean;
  inStock?: boolean;
  availability: 'available' | 'excluded' | 'unpriced';
}

/** A field found on real products, so a person can point a meaning at it instead of guessing its name. */
export interface CatalogueField {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'mixed';
  /** Share (0..1) of sampled products that carry a value at this path. */
  seen: number;
  example: string;
}

export interface MappingCheckResult {
  /** No error-level issue: the mapping is safe to save. */
  ok: boolean;
  mappingErrors: string[];
  sampleSize: number;
  /** Share (0..1) of sampled products for which each meaning could be read through the mapping. */
  readable: Record<'identifier' | 'title' | 'description' | 'brand' | 'category' | 'categoryPath' | 'price' | 'currency' | 'stock' | 'image', number>;
  currencies: Record<string, number>;
  availability: Record<'available' | 'excluded' | 'unpriced', number>;
  /** Every field found on the sampled products (objects are descended into, arrays are listed whole), most common first. */
  fields: CatalogueField[];
  /** Lifecycle values found in the status fields, and how the mapping currently treats each. */
  statuses: Array<{ value: string; count: number; treatedAs: 'excluded' | 'unpriced' | 'available' }>;
  /** Configured paths that read nothing in any sampled product (per meaning). */
  unusedPaths: Array<{ field: string; path: string }>;
  issues: MappingIssue[];
  rows: MappingCheckRow[];
}

const SAMPLE_EXAMPLES = 3;

function emptyResult(mappingErrors: string[]): MappingCheckResult {
  return {
    ok: false, mappingErrors, sampleSize: 0,
    readable: { identifier: 0, title: 0, description: 0, brand: 0, category: 0, categoryPath: 0, price: 0, currency: 0, stock: 0, image: 0 },
    currencies: {}, availability: { available: 0, excluded: 0, unpriced: 0 }, fields: [], statuses: [], unusedPaths: [],
    issues: mappingErrors.map((message) => ({ severity: 'error' as const, code: 'mapping_invalid', field: 'catalogMapping', message, affected: 0, share: 0, examples: [] })),
    rows: [],
  };
}

const FIELD_LIMIT = 120;
const MAX_DEPTH = 4;

function describeFields(sample: unknown[]): CatalogueField[] {
  const seen = new Map<string, { count: number; types: Set<string>; example: string }>();
  const kind = (value: unknown): CatalogueField['type'] =>
    Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
  const show = (value: unknown) => {
    const text = Array.isArray(value) ? JSON.stringify(value) : typeof value === 'object' ? '{…}' : String(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  };
  const visit = (value: unknown, prefix: string, depth: number, found: Set<string>) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || child === undefined || child === null || child === '') continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (!found.has(path)) {
        found.add(path);
        const entry = seen.get(path) ?? { count: 0, types: new Set<string>(), example: show(child) };
        entry.count++; entry.types.add(kind(child));
        seen.set(path, entry);
      }
      if (child && typeof child === 'object' && !Array.isArray(child) && depth < MAX_DEPTH) visit(child, path, depth + 1, found);
    }
  };
  for (const product of sample) visit(product, '', 0, new Set<string>());
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .slice(0, FIELD_LIMIT)
    .map(([path, entry]) => ({ path, type: (entry.types.size === 1 ? [...entry.types][0] : 'mixed') as CatalogueField['type'], seen: entry.count / Math.max(1, sample.length), example: entry.example }));
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/**
 * Checks a catalogue mapping against real product records before it is saved. It answers, for the sample you give it:
 * can each meaning (identifier, title, price, currency, stock, category, hierarchy path, lifecycle) be read through this
 * mapping, how many products would be quoted without a currency, which lifecycle values are in use, and which configured
 * paths read nothing. Pure and domain-neutral: the products come from the caller, the vocabulary from the mapping.
 */
export function checkCatalogMapping(input: unknown, products: unknown[], options: { rowLimit?: number } = {}): MappingCheckResult {
  let mapping: ResolvedCatalogMapping;
  try {
    CatalogMappingSchema.parse(input ?? {});
    mapping = resolveCatalogMapping(input ?? undefined);
  } catch (error: any) {
    const issues = Array.isArray(error?.issues)
      ? error.issues.map((issue: any) => `${(issue.path || []).join('.') || 'catalogMapping'}: ${issue.message}`)
      : [String(error?.message || error)];
    return emptyResult(issues);
  }

  const sample = products.filter((product) => product && typeof product === 'object');
  const total = sample.length;
  // Products the mapping hides (discontinued, delisted…) are never quoted, so price, currency and stock are judged on the rest.
  const sellable = sample.filter((product) => classifyAvailability(product, mapping) !== 'excluded').length;
  const share = (count: number, of = total) => (of === 0 ? 0 : count / of);
  const counts = { identifier: 0, title: 0, description: 0, brand: 0, category: 0, categoryPath: 0, price: 0, currency: 0, stock: 0, image: 0 };
  const currencies: Record<string, number> = {};
  const availability = { available: 0, excluded: 0, unpriced: 0 };
  const statusCounts = new Map<string, number>();
  const issuesData = {
    noIdentifier: [] as string[], noTitle: [] as string[], noCategory: [] as string[], noPath: [] as string[], unpriced: [] as string[],
    undeclared: [] as string[], noStock: [] as string[],
  };
  const rows: MappingCheckRow[] = [];
  const label = (product: any, normalizedSku: string) => normalizedSku || String(product?._id ?? '(no identifier)');

  const read = (product: unknown, paths: string[]) => paths.some((path) => present(readPath(product, path)));
  const usedPaths = new Map<string, Set<string>>();
  const touch = (field: string, product: unknown, paths: string[]) => {
    for (const path of paths) if (present(readPath(product, path))) {
      if (!usedPaths.has(field)) usedPaths.set(field, new Set());
      usedPaths.get(field)!.add(path);
    }
  };
  const fields: Array<[string, string[]]> = [
    ['identifierPaths', mapping.identifierPaths], ['titlePaths', mapping.titlePaths], ['descriptionPaths', mapping.descriptionPaths],
    ['brandPaths', mapping.brandPaths], ['categoryPaths', mapping.categoryPaths], ['categoryHierarchyPaths', mapping.categoryHierarchyPaths],
    ['imagePaths', mapping.imagePaths], ['stock.booleanPaths', mapping.stock.booleanPaths], ['stock.countPaths', mapping.stock.countPaths],
    ['availability.statusPaths', mapping.availability.statusPaths], ['availability.excludeFlagPaths', mapping.availability.excludeFlagPaths],
    ['pricing.sources.path', mapping.pricing.sources.map((source) => source.path)],
    ['pricing.sources.currencyPath', mapping.pricing.sources.flatMap((source) => (source.currencyPath ? [source.currencyPath] : []))],
  ];

  for (const product of sample as any[]) {
    for (const [field, paths] of fields) touch(field, product, paths);
    const normalized = normalizeCatalogProduct(product, mapping, { title: '', category: '' });
    const priced = extractPrice(product, mapping);
    const id = label(product, normalized.sku);
    const hasPath = mapping.categoryHierarchyPaths.some((path) => Array.isArray(readPath(product, path)) && (readPath(product, path) as unknown[]).length > 0);
    const pathValue = (mapping.categoryHierarchyPaths.map((path) => readPath(product, path)).find((value) => Array.isArray(value) && value.length > 0) as unknown[] | undefined) ?? [];

    if (read(product, mapping.identifierPaths)) counts.identifier++; else issuesData.noIdentifier.push(id);
    if (read(product, mapping.titlePaths)) counts.title++; else issuesData.noTitle.push(id);
    if (read(product, mapping.descriptionPaths)) counts.description++;
    if (read(product, mapping.brandPaths)) counts.brand++;
    if (read(product, mapping.categoryPaths)) counts.category++; else issuesData.noCategory.push(id);
    if (hasPath) counts.categoryPath++; else issuesData.noPath.push(id);
    if (read(product, mapping.imagePaths)) counts.image++;

    const state = classifyAvailability(product, mapping);
    availability[state]++;
    for (const path of mapping.availability.statusPaths) {
      const value = readPath(product, path);
      if (typeof value === 'string' && value.trim()) statusCounts.set(value.trim(), (statusCounts.get(value.trim()) ?? 0) + 1);
    }

    if (state !== 'excluded') {
      if (priced.priceCents !== null) {
        counts.price++;
        if (priced.currency) { counts.currency++; currencies[priced.currency] = (currencies[priced.currency] ?? 0) + 1; }
      } else if (state !== 'unpriced') {
        issuesData.unpriced.push(id);
      }
      if (priced.currencyUndeclared) issuesData.undeclared.push(id);

      const stock = extractStock(product, mapping);
      if (stock !== undefined) counts.stock++; else issuesData.noStock.push(id);
    }

    if (rows.length < (options.rowLimit ?? 12)) {
      rows.push({
        sku: normalized.sku, title: normalized.title, category: normalized.category, categoryPath: pathValue.map(String),
        priceCents: normalized.priceCents, currency: normalized.currency, currencyUndeclared: normalized.currencyUndeclared,
        inStock: normalized.inStock, availability: state,
      });
    }
  }

  const excluded = new Set(mapping.availability.excludedStatuses.map((value) => value.toLowerCase()));
  const unpricedStatuses = new Set(mapping.availability.unpricedStatuses.map((value) => value.toLowerCase()));
  const statuses = [...statusCounts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({
    value, count, treatedAs: (excluded.has(value.toLowerCase()) ? 'excluded' : unpricedStatuses.has(value.toLowerCase()) ? 'unpriced' : 'available') as 'excluded' | 'unpriced' | 'available',
  }));

  const unusedPaths: MappingCheckResult['unusedPaths'] = [];
  if (total > 0) for (const [field, paths] of fields) for (const path of paths) if (!usedPaths.get(field)?.has(path)) unusedPaths.push({ field, path });

  const issues: MappingIssue[] = [];
  const add = (severity: MappingIssueSeverity, code: string, field: string, message: string, ids: string[], of = total) =>
    issues.push({ severity, code, field, message, affected: ids.length, share: share(ids.length, of), examples: ids.slice(0, SAMPLE_EXAMPLES) });

  if (total === 0) {
    add('warning', 'empty_sample', 'catalogMapping', 'There are no product records to check this mapping against.', []);
  } else {
    if (issuesData.noIdentifier.length) add(issuesData.noIdentifier.length === total ? 'error' : 'warning', 'identifier_unreadable', 'identifierPaths',
      `${issuesData.noIdentifier.length} of ${total} products have no value at any identifier path, so they could not be added to a basket or looked up by SKU.`, issuesData.noIdentifier);
    if (issuesData.noTitle.length) add(issuesData.noTitle.length === total ? 'error' : 'warning', 'title_unreadable', 'titlePaths',
      `${issuesData.noTitle.length} of ${total} products have no value at any title path, so they would be shown without a name.`, issuesData.noTitle);
    if (sellable > 0 && counts.price === 0 && issuesData.unpriced.length === sellable) add('error', 'price_unreadable', 'pricing.sources',
      'No sampled product has a price at any configured price source, so nothing could be quoted.', issuesData.unpriced, sellable);
    else if (issuesData.unpriced.length) add('warning', 'price_missing', 'pricing.sources',
      `${issuesData.unpriced.length} of ${sellable} products have no readable price and will be shown without one.`, issuesData.unpriced, sellable);
    if (issuesData.undeclared.length) add(share(issuesData.undeclared.length, sellable) >= 0.5 ? 'error' : 'warning', 'currency_undeclared', 'pricing.sources',
      `${issuesData.undeclared.length} of ${sellable} products have a price but no declared currency, so the price would not be quoted. Point a source at the field that holds the currency, or state the currency the feed is priced in.`, issuesData.undeclared, sellable);
    if (Object.keys(currencies).length > 1) add('warning', 'mixed_currencies', 'pricing.sources',
      `Prices are in more than one currency (${Object.entries(currencies).map(([code, count]) => `${code} ${count}`).join(', ')}). Products in a currency other than the shop's are filtered out; nothing is converted.`, []);
    if (sellable > 0 && counts.stock === 0) add('warning', 'stock_unreadable', 'stock', 'Stock could not be read for any sampled product, so availability will not be shown.', issuesData.noStock, sellable);
    if (counts.category === 0) add('warning', 'category_unreadable', 'categoryPaths', 'No sampled product has a category at any category path.', issuesData.noCategory);
    if (counts.categoryPath === 0) add('warning', 'hierarchy_unreadable', 'categoryHierarchyPaths',
      'No sampled product has a category hierarchy at any hierarchy path, so department → group → category scopes cannot match; only category names will.', issuesData.noPath);
    else if (issuesData.noPath.length) add('info', 'hierarchy_partial', 'categoryHierarchyPaths',
      `${issuesData.noPath.length} of ${total} products have no category hierarchy; they are reachable by category name only.`, issuesData.noPath);
    const unclassified = statuses.filter((entry) => entry.treatedAs === 'available' && entry.count > 0);
    if (unclassified.length) add('info', 'status_values', 'availability',
      `Lifecycle values in use and treated as available: ${unclassified.map((entry) => `"${entry.value}" (${entry.count})`).join(', ')}. List any that should hide a product or mark it unpriced.`, []);
    for (const source of mapping.pricing.sources) {
      if (!usedPaths.get('pricing.sources.path')?.has(source.path)) add('info', 'price_source_unused', 'pricing.sources', `Price source "${source.path}" is not present on any sampled product.`, []);
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'), mappingErrors: [], sampleSize: total,
    readable: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, ['price', 'currency', 'stock'].includes(key) ? share(count, sellable) : share(count)])) as MappingCheckResult['readable'],
    currencies, availability, fields: describeFields(sample), statuses, unusedPaths, issues, rows,
  };
}
