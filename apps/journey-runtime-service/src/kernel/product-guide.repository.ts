import type { Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import type { ProductGuideRecord } from '../agent/product-guides';

export const COLLECTION_PRODUCT_GUIDES = 'product_guides';

/** The most guides one product returns (a product carries a specification guide, an installation guide and a manual at most). */
const MAX_GUIDES_PER_PRODUCT = 6;

/**
 * Reads the guides kept with products (see `scripts/placemakers/ingest-product-guides.ts`). Every read names the tenant, so
 * one shop never reads another's guides. Where the guides live is `PRODUCT_GUIDES_DB_NAME`, else the runtime's own database;
 * with no database at all (tests) the guides are held in memory.
 */
export class ProductGuideRepository {
  private col: Collection<ProductGuideRecord> | null = null;
  private readonly inMemory: ProductGuideRecord[] = [];

  constructor(private readonly dbOrProvider?: any) {
    if (dbOrProvider && typeof dbOrProvider.collection === 'function') this.col = dbOrProvider.collection(COLLECTION_PRODUCT_GUIDES);
  }

  /** Test seam: guides held in memory, used when no database is reachable. */
  addForTest(record: ProductGuideRecord): void {
    this.inMemory.push(record);
  }

  private async getCol(): Promise<Collection<ProductGuideRecord> | null> {
    if (this.col) return this.col;
    if (typeof this.dbOrProvider === 'function') {
      try {
        const resolved = await this.dbOrProvider();
        if (resolved && typeof resolved.collection === 'function') {
          this.col = resolved.collection(COLLECTION_PRODUCT_GUIDES);
          return this.col;
        }
      } catch {
        // fall through to the connection URI
      }
    }
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.PRODUCT_GUIDES_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ProductGuideRecord>(COLLECTION_PRODUCT_GUIDES);
      return this.col;
    } catch {
      return null;
    }
  }

  /** The guides carried by any of these products (the product's own identifier and its parent's), or [] when none or when the store is unreachable. */
  async findForProducts(tenantId: string, skus: string[]): Promise<ProductGuideRecord[]> {
    const wanted = [...new Set(skus.map((sku) => String(sku || '').trim()).filter(Boolean))];
    if (!tenantId || wanted.length === 0) return [];
    const col = await this.getCol();
    if (!col) return this.inMemory.filter((record) => record.tenantId === tenantId && record.skus.some((sku) => wanted.includes(sku))).slice(0, MAX_GUIDES_PER_PRODUCT);
    try {
      const rows = await col.find({ tenantId, skus: { $in: wanted } }, { projection: { _id: 0 } }).limit(MAX_GUIDES_PER_PRODUCT).toArray();
      return rows as ProductGuideRecord[];
    } catch {
      return [];
    }
  }
}
