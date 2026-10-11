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
  attributeContainers: Paths.optional(),
  imagePaths: Paths.optional(),
  certificationPaths: Paths.optional(),
  quantityPaths: Paths.optional(),
  candidateLimit: z.number().int().min(1).max(1000).optional(),
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
  attributeContainers: string[];
  imagePaths: string[];
  certificationPaths: string[];
  quantityPaths: string[];
  candidateLimit: number;
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
}

function declaredCurrency(doc: unknown, mapping: ResolvedCatalogMapping): string | undefined {
  const paths = mapping.pricing.sources.map((source) => source.currencyPath).filter((path): path is string => !!path);
  const value = firstString(doc, paths);
  return value ? value.toUpperCase() : undefined;
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
