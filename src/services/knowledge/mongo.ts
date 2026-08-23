import { MongoClient, Db, Collection, OptionalUnlessRequiredId, Document } from 'mongodb';
import { KnowledgeDocument, SearchOptions, SearchResult } from './types';
import { logger, redact } from '@/lib/logger';

const log = logger('knowledge/mongo');

// ── Singleton client ───────────────────────────────────────────────────
let client: MongoClient | null = null;
let db: Db | null = null;

const DB_NAME = 'journeyx';
const COLLECTION_NAME = 'documents';
const VECTOR_INDEX_NAME = 'vector_index';

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in environment');

  client = new MongoClient(uri);
  await client.connect();
  log.info('connected to MongoDB Atlas');
  return client;
}

export async function getDb(): Promise<Db> {
  if (db) return db;
  const c = await getMongoClient();
  db = c.db(DB_NAME);
  return db;
}

export async function getCollection(): Promise<Collection<KnowledgeDocument>> {
  const database = await getDb();
  return database.collection<KnowledgeDocument>(COLLECTION_NAME);
}

// ── Insert documents ───────────────────────────────────────────────────
export async function insertDocuments(docs: KnowledgeDocument[]): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await getCollection();
  const result = await col.insertMany(docs as OptionalUnlessRequiredId<KnowledgeDocument>[]);
  return result.insertedCount;
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
    score: typeof doc.score === 'number' ? doc.score : 0,
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
        { $or: filter['$or'] as Document[] },
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
/** How the results were actually obtained. */
export type SearchMode = 'vector' | 'regex' | 'failed';

export interface SearchReport {
  results: SearchResult[];
  mode: SearchMode;
  /** True when we answered with something worse than semantic search. */
  degraded: boolean;
  /** Why we fell back, when we did. */
  reason?: string;
}

/**
 * The health of the last search.
 *
 * Degradation used to be invisible: when the Atlas vector index was missing
 * or erroring, `search` quietly dropped to a keyword regex and kept returning
 * confident-looking answers. Callers could not tell, and neither could
 * anyone watching from outside. This module now records what happened so a
 * health check can report it.
 */
let lastReport: SearchReport = { results: [], mode: 'failed', degraded: true, reason: 'no search yet' };
export function lastSearchReport(): Omit<SearchReport, 'results'> {
  const { mode, degraded, reason } = lastReport;
  return { mode, degraded, reason };
}

/**
 * Search with full detail about how the answer was obtained.
 *
 * Prefer this over `search` in new code — the boolean `degraded` is the whole
 * point, and the plain `search` wrapper throws it away.
 */
export async function searchWithReport(
  queryEmbedding: number[] | null,
  options: SearchOptions
): Promise<SearchReport> {
  let reason: string | undefined;

  if (queryEmbedding) {
    try {
      const vectorResults = await vectorSearch(queryEmbedding, options);
      if (vectorResults.length > 0) {
        log.debug(`vector search: ${vectorResults.length} results`);
        lastReport = { results: vectorResults, mode: 'vector', degraded: false };
        return lastReport;
      }
      reason = 'vector index returned no matches';
    } catch (err) {
      reason = err instanceof Error ? err.message : 'vector search threw';
      // A missing or broken vector index is an operational fault, not a
      // routine miss. It must be loud enough to reach a log search.
      log.error('vector search unavailable — answers are degraded', reason);
    }
  } else {
    reason = 'no query embedding (embedding step unavailable)';
  }

  try {
    const regexResults = await regexSearch(options.query, options);
    log.warn(`degraded keyword search used (${reason}); ${regexResults.length} results`, redact(options.query));
    lastReport = { results: regexResults, mode: 'regex', degraded: true, reason };
    return lastReport;
  } catch (err) {
    log.error('keyword search also failed', err);
    lastReport = { results: [], mode: 'failed', degraded: true, reason: 'both search paths failed' };
    return lastReport;
  }
}

/** Back-compatible wrapper for callers that only want the hits. */
export async function search(
  queryEmbedding: number[] | null,
  options: SearchOptions
): Promise<SearchResult[]> {
  const report = await searchWithReport(queryEmbedding, options);
  return report.results;
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
  log.info('standard indexes created');
  // Note: Vector search index must be created in Atlas UI
}

// ── Close connection ───────────────────────────────────────────────────
export async function closeConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    log.info('MongoDB connection closed');
  }
}
