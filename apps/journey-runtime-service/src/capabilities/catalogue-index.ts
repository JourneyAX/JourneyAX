import { buildCatalogueBaseFilter, type ResolvedCatalogMapping } from '@journeyax/business-pack';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

/**
 * A slim in-memory copy of a tenant's catalogue, so a search is a few milliseconds of work in this process instead of a pattern
 * scan over every product in the database (seconds, and slower still when several run at once).
 *
 * The copy keeps what the search, ranking, availability, price, stock and attribute code reads: every field the tenant's catalogue
 * mapping names, plus every top-level text, number and flag field of a product (the catalogue normaliser turns those into the
 * product's attributes). Long lists and galleries the mapping does not name (per-branch stock, narratives, extra photos) stay in
 * the database. Nothing here knows any tenant, field name or industry: the field list comes from the mapping.
 *
 * It is read-only, loaded in the background, replaced as a whole only by a complete healthy load, and off unless
 * CATALOGUE_INDEX=on. A caller that gets no copy uses the database exactly as before.
 */

/** Top-level value types a product's own fields can have that the catalogue normaliser copies into its attributes. */
const SCALAR_TYPES = ['string', 'double', 'int', 'long', 'bool'];
const SCALARS_FIELD = '__scalars';
const NUMERIC_SEGMENT = /^\d+$/;
/** A reload whose result is smaller than this share of the copy in use is treated as a failed load. */
const MIN_RELOAD_SHARE = 0.5;
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_MS = 60 * 1000;
const DEFAULT_MAX_DOCS = 150_000;
/** Yield to other work after this many products so a load never holds the process for long. */
const YIELD_EVERY = 2000;

/** Every field path the catalogue code reads from a product, taken from the tenant's own mapping. */
export function mappedFieldPaths(mapping: ResolvedCatalogMapping): string[] {
  const priced = mapping.pricing.sources.flatMap((source) => [source.path, source.currencyPath].filter((path): path is string => !!path));
  return [...new Set([
    ...mapping.tenantFields, ...mapping.identifierPaths, ...mapping.titlePaths, ...mapping.descriptionPaths, ...mapping.brandPaths,
    ...mapping.categoryPaths, ...mapping.categoryScopePaths, ...mapping.categoryHierarchyPaths, ...mapping.searchPaths,
    ...priced, ...mapping.stock.booleanPaths, ...mapping.stock.countPaths,
    ...mapping.availability.excludeFlagPaths, ...mapping.availability.statusPaths,
    ...mapping.attributeContainers, ...mapping.imagePaths, ...mapping.certificationPaths, ...mapping.quantityPaths,
  ])];
}

/**
 * A database projection for those paths. A path through a list position ("images.0.url") keeps only the list up to that position,
 * and a path below another listed path is covered by it (two overlapping paths would be refused by the database).
 */
export function buildSlimProjection(paths: string[]): Record<string, unknown> {
  const whole = new Set<string>();
  const listed = new Map<string, number>();
  for (const path of paths) {
    const segments = path.split('.').filter(Boolean);
    const position = segments.findIndex((segment) => NUMERIC_SEGMENT.test(segment));
    if (position === 0 || segments.length === 0) continue;
    if (position < 0) { whole.add(segments.join('.')); continue; }
    const base = segments.slice(0, position).join('.');
    listed.set(base, Math.max(listed.get(base) ?? 0, Number(segments[position]) + 1));
  }
  const all = [...new Set([...whole, ...listed.keys()])];
  const coveredByAnother = (path: string) => all.some((other) => other !== path && path.startsWith(`${other}.`));
  const projection: Record<string, unknown> = {};
  for (const path of all) {
    if (coveredByAnother(path)) continue;
    const keep = listed.get(path);
    const reference = ['$', path].join('');
    projection[path] = keep && !whole.has(path)
      ? { $cond: [{ $isArray: reference }, { $slice: [reference, keep] }, reference] }
      : 1;
  }
  return projection;
}

/** The database pipeline that returns one slim record per product of the tenant that the search may ever show. */
export function buildSlimPipeline(mapping: ResolvedCatalogMapping, tenantId: string): object[] {
  const { filter } = buildCatalogueBaseFilter(mapping, tenantId);
  const match: Record<string, any> = { ...filter };
  if (!Array.isArray(match.$and) || match.$and.length === 0) delete match.$and;
  return [
    { $match: match },
    {
      $addFields: {
        [SCALARS_FIELD]: {
          $arrayToObject: {
            $filter: {
              input: { $objectToArray: '$$ROOT' },
              as: 'field',
              cond: { $in: [{ $type: '$$field.v' }, SCALAR_TYPES] },
            },
          },
        },
      },
    },
    { $project: { [SCALARS_FIELD]: 1, ...buildSlimProjection(mappedFieldPaths(mapping)) } },
  ];
}

/** Folds the product's own top-level fields back into the record the pipeline returned. */
export function toSlimProduct(record: any): any {
  if (!record || typeof record !== 'object') return record;
  const { [SCALARS_FIELD]: scalars, ...rest } = record;
  return scalars && typeof scalars === 'object' ? Object.assign(rest, scalars) : rest;
}

export type CatalogueLoader = (input: {
  tenantId: string;
  mapping: ResolvedCatalogMapping;
  getDb: () => Promise<any>;
}) => AsyncIterable<any>;

async function* loadFromDatabase({ tenantId, mapping, getDb }: Parameters<CatalogueLoader>[0]): AsyncGenerator<any> {
  const db = await getDb();
  const cursor = db.collection(COLLECTION_PRODUCTS).aggregate(buildSlimPipeline(mapping, tenantId), { allowDiskUse: true, batchSize: 1000, maxTimeMS: 300_000 });
  try {
    for await (const record of cursor) yield toSlimProduct(record);
  } finally {
    await cursor.close?.().catch?.(() => undefined);
  }
}

export interface CatalogueIndexStatus {
  tenantId: string;
  state: 'loading' | 'ready' | 'failed' | 'too_large';
  products: number;
  loadedAt?: string;
  loadMs?: number;
  error?: string;
}

interface Entry {
  key: string;
  docs?: any[];
  loadedAt?: number;
  loadMs?: number;
  loading?: Promise<void>;
  failedAt?: number;
  error?: string;
  tooLarge?: boolean;
}

export interface CatalogueIndexOptions {
  /** Tests: whether the index is on. Default reads CATALOGUE_INDEX on every call, so it can be switched off without a restart. */
  enabled?: () => boolean;
  refreshMs?: number;
  retryMs?: number;
  maxDocs?: number;
  loader?: CatalogueLoader;
  now?: () => number;
}

const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class CatalogueIndexRegistry {
  private static instance: CatalogueIndexRegistry | undefined;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: CatalogueIndexOptions = {}) {}

  /** The one registry every search handler in this process shares. */
  static shared(): CatalogueIndexRegistry {
    if (!CatalogueIndexRegistry.instance) CatalogueIndexRegistry.instance = new CatalogueIndexRegistry();
    return CatalogueIndexRegistry.instance;
  }

  isEnabled(): boolean {
    return this.options.enabled ? this.options.enabled() : process.env.CATALOGUE_INDEX === 'on';
  }

  private get refreshMs(): number { return this.options.refreshMs ?? positiveNumber(process.env.CATALOGUE_INDEX_REFRESH_MS, DEFAULT_REFRESH_MS); }
  private get retryMs(): number { return this.options.retryMs ?? DEFAULT_RETRY_MS; }
  private get maxDocs(): number { return this.options.maxDocs ?? positiveNumber(process.env.CATALOGUE_INDEX_MAX_DOCS, DEFAULT_MAX_DOCS); }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /**
   * The tenant's slim products when the index is on and loaded, otherwise undefined (use the database). The first call for a tenant
   * starts a background load; a copy older than the refresh interval is served while a new one loads.
   */
  productsFor(input: { tenantId: string; mapping: ResolvedCatalogMapping; getDb: () => Promise<any> }): any[] | undefined {
    if (!this.isEnabled()) return undefined;
    const entry = this.entryFor(input);
    if (entry.tooLarge) return undefined;
    if (entry.docs) {
      if (!entry.loading && this.now() - (entry.loadedAt ?? 0) > this.refreshMs) void this.start(entry, input);
      return entry.docs;
    }
    if (entry.loading) return undefined;
    if (entry.failedAt !== undefined && this.now() - entry.failedAt < this.retryMs) return undefined;
    void this.start(entry, input);
    return undefined;
  }

  /** Loads the tenant's copy now and resolves when it is ready or has failed (never rejects). Used at startup. */
  async warm(input: { tenantId: string; mapping: ResolvedCatalogMapping; getDb: () => Promise<any> }): Promise<void> {
    if (!this.isEnabled()) return;
    const entry = this.entryFor(input);
    if (entry.tooLarge || (entry.docs && !entry.loading)) return;
    await (entry.loading ?? this.start(entry, input));
  }

  status(): CatalogueIndexStatus[] {
    return [...this.entries.entries()].map(([tenantId, entry]) => ({
      tenantId,
      state: entry.tooLarge ? 'too_large' : entry.docs ? 'ready' : entry.loading ? 'loading' : 'failed',
      products: entry.docs?.length ?? 0,
      ...(entry.loadedAt !== undefined ? { loadedAt: new Date(entry.loadedAt).toISOString() } : {}),
      ...(entry.loadMs !== undefined ? { loadMs: entry.loadMs } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  /** Forgets every copy (tests, and a mapping change that should not wait for the next refresh). */
  clear(): void {
    this.entries.clear();
  }

  private entryFor(input: { tenantId: string; mapping: ResolvedCatalogMapping }): Entry {
    // What the copy holds depends on the tenant's mapping, so a changed mapping is a different copy.
    const key = JSON.stringify(buildSlimPipeline(input.mapping, input.tenantId));
    const existing = this.entries.get(input.tenantId);
    if (existing && existing.key === key) return existing;
    const entry: Entry = { key };
    this.entries.set(input.tenantId, entry);
    return entry;
  }

  private start(entry: Entry, input: { tenantId: string; mapping: ResolvedCatalogMapping; getDb: () => Promise<any> }): Promise<void> {
    const load = this.load(entry, input)
      .catch((err: any) => {
        entry.failedAt = this.now();
        entry.error = String(err?.message || err);
        console.warn(`[CatalogueIndex] tenant=${input.tenantId} load failed${entry.docs ? ' (keeping the previous copy)' : ''}: ${entry.error}`);
      })
      .finally(() => { entry.loading = undefined; });
    entry.loading = load;
    return load;
  }

  private async load(entry: Entry, input: { tenantId: string; mapping: ResolvedCatalogMapping; getDb: () => Promise<any> }): Promise<void> {
    const started = this.now();
    const docs: any[] = [];
    const loader = this.options.loader ?? loadFromDatabase;
    for await (const product of loader(input)) {
      if (docs.length >= this.maxDocs) {
        entry.tooLarge = true;
        entry.docs = undefined;
        throw new Error(`more than ${this.maxDocs} products; this tenant keeps using the database`);
      }
      docs.push(product);
      if (docs.length % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (docs.length === 0) throw new Error('the load returned no products');
    if (entry.docs && docs.length < entry.docs.length * MIN_RELOAD_SHARE) {
      throw new Error(`the reload returned ${docs.length} products against ${entry.docs.length} in use`);
    }
    entry.docs = docs;
    entry.loadedAt = this.now();
    entry.loadMs = entry.loadedAt - started;
    entry.failedAt = undefined;
    entry.error = undefined;
    console.log(`[CatalogueIndex] tenant=${input.tenantId} ready: ${docs.length} products in ${entry.loadMs} ms`);
  }
}

/** Where the search handler gets its database when it has to ask for one. */
export async function openCatalogueDatabase(dbProvider?: () => Promise<any>): Promise<any> {
  if (dbProvider) return dbProvider();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('no database configured');
  return (await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx')).db;
}
