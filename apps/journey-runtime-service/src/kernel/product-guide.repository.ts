import type { Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import type { ProductGuideRecord } from '../agent/product-guides';
import { guideDocId } from '../agent/product-guides';

export const COLLECTION_PRODUCT_GUIDES = 'product_guides';

const MAX_GUIDES_PER_PRODUCT = 32;
const MAX_INDEXED_CHUNKS = 4096;
const MAX_GUIDE_CHARS = 500_000;
export interface ProductGuideLookup { guides: ProductGuideRecord[]; status: 'available' | 'partial' | 'unavailable' }

/** Indexed PDF chunks are useful only with a source-owned product association, never a similar title or brand. */
export function indexedProductGuides(tenantId: string, skus: string[], urls: string[], rows: any[]): ProductGuideRecord[] {
  const wanted = new Set(skus); const linked = new Set(urls);
  const groups = new Map<string, { title: string; skus: Set<string>; chunks: Map<number, string>; pages?: number }>();
  for (const row of rows) {
    const owners = [row.projectId, row.tenantId, row.metadata?.brand].filter(value => typeof value === 'string' && value.length > 0);
    if (!owners.length || owners.some(owner => owner !== tenantId)) continue;
    const url = row.metadata?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const refs = [row.metadata?.sku, ...(Array.isArray(row.metadata?.skus) ? row.metadata.skus : [])].filter(value => value != null).map(String);
    if (!refs.some(ref => wanted.has(ref)) && !linked.has(url)) continue;
    if (row.metadata?.sourceKind !== 'pdf' && !/\.pdf(?:[?#]|$)/i.test(url) && !linked.has(url)) continue;
    const text = typeof row.content === 'string' ? row.content : typeof row.chunk === 'string' ? row.chunk : '';
    if (!text.trim()) continue;
    const group = groups.get(url) ?? { title: String(row.metadata?.documentTitle || row.title || ''), skus: new Set<string>(), chunks: new Map<number, string>(), pages: row.metadata?.pages };
    for (const ref of refs) group.skus.add(ref);
    if (linked.has(url)) for (const sku of wanted) group.skus.add(sku);
    const index = Number.isSafeInteger(row.chunkIndex) ? row.chunkIndex : group.chunks.size;
    if (!group.chunks.has(index)) group.chunks.set(index, text);
    groups.set(url, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_GUIDES_PER_PRODUCT).map(([url, group]) => {
    const text = [...group.chunks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
    return { tenantId, docId: guideDocId(url, group.title, text), title: group.title, url, kind: 'pdf', pages: group.pages,
      skus: [...group.skus], text: text.slice(0, MAX_GUIDE_CHARS), textChars: Math.min(text.length, MAX_GUIDE_CHARS), ...(text.length > MAX_GUIDE_CHARS ? { truncated: true } : {}) };
  });
}

/**
 * Reads the guides kept with products (see `scripts/placemakers/ingest-product-guides.ts`). Every read names the tenant, so
 * one shop never reads another's guides. Where the guides live is `PRODUCT_GUIDES_DB_NAME`, else the runtime's own database;
 * tests select their in-memory store explicitly; absent configuration is a source outage.
 */
export class ProductGuideRepository {
  private col: Collection<ProductGuideRecord> | null = null;
  private indexedCol: Collection<any> | null = null;
  private readonly inMemory: ProductGuideRecord[] = [];
  private memorySelected = false;

  constructor(private readonly dbOrProvider?: any) {
    if (dbOrProvider && typeof dbOrProvider.collection === 'function') {
      this.col = dbOrProvider.collection(COLLECTION_PRODUCT_GUIDES);
      this.indexedCol = dbOrProvider.collection('documents');
    }
  }

  /** Explicit test seam; never a fallback from a selected database. */
  addForTest(record: ProductGuideRecord): void {
    this.memorySelected = true;
    this.inMemory.push(record);
  }

  static forTest(records: ProductGuideRecord[] = []): ProductGuideRepository {
    const repository = new ProductGuideRepository(); repository.memorySelected = true;
    for (const record of records) repository.addForTest(record);
    return repository;
  }

  private async getCol(): Promise<Collection<ProductGuideRecord> | null> {
    if (this.memorySelected) return null;
    if (this.col) return this.col;
    if (typeof this.dbOrProvider === 'function') {
      try {
        const resolved = await this.dbOrProvider();
        if (resolved && typeof resolved.collection === 'function') {
          this.col = resolved.collection(COLLECTION_PRODUCT_GUIDES);
          this.indexedCol = resolved.collection('documents');
          return this.col;
        }
      } catch { return null; }
      // An explicitly selected store must never fall back to a process-global
      // database after an outage or a misconfigured provider.
      return null;
    }
    if (this.dbOrProvider !== undefined) return null;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.PRODUCT_GUIDES_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<ProductGuideRecord>(COLLECTION_PRODUCT_GUIDES);
      this.indexedCol = db.collection('documents');
      return this.col;
    } catch {
      return null;
    }
  }

  /** The guides carried by any of these products (the product's own identifier and its parent's), or [] when none or when the store is unreachable. */
  async findForProducts(tenantId: string, skus: string[], documentUrls: string[] = []): Promise<ProductGuideRecord[]> {
    return (await this.readForProducts(tenantId, skus, documentUrls)).guides;
  }

  /** Keep source outages distinct from a successful lookup that found no guide. */
  async readForProducts(tenantId: string, skus: string[], documentUrls: string[] = []): Promise<ProductGuideLookup> {
    const wanted = [...new Set(skus.map((sku) => String(sku || '').trim()).filter(Boolean))];
    if (!tenantId || wanted.length === 0) return { guides: [], status: 'available' };
    const col = await this.getCol();
    if (!col) return { guides: this.inMemory.filter((record) => record.tenantId === tenantId && record.skus.some((sku) => wanted.includes(sku))).slice(0, MAX_GUIDES_PER_PRODUCT), status: this.memorySelected ? 'available' : 'unavailable' };
    let rows: ProductGuideRecord[] = [];
    let directRead = false, indexedRead = false, capped = false;
    try { rows = await col.find({ tenantId, skus: { $in: wanted } }, { projection: { _id: 0 } }).limit(MAX_GUIDES_PER_PRODUCT).toArray() as ProductGuideRecord[]; directRead = true; capped = rows.length >= MAX_GUIDES_PER_PRODUCT; } catch { /* Try the associated indexed documents too. */ }
    const urls = [...new Set(documentUrls.filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)))].slice(0, 64);
    if (this.indexedCol) try {
      const indexed = await this.indexedCol.find({ $and: [
        { $or: [{ projectId: tenantId }, { tenantId }, { 'metadata.brand': tenantId }] },
        { $or: [{ 'metadata.sku': { $in: wanted } }, { 'metadata.skus': { $in: wanted } }, ...(urls.length ? [{ 'metadata.url': { $in: urls } }] : [])] },
        { $or: [{ 'metadata.sourceKind': 'pdf' }, { 'metadata.url': /\.pdf(?:[?#]|$)/i }, ...(urls.length ? [{ 'metadata.url': { $in: urls } }] : [])] },
      ] }, { projection: { _id: 0, projectId: 1, tenantId: 1, metadata: 1, title: 1, content: 1, chunk: 1, chunkIndex: 1 } }).sort({ chunkIndex: 1 }).limit(MAX_INDEXED_CHUNKS).toArray();
      indexedRead = true;
      capped ||= indexed.length >= MAX_INDEXED_CHUNKS;
      for (const guide of indexedProductGuides(tenantId, wanted, urls, indexed)) {
        const existing = rows.findIndex(row => row.url === guide.url || row.docId === guide.docId);
        if (existing < 0) rows.push(guide);
        else if (!rows[existing].text || rows[existing].truncated) rows[existing] = guide;
      }
    } catch { /* An unavailable vector store does not erase an existing linked guide. */ }
    capped ||= rows.length > MAX_GUIDES_PER_PRODUCT || rows.some(row => row.truncated);
    return { guides: rows.slice(0, MAX_GUIDES_PER_PRODUCT), status: directRead && indexedRead && !capped ? 'available' : directRead || indexedRead ? 'partial' : 'unavailable' };
  }
}
