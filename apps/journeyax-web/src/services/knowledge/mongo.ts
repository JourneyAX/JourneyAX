import { MongoClient, Db, Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import { KnowledgeDocument, SearchOptions, SearchResult } from './types';

const DB_NAME = 'journeyx';
const COLLECTION_NAME = 'documents';
const VECTOR_INDEX_NAME = 'vector_index';

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in environment');

  const { db } = await connectToDatabase(uri, DB_NAME);
  return db;
}

export async function getCollection(): Promise<Collection<KnowledgeDocument>> {
  const database = await getDb();
  return database.collection<KnowledgeDocument>(COLLECTION_NAME);
}

// ── Insert documents (idempotent: upsert by sourceUrl + chunkIndex) ─────
// Upsert so re-ingesting a product replaces its doc instead of creating a
// duplicate — safe to re-run against the live catalogue.
export async function insertDocuments(docs: KnowledgeDocument[]): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await getCollection();
  const ops = docs.map((d: any) => ({
    updateOne: {
      // projectId in the key when present (isolation contract); legacy docs
      // without projectId keep the old key so re-ingests stay idempotent.
      filter: d.projectId
        ? { projectId: d.projectId, sourceUrl: d.sourceUrl, chunkIndex: d.chunkIndex }
        : { sourceUrl: d.sourceUrl, chunkIndex: d.chunkIndex },
      update: { $set: d },
      upsert: true,
    },
  }));
  const result = await col.bulkWrite(ops as any[]);
  return (result.upsertedCount || 0) + (result.modifiedCount || 0);
}

// ── Clear brand data ───────────────────────────────────────────────────
export async function clearBrandDocuments(brand: string): Promise<number> {
  const col = await getCollection();
  const result = await col.deleteMany({ brand });
  return result.deletedCount;
}

// ── Vector search ──────────────────────────────────────────────────────
export async function vectorSearch(
  queryEmbedding: number[],
  options: SearchOptions
): Promise<SearchResult[]> {
  const col = await getCollection();
  const limit = options.limit || 8;

  // Build pre-filter for metadata fields
  const filter: Record<string, unknown> = {};
  if (options.brand) {
    filter['metadata.brand'] = options.brand;
  }
  if (options.type) {
    filter['metadata.type'] = options.type;
  }
  if (options.category) {
    filter['$or'] = [
      { 'metadata.category': options.category },
      { 'metadata.category': { $exists: false } },
      { 'metadata.category': null }
    ];
  }

  const pipeline: object[] = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: limit * 10,
        limit: limit,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      },
    },
    {
      $addFields: {
        score: { $meta: 'vectorSearchScore' },
      },
    },
    {
      $project: {
        embedding: 0, // Don't return the 1536-dim vector
      },
    },
  ];

  const results = await col.aggregate(pipeline).toArray();

  return results.map((doc) => ({
    document: doc as unknown as KnowledgeDocument,
    score: (doc as any).score || 0,
  }));
}

// ── Regex search (works without any Atlas indexes) ─────────────────────
export async function regexSearch(
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  const col = await getCollection();
  const limit = options.limit || 8;

  const filter: Record<string, unknown> = {};
  
  // Brand filter — check both 'brand' and 'metadata.brand'
  if (options.brand) {
    filter['$or'] = [
      { brand: options.brand },
      { 'metadata.brand': options.brand }
    ];
  }
  if (options.type) filter['metadata.type'] = options.type;
  
  if (options.category) {
    const categoryOr = [
      { 'metadata.category': options.category },
      { 'metadata.category': { $exists: false } },
      { 'metadata.category': null }
    ];
    if (filter['$or']) {
      filter['$and'] = [
        { $or: filter['$or'] as any[] },
        { $or: categoryOr }
      ];
      delete filter['$or'];
    } else {
      filter['$or'] = categoryOr;
    }
  }

  // Build regex from the important words in the query
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how'].includes(w));
  
  if (words.length > 0) {
    const regexPattern = words.join('|');
    filter.chunk = { $regex: new RegExp(regexPattern, 'i') };
  }

  const results = await col
    .find(filter)
    .limit(limit)
    .toArray();

  return results.map((doc, i) => ({
    document: doc as KnowledgeDocument,
    score: 1 - i * 0.1, // Decreasing relevance
  }));
}

// ── Search (tries vector first, falls back to regex) ───────────────────
export async function search(
  queryEmbedding: number[] | null,
  options: SearchOptions
): Promise<SearchResult[]> {
  // Try vector search first
  if (queryEmbedding) {
    try {
      const vectorResults = await vectorSearch(queryEmbedding, options);
      if (vectorResults.length > 0) {
        console.log(`  📊 Vector search: ${vectorResults.length} results`);
        return vectorResults;
      }
    } catch (err) {
      console.warn('  ⚠️ Vector search unavailable, using regex fallback');
    }
  }
  
  // Fallback to regex search (always works, no index needed)
  try {
    const regexResults = await regexSearch(options.query, options);
    console.log(`  📊 Regex search: ${regexResults.length} results for "${options.query}"`);
    return regexResults;
  } catch (err) {
    console.error('  ❌ Regex search also failed:', err);
    return [];
  }
}

// ── Stats ──────────────────────────────────────────────────────────────
export async function getStats(brand?: string): Promise<{
  totalDocuments: number;
  byType: Record<string, number>;
  brands: string[];
}> {
  const col = await getCollection();
  const filter = brand ? { brand } : {};

  const totalDocuments = await col.countDocuments(filter);

  const typeAgg = await col
    .aggregate([
      { $match: filter },
      { $group: { _id: '$metadata.type', count: { $sum: 1 } } },
    ])
    .toArray();

  const byType: Record<string, number> = {};
  for (const t of typeAgg) {
    byType[t._id as string] = t.count;
  }

  const brandsAgg = await col.distinct('brand');

  return { totalDocuments, byType, brands: brandsAgg };
}

// ── Ensure indexes ─────────────────────────────────────────────────────
export async function ensureIndexes(): Promise<void> {
  const col = await getCollection();
  // Standard indexes for filtering
  await col.createIndex({ brand: 1 });
  await col.createIndex({ 'metadata.type': 1 });
  await col.createIndex({ 'metadata.category': 1 });
  await col.createIndex({ sourceUrl: 1 });
  console.log('✅ Standard indexes created');
  // Note: Vector search index must be created in Atlas UI
}

// ── Close connection ───────────────────────────────────────────────────
export async function closeConnection(): Promise<void> {
  console.log('MongoDB connection close requested (managed by shared client pool)');
}
