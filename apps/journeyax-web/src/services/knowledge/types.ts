import { ObjectId } from 'mongodb';

// ── Document stored in MongoDB ─────────────────────────────────────────
export interface KnowledgeDocument {
  _id?: ObjectId;
  /**
   * THE platform isolation key (see project.types.ts contract). New ingests always
   * set it; legacy caroma docs are backfilled. `brand` remains for back-compat with
   * existing retrieval filters (brand === projectId for per-project corpora).
   */
  projectId?: string;
  brand: string;
  sourceUrl: string;
  title: string;
  content: string;          // full page markdown
  chunk: string;             // the specific chunk text (what gets embedded)
  chunkIndex: number;
  metadata: DocumentMetadata;
  embedding: number[];       // 1536-dim from text-embedding-3-small
  crawledAt: Date;
  updatedAt: Date;
}

export interface DocumentMetadata {
  type: DocumentType;
  category?: string;
  collection?: string;
  brand: string;
  sku?: string;
  price?: number;
  currency?: string;
  images?: string[];
  finishes?: string[];
  url?: string;
  /** Structured technical specifications (item code, material, WELS, dimensions, warranty…). */
  specs?: Record<string, string>;
  /** Linked technical documents (install guide, CAD/3D files, spec sheet, warranty PDFs). */
  documents?: { title: string; url: string; kind?: string }[];
  /** Finish/colour variants with their SKUs (and stock status where available). */
  variants?: { sku: string; finish?: string; availability?: string }[];
  /** Full product description. */
  description?: string;
  /** Short / summary description (meta description, subtitle). */
  shortDescription?: string;
  /** Stock status from JSON-LD offers (InStock / OutOfStock). */
  availability?: string;
  /** Inventory count where the page exposes it. */
  inventory?: number;
  /** Selectable product options harvested generically (e.g. { Size: [...], Color: [...] }). */
  options?: Record<string, string[]>;
  /** Aggregate review signal. */
  rating?: number;
  reviewCount?: number;
  /** Brand price range when variants differ. */
  priceMin?: number;
  priceMax?: number;
}

export type DocumentType =
  | 'product'
  | 'troubleshooting'
  | 'design'
  | 'collection'
  | 'installation'
  | 'technical'
  | 'faq'
  | 'pdf'
  | 'general';

// ── Search types ───────────────────────────────────────────────────────
export interface SearchOptions {
  query: string;
  brand?: string;
  type?: DocumentType;
  category?: string;
  collection?: string;
  limit?: number;
}

export interface SearchResult {
  document: KnowledgeDocument;
  score: number;
}

// ── Crawl types ────────────────────────────────────────────────────────
// (Firecrawl removed — scraping is Playwright, in scripts/ingest-project.ts.)
export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  html?: string;            // raw HTML — needed to recover lazy-loaded product images
  metadata?: Record<string, unknown>;
}

// ── Chunk types ────────────────────────────────────────────────────────
export interface Chunk {
  text: string;
  index: number;
  sourceUrl: string;
  title: string;
  fullContent: string;
  metadata: DocumentMetadata;
}

// ── Ingestion status ───────────────────────────────────────────────────
export interface IngestionStatus {
  brand: string;
  status: 'idle' | 'crawling' | 'processing' | 'embedding' | 'complete' | 'error';
  totalPages: number;
  processedPages: number;
  totalChunks: number;
  embeddedChunks: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}
