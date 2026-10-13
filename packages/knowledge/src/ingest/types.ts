import { z } from 'zod';

/**
 * Domain-neutral ingestion contracts. Nothing here names a tenant, a department or a product: the taxonomy comes
 * from a dated snapshot of the tenant's own catalogue and every wording/threshold comes from the tenant's config.
 */

const Name = z.string().min(1).max(200);

export const TaxonomyRowSchema = z.object({
  /** Category path as stored on products (department → group → category). Empty when a product has none. */
  path: z.array(Name).max(8),
  /** The product's leaf `category` value, when it differs from the last path element it is kept as an alias. */
  category: Name.optional(),
  productCount: z.number().int().nonnegative(),
}).strict();

export const KeywordHintSchema = z.object({
  category: Name,
  path: z.array(Name).max(8),
  keywords: z.array(z.string().min(1).max(120)).max(100),
  model: z.string().optional(),
  generatedAt: z.string().optional(),
}).strict();

export const DocumentCandidateSchema = z.object({
  category: Name,
  path: z.array(Name).max(8),
  sourceUrl: z.string().min(1),
  title: z.string().max(300),
  kind: z.string().min(1).max(60),
  chunkCount: z.number().int().positive(),
  crawledAt: z.string().optional(),
  sku: z.string().optional(),
}).strict();

export const TaxonomySnapshotSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  snapshotAt: z.string().datetime(),
  source: z.string().min(1),
  totalProducts: z.number().int().nonnegative(),
  rows: z.array(TaxonomyRowSchema).min(1),
  keywordHints: z.array(KeywordHintSchema).default([]),
  documentCandidates: z.array(DocumentCandidateSchema).default([]),
  documentTotals: z.object({
    documents: z.number().int().nonnegative(),
    mappedToProduct: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
  }).strict().optional(),
}).strict();
export type TaxonomySnapshot = z.infer<typeof TaxonomySnapshotSchema>;
export type TaxonomyRow = z.infer<typeof TaxonomyRowSchema>;

export const IngestConfigSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  modelId: z.string().min(1),
  /** Products whose taxonomy is below this count are covered by their nearest concept instead of getting their own. */
  minProductsForConcept: z.number().int().min(1).default(1),
  /** Rows with no path are filed under this department; when absent they are excluded and reported. */
  unassignedDepartment: Name.optional(),
  exclusions: z.array(z.object({
    department: Name.optional(),
    category: Name.optional(),
    reason: z.string().min(1),
  }).strict().refine((entry) => Boolean(entry.department || entry.category), 'department or category required')).default([]),
  navigation: z.object({
    /** Customer-facing question; `{name}` is replaced by the parent concept's name. */
    questionTemplate: z.string().min(3).max(300),
    uiInputType: z.enum(['card_choice', 'select']).default('card_choice'),
    maxOptions: z.number().int().min(2).max(40).default(20),
    /** How many child groups a broad request previews, and how many products each. */
    overviewGroups: z.number().int().min(1).max(10).default(4),
    maxItemsPerGroup: z.number().int().min(1).max(10).default(2),
  }).strict(),
  /** Commerce policy of derived concepts. Required: derived knowledge must never be more permissive than the merchant chose. */
  commerce: z.object({
    addToCart: z.enum(['allowed', 'allowed_with_warning', 'blocked']),
    checkout: z.enum(['allowed', 'requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']),
  }).strict(),
  keywords: z.object({
    maxPerConcept: z.number().int().min(0).max(30).default(8),
    minLength: z.number().int().min(2).max(20).default(4),
  }).strict().default({ maxPerConcept: 8, minLength: 4 }),
  sources: z.object({
    maxPerConcept: z.number().int().min(0).max(10).default(3),
  }).strict().default({ maxPerConcept: 3 }),
  /** Extra search phrases derived from the category names themselves. */
  synonyms: z.object({
    splitOn: z.array(z.string().min(1)).default([' & ', ' and ', ',', '/']),
    pluralise: z.enum(['english', 'none']).default('none'),
    minLength: z.number().int().min(2).max(20).default(3),
    /** Also index the last word of a multi-word name ("Wood Screws" → "screws"); shared ones resolve to a common parent. */
    headNouns: z.boolean().default(false),
    /** Words never indexed on their own (too generic to identify a category). Tenant data. */
    ignoreTerms: z.array(z.string().min(1)).default([]),
    /**
     * A word claimed by several departments goes to the dominant department when it holds at least this share of
     * the claimants' products (0.5–1). 1 disables the rule: cross-department words stay unassigned.
     */
    dominanceThreshold: z.number().min(0.5).max(1).default(1),
  }).strict().default({ splitOn: [' & ', ' and ', ',', '/'], pluralise: 'none', minLength: 3, headNouns: false, ignoreTerms: [], dominanceThreshold: 1 }),
  documents: z.object({
    /** Ordered classification of crawled documents by phrases in their title or opening text. */
    kinds: z.array(z.object({ kind: z.string().min(1).max(60), anyOf: z.array(z.string().min(1)).min(1) }).strict()).default([]),
    /** Candidates kept per category in a snapshot, best first. */
    maxCandidatesPerCategory: z.number().int().min(0).max(50).default(8),
  }).strict().default({ kinds: [], maxCandidatesPerCategory: 8 }),
  /** Human-readable wording for generated descriptions; `{name}` `{products}` `{children}` `{date}` are replaced. */
  descriptions: z.object({
    leaf: z.string().min(3).max(300),
    parent: z.string().min(3).max(300),
  }).strict(),
}).strict();
export type IngestConfig = z.infer<typeof IngestConfigSchema>;

export const PROVENANCE_KEY = 'x-journeyax-provenance';
export const GENERATOR = 'okf-taxonomy-ingest/1';

export type DerivationKind =
  | 'catalogue_taxonomy'          // structure read from the tenant's own catalogue
  | 'model_generated_keywords'    // retrieval aids produced by a model; never evidence
  | 'crawl_document_candidate'    // a crawled document that may later support a claim once a human confirms it
  | 'authored_proposal';          // drafted on the merchant's behalf; becomes the merchant's only after their review

export interface Provenance {
  kind: DerivationKind;
  generator: string;
  snapshotAt: string;
  /** Always false for generated material: nothing produced by ingestion is a merchant-verified claim. */
  verified: false;
  detail?: Record<string, unknown>;
}

/** Provenance is recorded per field group so a reviewer can see exactly which parts are derived. */
export type ProvenanceMap = Record<string, Provenance>;
