import type { Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import type { ContentPageRecord } from '../agent/content-pages';

export const COLLECTION_CONTENT_PAGES = 'content_pages';

/** How long a tenant's pages are kept in memory: a shop has hundreds of pages, so one read serves many customers. */
const CACHE_MS = 10 * 60 * 1000;
const MAX_PAGES = 2000;

/**
 * Reads the shop's own web pages kept as text (see `scripts/placemakers/ingest-content-pages.ts`). Every read names the tenant.
 * Where they live is `CONTENT_PAGES_DB_NAME`, else `PRODUCT_GUIDES_DB_NAME`, else the runtime's own database; with no database at
 * all (tests) they are held in memory.
 */
export class ContentPageRepository {
  private col: Collection<ContentPageRecord> | null = null;
  private readonly inMemory: ContentPageRecord[] = [];
  private readonly cache = new Map<string, { at: number; pages: ContentPageRecord[] }>();

  constructor(private readonly dbOrProvider?: any, private readonly now: () => number = Date.now) {
    if (dbOrProvider && typeof dbOrProvider.collection === 'function') this.col = dbOrProvider.collection(COLLECTION_CONTENT_PAGES);
  }

  addForTest(record: ContentPageRecord): void {
    this.inMemory.push(record);
    this.cache.clear();
  }

  private async getCol(): Promise<Collection<ContentPageRecord> | null> {
    if (this.col) return this.col;
    if (typeof this.dbOrProvider === 'function') {
      try {
        const resolved = await this.dbOrProvider();
        if (resolved && typeof resolved.collection === 'function') {
          this.col = resolved.collection(COLLECTION_CONTENT_PAGES);
          return this.col;
        }
      } catch {
        // fall through to the connection URI
      }
    }
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.CONTENT_PAGES_DB_NAME || process.env.PRODUCT_GUIDES_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ContentPageRecord>(COLLECTION_CONTENT_PAGES);
      return this.col;
    } catch {
      return null;
    }
  }

  /** Every page of the tenant, or [] when it has none or the store is unreachable (an empty answer is not kept, so a load is seen at once). */
  async listPages(tenantId: string): Promise<ContentPageRecord[]> {
    if (!tenantId) return [];
    const cached = this.cache.get(tenantId);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.pages;
    const col = await this.getCol();
    let pages: ContentPageRecord[];
    if (!col) pages = this.inMemory.filter((record) => record.tenantId === tenantId);
    else {
      try {
        pages = (await col.find({ tenantId }, { projection: { _id: 0 } }).limit(MAX_PAGES).toArray()) as ContentPageRecord[];
      } catch {
        return [];
      }
    }
    if (pages.length > 0) this.cache.set(tenantId, { at: this.now(), pages });
    return pages;
  }
}
