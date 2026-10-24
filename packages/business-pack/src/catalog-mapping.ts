import { z } from 'zod';
import defaults from './defaults/catalog-mapping.json';

/** Dotted field path: letters, digits, underscore and dots only. Operators ($) can never be injected. */
const FieldPath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, 'invalid field path');
const Paths = z.array(FieldPath);

export const PriceSourceSchema = z.object({
  path: FieldPath,
  unit: z.enum(['major', 'minor']),
  /** Field holding the currency this price is declared in. */
  currencyPath: FieldPath.optional(),
  /** Currency the tenant explicitly asserts for every price read from this source (e.g. a USD-only feed). */
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  /** Read `path` as a number, or as `{ min }`-style range using this sub-key. */
  rangeKey: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
});

/** Terms are matched as lower-case substrings of the catalogue category. */
export const ComponentCategoryRuleSchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
}).strict();

export const AttributeDefinitionSchema = z.object({
  description: z.string().optional(),
  type: z.string().optional(),
  examples: z.array(z.string()).optional(),
  extractionPatterns: z.array(z.string()).optional(),
  normalizer: z.string().optional(),
  equivalenceTable: z.record(z.string(), z.array(z.string())).optional(),
}).passthrough();

export type AttributeDefinition = z.infer<typeof AttributeDefinitionSchema>;

export const CatalogMappingSchema = z.object({
  version: z.string().optional(),
  tenantFields: Paths.optional(),
  identifierPaths: Paths.optional(),
  titlePaths: Paths.optional(),
  descriptionPaths: Paths.optional(),
  brandPaths: Paths.optional(),
  categoryPaths: Paths.optional(),
  categoryScopePaths: Paths.optional(),
  categoryHierarchyPaths: Paths.optional(),
  searchPaths: Paths.optional(),
  pricing: z.object({
    sources: z.array(PriceSourceSchema).optional(),
    /** When true (platform default) a price without a declared currency is treated as unpriced. */
    requireDeclaredCurrency: z.boolean().optional(),
  }).optional(),
  stock: z.object({ booleanPaths: Paths.optional(), countPaths: Paths.optional() }).optional(),
  availability: z.object({
    excludeFlagPaths: Paths.optional(),
    statusPaths: Paths.optional(),
    excludedStatuses: z.array(z.string().min(1)).optional(),
    unpricedStatuses: z.array(z.string().min(1)).optional(),
  }).optional(),
  attributeAliases: z.record(z.string(), z.array(z.string().min(1))).optional(),
  attributeDefinitions: z.record(z.string(), AttributeDefinitionSchema).optional(),
  attributeContainers: Paths.optional(),
  imagePaths: Paths.optional(),
  certificationPaths: Paths.optional(),
  quantityPaths: Paths.optional(),
  /** Lists of other products' SKUs the shop itself suggests with a product ("have you considered"), as SKU strings or objects carrying `sku`. */
  accessoryPaths: Paths.optional(),
  /** Lists of short feature statements on a product, shown on its card as why it fits. */
  highlightPaths: Paths.optional(),
  /** Patterns (case-insensitive) marking a feature statement as a warning ("should not be used where..."): shown as a caution, never as a reason to buy. */
  cautionPatterns: z.array(z.string().min(1).max(200)).optional(),
  ratingValuePaths: Paths.optional(),
  ratingCountPaths: Paths.optional(),
  /** Branches holding the product, and the branches asked, for an availability line. */
  branchAvailablePaths: Paths.optional(),
  branchTotalPaths: Paths.optional(),
  /** A flag that is true when the product can only be collected, and the list of ways it can be fulfilled (codes the tenant words in its own labels). */
  pickupOnlyPaths: Paths.optional(),
  deliveryOptionPaths: Paths.optional(),
  candidateLimit: z.number().int().min(1).max(1000).optional(),
  /** Which catalogue categories may fill which planner component categories (publication-time integrity). */
  componentCategoryRules: z.record(z.string().min(1), ComponentCategoryRuleSchema).optional(),
}).strict();

export type CatalogMappingInput = z.infer<typeof CatalogMappingSchema>;
export type PriceSource = z.infer<typeof PriceSourceSchema>;

export interface ResolvedCatalogMapping {
  version: string;
  tenantFields: string[];
  identifierPaths: string[];
  titlePaths: string[];
  descriptionPaths: string[];
  brandPaths: string[];
  categoryPaths: string[];
  categoryScopePaths: string[];
  categoryHierarchyPaths: string[];
  searchPaths: string[];
  pricing: { sources: PriceSource[]; requireDeclaredCurrency: boolean };
  stock: { booleanPaths: string[]; countPaths: string[] };
  availability: { excludeFlagPaths: string[]; statusPaths: string[]; excludedStatuses: string[]; unpricedStatuses: string[] };
  attributeAliases: Record<string, string[]>;
  attributeDefinitions: Record<string, AttributeDefinition>;
  attributeContainers: string[];
  imagePaths: string[];
  certificationPaths: string[];
  quantityPaths: string[];
  accessoryPaths: string[];
  highlightPaths: string[];
  cautionPatterns: string[];
  ratingValuePaths: string[];
  ratingCountPaths: string[];
  branchAvailablePaths: string[];
  branchTotalPaths: string[];
  pickupOnlyPaths: string[];
  deliveryOptionPaths: string[];
  candidateLimit: number;
  componentCategoryRules: Record<string, { allow?: string[]; deny?: string[] }>;
}

const PLATFORM_DEFAULTS = defaults as unknown as ResolvedCatalogMapping;

/** Tenant mapping replaces a default field wholesale; nothing is merged element by element. */
export function resolveCatalogMapping(tenant?: unknown): ResolvedCatalogMapping {
  if (tenant === undefined || tenant === null) return structuredClone(PLATFORM_DEFAULTS);
  const parsed = CatalogMappingSchema.parse(tenant);
  const base = structuredClone(PLATFORM_DEFAULTS);
  return {
    ...base,
    ...Object.fromEntries(Object.entries(parsed).filter(([key, value]) => value !== undefined && key !== 'pricing' && key !== 'stock' && key !== 'availability')),
    pricing: {
      sources: parsed.pricing?.sources ?? base.pricing.sources,
      requireDeclaredCurrency: parsed.pricing?.requireDeclaredCurrency ?? base.pricing.requireDeclaredCurrency,
    },
    stock: { ...base.stock, ...stripUndefined(parsed.stock) },
    availability: { ...base.availability, ...stripUndefined(parsed.availability) },
    attributeDefinitions: parsed.attributeDefinitions ?? base.attributeDefinitions ?? {},
  } as ResolvedCatalogMapping;
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function readPath(doc: unknown, path: string): unknown {
  let current: any = doc;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function firstValue(doc: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = readPath(doc, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function firstString(doc: unknown, paths: string[]): string | undefined {
  const value = firstValue(doc, paths);
  return typeof value === 'string' ? value : undefined;
}

export interface NormalizedPrice {
  priceCents: number | null;
  /** Only ever a currency declared by the product or asserted by the tenant mapping. */
  currency?: string;
  /** True when a numeric price exists but no declared currency could be established. */
  currencyUndeclared: boolean;
}

export function extractPrice(doc: unknown, mapping: ResolvedCatalogMapping): NormalizedPrice {
  let undeclared = false;
  for (const source of mapping.pricing.sources) {
    let raw = readPath(doc, source.path);
    if (raw && typeof raw === 'object' && source.rangeKey) raw = (raw as any)[source.rangeKey];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    const declared = (source.currencyPath ? firstString(doc, [source.currencyPath]) : undefined) ?? source.currency;
    if (!declared && mapping.pricing.requireDeclaredCurrency) { undeclared = true; continue; }
    const priceCents = source.unit === 'minor' ? Math.round(raw) : Math.round(raw * 100);
    return { priceCents, currency: declared ? declared.toUpperCase() : undefined, currencyUndeclared: false };
  }
  return { priceCents: null, currencyUndeclared: undeclared };
}

export function extractStock(doc: unknown, mapping: ResolvedCatalogMapping): boolean | undefined {
  for (const path of mapping.stock.booleanPaths) {
    const value = readPath(doc, path);
    if (typeof value === 'boolean') return value;
  }
  for (const path of mapping.stock.countPaths) {
    const value = readPath(doc, path);
    if (typeof value === 'number') return value > 0;
  }
  return undefined;
}

export type CatalogAvailabilityState = 'available' | 'excluded' | 'unpriced';

/** Single source of truth for lifecycle vocabulary; replaces hard-coded status lists in callers. */
export function classifyAvailability(doc: unknown, mapping: ResolvedCatalogMapping): CatalogAvailabilityState {
  if (mapping.availability.excludeFlagPaths.some((path) => readPath(doc, path) === true)) return 'excluded';
  const statuses = mapping.availability.statusPaths
    .map((path) => readPath(doc, path))
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  const excluded = new Set(mapping.availability.excludedStatuses.map((value) => value.toLowerCase()));
  if (statuses.some((status) => excluded.has(status))) return 'excluded';
  const unpriced = new Set(mapping.availability.unpricedStatuses.map((value) => value.toLowerCase()));
  if (statuses.some((status) => unpriced.has(status))) return 'unpriced';
  return 'available';
}

export interface NormalizedCatalogProduct {
  sku: string;
  title: string;
  description: string;
  category: string;
  priceCents: number | null;
  price?: number;
  currency?: string;
  currencyUndeclared: boolean;
  inStock?: boolean;
  availableQuantity?: number;
  certifications: string[];
  imageUrl: string;
  availability: CatalogAvailabilityState;
  attributes: Record<string, unknown>;
  /** Short feature statements the catalogue lists for this product (at most eight). */
  highlights: string[];
  /** Feature statements that read as warnings (at most two), kept apart from the highlights. */
  cautions: string[];
  rating?: number;
  ratingCount?: number;
  branchesAvailable?: number;
  branchesTotal?: number;
  /** True when the record says the product can only be collected. Undefined when the record does not say. */
  pickupOnly?: boolean;
  /** The ways the record says the product can be fulfilled, as the record writes them (empty when it lists none). */
  deliveryOptions: string[];
  /** The product's shelf, from the broadest group down to the one it sits in (empty when the record carries none). */
  categoryTrail: string[];
  /** SKUs the shop itself suggests with this product (empty when the record carries none). */
  accessorySkus: string[];
}

const MAX_HIGHLIGHTS = 8;
const HIGHLIGHT_LENGTH = { min: 3, max: 160 };

function firstNumber(doc: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = readPath(doc, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function highlightsOf(doc: unknown, paths: string[], cautionPatterns: string[]): { highlights: string[]; cautions: string[] } {
  const cautionTests = cautionPatterns.flatMap((source) => { try { return [new RegExp(source, 'i')]; } catch { return []; } });
  for (const path of paths) {
    const value = readPath(doc, path);
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
      const text = typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : '';
      if (text.length < HIGHLIGHT_LENGTH.min || text.length > HIGHLIGHT_LENGTH.max || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push(text);
      if (out.length >= MAX_HIGHLIGHTS) break;
    }
    if (out.length > 0) {
      const isCaution = (text: string) => cautionTests.some((test) => test.test(text));
      return { highlights: out.filter((text) => !isCaution(text)), cautions: out.filter(isCaution).slice(0, 2) };
    }
  }
  return { highlights: [], cautions: [] };
}

function declaredCurrency(doc: unknown, mapping: ResolvedCatalogMapping): string | undefined {
  const paths = mapping.pricing.sources.map((source) => source.currencyPath).filter((path): path is string => !!path);
  const value = firstString(doc, paths);
  return value ? value.toUpperCase() : undefined;
}

/** The SKUs the record lists as suggested with it: a list of SKU strings, a list of objects with `sku`, or an object whose `items` is one of those. */
function accessorySkusOf(doc: unknown, mapping: ResolvedCatalogMapping): string[] {
  const skus: string[] = [];
  for (const path of mapping.accessoryPaths) {
    const value: any = readPath(doc, path);
    const list: unknown[] = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
    for (const entry of list) {
      const sku = typeof entry === 'string' ? entry : typeof (entry as any)?.sku === 'string' ? (entry as any).sku : '';
      if (sku.trim() && !skus.includes(sku.trim())) skus.push(sku.trim());
    }
    if (skus.length > 0) break;
  }
  return skus.slice(0, 12);
}

function categoryTrailOf(doc: unknown, mapping: ResolvedCatalogMapping): string[] {
  for (const path of mapping.categoryHierarchyPaths) {
    const value = readPath(doc, path);
    if (Array.isArray(value) && value.length > 0 && value.every((segment) => typeof segment === 'string')) return value as string[];
  }
  return [];
}

export function normalizeCatalogProduct(doc: any, mapping: ResolvedCatalogMapping, labels: { title: string; category: string }): NormalizedCatalogProduct {
  const priced = extractPrice(doc, mapping);
  const availability = classifyAvailability(doc, mapping);
  const priceCents = availability === 'unpriced' ? null : priced.priceCents;
  const attributes: Record<string, unknown> = {};
  for (const container of [...mapping.attributeContainers].reverse()) {
    const value = readPath(doc, container);
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(attributes, value);
  }
  for (const [key, value] of Object.entries(doc || {})) {
    if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && !(key in attributes)) attributes[key] = value;
  }
  const certifications = firstValue(doc, mapping.certificationPaths);
  const imageValue = firstValue(doc, mapping.imagePaths);
  const quantity = firstValue(doc, mapping.quantityPaths);
  return {
    sku: String(firstValue(doc, mapping.identifierPaths) ?? doc?._id ?? ''),
    title: firstString(doc, mapping.titlePaths) || labels.title,
    description: firstString(doc, mapping.descriptionPaths) || '',
    category: firstString(doc, mapping.categoryPaths) || labels.category,
    priceCents,
    price: priceCents != null ? priceCents / 100 : undefined,
    // A priced item carries the currency it was priced in; an unpriced one only a currency the product itself declares.
    currency: priceCents != null ? priced.currency : declaredCurrency(doc, mapping),
    currencyUndeclared: priceCents == null && priced.currencyUndeclared,
    inStock: extractStock(doc, mapping),
    availableQuantity: typeof quantity === 'number' ? quantity : undefined,
    certifications: Array.isArray(certifications) ? certifications.filter((c): c is string => typeof c === 'string') : [],
    imageUrl: typeof imageValue === 'string' ? imageValue : '',
    availability,
    attributes,
    ...highlightsOf(doc, mapping.highlightPaths, mapping.cautionPatterns),
    rating: firstNumber(doc, mapping.ratingValuePaths),
    ratingCount: firstNumber(doc, mapping.ratingCountPaths),
    branchesAvailable: firstNumber(doc, mapping.branchAvailablePaths),
    branchesTotal: firstNumber(doc, mapping.branchTotalPaths),
    pickupOnly: (() => { const value = firstValue(doc, mapping.pickupOnlyPaths); return typeof value === 'boolean' ? value : undefined; })(),
    deliveryOptions: (() => { const value = firstValue(doc, mapping.deliveryOptionPaths); return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 8) : []; })(),
    categoryTrail: categoryTrailOf(doc, mapping),
    accessorySkus: accessorySkusOf(doc, mapping),
  };
}

/** Attribute lookup honouring tenant aliases (e.g. a filter key mapped to the field the catalog really uses). */
export function readAttribute(item: { attributes: Record<string, unknown> } & Record<string, unknown>, key: string, mapping: ResolvedCatalogMapping): unknown {
  for (const candidate of [key, ...(mapping.attributeAliases[key] || [])]) {
    const value = item[candidate] ?? item.attributes?.[candidate];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Publication-time integrity: may a catalogue product of `catalogueCategory` fill a component of
 * `componentCategory`? Rules are tenant data; a component with no rule is not constrained.
 */
export function isComponentCategoryCompatible(
  componentCategory: string,
  catalogueCategory: string,
  rules: ResolvedCatalogMapping['componentCategoryRules'],
): boolean {
  const component = (componentCategory || '').toLowerCase().trim();
  const category = (catalogueCategory || '').toLowerCase().trim();
  if (!category) return true;
  const rule = Object.entries(rules).find(([key]) => key.toLowerCase() === component)?.[1];
  if (!rule) return true;
  const has = (terms?: string[]) => (terms || []).some((term) => category.includes(term.toLowerCase()));
  if (has(rule.deny)) return false;
  return rule.allow && rule.allow.length > 0 ? has(rule.allow) : true;
}
