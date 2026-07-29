/**
 * Ingestion ports — contract-first, mirroring packages/integration/ports.ts.
 *
 * The pipeline depends ONLY on these interfaces, never on a concrete connector.
 * Adding a tenant = configuration. Adding a source type = one registration.
 */

/* ─────────────────────────── Converter / Populator ───────────────────────────
 * Classic enterprise-commerce mapping pattern: a Converter owns the SOURCE→TARGET
 * transformation and delegates to ordered, single-responsibility Populators.
 * Each populator fills one concern (price, colour, imagery, stock…), so mapping
 * is composable and testable instead of one procedural blob — and a REVERSE
 * converter enables target→source write-back (order push, PIM export).
 */
export interface Populator<SOURCE, TARGET> {
  /** Stable id — lets a project add/remove/reorder populators by configuration. */
  readonly id: string;
  /** Lower runs first. Identity/base populators should claim low orders. */
  readonly order?: number;
  populate(source: SOURCE, target: TARGET, ctx?: ConversionContext): void | Promise<void>;
}

export interface Converter<SOURCE, TARGET> {
  readonly id: string;
  /** Build a fresh target instance (before populators run). */
  createTarget(source: SOURCE, ctx?: ConversionContext): TARGET;
  /** Run every registered populator, in order, against the target. */
  convert(source: SOURCE, ctx?: ConversionContext): Promise<TARGET>;
  /** Convert onto an EXISTING target — the accumulate/merge case (e.g. many CSV
   *  rows folding into one canonical product). */
  convertInto(source: SOURCE, target: TARGET, ctx?: ConversionContext): Promise<TARGET>;
}

/** Per-conversion metadata (tenant, currency, source flags) available to populators. */
export interface ConversionContext {
  projectId: string;
  currency?: string;
  /** Free-form flags a connector can pass through, e.g. { sublimation: true }. */
  flags?: Record<string, unknown>;
}

/* ─────────────────────────── Ingestion source port ─────────────────────────── */

/** One configured source on a project (mirrors KnowledgeSourceItem in config). */
export interface SourceConfig {
  id: string;
  type: string;
  enabled?: boolean;
  label?: string;
  url?: string;
  role?: string;
  currency?: string;
  sublimation?: boolean;
  docType?: string;
  storeId?: string;
  catalogId?: string;
  sitemapUrl?: string;
  urlIncludes?: string;
  urlExcludes?: string;
  maxPages?: number;
  [k: string]: unknown;
}

/** What a connector run produced — surfaced to the job record and back office. */
export interface IngestionResult {
  sourceId: string;
  /** canonical products written/updated */
  products?: number;
  /** knowledge chunks embedded */
  chunks?: number;
  skipped?: number;
  errors?: string[];
}

/** Everything a connector needs, injected — no globals, no hardcoded paths. */
export interface IngestionContext {
  projectId: string;
  /** Mongo Db handle (typed loosely to keep this package driver-agnostic). */
  db: unknown;
  /** Artifact store root for this project (local dir in dev, bucket-backed in prod). */
  storageDir: string;
  /** Model used for bulk enrichment work (from project config, never hardcoded). */
  ingestModel: string;
  log: (msg: string) => void | Promise<void>;
  progress: (patch: Record<string, unknown>) => void | Promise<void>;
}

/**
 * A source connector knows how to pull ONE kind of source and write it into the
 * canonical stores. It must not know about any specific brand or tenant.
 */
export interface IngestionSourcePort {
  /** Source type this connector handles, e.g. 'csv-feed' | 'pdf' | 'kb-articles'. */
  readonly type: string;
  /** Human label for the back office. */
  readonly label: string;
  /** Optional pre-flight: cheap validation of a configured source. */
  validate?(source: SourceConfig): { ok: boolean; message?: string };
  /** Run the ingestion for the given configured sources of this type. */
  ingest(sources: SourceConfig[], ctx: IngestionContext): Promise<IngestionResult[]>;
}

/* ─────────────────────────── Artifact storage port ───────────────────────────
 * Local filesystem in dev, object storage (GCS/S3) in prod — the pipeline never
 * knows which. Keeps 2.6GB of feeds/PDFs out of the repo and into per-project buckets.
 */
export interface ArtifactStorePort {
  readonly kind: 'local' | 'gcs' | 's3';
  /** Absolute path/URI for a project-scoped artifact key. */
  resolve(projectId: string, key: string): string;
  exists(projectId: string, key: string): Promise<boolean>;
  /** Persist a remote URL into the store (idempotent); returns the local handle. */
  fetchInto(projectId: string, key: string, url: string): Promise<string>;
}
