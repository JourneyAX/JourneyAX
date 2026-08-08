import { Injectable, Inject } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';
import { getOrSet, cacheKey, MAX_TTL_SECONDS } from '@journeyax/cache';
import { MongoClient, Db, Collection } from 'mongodb';
import OpenAI from 'openai';

const DB_NAME = 'journeyx';
const COLLECTION_NAME = 'documents';

/**
 * Map an agent-requested knowledge type to the types that ACTUALLY exist in the
 * corpus. Installation/warranty/care content was ingested as `type: "technical"`
 * (with a category), and warranty/policy also lives under `type: "policy"`.
 * Without this, searching type:"installation" or type:"faq" matched ZERO docs —
 * the root cause of guides/warranty never appearing in the conversation.
 */
function expandTypeFilter(type: string): unknown {
  switch (type) {
    case 'installation': return { $in: ['installation', 'technical'] };
    // Fashion fit knowledge (size charts, "runs small", how-to-measure, fabric
    // care, occasion styling) is ingested under these companion types. A shopper
    // fit question is a kind of FAQ, so fold them into faq too — tenants without
    // sizing docs simply match nothing extra, so this is safe cross-tenant.
    case 'sizing':
    case 'fit':
    case 'measurement':
    case 'care':
    case 'styling':      return { $in: ['sizing', 'fit', 'measurement', 'care', 'styling'] };
    case 'faq':
    case 'warranty':     return { $in: ['faq', 'policy', 'technical', 'sizing', 'fit', 'measurement', 'care'] };
    case 'troubleshooting': return { $in: ['troubleshooting', 'technical'] };
    default:             return type; // product / design / collection — exact
  }
}
import { resolveNeeds, isReliableCharacter } from './needs-vocabulary';
import { RenderService } from './render.service';

const VECTOR_INDEX_NAME = 'vector_index';
const EMBEDDING_MODEL = 'text-embedding-3-small';
// Was 1500 — far too small: a single product chunk (~1500 tokens, see chunker.ts)
// consumed the ENTIRE budget, so the model effectively saw one truncated result
// and could not compare products or read full specs. Raised so multiple results survive.
const MAX_TOKEN_BUDGET = 6000;

/** How long a style's design lines stay cached before being re-checked (AUG-41). */
const DESIGN_LINE_TTL_MS = 24 * 60 * 60 * 1000;

/** Vivid, unambiguous, and in every brand palette seen so far — the probe only
 *  needs the reply to contain SOME saturated colour, not this exact one. */
const PROBE_COLOUR = 'RA TRUE RED';

interface KnowledgeDocument {
  _id?: any;
  brand: string;
  sourceUrl: string;
  title: string;
  content: string;
  chunk: string;
  chunkIndex: number;
  metadata: {
    type?: string;
    category?: string;
    collection?: string;
    brand?: string;
    sku?: string;
    price?: number;
    currency?: string;
    images?: string[];
    finishes?: string[];
    url?: string;
  };
  embedding?: number[];
  crawledAt?: Date;
  updatedAt?: Date;
}

interface SearchOptions {
  query: string;
  brand?: string;
  type?: string;
  category?: string;
  limit?: number;
}

interface SearchResult {
  document: KnowledgeDocument;
  score: number;
}

@Injectable()
export class ProductService {
  private db: Db | null = null;
  private openai: OpenAI | null = null;

  /* RenderService composes texture URLs and holds no state or dependency of its
   * own, so injecting it here introduces no cycle. Ink resolution needs it. */
  /* Explicit token: this build does not emit decorator metadata, so an
   * un-annotated constructor parameter arrives as undefined rather than as the
   * provider — which surfaces only at call time, as "cannot read 'build'". */
  constructor(@Inject(RenderService) private readonly renderer: RenderService) {}

  // ── Database Connection ─────────────────────────────────────────────
  private async getDb(): Promise<Db> {
    if (this.db) return this.db;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set in environment');
    const { db } = await connectToDatabase(uri, DB_NAME);
    this.db = db;
    return db;
  }

  private async getCollection(): Promise<Collection<KnowledgeDocument>> {
    const database = await this.getDb();
    return database.collection<KnowledgeDocument>(COLLECTION_NAME);
  }

  // ── OpenAI Embedding ────────────────────────────────────────────────
  private getOpenAI(): OpenAI {
    if (!this.openai) this.openai = new OpenAI();
    return this.openai;
  }

  async embedText(text: string): Promise<number[]> {
    try {
      const response = await this.getOpenAI().embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      });
      return response.data[0].embedding;
    } catch (err) {
      /* Do not keep a client that has proven broken.
       *
       * The client is built once and cached — so a key that was bad at first
       * use (quota exhausted, mid-rotation) kept THIS process on the regex
       * fallback forever, even after the key was fixed. Dropping the client
       * makes the next call rebuild from the current environment: the service
       * heals as soon as the key does, instead of degrading every search until
       * someone thinks to restart it. */
      this.openai = undefined as any;
      console.warn('[ProductService] Embedding failed, will use regex fallback:', err);
      return [];
    }
  }

  // ── Hand-authored knowledge ingest ──────────────────────────────────
  /**
   * Ingest curated knowledge documents (fit guides, size charts, care, styling)
   * that don't come from a crawlable source — the platform's answer to "the
   * brand blocks its size charts, so we author the guidance and embed it".
   *
   * Embeds each doc and upserts it into the SAME `documents` collection the
   * crawler writes, tagged with `projectId` + `metadata.type`, so retrieval (and
   * the `sizing` type filter) surface it exactly like any other knowledge. Keyed
   * by a stable sourceUrl so re-ingest replaces rather than duplicates.
   */
  async ingestKnowledgeDocuments(
    projectId: string,
    docs: Array<{ title: string; type: string; content: string; category?: string }>,
    namespace = 'kb',
  ): Promise<{ inserted: number; updated: number; skipped: number }> {
    const pid = (projectId || '').toLowerCase();
    const col = await this.getCollection();
    let inserted = 0, updated = 0, skipped = 0;
    for (const d of docs || []) {
      const title = String(d?.title || '').trim();
      const type = String(d?.type || '').trim().toLowerCase();
      const content = String(d?.content || '').trim();
      if (!title || !content || !type) { skipped++; continue; }
      const embedding = await this.embedText(content);
      if (!embedding.length) { skipped++; continue; }   // embedding down → do not write a doc that can't be found
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
      const sourceUrl = `knowledge://${pid}/${namespace}/${slug}`;
      const now = new Date();
      const res = await (col as any).updateOne(
        { projectId: pid, sourceUrl },
        { $set: {
          chunkIndex: 0,
          projectId: pid,
          sourceUrl,
          brand: pid,
          chunk: content,
          content,
          crawledAt: now,
          embedding,
          metadata: { type, brand: pid, category: d?.category || namespace, source: 'curated', url: sourceUrl },
          title,
          updatedAt: now,
        } },
        { upsert: true },
      );
      if (res.upsertedCount) inserted++; else updated++;
    }
    return { inserted, updated, skipped };
  }

  // ── Spec & Image Parsing ────────────────────────────────────────────
  private parseSpecs(content: string): Record<string, string> {
    const specs: Record<string, string> = {};
    const specsIdx = content.indexOf('Specifications');
    if (specsIdx === -1) return specs;

    const techDownloadsIdx = content.indexOf('Technical Downloads', specsIdx);
    const specsText = techDownloadsIdx !== -1
      ? content.substring(specsIdx, techDownloadsIdx)
      : content.substring(specsIdx);

    const lines = specsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let i = 1; i < lines.length - 1; i += 2) {
      const key = lines[i];
      const val = lines[i + 1];
      if (key === 'Product Codes' || /^\d+[A-Z\d]*$/.test(key) || /^\d+[A-Z\d]*$/.test(val)) {
        continue;
      }
      if (key.length < 40 && !key.includes('[') && !key.includes('http') && val.length < 100) {
        specs[key] = val;
      }
    }
    return specs;
  }

  private parseImages(content: string): string[] {
    const images: string[] = [];
    const idx = content.indexOf('--- Product Images ---');
    if (idx === -1) {
      const cdnRegex = /(https?:\/\/cdn\.[^\s"']+\.(?:jpg|jpeg|png|webp|avif)[^\s"']*)/gi;
      let match;
      while ((match = cdnRegex.exec(content)) !== null) {
        if (!images.includes(match[1])) images.push(match[1]);
      }
      return images;
    }

    const text = content.substring(idx + '--- Product Images ---'.length);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
    return lines;
  }

  // ── Vector Search ───────────────────────────────────────────────────
  private async vectorSearch(
    queryEmbedding: number[],
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const col = await this.getCollection();
    const limit = options.limit || 8;

    const filter: Record<string, unknown> = {};
    if (options.brand) {
      filter['metadata.brand'] = options.brand;
    }
    if (options.type) {
      /* NOTE (AUG-67): the design/cap knowledge stages write the kind top-level as
       * `docType`, not `metadata.type`, so all 6,860 measured design-line documents
       * are unreachable whenever a type filter is passed. An `$or` here is NOT the
       * fix — Atlas $vectorSearch rejects it and the whole query silently falls
       * back to regex (same trap as the $exists note below). The real fix is to
       * backfill `metadata.type` on those documents at ingest. */
      filter['metadata.type'] = expandTypeFilter(options.type);
    }
    if (options.category) {
      // IMPORTANT: Atlas $vectorSearch `filter` does NOT support $exists.
      // The previous $or with { $exists: false } / null made the ENTIRE vector
      // query throw whenever a category was passed → silent fallback to weak
      // regex search (a major accuracy bug). Use a plain equality here; the
      // unfiltered retry in searchRaw() covers the "no category match" case.
      filter['metadata.category'] = options.category;
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
          embedding: 0,
        },
      },
    ];

    const results = await col.aggregate(pipeline).toArray();
    return results.map((doc) => ({
      document: doc as unknown as KnowledgeDocument,
      score: (doc as any).score || 0,
    }));
  }

  // ── Regex Fallback Search ───────────────────────────────────────────
  private async regexSearch(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const col = await this.getCollection();
    const limit = options.limit || 8;

    const filter: Record<string, unknown> = {};

    if (options.brand) {
      filter['$or'] = [
        { brand: options.brand },
        { 'metadata.brand': options.brand }
      ];
    }
    if (options.type) filter['metadata.type'] = expandTypeFilter(options.type);

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
      score: 1 - i * 0.1,
    }));
  }

  // ── Main Search (vector + regex fallback) ───────────────────────────
  private async searchRaw(
    queryEmbedding: number[] | null,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    if (queryEmbedding && queryEmbedding.length > 0) {
      try {
        // 1) Semantic search WITH tenant/type/category filters.
        let vectorResults = await this.vectorSearch(queryEmbedding, options);

        // 2) If the filter matched nothing, retry relaxing ONLY the optional
        //    category/type filters. The tenant (brand) filter is MANDATORY and is
        //    never dropped — removing it would return another tenant's documents
        //    from the shared collection (cross-tenant data leak). Tenant isolation
        //    must hold even on the fallback path.
        if (vectorResults.length === 0 && (options.type || options.category)) {
          vectorResults = await this.vectorSearch(queryEmbedding, {
            query: options.query,
            brand: options.brand, // ← keep tenant isolation
            limit: options.limit,
          });
          if (vectorResults.length > 0) {
            console.log(
              `  [ProductService] VECTOR (relaxed category/type, tenant kept): ${vectorResults.length} results`,
            );
          }
        }

        if (vectorResults.length > 0) {
          const topScores = vectorResults.slice(0, 3).map((r) => r.score.toFixed(3)).join(', ');
          console.log(
            `  [ProductService] VECTOR search: ${vectorResults.length} results, top scores [${topScores}] for "${options.query}"`,
          );
          return vectorResults;
        }
        console.warn(`  [ProductService] VECTOR search returned 0 for "${options.query}" — falling back to REGEX`);
      } catch (err) {
        console.warn('  [ProductService] VECTOR search errored, using REGEX fallback:', (err as Error).message);
      }
    }

    try {
      const regexResults = await this.regexSearch(options.query, options);
      // Loud on purpose: if you see REGEX in the logs, semantic search is NOT running
      // and answer quality will be poor. Fix the vector index/filter, don't rely on this.
      console.warn(
        `  [ProductService] REGEX (keyword) fallback: ${regexResults.length} results for "${options.query}" — semantic search not used`,
      );
      return regexResults;
    } catch (err) {
      console.error('  [ProductService] Regex search also failed:', err);
      return [];
    }
  }

  // ── Public API: Search with Token Budgeting (Weaviate Pillar 3) ────
  /**
   * Additive lexical boost over vector results, sorted in place.
   *
   * For each result we count how many of the query's distinctive tokens (4+ chars,
   * minus stopwords) appear in the product TITLE, and add a small amount per hit to
   * the semantic score. Boost is deliberately tiny (0.04/hit, capped) so it only
   * settles ties between semantically-similar candidates — the fix for the
   * soccer/football embedding collision — and never lets a keyword coincidence beat
   * a clearly-better semantic match. No sport list, no domain terms: pure keyword
   * agreement between the query and the title.
   */
  private lexicalRerank(query: string, results: SearchResult[]): void {
    if (!results || results.length < 2) return;
    const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'jersey', 'jerseys', 'team', 'custom', 'players', 'player', 'about', 'need', 'want', 'colours', 'colors']);
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
    if (!tokens.length) return;
    for (const r of results) {
      const title = String((r.document as any)?.title || (r.document as any)?.metadata?.title || '').toLowerCase();
      if (!title) continue;
      let hits = 0;
      for (const t of tokens) if (title.includes(t)) hits++;
      (r as any).score = (r.score || 0) + Math.min(hits, 3) * 0.04;
    }
    results.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  async search(
    query: string,
    brand: string,
    type?: string,
    category?: string,
    limit: number = 8,
    gender?: string,
  ): Promise<{
    found: boolean;
    resultCount: number;
    results: any[];
    message?: string;
  }> {
    // Over-fetch when a gender filter is on so we still return a full set after
    // dropping the wrong gender (the vector index has no gender to filter on).
    const fetchLimit = gender ? Math.max(limit * 4, 24) : limit;
    // Step 0: NEEDS → measured vocabulary (AUG-67). "modern" is meaningless to the
    // index; 'bold — accents dominate' is what the visual reader actually wrote.
    // Additive: an unrecognised need leaves the query exactly as it was.
    const needs = resolveNeeds(query);
    if (needs.character.length) {
      console.log(`  [ProductService] NEEDS "${needs.matched.join(', ')}" → ${needs.character.join(' | ')}`);
    }

    // Step 1: Generate embedding (on the needs-expanded query)
    const queryEmbedding = await this.embedText(needs.expandedQuery);

    // Step 2: Execute search
    let rawResults = await this.searchRaw(
      queryEmbedding.length > 0 ? queryEmbedding : null,
      { query: needs.expandedQuery, brand, type, category, limit: fetchLimit }
    );

    // Step 2.4: Reward documents whose MEASURED character matches the need, and
    // never reward one the reader flagged as unreliable — a partially-rendered
    // design reads "subtle" precisely because its accents failed to draw.
    if (needs.character.length) {
      for (const r of rawResults) {
        const doc: any = r.document;
        const chars: string[] = Array.isArray(doc?.character) ? doc.character : [];
        if (!isReliableCharacter(chars)) continue;
        const hay = chars.join(' ').toLowerCase();
        const hits = needs.character.filter((c) => hay.includes(c.toLowerCase())).length;
        if (hits) (r as any).score = (r.score || 0) + Math.min(hits, 2) * 0.06;
      }
    }

    // Step 2.5: Lexical re-rank. Embeddings place near-synonyms together —
    // "soccer" and "football" (the same word in most of the world) sit almost on
    // top of each other, so a "women's SOCCER jersey" query can surface a ladies
    // FOOTBALL jersey first. Nudge results whose TITLE actually contains the
    // query's distinctive words above pure-semantic near-misses. Generic (no
    // hardcoded sport list): a small additive boost per matched query token, so it
    // only reorders genuine ties and never overrides a strong semantic winner.
    this.lexicalRerank(query, rawResults);

    // Step 2.7: GENDER FILTER (apparel). The retrieval index carries no gender — it
    // lives on the products collection (`division`). Look it up for the candidates and
    // DROP the wrong gender before budgeting, so a "men's ..." search never surfaces
    // women's items. Unisex + unknown are always kept. Over-fetched above so the final
    // set stays full; then trim back to `limit`.
    if (gender) {
      const want = String(gender).trim().toLowerCase();
      const skus = [...new Set(rawResults.map((r: any) => r.document?.metadata?.sku).filter(Boolean))];
      if (skus.length) {
        try {
          const db = await this.getDb();
          const rows = await db.collection('products')
            .find({ projectId: brand, parentSku: { $in: skus } }, { projection: { _id: 0, parentSku: 1, division: 1 } })
            .toArray();
          const divBy = new Map(rows.map((x: any) => [String(x.parentSku), String(x.division || '').trim().toLowerCase()]));
          rawResults = rawResults.filter((r: any) => {
            const sku = r.document?.metadata?.sku;
            if (!sku) return true;
            const div = divBy.get(String(sku));
            if (!div) return true;                                  // unknown → keep (never hide a real item)
            return div === want || div === 'unisex' || div.startsWith(want);
          });
        } catch { /* filter is best-effort — never fail a search on it */ }
      }
      rawResults = rawResults.slice(0, limit);
    }

    // Step 3: Apply RAG-aware Token Budgeting (max 1500 tokens)
    let cumulativeTokens = 0;
    const budgetedResults: any[] = [];

    for (const r of rawResults) {
      const meta: any = r.document.metadata || {};
      // Prefer the structured data captured by the JSON-LD scrape (real PIM product
      // photos + clean specs). Only fall back to parsing the content text when the
      // metadata is missing — content parsing misses PIM images (they're on
      // stshared…blob.core.windows.net, not cdn.) and yields noisier specs.
      const specs = (meta.specs && Object.keys(meta.specs).length) ? meta.specs : this.parseSpecs(r.document.content);
      const images = (Array.isArray(meta.images) && meta.images.length) ? meta.images : this.parseImages(r.document.content);
      const contentChunk = r.document.chunk || '';

      const chunkTokens = Math.ceil(contentChunk.length / 4);

      if (cumulativeTokens + chunkTokens > MAX_TOKEN_BUDGET) {
        const remainingBudget = MAX_TOKEN_BUDGET - cumulativeTokens;
        if (remainingBudget > 50) {
          const charSliceLimit = remainingBudget * 4;
          budgetedResults.push({
            title: r.document.title,
            type: r.document.metadata?.type,
            sku: r.document.metadata?.sku || specs['Item Code'] || '',
            price: r.document.metadata?.price,
            collection: r.document.metadata?.collection,
            finishes: r.document.metadata?.finishes || (specs['Colour'] ? [specs['Colour']] : []),
            images: images,
            imageUrl: images[0] || '',
            specs: specs,
            description: meta.description || '',
            url: r.document.metadata?.url || r.document.sourceUrl,
            documents: meta.documents || [],
            content: contentChunk.slice(0, charSliceLimit) + '... [Content truncated due to token budget]'
          });
          cumulativeTokens = MAX_TOKEN_BUDGET;
        }
        break;
      } else {
        budgetedResults.push({
          title: r.document.title,
          type: r.document.metadata?.type,
          sku: r.document.metadata?.sku || specs['Item Code'] || '',
          price: r.document.metadata?.price,
          collection: r.document.metadata?.collection,
          finishes: r.document.metadata?.finishes || (specs['Colour'] ? [specs['Colour']] : []),
          images: images,
          imageUrl: images[0] || '',
          specs: specs,
          description: meta.description || '',
          url: r.document.metadata?.url || r.document.sourceUrl,
          documents: meta.documents || [],
          content: contentChunk
        });
        cumulativeTokens += chunkTokens;
      }
    }

    if (budgetedResults.length === 0) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        // Do NOT tell the model to "keep searching" — that drove an infinite
        // retrieval loop. Instruct it to stop searching and involve the user.
        message: 'No matching documents found. Do not invent product or installation details. Either ask the customer one clarifying question to narrow the search, or tell them this item was not found and suggest the next step.'
      };
    }

    // ANF-98: the retrieval index (documents.metadata) doesn't carry the variant
    // axis, but the canonical `products` collection does. Join it so the card can
    // render real colour swatches + size pills + rating. Additive + best-effort —
    // a product without this data is returned exactly as before (unchanged for
    // every existing tenant), and a failed join never fails the search.
    try {
      const skus = [...new Set(budgetedResults.map((r: any) => r.sku).filter(Boolean))];
      if (skus.length) {
        const db = await this.getDb();
        const canon = await db.collection('products')
          .find(
            { projectId: brand, parentSku: { $in: skus } },
            { projection: { _id: 0, parentSku: 1, colors: 1, sizes: 1, rating: 1, completeTheLook: 1, originalPrice: 1 } },
          )
          .toArray();
        const byS = new Map(canon.map((c: any) => [String(c.parentSku), c]));
        for (const r of budgetedResults as any[]) {
          const c = byS.get(String(r.sku));
          if (!c) continue;
          if (Array.isArray(c.colors) && c.colors.length) r.colors = c.colors;
          if (Array.isArray(c.sizes) && c.sizes.length) r.sizes = c.sizes;
          if (c.rating) r.rating = c.rating;
          if (Array.isArray(c.completeTheLook) && c.completeTheLook.length) r.completeTheLook = c.completeTheLook.slice(0, 12);
          if (c.originalPrice?.min) r.originalPrice = c.originalPrice.min;
        }
      }
    } catch { /* enrichment is best-effort — never fail a search over it */ }

    return {
      found: true,
      resultCount: budgetedResults.length,
      results: budgetedResults
    };
  }

  // ── Ingestion control (AUG-7): start a config-driven run + report status ──
  // The pipeline is spawned as a detached worker: ingestion takes minutes-to-hours
  // and must never block an HTTP request. All of WHAT to ingest comes from the
  // project's own config, so this endpoint is brand-agnostic.
  async startIngest(projectId: string, only?: string[]): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    const db = await this.getDb();
    const jobs = db.collection('ingest_jobs');

    const running = await jobs.findOne({ projectId, status: { $in: ['queued', 'running'] } });
    if (running) return { ok: false, jobId: String(running._id), error: `An ingest is already ${running.status} for this project.` };

    const { insertedId } = await jobs.insertOne({
      projectId, status: 'queued', progress: {}, log: [],
      only: only?.length ? only : null, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = String(insertedId);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const cwd = process.env.INGEST_WORKER_CWD || path.resolve(process.cwd(), '../journeyax-web');
    const args = ['tsx', 'src/scripts/run-ingest.ts', '--project', projectId, '--job', jobId];
    if (only?.length) args.push('--only', only.join(','));
    try {
      // Large catalogue PDFs (hundreds of MB) need more than Node's ~4GB default
      // heap even with windowed extraction, since the source buffer stays resident.
      // Tunable per deployment via INGEST_MAX_OLD_SPACE_MB.
      const heapMb = process.env.INGEST_MAX_OLD_SPACE_MB || '8192';
      const env = {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${heapMb}`.trim(),
      };
      // stdio 'inherit' streams the worker's stage-by-stage logs into THIS
      // service's terminal, so an operator can watch ingestion live (the job
      // record + back office still get the same lines). Set INGEST_QUIET=true to
      // silence the console and rely on the job log alone.
      const quiet = process.env.INGEST_QUIET === 'true';
      const child = spawn('npx', args, {
        cwd, detached: true, env,
        stdio: quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      });
      child.unref();
    } catch (e) {
      await jobs.updateOne({ _id: insertedId }, { $set: { status: 'failed', error: (e as Error).message } });
      return { ok: false, jobId, error: (e as Error).message };
    }
    return { ok: true, jobId };
  }

  async getIngestJob(projectId: string, jobId: string): Promise<Record<string, unknown>> {
    const db = await this.getDb();
    let doc: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ObjectId } = require('mongodb');
      doc = await db.collection('ingest_jobs').findOne({ _id: new ObjectId(jobId) });
    } catch { /* malformed id */ }
    if (!doc || doc.projectId !== projectId) return { found: false };
    const { _id, log, ...rest } = doc;
    return { found: true, jobId: String(_id), ...rest, log: (log || []).slice(-40) };
  }

  // ── Pricebook (authoritative price/stock by SKU) — P0-04 ─────────────
  /**
   * Data maintenance operations (AUG-18).
   *
   * These repairs previously had to be run by hand against the database, which
   * meant no authorisation, no audit trail, and no way for an operator to repeat
   * them. Exposing them as named, permission-checked operations puts every
   * mutation on the same audited path as ingestion.
   *
   * Every op supports `dryRun` and reports what it WOULD change, because a
   * maintenance action that silently deletes the wrong rows is worse than none.
   */
  async runMaintenance(brand: string, op: string, dryRun = true, limit?: number): Promise<{
    op: string; dryRun: boolean; ok: boolean; changed: number; details: Record<string, unknown>;
  }> {
    const db = await this.getDb();
    const base = { op, dryRun, ok: true };

    if (op === 'probe-renderability') {
      /* Establish, ahead of any conversation, which styles can actually be
       * designed (AUG-25).
       *
       * Renderability used to be discovered lazily, on the first render request.
       * That is far too late: retrieval ranks styles by how well their text
       * matches, so a request for a custom team jersey surfaced "Game7
       * Two-Button Baseball Jersey" — a STOCK style with fixed factory colours,
       * no design lines and no printable zones. The customer was shown a
       * garment that can never wear their colours, and the failure only became
       * visible when the preview came up empty.
       *
       * Probing in bulk turns "can this be designed?" into a fact known before
       * the style is ever offered. Only sublimated styles are probed: a stock
       * style is not made-to-order and no imaging template exists for it, so
       * asking would be 1,477 pointless requests to someone else's host.
       */
      const P = db.collection('products');
      const filter = { projectId: brand, isSublimation: true, renderPattern: { $exists: false } };
      const pending = await P.countDocuments(filter);
      if (dryRun) return { ...base, changed: pending, details: { wouldProbe: pending } };

      const cfg = await this.getRendererConfig(brand);
      if (!cfg) {
        return { ...base, ok: false, changed: 0,
                 details: { error: 'No renderer configured for this project (project.configurator.renderer).' } };
      }

      const batch = await P.find(filter, { projection: { parentSku: 1 } })
        .limit(limit ?? 0).toArray();

      let renderable = 0, noTexture = 0, noMesh = 0, failed = 0;
      const CONC = 4;   // deliberately gentle — this is someone else's imaging host
      for (let i = 0; i < batch.length; i += CONC) {
        await Promise.all(batch.slice(i, i + CONC).map(async (p: any) => {
          const sku = String(p.parentSku || '');
          if (!sku) return;
          try {
            // Both resolvers cache onto the product document themselves.
            const [pattern, mesh] = await Promise.all([
              this.resolveTexturePattern(brand, sku, cfg),
              this.resolveGeometry(brand, sku, cfg),
            ]);
            if (pattern && mesh) renderable++;
            else if (!pattern) noTexture++;
            else noMesh++;
          } catch {
            /* A probe that threw is left UNRESOLVED rather than recorded as
             * unrenderable — a network blip must not permanently mark a good
             * style as undesignable. It is simply picked up by the next run. */
            failed++;
          }
        }));
      }

      return { ...base, changed: renderable + noTexture + noMesh,
               details: { probed: batch.length, renderable, noTexture, noMesh, failed, remaining: pending - batch.length } };
    }

    if (op === 'reindex') {
      const specs: [string, any, any?][] = [
        ['products', { projectId: 1, parentSku: 1 }, { unique: true }],
        ['products', { projectId: 1, 'taxonomy.sport': 1 }],
        ['products', { projectId: 1, 'taxonomy.audience': 1, 'taxonomy.sport': 1 }],
        ['collections', { projectId: 1, name: 1 }, { unique: true }],
        ['collections', { projectId: 1, skus: 1 }],
        ['team_directory', { projectId: 1, slug: 1 }, { unique: true }],
        ['team_directory', { projectId: 1, searchNames: 1 }],
        ['team_directory', { projectId: 1, kind: 1 }],
        /* The design-knowledge upsert filter (AUG-43). Without this every
         * upsert scanned the whole `documents` collection — 14,000 docs each
         * carrying a 1536-dimension embedding — so one lookup took 4.9 SECONDS
         * and a 7,000-document pass ran for hours before the server killed it
         * as a long-running operation. */
        ['documents', { projectId: 1, docType: 1, sku: 1, designLine: 1 }],
        ['documents', { projectId: 1, docType: 1 }],
        /* The pricebook lookup (P0-04). Pricing a kit matched SKUs with no
         * index at all, so every quote scanned the whole collection — the same
         * cost as above, paid on the step where the customer is watching a
         * total appear. */
        ['documents', { 'metadata.brand': 1, 'metadata.sku': 1 }],
        ['documents', { 'metadata.brand': 1, 'metadata.specs.Item Code': 1 }],
        /* The back-office catalogue list: filter by tenant + kind, newest first. */
        ['documents', { 'metadata.brand': 1, 'metadata.type': 1, updatedAt: -1 }],
      ];
      if (dryRun) return { ...base, changed: specs.length, details: { wouldEnsure: specs.length } };
      let n = 0;
      for (const [col, keys, opts] of specs) {
        await db.collection(col).createIndex(keys, opts || {}).then(() => { n++; }).catch(() => {});
      }
      return { ...base, changed: n, details: { ensured: n } };
    }

    if (op === 'clear-render-patterns') {
      // Forget which texture-atlas id resolved for each style, so the next
      // render re-probes. Needed whenever the imaging host publishes new
      // templates or the resolution rules change — otherwise a style stays
      // pinned to a stale (or wrongly rejected) pattern forever.
      const filter = {
        projectId: brand,
        $or: [{ renderPattern: { $exists: true } }, { hasGeometry: { $exists: true } }],
      };
      const n = await db.collection('products').countDocuments(filter);
      if (dryRun) return { ...base, changed: n, details: { wouldClear: n } };
      const r = await db.collection('products')
        .updateMany(filter, { $unset: { renderPattern: '', hasGeometry: '' } });
      return { ...base, changed: r.modifiedCount, details: { cleared: r.modifiedCount } };
    }

    if (op === 'sync-doc-type') {
      /* Make every knowledge document reachable when a type filter is applied.
       *
       * The design and cap stages write the kind top-level as `docType`, while
       * retrieval filters on `metadata.type` — so thousands of measured design
       * documents were invisible to any typed search, and the needs mapping
       * (AUG-67) had nothing to rank. An `$or` at query time is NOT available:
       * Atlas $vectorSearch rejects it and silently degrades the whole query to
       * regex. So the two fields are reconciled in the data instead, which is
       * also the only version of this fix that helps the vector index.
       *
       * Copy-only, never overwrite: where both exist, `metadata.type` is what
       * retrieval has always used and stays authoritative. */
      const D = db.collection('documents');
      const missing = (path: string) =>
        ({ $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }] });

      const typeFilter = {
        projectId: brand,
        docType: { $exists: true, $nin: [null, ''] },
        ...missing('metadata.type'),
      };
      /* The SAME mismatch applies to the tenant key. Retrieval filters on
       * `metadata.brand` while these documents carry only `projectId`, so even a
       * correctly typed design document stays invisible.
       *
       * `projectId` is the real isolation key (AUG-19) and filtering on it
       * directly would be the better fix — but the Atlas vector index declares
       * only metadata.brand/type/category as filter paths, and filtering on a
       * path the index does not know silently drops the whole query to regex.
       * Until the index is redefined, the field is mirrored instead. */
      const brandFilter = { projectId: brand, ...missing('metadata.brand') };

      if (dryRun) {
        const [nType, nBrand] = await Promise.all([
          D.countDocuments(typeFilter), D.countDocuments(brandFilter),
        ]);
        const byKind = await D.aggregate([
          { $match: typeFilter }, { $group: { _id: '$docType', n: { $sum: 1 } } }, { $sort: { n: -1 } },
        ]).toArray();
        return { ...base, changed: nType + nBrand,
                 details: { wouldSyncType: nType, wouldSyncBrand: nBrand, byDocType: byKind } };
      }
      const [rType, rBrand] = await Promise.all([
        D.updateMany(typeFilter, [{ $set: { 'metadata.type': '$docType' } }]),
        D.updateMany(brandFilter, [{ $set: { 'metadata.brand': '$projectId' } }]),
      ]);
      return { ...base, changed: rType.modifiedCount + rBrand.modifiedCount,
               details: { syncedType: rType.modifiedCount, syncedBrand: rBrand.modifiedCount } };
    }

    if (op === 'clear-design-visuals') {
      /* Forget every visual reading so the next capture re-derives them all
       * under one version of the analyser.
       *
       * Readings are only comparable if they were measured the same way, and
       * this analyser changed repeatedly while data was being collected — the
       * neutral filter, the tiny-zone rule, and the unreadable-render guard all
       * landed mid-flight. Mixing readings from several versions produces a
       * flag rate that describes the code's history rather than the catalogue.
       */
      const filter = { projectId: brand, designVisualsAt: { $exists: true } };
      const n = await db.collection('products').countDocuments(filter);
      if (dryRun) return { ...base, changed: n, details: { wouldClear: n } };
      const r = await db.collection('products')
        .updateMany(filter, { $unset: { designVisuals: '', designVisualsAt: '' } });
      return { ...base, changed: r.modifiedCount, details: { cleared: r.modifiedCount } };
    }

    if (op === 'dedupe-sizing-groups') {
      const C = db.collection('collections');
      const groups = await C.find({ projectId: brand, kind: 'sizing-group' }).toArray();

      // A group is identified by its DISTINCT members. Role collisions (the same
      // code as both adult and ladies) produce a different key from the clean
      // form, which is how duplicates survive an upsert.
      const bySig = new Map<string, any[]>();
      for (const g of groups as any[]) {
        const sig = [...new Set(g.skus || [])].sort().join('|');
        (bySig.get(sig) || bySig.set(sig, []).get(sig))!.push(g);
      }
      const collisions = (groups as any[]).filter((g) => {
        const v = [g.adult, g.youth, g.ladies].filter(Boolean);
        return new Set(v).size !== v.length;
      });
      const dupes = [...bySig.values()].filter((v) => v.length > 1);
      const wouldRemove = dupes.reduce((n, v) => n + v.length - 1, 0);

      if (dryRun) {
        return { ...base, changed: wouldRemove + collisions.length,
          details: { duplicateGroups: dupes.length, rowsToRemove: wouldRemove, roleCollisions: collisions.length } };
      }

      let removed = 0, repaired = 0;
      // Repair role collisions first: the specific slot carries the real
      // information, so the generic `adult` slot is the one to clear.
      for (const g of collisions) {
        let adult = g.adult;
        if (adult && (adult === g.ladies || adult === g.youth)) adult = null;
        const skus = [...new Set([adult, g.youth, g.ladies].filter(Boolean))];
        if (skus.length < 2) { await C.deleteOne({ _id: g._id }); removed++; continue; }
        await C.updateOne({ _id: g._id }, { $set: { adult, skus } });
        repaired++;
      }
      // Then collapse duplicates, keeping the most complete record. Losers are
      // deleted BEFORE the keeper is renamed, or the unique key collides.
      for (const [sig, list] of bySig) {
        if (list.length < 2) continue;
        const filled = (g: any) => [g.adult, g.youth, g.ladies].filter(Boolean).length;
        list.sort((a, b) => filled(b) - filled(a));
        const keep = list[0], target = `sizing:${sig}`;
        for (const d of list.slice(1)) { await C.deleteOne({ _id: d._id }); removed++; }
        if (keep.name !== target) {
          await C.deleteOne({ projectId: brand, name: target, _id: { $ne: keep._id } });
          await C.updateOne({ _id: keep._id }, { $set: { name: target, skus: [...new Set(keep.skus)] } });
        }
      }
      return { ...base, changed: removed + repaired, details: { removed, repaired } };
    }

    if (op === 'purge-directory') {
      // Rebuilding the directory from scratch; ingestion re-populates it.
      const T = db.collection('team_directory');
      const n = await T.countDocuments({ projectId: brand, sourceKind: { $ne: 'in-conversation' } });
      if (dryRun) {
        return { ...base, changed: n,
          details: { wouldDelete: n, preserved: 'customer-registered records are never purged' } };
      }
      // Customer-registered entities are the tenant's own data and are NOT
      // regenerable from any source, so they survive a purge.
      const r = await T.deleteMany({ projectId: brand, sourceKind: { $ne: 'in-conversation' } });
      return { ...base, changed: r.deletedCount, details: { deleted: r.deletedCount } };
    }

    return { op, dryRun, ok: false, changed: 0,
      details: { error: `Unknown operation "${op}".`, available: ['reindex', 'dedupe-sizing-groups', 'purge-directory'] } };
  }

  /**
   * Register a club / travel / rec team the customer names (AUG-15).
   *
   * No public registry of club teams exists — they form and fold constantly — so
   * these are TENANT-OWNED records captured from the customer. That is also the
   * more valuable asset: a club that ordered last season is found instantly on
   * reorder, which no public dataset could ever provide.
   *
   * Everything here is customer-stated, so it is recorded as such: colours are
   * kept because the customer supplied them, never because we looked them up.
   */
  async registerTeam(brand: string, input: {
    name: string; kind?: string; city?: string; state?: string; country?: string;
    sport?: string; colours?: { name?: string; hex?: string }[];
  }): Promise<{ ok: boolean; slug?: string; message: string }> {
    const name = String(input?.name || '').trim();
    if (!name) return { ok: false, message: 'A team name is required.' };

    const db = await this.getDb();
    const T = db.collection('team_directory');
    const slug = `club-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
      + (input.state ? `-${String(input.state).toLowerCase()}` : '');

    const searchNames = [...new Set([name, input.city ? `${name} ${input.city}` : '']
      .filter(Boolean).map((s) => s.toLowerCase()))];

    await T.updateOne(
      { projectId: brand, slug },
      { $set: {
        projectId: brand, slug, kind: input.kind || 'club',
        programme: name, institution: name,
        city: input.city || null, state: input.state || null,
        country: input.country || null, sport: input.sport || null,
        searchNames,
        colours: input.colours || [],
        // Provenance is the point: these facts came from the customer, so the
        // agent can rely on them for THIS customer without implying they are
        // verified against any authority.
        colourSource: input.colours?.length ? 'customer-stated' : 'unconfirmed',
        artworkPolicy: 'customer-supplied',
        confidence: 'customer-stated',
        source: 'customer', sourceKind: 'in-conversation',
        updatedAt: new Date(),
      } },
      { upsert: true },
    );
    return { ok: true, slug, message: `Saved "${name}" to this account, so it can be reused on the next order.` };
  }

  /**
   * Find a school / athletic programme the customer is buying for (AUG-15).
   *
   * Returns candidates rather than one answer — "Chicago" legitimately matches
   * several programmes, and picking silently would put the wrong crest on a
   * team's kit. Every record carries its confidence and source so the agent can
   * say where a fact came from, and colours/artwork are never presented as
   * settled: they are confirmed with the customer.
   */
  /** Levenshtein distance, capped — we only care whether two strings are CLOSE,
   *  so anything past the cap is simply "not a match" and exits early. */
  private editDistance(a: string, b: string, cap = 6): number {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > cap) return cap + 1;   // whole row already too far — stop
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * Token-overlap + edit-distance matching for names that exact/prefix missed.
   *
   * A shared distinctive token ("thunder") narrows 41k records to a handful
   * using the existing index; edit distance then ranks them. This catches both
   * "Thunder" → "Naperville Thunder" and "Napervile Thunder" → the same, which
   * is what customers actually get wrong.
   */
  private async fuzzyTeamMatch(
    T: any, brand: string, q: string, loc: any, proj: any, want: number, seen: Set<string>,
  ): Promise<any[]> {
    // Ignore short/common words — "high", "school", "the" match half the country.
    const STOP = new Set(['the', 'of', 'high', 'school', 'middle', 'jr', 'sr', 'academy', 'college', 'university', 'and']);
    // Include SHORT tokens: an acronym ("IIT", "UCLA") is usually the most
    // discriminative word in the query, and dropping it meant "IIT Chicago"
    // searched only on "chicago" — which Illinois Tech's names never contain.
    const tokens = q.split(/\s+/).map((t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase())
      .filter((t) => t.length >= 2 && !STOP.has(t));
    if (!tokens.length) return [];

    // Aliases live in searchNames ("IIT" for Illinois Tech), and the acronym
    // check below needs them, so this tier reads them explicitly and strips
    // them from the response afterwards.
    const fuzzyProj = { projection: { _id: 0, embedding: 0 } };
    const candidates = await T.find(
      { projectId: brand, ...loc, searchNames: { $regex: tokens.map((t) => `(?=.*${t})`).join('') } },
      fuzzyProj,
    ).limit(200).toArray();

    // Nothing shares every token — retry on ANY token, for a single-word typo.
    const pool = candidates.length ? candidates : await T.find(
      { projectId: brand, ...loc, searchNames: { $regex: tokens.join('|') } },
      fuzzyProj,
    ).limit(200).toArray();

    return pool
      .filter((m: any) => !seen.has(m.slug))
      .filter((m: any) => {
        /* Acronyms and initials are IDENTITY-BEARING, not noise. "IIT Chicago"
         * and "IYC Chicago" differ by two characters but are unrelated
         * institutions — edit distance alone happily matches them. So a short
         * token in the query must actually appear somewhere in the candidate;
         * otherwise this is a different organisation, not a misspelling. */
        const shortTokens = q.split(/\s+/)
          .map((t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase())
          .filter((t) => t.length >= 2 && t.length <= 4 && !STOP.has(t));
        if (!shortTokens.length) return true;
        const hay = [m.programme, m.institution, m.nickname, ...(m.searchNames || [])]
          .filter(Boolean).join(' ').toLowerCase();
        return shortTokens.every((t) => hay.includes(t));
      })
      .map((m: any) => {
        // Score against EVERY known name (label, nickname, aliases) and keep the
        // best — a customer using an alias should score as well as one using the
        // official name.
        const names: string[] = [...new Set([m.programme, m.institution, m.nickname, ...(m.searchNames || [])]
          .filter(Boolean).map((x: any) => String(x).toLowerCase()))];
        let score = 1;
        for (const name of names) {
          // Score against the QUERY length, not the longest of the two: dividing
          // by max() lets a long unrelated name ("Thunderbolt Career and
          // Technology Center") look close simply because it is long.
          const whole = this.editDistance(q, name, 40) / Math.max(q.length, 1);
          /* Containment in ONE direction only: the record's name may contain the
           * query ("Thunder" → "Naperville Thunder"). The reverse is unsafe —
           * "Rockford Lightning" contains "Rockford", which would score every
           * school in Rockford as a near-certain match for a team that isn't
           * theirs. Preferring no match over a confident wrong one matters more
           * here than recall: the cost of the wrong school is a printed order. */
          const contained = name.includes(q) ? 0.1 : 1;
          score = Math.min(score, whole, contained);
        }
        return { m, score };
      })
      .filter((x: any) => x.score <= 0.34)   // ~1 typo per 3 characters; beyond that it is a different name
      .sort((a: any, b: any) => a.score - b.score)
      .slice(0, want)
      // Flagged so the agent treats these as SUGGESTIONS to confirm, not as a
      // found record — a near-miss on a school name is not an identification.
      .map((x: any) => {
        const { searchNames, ...rest } = x.m;
        return { ...rest, matchedBy: 'fuzzy', matchConfidence: Number((1 - x.score).toFixed(2)) };
      });
  }

  /**
   * Propose a team's colours (AUG-27).
   *
   * Every directory record arrives with colours: [] and colourSource:
   * "unconfirmed" — NCES and Wikidata give us the institution, never its kit
   * palette. So the agent has been asking "what are your colours?", which is the
   * un-agentic moment: the customer told us their school, and we made them do
   * the work anyway.
   *
   * This proposes an answer instead. Three rules make that safe:
   *
   *   1. A proposal is NEVER applied. It is stored as `proposed`, with its
   *      provenance, and only becomes usable once a human confirms it. The
   *      brand's own spec requires research be shown and confirmed.
   *   2. Proposed names are mapped onto the colours this brand actually STOCKS.
   *      A school whose colours are "Vegas Gold and Navy" can be served; one
   *      whose gold we do not stock is told so, rather than being shown a
   *      substitute or a black garment.
   *   3. Nothing here touches artwork. Colours are not a crest — logos remain
   *      customer-supplied, always.
   */
  async proposeTeamColours(brand: string, slug: string, palette: string[] = []): Promise<{
    slug: string;
    status: 'confirmed' | 'proposed' | 'unknown';
    colours: string[];
    stocked: string[];
    notStocked: string[];
    source?: string;
    guidance: string;
  }> {
    const db = await this.getDb();
    const T = db.collection('team_directory');
    const rec: any = await T.findOne({ projectId: brand, slug }, { projection: { _id: 0 } });
    if (!rec) {
      return { slug, status: 'unknown', colours: [], stocked: [], notStocked: [],
               guidance: 'No such programme on file — ask the customer to name it again.' };
    }

    // Already settled by a human: use it, do not research again.
    if (rec.colourSource === 'customer-confirmed' && rec.colours?.length) {
      const { stocked, notStocked } = this.splitByPalette(rec.colours, palette);
      return { slug, status: 'confirmed', colours: rec.colours, stocked, notStocked,
               source: 'confirmed by the customer',
               guidance: 'These were confirmed by the customer. Use them.' };
    }
    // Already proposed and still awaiting confirmation: re-offer the same answer
    // rather than paying for research twice and risking a different one.
    if (rec.proposedColours?.length) {
      const { stocked, notStocked } = this.splitByPalette(rec.proposedColours, palette);
      return { slug, status: 'proposed', colours: rec.proposedColours, stocked, notStocked,
               source: rec.proposedColourSource,
               guidance: 'PROPOSED, not confirmed. Show the customer, name the source, and ask them '
                       + 'to confirm before using these on a garment.' };
    }

    let colours: string[] = [];
    let source = '';
    try {
      const who = [rec.institution, rec.city, rec.state, rec.country].filter(Boolean).join(', ');
      const r = await this.getOpenAI().chat.completions.create({
        model: process.env.TEAM_COLOUR_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [{
          role: 'user',
          content: `What are the official athletic team colours of ${who}?\n`
            + `Reply as JSON: {"colours":["Colour One","Colour Two"],"source":"where this is commonly published",`
            + `"confident":true|false}. Use plain colour names. If you are not reasonably sure which `
            + `institution this is, or do not know its colours, return {"colours":[],"confident":false}. `
            + `Do NOT guess — a wrong answer puts the wrong colours on a team's uniform.`,
        }],
        response_format: { type: 'json_object' },
      });
      const parsed = JSON.parse(r.choices[0]?.message?.content || '{}');
      if (parsed?.confident && Array.isArray(parsed.colours)) {
        colours = parsed.colours.map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 4);
        source = String(parsed.source || 'general knowledge');
      }
    } catch {
      /* fall through to unknown — asking the customer is a fine outcome */
    }

    if (!colours.length) {
      return { slug, status: 'unknown', colours: [], stocked: [], notStocked: [],
               guidance: 'Colours are not known for this programme. Ask the customer, and offer the '
                       + "brand's stocked colours to choose from." };
    }

    await T.updateOne({ projectId: brand, slug }, { $set: {
      proposedColours: colours, proposedColourSource: source, proposedAt: new Date(),
    } });

    const { stocked, notStocked } = this.splitByPalette(colours, palette);
    return { slug, status: 'proposed', colours, stocked, notStocked, source,
             guidance: 'PROPOSED, not confirmed. Say where this came from, show the customer, and ask '
                     + 'them to confirm before putting it on a garment. '
                     + (notStocked.length
                        ? `${notStocked.join(', ')} is not stocked by this brand — offer the nearest alternative.`
                        : '') };
  }

  /** Confirm a team's colours. Only a human confirmation settles this. */
  async confirmTeamColours(brand: string, slug: string, colours: string[]): Promise<{ ok: boolean }> {
    const db = await this.getDb();
    const clean = (colours || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 4);
    if (!clean.length) return { ok: false };
    await db.collection('team_directory').updateOne({ projectId: brand, slug }, { $set: {
      colours: clean, colourSource: 'customer-confirmed', colourConfirmedAt: new Date(),
    } });
    return { ok: true };
  }

  /** Which of these colour names this brand can actually print. */
  private splitByPalette(colours: string[], palette: string[]): { stocked: string[]; notStocked: string[] } {
    if (!palette?.length) return { stocked: [], notStocked: [] };
    const known = new Map(palette.map((p) => [p.trim().toUpperCase(), p]));
    const stocked: string[] = []; const notStocked: string[] = [];
    for (const c of colours) {
      /* Match on WORDS, both directions. People say "Navy Blue" for NAVY and
       * "Gold" for VEGAS GOLD; a one-directional substring test declares the
       * first missing and the second found, which is arbitrary. Requiring one
       * name's words to be a subset of the other's keeps SCARLET and RED apart
       * (no shared word) while catching the real synonyms. */
      const words = (v: string) => new Set(v.toUpperCase().split(/[^A-Z]+/).filter(Boolean));
      const want = words(c);
      const hit = known.get(c.trim().toUpperCase())
        || palette.find((p) => {
          const have = words(p);
          const subset = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
          return subset(want, have) || subset(have, want);
        });
      if (hit) stocked.push(hit); else notStocked.push(c);
    }
    return { stocked, notStocked };
  }

  async findTeams(brand: string, query: string, limit = 6, where: { state?: string; city?: string } = {}): Promise<{
    query: string;
    matches: any[];
    totalMatches: number;
    needsLocation?: boolean;
    availableStates?: string[];
    guidance: string;
  }> {
    const q = String(query || '').trim().toLowerCase();
    const baseGuidance =
      'Confirm the exact programme with the customer before proceeding. Team colours and any ' +
      'logo/crest must be supplied or confirmed BY the customer — never assert them from this record, ' +
      'and never reproduce a school mark from an outside source.';
    if (!q) return { query: '', matches: [], totalMatches: 0, guidance: baseGuidance };

    const db = await this.getDb();
    const T = db.collection('team_directory');
    const proj = { projection: { _id: 0, embedding: 0, searchNames: 0 } };

    /* Location narrows, but must never EXCLUDE a record that simply has no
     * location on file. College programmes carry country only, so a helpful
     * `state: "IL"` from the agent was dropping the very record it was trying to
     * pin down — a more specific query returning fewer results. Treat "unknown
     * location" as "still a candidate" and let the customer confirm. */
    const locMatch = (field: string, value: string) => ({
      $or: [
        { [field]: new RegExp(`^${String(value).trim()}$`, 'i') },
        { [field]: { $in: [null, ''] } },
        { [field]: { $exists: false } },
      ],
    });
    const locClauses: any[] = [];
    if (where.state) locClauses.push(locMatch('state', where.state));
    if (where.city) locClauses.push(locMatch('city', where.city));
    const loc: any = locClauses.length ? { $and: locClauses } : {};

    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Exact handle beats prefix, so a precise name outranks a loose substring.
    const exact = { projectId: brand, searchNames: q, ...loc };
    const prefix = { projectId: brand, searchNames: { $regex: `^${esc}` }, ...loc };

    const totalMatches = await T.countDocuments(exact) || await T.countDocuments(prefix);

    let matches = await T.find(exact, proj).limit(limit).toArray();
    if (matches.length < limit) {
      const more = await T.find(prefix, proj).limit(limit - matches.length).toArray();
      const seen = new Set(matches.map((m: any) => m.slug));
      matches = [...matches, ...more.filter((m: any) => !seen.has(m.slug))];
    }

    /* Fuzzy fallback — only when exact and prefix both come up short.
     *
     * Deliberately LEXICAL, not semantic. Team names are proper nouns, and
     * embeddings cluster them by theme: "Rockford Lightning" scores HIGHER
     * against "Naperville Thunder" than the same team misspelt does. Matching a
     * thematically-similar team would put the wrong school's crest on a kit.
     *
     * The real misses are typos and partial names, so this ranks by shared
     * tokens first, then edit distance — both exact, free and explainable. */
    if (matches.length < limit) {
      matches = [...matches, ...(await this.fuzzyTeamMatch(T, brand, q, loc, proj, limit - matches.length,
        new Set(matches.map((m: any) => m.slug))))];
    }

    /* School names repeat heavily across the country — "Central High School"
     * exists in dozens of states. When the customer hasn't given a location and
     * the name is ambiguous, say so and hand back the states on file, so the
     * agent asks "which state?" instead of guessing or listing forty options. */
    const ambiguous = !where.state && !where.city && totalMatches > limit;
    let availableStates: string[] | undefined;
    if (ambiguous) {
      availableStates = (await T.distinct('state', exact) as string[])
        .filter(Boolean).sort().slice(0, 60);
    }

    return {
      query,
      matches,
      totalMatches,
      ...(ambiguous ? { needsLocation: true, availableStates } : {}),
      guidance: ambiguous
        ? `${totalMatches} organisations share this name. Ask the customer which state (or city) theirs is in before going further — do not pick one. ${baseGuidance}`
        : matches.length && matches.every((m: any) => m.matchedBy === 'fuzzy')
          // No exact record matched — these are spelling-corrections, not an
          // identification, so the agent must read them back rather than adopt one.
          ? `No exact match — these are close-spelling suggestions. Read the closest one back and ask "did you mean…?" before using it. ${baseGuidance}`
          : baseGuidance,
    };
  }

  /**
   * Which of these tokens are real style codes in this catalogue (AUG-22).
   *
   * Used to settle IDENTITY: when a customer names a style, that style must win
   * over any code the model picked up while searching. One indexed query for the
   * whole candidate set, so it is cheap enough to run on every design turn.
   */
  async existingSkus(brand: string, skus: string[]): Promise<string[]> {
    const clean = [...new Set((skus || [])
      .map((s) => String(s || '').trim().toUpperCase())
      .filter((s) => s.length >= 3 && s.length <= 12))];
    if (!clean.length) return [];
    const db = await this.getDb();
    const rows = await db.collection('products')
      .find({ projectId: brand, parentSku: { $in: clean } }, { projection: { parentSku: 1, _id: 0 } })
      .toArray();
    return rows.map((r: any) => String(r.parentSku).toUpperCase());
  }

  /** The imaging-platform config for this project (AUG-21). Read from the
   *  project's own configurator block so hosts, cameras and template slot names
   *  are never hardcoded to one vendor. */
  /**
   * The brand's real colour list, as captured from the platform (AUG-30).
   *
   * Returns the RENDER codes, because that is what every consumer already
   * expects a palette entry to be — the seed list is render codes, the imaging
   * host is driven by them, and a display name like "Soul Blue" would not
   * compose. Cached per project: this is a static list that changes only when
   * an ingest re-captures it.
   */
  private async capturedPalette(brand: string): Promise<string[]> {
    return getOrSet(cacheKey(brand, 'captured-palette'), async () => {
      try {
        const db = await this.getDb();
        const doc: any = await db.collection('brand_palettes').findOne({ projectId: brand });
        const colours: any[] = Array.isArray(doc?.colours) ? doc.colours : [];
        return [...new Set(
          colours.map((c) => String(c?.render || c?.display || '').trim()).filter(Boolean),
        )];
      } catch {
        return [];
      }
    }, { ttlSeconds: 3600 });
  }

  /**
   * Compose a render for a style: texture atlas, geometry, design lines,
   * lettering and catalogue photo, resolved for THIS style and handed to the
   * renderer. The HTTP route is a thin delegate over this, so anything that
   * renders internally behaves identically to what a customer sees.
   */
  async renderStyle(brand: string, body: any): Promise<any> {
    const cfg = await this.getRendererConfig(brand);
    if (!cfg) {
      return { style: body?.style, renderable: false,
        notes: ['No renderer configured for this project (project.configurator.renderer).'] };
    }
    const style = String(body?.style || '');
    if (!style) return { style, renderable: false, notes: ['style is required.'] };

    /* Headwear is configured by colourway, not by a composed atlas, so it takes
     * its own path before any of the texture resolution below — every one of
     * those probes would be a wasted round trip against a style that has no
     * template, and would end in renderable:false for a cap that renders fine. */
    const cap = await this.resolveCap(brand, style);
    if (cap) {
      const capImage = await this.getCatalogueImage(brand, style);
      return this.renderer.build(
        { ...body, style },
        { ...cfg, cap, catalogueImage: capImage },
      );
    }

    const [pattern, meshFormat, designLines, catalogueImage] = await Promise.all([
      this.resolveTexturePattern(brand, style, cfg),
      this.resolveGeometry(brand, style, cfg),
      this.resolveDesignLines(brand, style, cfg),
      this.getCatalogueImage(brand, style),
    ]);
    // Only offer a mesh we have actually seen. Texture coverage and model
    // coverage differ, and promising geometry that 404s strands the viewer.
    // Where the lettering sits, so the browser can turn a click on the garment
    // into "the customer touched the team name". Cached per style+design line.
    const textZones = pattern
      ? await this
          .resolveTextZones(brand, style, body?.designLine, cfg, pattern)
          .catch(() => null)
      : null;

    // Colour zones come from THIS style's catalogue entry, not a fixed list.
    /* Where this style can be lettered, from the decoration capture (AUG-30).
     *
     * Distinct from `textZones`, which are measured UV rectangles used to turn a
     * click on the garment into "they touched the team name". Those are absent
     * for every style at present, and the UI had no other way to know whether a
     * garment takes lettering at all — so it could not offer name and number
     * fields safely. The captured slot list answers the simpler question the UI
     * actually needs: does this style print a name or a number? */
    const lettering = await this.getLetteringSlots(brand, style, body?.designLine);

    const effective = {
      ...cfg,
      ...(catalogueImage ? { catalogueImage } : {}),
      ...(textZones ? { textZones } : {}),
      ...(lettering?.length ? { letteringSlots: lettering } : {}),
      ...(designLines ? { designLines } : {}),
      ...(meshFormat ? { meshFormat } : { modelBase: undefined }),
    };
    return this.renderer.build(body || {}, effective, pattern || undefined);
  
  }

  /**
   * What a brand's ink ACTUALLY looks like (AUG-81).
   *
   * The captured palette stores an id, a display name and a render code — and
   * no colour value at all, because the platform never publishes one: a
   * garment's colour is applied by NAME and resolved inside the imaging host's
   * own defined colourspace. So every swatch we drew was a guess made from the
   * colour's WORD, via CSS. "Blue" happened to work; "Bright Blue", "Vegas
   * Gold" and "RA Gridiron Silver" are not CSS colours, so they came out white
   * — a blank chip beside the words "your team colours", which is the one place
   * a coach must be able to trust what they see.
   *
   * The brand can answer the question even though it does not publish the
   * answer: ask its own renderer to paint a garment in exactly one ink and read
   * the pixels back. Every zone takes that ink (the renderer repeats a single
   * colour across all zones), so the dominant opaque pixel IS the ink. That
   * makes BRIGHT BLUE #0078ba rather than CSS blue #0000ff — the brand's real
   * colour, derived from the brand's own imaging, with nothing hand-typed.
   *
   * One probe per colour for the life of the catalogue: the result is cached,
   * and the cache is dropped on ingest and publish like every other catalogue
   * fact. Unknown colours resolve to nothing rather than to a plausible wrong
   * value — a missing swatch is honest, a wrong one is not.
   */
  async inkColours(brand: string, names: string[]): Promise<Record<string, string>> {
    const wanted = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))];
    if (!wanted.length) return {};
    const out: Record<string, string> = {};
    await Promise.all(wanted.map(async (name) => {
      const hex = await getOrSet(cacheKey(brand, 'ink-colour', { name: name.toUpperCase() }),
        () => this.probeInk(brand, name), { ttlSeconds: MAX_TTL_SECONDS });
      if (hex) out[name] = hex;
    }));
    return out;
  }

  /** The style used to probe inks: any style this project can actually render. */
  private async inkProbeStyle(brand: string): Promise<{ style: string; designLine?: string } | null> {
    return getOrSet(cacheKey(brand, 'ink-probe-style'), async () => {
      const db = await this.getDb();
      /* The style must carry design lines as well as a texture pattern: the
       * renderer resolves colour zones FROM the chosen design line, so a style
       * with none composes no texture and the probe returns nothing.
       * `designLines` is a MAP of slug → { label, zones }, not a list. */
      const row: any = await db.collection('products').findOne(
        { projectId: brand,
          renderPattern: { $exists: true, $ne: null },
          designLines: { $exists: true, $ne: null } },
        { projection: { parentSku: 1, designLines: 1 } },
      );
      if (!row?.parentSku) return null;
      // Any design line will do — a single colour is repeated across every zone,
      // so the ink dominates the atlas whichever pattern is drawn over it.
      const designLine = Object.keys(row.designLines || {})[0];
      return { style: String(row.parentSku), designLine: designLine || undefined };
    }, { ttlSeconds: MAX_TTL_SECONDS });
  }

  private async probeInk(brand: string, name: string): Promise<string | null> {
    try {
      const probe = await this.inkProbeStyle(brand);
      if (!probe) return null;
      const built: any = await this.renderStyle(brand, {
        style: probe.style, designLine: probe.designLine, colours: [name],
      });
      /* A colour the brand does not stock is REJECTED by the renderer and its
       * zones are simply left unset — which paints the garment white. Reading
       * the pixels back would then report every unknown colour as #ffffff, a
       * confident wrong answer of exactly the kind this whole probe exists to
       * remove. The renderer says which names it refused; believe it. */
      const rejected: string[] = Array.isArray(built?.rejectedColours) ? built.rejectedColours : [];
      if (rejected.some((r) => String(r).trim().toUpperCase() === name.trim().toUpperCase())) return null;
      const url = String(built?.texture || '');
      if (!url) return null;
      // Small render: the ink is a flat fill, so 200px is as truthful as 1200
      // and an order of magnitude cheaper.
      const res = await fetch(url.replace(/([?&]wid=)\d+/, '$1200'),
        { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      return this.dominantOpaqueColour(Buffer.from(await res.arrayBuffer()));
    } catch {
      return null;   // best-effort: no swatch beats a wrong swatch
    }
  }

  /** The most common fully-opaque pixel in a PNG, as `#rrggbb`. */
  private dominantOpaqueColour(png: Buffer): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PNG } = require('pngjs');
      const img = PNG.sync.read(png);
      const counts = new Map<number, number>();
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] < 250) continue;
        const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let best = -1, bestN = 0;
      for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
      if (best < 0) return null;
      return '#' + best.toString(16).padStart(6, '0');
    } catch {
      return null;
    }
  }

  async getRendererConfig(brand: string): Promise<any | null> {
    try {
      const base = process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
      const res = await fetch(`${base}/api/v1/projects/${encodeURIComponent(brand)}`, {
        headers: { 'X-Tenant-ID': brand, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const p: any = await res.json();
      const r = p?.configurator?.renderer;
      if (!r) return null;
      // sizeScale lives on `configurator`, not on `renderer`, but the studio needs
      // it alongside the palette so a size that cannot be ordered is never
      // offered in a dropdown.
      const cfg = Array.isArray(p?.configurator?.sizeScale)
        ? { ...r, sizeScale: p.configurator.sizeScale }
        : { ...r };

      /* Serve the CAPTURED palette when we have one.
       *
       * The configured `renderer.palette` is a seed — fourteen colours typed in
       * by hand — while the ingest captured the brand's real one (111 shades)
       * into `brand_palettes`. Everything downstream matches a school's colours
       * against this list, so the short list quietly decided what a team could
       * wear: Naperville North's BLUE mapped to nothing at all (the seed has
       * NAVY but no word "blue"), the jersey came back in one colour, and three
       * "different" design concepts rendered identically. Config still wins when
       * no capture exists. */
      const captured = await this.capturedPalette(brand);
      if (captured.length) cfg.palette = captured;
      return cfg;
    } catch {
      return null;
    }
  }

  /**
   * Which texture-atlas id pattern actually works for this style (AUG-25).
   *
   * Two id namespaces are in use and neither covers the whole catalogue, so the
   * only reliable answer is to ask the imaging host once and remember it. A
   * missing template answers 200 with a ~36-byte body rather than a 404, and the
   * downstream 3D renderer then hangs on it indefinitely — which is how a
   * customer ends up staring at an empty viewer with no error. Resolving here
   * means an unrenderable style is known to be unrenderable before we promise
   * the customer a preview.
   *
   * The result is cached on the product document, so this costs one probe per
   * style for the life of the catalogue.
   */
  /**
   * Did this render actually paint? (AUG-25)
   *
   * A cutting-pattern layout is near-pure white with thin outlines; a garment
   * atlas wearing a probe colour has a substantial saturated area. Saturation
   * separates them where byte count cannot.
   */
  private paintsColour(png: Buffer, minShare = 0.02): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PNG } = require('pngjs');
      const img = PNG.sync.read(png);
      let coloured = 0, opaque = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] < 200) continue;
        opaque++;
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx > 42 && (mx - mn) / mx >= 0.25) coloured++;   // clearly saturated
      }
      return opaque > 0 && coloured / opaque >= minShare;
    } catch {
      // Undecodable: fall back to accepting it rather than rejecting a template
      // for a parsing problem of ours.
      return true;
    }
  }

  async resolveTexturePattern(brand: string, style: string, cfg: any): Promise<string | null> {
    const db = await this.getDb();
    // Products are keyed on an upper-cased parentSku, same as getOptions — using
    // any other field silently matches nothing, so every render would re-probe
    // the imaging host instead of answering from cache.
    const key = { projectId: brand, parentSku: String(style || '').trim().toUpperCase() };
    const cached = await db.collection('products').findOne(key, { projection: { renderPattern: 1 } });
    if (cached && 'renderPattern' in cached) return (cached as any).renderPattern || null;

    const base = String(cfg?.textureBase || '').replace(/\/$/, '');
    const patterns: string[] = cfg?.texturePatterns?.length
      ? cfg.texturePatterns
      : ['preview-prod-{style}-l', 'preview-{style}_front'];

    /* Ask the template to PAINT something (AUG-25).
     *
     * Byte count alone cannot tell a garment from a cutting pattern. For style
     * 228108 the correct id returns 408 with a 36-byte body — a processing
     * abort — so probing fell through to `preview-prod-228108-l`, which answers
     * 200 with 27KB of garment panel OUTLINES labelled "22810B-L": a different
     * style's pattern layout, no fill, no design. It passed every check here and
     * then produced 433 blank captures that were recorded as product faults.
     *
     * So the probe fills a body zone with a vivid colour and requires the reply
     * to actually contain that colour. A real atlas paints; an outline cannot.
     * Both namespaces are set because tops use SUB_FIRST_* and bottoms
     * SUB_SECOND_*, and setting one the template does not have is harmless. */
    /* The paint check only works if the design LAYER is switched on — a body
     * zone on a hidden layer paints nothing even on a perfectly good template,
     * which is why an earlier version of this probe rejected known-good styles.
     * Design lines come from the catalogue, independently of the texture id, so
     * one can be fetched first. Where none is available the check is skipped
     * rather than guessed at: no probe is better than a wrong verdict. */
    const lines = await this.resolveDesignLines(brand, style, cfg).catch(() => null);
    /* Pick the design line with the MOST colour zones. Taking the first one
     * rejected 329X3M — a style that renders perfectly — because its first line
     * is WEATHERED, which has zero colour zones and therefore paints nothing no
     * matter how good the template is. A line that paints a lot is the only
     * useful witness that a template works. */
    const toggle = lines
      ? Object.entries(lines)
          .sort((a, b) => (b[1]?.zones?.length || 0) - (a[1]?.zones?.length || 0))
          .filter(([, v]) => (v?.zones?.length || 0) > 0)[0]?.[0] ?? null
      : null;

    const fill = (name: string) =>
      encodeURIComponent(`<fill><SolidColor s7:colorName='${name}' s7:colorspace='defined'/></fill>`);
    const probeQuery = `?fmt=png&wid=600&setAttr.swatch=${encodeURIComponent('{visible=false}')}`
      + (toggle ? `&setAttr.${encodeURIComponent(toggle)}=${encodeURIComponent('{visible=true}')}` : '')
      + `&setElement.SUB_FIRST_BODY_COLOR=${fill(PROBE_COLOUR)}`
      + `&setElement.SUB_SECOND_BODY_COLOR=${fill(PROBE_COLOUR)}`;

    let hit: string | null = null;
    for (const pattern of patterns) {
      const id = pattern.replace('{style}', style);
      /* A 36-byte body is the imaging host ABORTING, not saying the template is
       * absent — the two are indistinguishable by status code. Rejecting on the
       * first abort is what demoted good styles to a wrong template, so each
       * pattern is retried before it is written off. */
      for (let attempt = 0; attempt < 3 && !hit; attempt++) {
        try {
          const res = await fetch(`${base}/${id}${probeQuery}`, { signal: AbortSignal.timeout(15000) });
          const body = Buffer.from(await res.arrayBuffer());
          if (!res.ok || body.byteLength <= 2000) {
            // Abort or genuinely missing — wait a moment and ask again.
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          /* Only judge by paint when a layer was actually switched on. Without
           * a toggle the reply is legitimately unpainted, and a cutting pattern
           * is indistinguishable from a real garment by ink alone — measured at
           * 2.6% vs 3.6% non-white, 0% saturation on both. Guessing there would
           * reject working styles, which is worse than accepting a rare wrong
           * template. */
          if (!toggle || this.paintsColour(body)) { hit = pattern; }
          else {
            console.warn(`[ProductService] ${style}: ${id} responded but painted nothing with `
              + `"${toggle}" visible — not this style's atlas`);
            break;   // retrying will not change what the template is
          }
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
      }
      if (hit) break;
    }

    await db.collection('products').updateOne(key, { $set: { renderPattern: hit } });
    return hit;
  }

  /**
   * Does this style actually have a mesh? (AUG-25, geometry half.)
   *
   * Deriving {style}.obj from a base URL asserts geometry exists for every style
   * in the catalogue, which is not true — model coverage is far thinner than
   * texture coverage. Claiming a mesh we do not have produces a viewer that
   * fails after the customer has already been told their design is ready, so
   * the existence check belongs here, not in the browser.
   *
   * Cached alongside renderPattern; a HEAD is enough and costs nothing to keep.
   */
  async resolveGeometry(brand: string, style: string, cfg: any): Promise<'glb' | 'obj' | null> {
    if (!cfg?.modelBase) return null;
    const db = await this.getDb();
    const key = { projectId: brand, parentSku: String(style || '').trim().toUpperCase() };
    const cached = await db.collection('products').findOne(key, { projection: { hasGeometry: 1, meshFormat: 1 } });
    if (cached && 'meshFormat' in cached) return (cached as any).meshFormat || null;

    // One folder per style, holding the glTF, the legacy OBJ/MTL and a normal
    // map. Prefer the glTF — it is roughly a third the size — but some styles
    // were never re-exported and ship OBJ only, so fall back rather than
    // declaring them unrenderable.
    const dir = `${String(cfg.modelBase).replace(/\/$/, '')}/${style}`;
    const exists = async (url: string) => {
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
        // A 200 is not proof of existence: static hosts with a single-page-app
        // rewrite answer 200 + index.html for ANY unknown path. A real mesh is
        // hundreds of kilobytes of binary; the fallback is a little text/html.
        const type = (res.headers.get('content-type') || '').toLowerCase();
        const size = Number(res.headers.get('content-length') || 0);
        return res.ok && !type.includes('text/html') && size > 10000;
      } catch {
        return false;
      }
    };

    const format = (await exists(`${dir}/${style}.glb`)) ? 'glb'
      : (await exists(`${dir}/${style}.obj`)) ? 'obj'
      : null;

    await db.collection('products').updateOne(key, { $set: { hasGeometry: !!format, meshFormat: format } });
    return format as 'glb' | 'obj' | null;
  }

  /**
   * The design lines this style actually offers, and the colour zones each one
   * exposes (AUG-23).
   *
   * This is the fix for garments rendering with no body colour. Three things
   * vary that we previously treated as fixed:
   *
   *   1. Design lines are PER STYLE. 228130 offers "center field"; 329X3M offers
   *      "serpentine", "topography", "pearl"… Asking for a design line the style
   *      does not have leaves its layer hidden, and every colour silently does
   *      nothing — the garment renders blank.
   *   2. Zone names are per (style x design line). Some have a body zone, some
   *      have none at all ("hitter" starts at ACCENT_1), some carry a separate
   *      trim variant (BODY_COLOR_T alongside BODY_COLOR).
   *   3. The prefix is not constant. Tops use SUB_FIRST_*, bottoms SUB_SECOND_*.
   *
   * The vendor's own catalogue API returns all of it, so none of it is guessed.
   * Cached on the product document — one fetch per style for the catalogue's life.
   */
  async resolveDesignLines(
    brand: string,
    style: string,
    cfg: any,
  ): Promise<Record<string, { label: string; zones: string[] }> | null> {
    const db = await this.getDb();
    const key = { projectId: brand, parentSku: String(style || '').trim().toUpperCase() };
    const cached = await db.collection('products').findOne(key,
      { projection: { designLines: 1, designLinesAt: 1, unavailableDesignLines: 1 } });

    /* Some design lines the catalogue lists are not implemented on the style's
     * atlas — proven by same-style pairs: on 228103 "PHILLY" renders nothing
     * while "VEGAS" paints, from the identical template. Offering one produces
     * a garment with no design on it, so any line the visual capture found
     * unrenderable is withheld here rather than shown and then apologised for. */
    const blocked = new Set<string>(
      ((cached as any)?.unavailableDesignLines || []).map((x: string) => String(x).toLowerCase()),
    );
    const usable = (m: Record<string, { label: string; zones: string[] }> | null) => {
      if (!m || !blocked.size) return m;
      const out = Object.fromEntries(Object.entries(m).filter(([slug]) => !blocked.has(slug.toLowerCase())));
      return Object.keys(out).length ? out : null;
    };

    /* The cache used to be permanent, which quietly made the catalogue append-
     * only-in-reverse: 329X3M had eight design lines cached while the brand had
     * since published a ninth (WEATHERED), and no code path could ever show it.
     * A style's design lines change when the brand adds a pattern — rarely, but
     * a miss lasts forever, so the entry is re-checked after a day. A failed
     * re-check keeps serving the cached value rather than dropping to nothing. */
    const age = (cached as any)?.designLinesAt
      ? Date.now() - new Date((cached as any).designLinesAt).getTime()
      : Number.MAX_SAFE_INTEGER;
    if (cached && 'designLines' in cached && age < DESIGN_LINE_TTL_MS) {
      return usable((cached as any).designLines || null);
    }

    const tmpl: string = cfg?.catalogApi || '';
    if (!tmpl) return null;

    const out: Record<string, { label: string; zones: string[] }> = {};
    try {
      const res = await fetch(tmpl.replace('{style}', encodeURIComponent(style)), {
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data: any = await res.json();
        for (const row of data?.jsonData || []) {
          const label = String(row?.designLine || '').trim();
          if (!label) continue;
          const zones = ((row?.config?.item?.options || []) as any[])
            .map((o) => String(o?.optionId || '').trim())
            .filter(Boolean);
          if (!zones.length) continue;
          // The layer toggle is the display name lower-cased; spaces and
          // hyphens are preserved ("all-over pattern", not "all_over_pattern").
          const slug = label.toLowerCase();
          if (!out[slug]) out[slug] = { label, zones };
        }
      }
    } catch {
      /* leave empty — callers treat null/empty as "unknown", not "none" */
    }

    /* A fetch that returned nothing is not proof the style has no design lines —
     * it is far more often a timeout or a bad gateway. Keeping the previous
     * answer means a transient outage degrades to stale rather than to "this
     * style cannot be designed", which is a sale lost on a false negative. */
    if (!Object.keys(out).length && cached && (cached as any).designLines) {
      return usable((cached as any).designLines);
    }

    const value = Object.keys(out).length ? out : null;
    await db.collection('products').updateOne(key, { $set: { designLines: value, designLinesAt: new Date() } });
    return usable(value);
  }

  /**
   * Which lettering positions this style prints (AUG-45).
   *
   * Captured from the catalogue per style and design line — t1/t2/t7/t21 and
   * friends, with their fonts and sizes. Slot ids vary per style, so this is
   * read and never defaulted; a garment with none takes no lettering, and the
   * UI must not offer a name field for it.
   */
  async getLetteringSlots(brand: string, style: string, designLine?: string): Promise<string[]> {
    const db = await this.getDb();
    const p: any = await db.collection('products').findOne(
      { projectId: brand, parentSku: String(style || '').trim().toUpperCase() },
      { projection: { 'decoration.designLines': 1, 'decoration.textSlots': 1 } },
    );
    const lines = p?.decoration?.designLines || [];
    const slug = String(designLine || '').trim().toLowerCase();
    const line = slug ? lines.find((d: any) => d.slug === slug) : null;
    // The named design line's own slots when we have it; otherwise the style's
    // union, so a garment that letters somewhere is never reported as bare.
    const slots = line?.textSlots?.length
      ? line.textSlots.map((t: any) => t.slot)
      : (p?.decoration?.textSlots || []);
    return [...new Set(slots.filter(Boolean))] as string[];
  }

  /**
   * Where each text zone SITS on the garment, in atlas UV space (AUG-37).
   *
   * This is what makes "click the team name on the chest and edit it there"
   * possible: a click is raycast into the mesh, which yields a UV coordinate,
   * and the zone whose rectangle contains it is the thing the customer touched.
   *
   * The rectangles cannot come from the mesh. Only a minority of styles carry
   * zone-named materials (228130 does; 329X3M and 4R6VTB expose just `main` and
   * `reverse`), and the glTF export flattens them further. So we ask the imaging
   * system instead: render the atlas with a zone blank, render it again with the
   * zone filled, and the pixels that changed ARE that zone. It works on any
   * style, and it discovers the zone's real shape — on 329X3M the team name runs
   * vertically, which no assumed "chest strip" rectangle would have caught.
   *
   * Zones differ per design line, so results are cached per (style, designLine).
   */
  async resolveTextZones(
    brand: string,
    style: string,
    designLine: string | undefined,
    cfg: any,
    texturePattern: string,
  ): Promise<{ key: string; slot: string; uv: [number, number, number, number] }[] | null> {
    if (!designLine) return null;
    const db = await this.getDb();
    const key = { projectId: brand, parentSku: String(style || '').trim().toUpperCase() };
    const field = `textZones.${designLine.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const inflightKey = `${brand}:${style}:${designLine}`.toLowerCase();

    const cached = await db.collection('products').findOne(key, { projection: { textZones: 1 } });
    const hit = (cached as any)?.textZones?.[designLine.toLowerCase().replace(/[^a-z0-9]+/g, '_')];
    if (hit) return hit;

    /* Measuring the zones costs several full atlas renders — ~30s the first time
     * for a style. Doing that INSIDE the render request starved the render
     * itself: the storefront gives up after 8s, so the customer saw "preview
     * unavailable" for a garment that renders perfectly. Seeing the garment
     * matters more than being able to click its lettering on the very first
     * frame, so the measurement runs in the background and the NEXT render picks
     * it up from cache.
     */
    if (this.zonesInFlight.has(inflightKey)) return null;
    this.zonesInFlight.add(inflightKey);
    void this.measureTextZones(brand, style, designLine, cfg, texturePattern, key, field)
      .catch(() => { /* a failed measurement simply leaves click-to-edit off */ })
      .finally(() => this.zonesInFlight.delete(inflightKey));
    return null;
  }

  /** Guards against re-measuring the same style while a measurement is running. */
  private zonesInFlight = new Set<string>();

  /** The expensive half of resolveTextZones, run off the request path. */
  private async measureTextZones(
    brand: string,
    style: string,
    designLine: string,
    cfg: any,
    texturePattern: string,
    key: Record<string, unknown>,
    field: string,
  ): Promise<void> {
    const db = await this.getDb();

    const base = String(cfg?.textureBase || '').replace(/\/$/, '');
    const id = texturePattern.replace('{style}', style);
    const slots: { key: string; slot: string; fontSize?: number }[] =
      cfg?.textSlots?.length ? cfg.textSlots : [];
    if (!base || !slots.length) return;

    /** One atlas render. Retries: Scene7 aborts under load with a tiny body. */
    const shot = async (params: string): Promise<Buffer | null> => {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(`${base}/${id}?${params}`, { signal: AbortSignal.timeout(60000) });
          const buf = Buffer.from(await res.arrayBuffer());
          if (res.ok && buf.length > 5000) return buf;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 4000));
      }
      return null;
    };

    const common = `fmt=png&wid=600&setAttr.swatch=${encodeURIComponent('{visible=false}')}`
      + `&setAttr.${encodeURIComponent(designLine.toLowerCase())}=${encodeURIComponent('{visible=true}')}`;
    const content = (t: string) =>
      `setElement.${'{s}'}=${encodeURIComponent(`<content><p><span>${t}</span></p></content>`)}`;

    const out: { key: string; slot: string; uv: [number, number, number, number] }[] = [];
    for (const s of slots) {
      const font = cfg?.defaultFont || 'Stinger';
      const size = s.fontSize ?? 78;
      const attr = `setAttr.${s.slot}=${encodeURIComponent(
        `{visible=true&s7:colorName=BLACK&fontFamily=${font}&fontSize=${size}&s7:maxFontSize=${size}}`)}`;
      // A BLANK string, not visible=false: hiding a layer makes Scene7 abort the
      // whole render ("SVG processing was forcibly stopped").
      const blank = await shot(`${common}&${content(' ').replace('{s}', s.slot)}&${attr}&isFontSizeCorrected=true`);
      const full = await shot(`${common}&${content('WWWWWWWW').replace('{s}', s.slot)}&${attr}&isFontSizeCorrected=true`);
      if (!blank || !full) continue;
      const uv = this.changedRegion(blank, full);
      if (uv) out.push({ key: s.key, slot: s.slot, uv });
    }

    if (out.length) await db.collection('products').updateOne(key, { $set: { [field]: out } });
  }

  /**
   * Bounding box of what changed between two PNGs, as a UV rectangle.
   *
   * Decodes the PNGs without an image library: both renders come from the same
   * template at the same width, so they share dimensions, and we only need the
   * region that differs — not colour fidelity.
   */
  private changedRegion(a: Buffer, b: Buffer): [number, number, number, number] | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PNG } = require('pngjs');
      const pa = PNG.sync.read(a);
      const pb = PNG.sync.read(b);
      if (pa.width !== pb.width || pa.height !== pb.height) return null;
      let x0 = pa.width, y0 = pa.height, x1 = -1, y1 = -1;
      for (let y = 0; y < pa.height; y++) {
        for (let x = 0; x < pa.width; x++) {
          const i = (pa.width * y + x) << 2;
          const d = Math.abs(pa.data[i] - pb.data[i])
            + Math.abs(pa.data[i + 1] - pb.data[i + 1])
            + Math.abs(pa.data[i + 2] - pb.data[i + 2])
            + Math.abs(pa.data[i + 3] - pb.data[i + 3]);
          if (d > 40) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      // Pad slightly: a click near the edge of the lettering still means the
      // customer is pointing at the name.
      const px = pa.width * 0.012, py = pa.height * 0.012;
      return [
        Math.max(0, (x0 - px) / pa.width), Math.max(0, (y0 - py) / pa.height),
        Math.min(1, (x1 + px) / pa.width), Math.min(1, (y1 + py) / pa.height),
      ];
    } catch {
      return null;
    }
  }

  /**
   * The rack (AUG-40) — what else can hang in this kit.
   *
   * Grouped by the catalogue's own `garmentType` (Top / Bottom / …), not by a
   * curated "these go together" list, because for most styles we do not HAVE
   * that pairing data — 329X3M has no goesWith at all. Inventing a matching
   * bottom would be the same failure as inventing a colour: plausible, and
   * wrong.
   *
   * Styles we know we can render come first and are flagged, so the rack leads
   * with things that will actually appear when clicked.
   */
  async getRack(brand: string, perType = 12): Promise<{
    type: string;
    items: { sku: string; name?: string; renderable: boolean; image?: string }[];
  }[]> {
    const db = await this.getDb();
    const rows = await db.collection('products').find(
      { projectId: brand, 'optionSpace.descriptive.garmentType': { $exists: true } },
      { projection: {
          parentSku: 1, title: 1, imageUrl: 1, renderPattern: 1, hasGeometry: 1,
          decorationSystem: 1,
          'optionSpace.descriptive.garmentType': 1,
        } },
    ).limit(4000).toArray();

    const byType = new Map<string, { sku: string; name?: string; renderable: boolean; image?: string }[]>();
    for (const r of rows as any[]) {
      const type = r?.optionSpace?.descriptive?.garmentType;
      if (!type || !r.parentSku) continue;
      const list = byType.get(type) || [];
      list.push({
        sku: r.parentSku,
        name: r.title,
        /* Known-good when the style has a proven way to be shown. For apparel
         * that means BOTH an atlas and a mesh; for headwear it means a captured
         * colourway and mesh, recorded as a decoration system. A cap has no
         * atlas by design, so testing only the apparel path would hang every
         * cap in the rack greyed out as unpreviewable while it previews fine. */
        renderable: !!((r.renderPattern && r.hasGeometry) || r.decorationSystem),
        image: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
      });
      byType.set(type, list);
    }

    return [...byType.entries()]
      .map(([type, items]) => ({
        type,
        // Renderable first — the rack should lead with what will actually show.
        items: items
          .sort((a, b) => Number(b.renderable) - Number(a.renderable) || a.sku.localeCompare(b.sku))
          .slice(0, perType),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  /**
   * Can each of these styles be custom-designed? (AUG-25)
   *
   * Three-valued on purpose. 'unknown' means the style has not been probed, and
   * the caller must not turn that into 'no' — the same rule as `preview3D`, for
   * the same reason: a style that simply has not been checked being reported as
   * undesignable costs a sale on a false negative.
   */
  /**
   * This style's captured cap configuration, if it has one (CAP-1).
   *
   * Returns null for everything else, which is what keeps the render path
   * unchanged for apparel: the cap branch only engages when the capture stage
   * actually confirmed colourways and a mesh for this style.
   */
  async resolveCap(brand: string, style: string): Promise<{
    meshUrl?: string; meshes?: string[];
    colours?: { code: string; name?: string; meshes: Record<string, string> }[];
  } | null> {
    const db = await this.getDb();
    const row: any = await db.collection('products').findOne(
      { projectId: brand, parentSku: String(style).trim().toUpperCase(), decorationSystem: 'cap' },
      { projection: { capColours: 1, capMeshes: 1, capMeshUrl: 1 } },
    );
    if (!row) return null;
    return { meshUrl: row.capMeshUrl, meshes: row.capMeshes, colours: row.capColours };
  }

  async getDesignability(brand: string, skus: string[]): Promise<Record<string, 'yes' | 'no' | 'unknown'>> {
    const clean = [...new Set((skus || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].slice(0, 50);
    if (!clean.length) return {};

    const db = await this.getDb();
    const rows = await db.collection('products').find(
      { projectId: brand, parentSku: { $in: clean } },
      { projection: { parentSku: 1, renderPattern: 1, hasGeometry: 1, isSublimation: 1, decorationSystem: 1 } },
    ).toArray();

    const out: Record<string, 'yes' | 'no' | 'unknown'> = {};
    for (const sku of clean) out[sku] = 'unknown';
    for (const r of rows as any[]) {
      /* A captured decoration system is a definite YES, and it is checked
       * first because `isSublimation` answers a different question than the
       * one being asked here.
       *
       * Sublimation is how the APPAREL is made to order. Headwear is made to
       * order too, but through a different mechanism — the platform hands back
       * a per-mesh colour map instead of composing a texture — so every cap
       * carries `isSublimation: false` while being fully customisable. Reading
       * that flag as "cannot be designed" made the agent refuse all 112 cap
       * styles as if they were stock, which is how a customer asking for team
       * caps would have been told no.
       *
       * The field is only set once colours AND a mesh have been confirmed to
       * exist (cap-decoration.ts), so it is evidence rather than intent. */
      if (r.decorationSystem) { out[String(r.parentSku).toUpperCase()] = 'yes'; continue; }

      /* A stock style is a definite NO, and the catalogue says so directly —
       * it is not made-to-order, so no imaging template exists and none ever
       * will. This is the case that broke the Plainfield North journey: Game7
       * is never probed (probing stock styles would be pointless load), so
       * relying on the probe alone would leave the one style we most needed to
       * rule out sitting at 'unknown' and the model still free to offer it.
       * Designability is a property of the product, not only of our probing. */
      if (r.isSublimation === false) { out[String(r.parentSku).toUpperCase()] = 'no'; continue; }

      const probed = 'renderPattern' in r;
      out[String(r.parentSku).toUpperCase()] = !probed ? 'unknown'
        : (r.renderPattern && r.hasGeometry) ? 'yes' : 'no';
    }
    return out;
  }

  /**
   * Styles that can actually be designed, for when the chosen one cannot (AUG-25).
   *
   * Retrieval ranks by how well a style's text matches the request, which has no
   * notion of whether the style is made-to-order. A request for a custom team
   * jersey surfaced "Game7 Two-Button Baseball Jersey" — a stock style with
   * fixed factory colours and no printable zones. Telling the customer "this one
   * cannot be previewed" is honest but useless; they asked for a team jersey and
   * there are 97 sublimated ones that would have worked.
   *
   * Only styles PROVEN designable are returned — an atlas and a mesh both
   * resolved. An unprobed style is omitted rather than offered hopefully: this
   * list exists precisely because something was already promised and could not
   * be delivered, so a second guess would repeat the original error.
   */
  async getDesignable(brand: string, opts: { like?: string; likeSku?: string; limit?: number } = {}): Promise<{
    sku: string; name?: string; garmentType?: string; image?: string; price?: number;
  }[]> {
    const db = await this.getDb();

    // A caller that only has the failed style's code gets its name resolved
    // here, so "what was wanted" is described in the catalogue's own words.
    let like = opts.like || '';
    if (!like && opts.likeSku) {
      const raw = String(opts.likeSku).trim();
      const src: any = await db.collection('products').findOne(
        { projectId: brand, parentSku: raw.toUpperCase() },
        { projection: { name: 1, title: 1 } },
      );
      /* The caller often holds a NAME rather than a code — the model quotes what
       * it showed the customer ("Pop Warner … Football Jersey"), or an ordinal
       * ("product 2"). A style code never contains whitespace, so treat anything
       * that does as the description itself rather than losing the signal. */
      like = String(src?.name || src?.title || (/\s/.test(raw) ? raw : ''));
    }
    /* "Designable" spans two mechanisms, and both must be offered here.
     *
     * Apparel proves it with an imaging template plus geometry; headwear proves
     * it with a captured colour map plus a confirmed mesh. Listing only the
     * first would leave the agent unable to *suggest* a cap even after
     * getDesignability started permitting one — the style would be allowed but
     * never surfaced, which reads to a customer as caps not existing. */
    const designable = {
      $or: [
        { renderPattern: { $nin: [null, false] }, hasGeometry: true },
        { decorationSystem: { $type: 'string' } },
      ],
    };
    const filter: Record<string, unknown> = { projectId: brand, ...designable };

    /* Match on the words of the style the model tried, so "baseball jersey"
     * yields baseball jerseys rather than an arbitrary designable garment. Stop
     * words that describe every style in the catalogue would match everything,
     * so they carry no signal and are dropped. */
    const words = String(like)
      .split(/[^A-Za-z]+/)
      .filter((w) => w.length > 2 && !/^(the|and|for|with|youth|ladies|mens|sublimated|freestyle|custom|two|full|button)$/i.test(w))
      .slice(0, 6)
      /* Match the stem, because customers pluralise and catalogues do not.
       *
       * "pants" matches ZERO styles — the catalogue calls them "Pant" — so a
       * request for team pants fell through to whatever else in the query
       * happened to match, and came back with a cap. Trimming a trailing "s"
       * makes "pants" match "Pant", "jerseys" match "Jersey" and "caps" match
       * "Cap", while a plural that IS the catalogue's own spelling ("Shorts")
       * still matches because these are substring patterns, not whole words. */
      .map((w) => (w.length > 3 && /s$/i.test(w) ? w.slice(0, -1) : w));

    /* Both conditions are `$or`s, so they are combined under `$and` rather than
     * spread into one object — a second `$or` key would silently replace the
     * first, dropping the designability test and offering stock styles again. */
    /* If the caller TOLD us what they wanted but we could not derive a single
     * usable word from it, we do not know what to substitute — and answering
     * anyway returns whatever designable rows Mongo hands back first, which is
     * how a football jersey came back as three caps. Silence is correct here:
     * the agent then says it could not find an alternative instead of steering
     * the customer into an unrelated product. Only a caller that asked for
     * nothing in particular gets the general designable list. */
    /* Presence, not truthiness. The agent calls `likeSku: String(sku || '')`, so
     * a style it failed to identify arrives as an EMPTY STRING — still a request
     * for something specific, just one it could not name. Treating that as "no
     * preference" is what returned caps for a football jersey. */
    const askedForSomething = opts.like !== undefined || opts.likeSku !== undefined;
    if (askedForSomething && !words.length) return [];

    const rows = await db.collection('products').find(
      words.length
        ? { projectId: brand, $and: [designable, { $or: words.map((w) => ({ name: new RegExp(w, 'i') })) }] }
        : filter,
      { projection: { parentSku: 1, name: 1, title: 1, imageUrl: 1, priceUSD: 1,
                      'optionSpace.descriptive.garmentType': 1 } },
    ).limit(200).toArray();

    // Rank by how many of the request's words the style's name carries, so the
    // closest garment leads rather than whichever row Mongo returned first.
    const score = (name: string) => words.filter((w) => new RegExp(w, 'i').test(name)).length;
    return (rows as any[])
      .map((r) => ({
        sku: r.parentSku,
        name: r.title || r.name,
        garmentType: r?.optionSpace?.descriptive?.garmentType,
        image: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
        // Real catalogue price — a substituted card must be as grounded as one
        // the model built from retrieval, or the grounding check will reject it.
        price: typeof r?.priceUSD?.min === 'number' ? r.priceUSD.min : undefined,
        _s: score(String(r.name || r.title || '')),
      }))
      .filter((r) => r.sku)
      .sort((a, b) => b._s - a._s || String(a.sku).localeCompare(String(b.sku)))
      .slice(0, opts.limit ?? 6)
      .map(({ _s, ...rest }) => rest);
  }

  /**
   * The style's catalogue photograph, for when it cannot be previewed live.
   * A real photo of the garment is far better than an empty viewer and a
   * sentence explaining why it is empty.
   */
  async getCatalogueImage(brand: string, style: string): Promise<string | undefined> {
    const db = await this.getDb();
    const doc = await db.collection('products').findOne(
      { projectId: brand, parentSku: String(style || '').trim().toUpperCase() },
      { projection: { imageUrl: 1, images: 1 } },
    );
    const img = (doc as any)?.imageUrl || (doc as any)?.images?.[0];
    return typeof img === 'string' && img.startsWith('http') ? img : undefined;
  }

  /** The project's brand orientation brief (AUG-14). Small and cacheable — it is
   *  injected into every conversation, not searched. */
  async getBrandHub(brand: string): Promise<any | null> {
    const db = await this.getDb();
    return db.collection('brand_hub').findOne({ projectId: brand }, { projection: { _id: 0 } });
  }

  /**
   * What a customer can actually CHOOSE on a product (AUG-13): the colours and
   * sizes that form real variants, plus the fixed characteristics that describe
   * it. Sourced from the commerce platform, so it is exact — the agent must
   * never improvise a colour that isn't offered.
   */
  async getOptions(brand: string, sku: string): Promise<{
    sku: string;
    found: boolean;
    choices: Record<string, { value: string; swatchImage?: string }[]>;
    characteristics: Record<string, string>;
    preview3D?: 'yes' | 'no' | 'unknown';
    goesWith: { sku?: string; name?: string }[];
    views: string[];
    variantCount?: number;
  }> {
    const clean = String(sku || '').trim().toUpperCase();
    const empty = { sku: clean, found: false, choices: {}, characteristics: {}, goesWith: [], views: [] };
    if (!clean) return empty;

    const db = await this.getDb();
    const p: any = await db.collection('products').findOne(
      { projectId: brand, parentSku: clean },
      { projection: { optionSpace: 1, renderPattern: 1, hasGeometry: 1 } },
    );
    const os = p?.optionSpace;
    if (!os) return empty;

    /* The supplier feed carries an `is3D` flag that does NOT describe what this
     * platform can render. 329X3M is marked is3D:"FALSE" yet has a 1.8MB glTF
     * and previews correctly — the agent read the flag, believed it, and told a
     * customer "this style doesn't support 3D customization", which was false
     * and cost the sale. A stale supplier flag must never speak for our own
     * capability.
     *
     * The honest answer is what WE resolved: an atlas exists and a mesh exists.
     * Where we have not resolved it yet we say so, rather than defaulting to no.
     */
    const characteristics: Record<string, string> = { ...(os.descriptive || {}) };
    delete characteristics.is3D;
    delete characteristics.isSublimation2D;

    const resolved = 'renderPattern' in (p || {}) || 'hasGeometry' in (p || {});
    const preview3D = !resolved ? 'unknown'
      : (p.renderPattern && p.hasGeometry) ? 'yes' : 'no';

    return {
      sku: clean,
      found: true,
      choices: os.defining || {},
      characteristics,
      /**
       * Whether THIS platform can show the style in 3D. 'unknown' means we have
       * not checked yet — the agent must not turn that into "no".
       */
      preview3D,
      goesWith: (os.merchandising || []).filter((m: any) => m.sku || m.name),
      views: os.angleImages || [],
      variantCount: os.variantCount,
    };
  }

  /**
   * Structural relationships for a SKU (AUG-10) — the FACT-layer counterpart to
   * vector search. Answers "what else is in this collection / what completes this
   * look / is there a youth version?" deterministically, from relationships the
   * catalogue-extraction stage derived. Returns [] when nothing is known rather
   * than guessing — the agent must not invent a youth SKU that doesn't exist.
   */
  async getRelated(brand: string, sku: string): Promise<{
    sku: string;
    collections: Array<{ name: string; skus: string[] }>;
    outfittingSets: Array<{ name: string; skus: string[] }>;
    sizingGroup: { styleName?: string; adult?: string; youth?: string; ladies?: string } | null;
  }> {
    const clean = String(sku || '').trim().toUpperCase();
    const empty = { sku: clean, collections: [], outfittingSets: [], sizingGroup: null };
    if (!clean) return empty;

    const db = await this.getDb();
    const rows = await db.collection('collections')
      .find({ projectId: brand, skus: clean } as any)
      .limit(50)
      .toArray();

    const collections: Array<{ name: string; skus: string[] }> = [];
    const outfittingSets: Array<{ name: string; skus: string[] }> = [];
    let sizingGroup: any = null;
    for (const r of rows as any[]) {
      const others = (r.skus || []).filter((s: string) => s !== clean);
      if (r.kind === 'collection') collections.push({ name: r.name, skus: others });
      // `name` is the SKU-signature key; `label` is the human name (older rows
      // predate the split and carry the label in `name`).
      else if (r.kind === 'outfitting-set') outfittingSets.push({ name: r.label || String(r.name).replace(/^set:/, ''), skus: others });
      else if (r.kind === 'sizing-group') {
        // A SKU can match more than one recorded group; prefer the most complete
        // one rather than whichever the index happened to return first.
        const filled = (g: any) => [g.adult, g.youth, g.ladies].filter(Boolean).length;
        const candidate = { styleName: r.styleName, adult: r.adult, youth: r.youth, ladies: r.ladies };
        if (!sizingGroup || filled(candidate) > filled(sizingGroup)) sizingGroup = candidate;
      }
    }
    return { sku: clean, collections, outfittingSets, sizingGroup };
  }

  // The single source of truth for money in a quote. The agent proposes only
  // SKUs + quantities; the quote engine calls THIS to rehydrate the real price,
  // name, image and stock from the catalogue — the LLM never sets a price.
  async getBySkus(brand: string, skus: string[]): Promise<{
    found: string[];
    missing: string[];
    items: Array<{ sku: string; name: string; price: number | null; currency?: string; category?: string; imageUrl?: string; url?: string; inStock: boolean }>;
  }> {
    const clean = Array.from(new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean)));
    if (clean.length === 0) return { found: [], missing: [], items: [] };

    /* Prices are catalogue facts, not live figures — they change when an ingest
     * runs, not between turns of a conversation. Caching them per style keeps a
     * quote instant on the step where the customer is watching a total appear,
     * and the project's cache is dropped on ingest and on publish, so a price
     * can never outlive the catalogue it came from. Sorted key: the same set of
     * styles in any order is the same lookup. */
    return getOrSet(cacheKey(brand, 'pricebook', { skus: [...clean].sort().join(',') }),
      () => this.readPricebook(brand, clean), { ttlSeconds: 600 });
  }

  private async readPricebook(brand: string, clean: string[]): Promise<{
    found: string[];
    missing: string[];
    items: Array<{ sku: string; name: string; price: number | null; currency?: string; category?: string; imageUrl?: string; url?: string; inStock: boolean; colors?: { name: string; hex?: string }[]; sizes?: string[]; rating?: { value: number; count?: number }; completeTheLook?: { name: string; productId?: string; image?: string; price?: string }[]; originalPrice?: number }>;
  }> {
    const col = await this.getCollection();
    // Tenant-scoped (isolation) + match by catalogue SKU (metadata.sku or Item Code spec).
    /* Never pull whole documents here.
     *
     * Each one carries a 1536-dimension embedding and its full text, and a
     * style can have dozens of chunks — so pricing ONE jersey shipped megabytes
     * across the wire and took nine seconds, in the step where the customer is
     * watching a total appear. This is the same trap already documented for the
     * design-knowledge upsert (AUG-43), landed here in the money path. Ask for
     * the handful of fields the pricebook actually reads. */
    const docs = await col
      .find({
        $and: [
          { $or: [{ 'metadata.brand': brand }, { brand }] },
          { $or: [{ 'metadata.sku': { $in: clean } }, { 'metadata.specs.Item Code': { $in: clean } }] },
        ],
      } as any, {
        projection: {
          title: 1, sourceUrl: 1,
          'metadata.sku': 1, 'metadata.name': 1, 'metadata.price': 1, 'metadata.currency': 1,
          'metadata.category': 1, 'metadata.images': 1, 'metadata.imageUrl': 1, 'metadata.url': 1,
          'metadata.specs.Item Code': 1,
        },
      })
      .toArray();

    // A SKU can have several chunks — keep the first doc that carries a price.
    const bySku = new Map<string, any>();
    for (const d of docs) {
      const meta: any = (d as any).metadata || {};
      const specs = meta.specs || {};
      const sku = String(meta.sku || specs['Item Code'] || '').trim();
      if (!sku || !clean.includes(sku)) continue;
      const existing = bySku.get(sku);
      const hasPrice = typeof meta.price === 'number' && meta.price > 0;
      if (!existing || (hasPrice && !(typeof existing.price === 'number' && existing.price > 0))) {
        const images = Array.isArray(meta.images) ? meta.images : [];
        bySku.set(sku, {
          sku,
          name: (d as any).title || meta.name || sku,
          price: typeof meta.price === 'number' ? meta.price : null,
          currency: meta.currency,
          category: meta.category,
          imageUrl: images[0] || meta.imageUrl || '',
          url: meta.url || (d as any).sourceUrl,
          // No live inventory system yet: catalogue presence ⇒ in stock. A future
          // inventory-service reservation replaces this (never hard-coded copy).
          inStock: true,
        });
      }
    }

    /* Attach the production lead time (C6). It lives on the products
       collection keyed by parent style, so a variant SKU (style.colour.size)
       is reduced to its style before the lookup. Read-only enrichment: a SKU
       with no window simply has none, never a fabricated zero. */
    if (bySku.size) {
      const styleOf = (sku: string) => String(sku).toUpperCase().split('.')[0];
      const styles = [...new Set([...bySku.keys()].map(styleOf))];
      const db = await this.getDb();
      const rows = await db.collection('products').find(
        { projectId: brand, parentSku: { $in: styles } },
        { projection: { parentSku: 1, leadTimeDays: 1, colors: 1, sizes: 1, rating: 1, completeTheLook: 1, originalPrice: 1 } },
      ).toArray();
      const byStyle = new Map(rows.map((r: any) => [String(r.parentSku).toUpperCase(), r]));
      for (const [sku, item] of bySku) {
        const r: any = byStyle.get(styleOf(sku));
        if (!r) continue;
        if (typeof r.leadTimeDays === 'number') item.leadTimeDays = r.leadTimeDays;
        // ANF-98: the variant axis lives on the products collection — surface it so
        // grounded cards get real colour swatches + size pills.
        if (Array.isArray(r.colors) && r.colors.length) item.colors = r.colors;
        if (Array.isArray(r.sizes) && r.sizes.length) item.sizes = r.sizes;
        if (r.rating) item.rating = r.rating;
        // ANF-99: "Wear It With" complete-the-look strip (denormalised outfit items).
        if (Array.isArray(r.completeTheLook) && r.completeTheLook.length) item.completeTheLook = r.completeTheLook.slice(0, 12);
        if (r.originalPrice?.min) item.originalPrice = r.originalPrice.min;
      }
    }

    const found = Array.from(bySku.keys());
    const missing = clean.filter((s) => !bySku.has(s));
    return { found, missing, items: Array.from(bySku.values()) };
  }

  // ── Stats ───────────────────────────────────────────────────────────
  async getStats(brand?: string) {
    const col = await this.getCollection();
    const brandFilter = brand ? { $or: [{ projectId: brand }, { brand }, { 'metadata.brand': brand }] } : {};
    const P = { ...brandFilter, 'metadata.type': 'product' };

    const [
      totalDocuments, products, withSpecs, withImage, withPrice,
      designs, technical, troubleshooting, typeAgg
    ] = await Promise.all([
      col.countDocuments(brandFilter),
      col.countDocuments(P),
      col.countDocuments({ ...P, 'metadata.specs': { $exists: true } }),
      col.countDocuments({ ...P, 'metadata.images.0': { $exists: true } }),
      col.countDocuments({ ...P, 'metadata.price': { $exists: true } }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'design' }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'technical' }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'troubleshooting' }),
      col.aggregate([
        { $match: brandFilter },
        { $group: { _id: '$metadata.type', count: { $sum: 1 } } },
      ]).toArray()
    ]);

    const byType: Record<string, number> = {};
    for (const t of typeAgg) {
      byType[t._id as string] = t.count;
    }

    const brandsAgg = await col.distinct('brand');

    const dupAgg = await col.aggregate([
      { $match: brandFilter },
      { $group: { _id: { u: '$sourceUrl', c: '$chunkIndex', t: '$metadata.type' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'groups' },
    ]).toArray();

    return {
      totalDocuments,
      byType,
      brands: brandsAgg,
      total: totalDocuments,
      products,
      withSpecs,
      withImage,
      withPrice,
      designs,
      technical,
      troubleshooting,
      duplicateGroups: (dupAgg[0] as any)?.groups || 0,
      specsPct: products ? Math.round((withSpecs / products) * 100) : 0,
    };
  }

  async getReconciliation(brand: string) {
    const db = await this.getDb();
    
    const doc = await db.collection('ingest_reconciliation').findOne({
      projectId: brand,
      kind: 'catalogue-codes-missing-from-feed',
    });
    
    const rels = db.collection('collections');
    const [collections, sizingGroups, outfittingSets] = await Promise.all([
      rels.countDocuments({ projectId: brand, kind: 'collection' }),
      rels.countDocuments({ projectId: brand, kind: 'sizing-group' }),
      rels.countDocuments({ projectId: brand, kind: 'outfitting-set' }),
    ]);

    const hub = await db.collection('brand_hub').findOne({ projectId: brand }, { projection: { _id: 0 } });

    return {
      brand,
      hub: hub || null,
      relationships: { collections, sizingGroups, outfittingSets },
      missing: doc
        ? {
            distinctCodes: doc.distinctCodes ?? 0,
            totalReferences: doc.totalReferences ?? 0,
            codes: (doc.codes || []).slice(0, 100),
            updatedAt: doc.updatedAt ?? null,
          }
        : null,
    };
  }

  // ── Backoffice Catalogue APIs ──────────────────────────────────────────

  async getCatalogue(projectId: string, q: string | undefined, limit: number) {
    const col = await this.getCollection();
    const match: any = { "metadata.brand": projectId, "metadata.type": "product" };
    if (q) match.$and = [{ $or: [{ title: { $regex: q, $options: "i" } }, { "metadata.sku": { $regex: q, $options: "i" } }] }];

    const rows = await col.aggregate([
      { $match: match },
      { $project: {
          sourceUrl: 1, title: 1, updatedAt: 1,
          "metadata.sku": 1, "metadata.price": 1, "metadata.currency": 1,
          "metadata.category": 1, "metadata.collection": 1, "metadata.images": 1,
          "metadata.availability": 1, "metadata.specs": 1,
      } },
      { $sort: { updatedAt: -1 } },
      { $group: {
          _id: "$sourceUrl",
          titles: { $addToSet: "$title" },
          sku: { $first: "$metadata.sku" },
          price: { $first: "$metadata.price" },
          currency: { $first: "$metadata.currency" },
          category: { $first: "$metadata.category" },
          collection: { $first: "$metadata.collection" },
          image: { $first: { $arrayElemAt: ["$metadata.images", 0] } },
          availability: { $first: "$metadata.availability" },
          specCount: { $first: { $size: { $objectToArray: { $ifNull: ["$metadata.specs", {}] } } } },
          updatedAt: { $first: "$updatedAt" },
      } },
      { $limit: limit },
    ]).toArray();

    for (const r of rows as any[]) {
      const clean = (r.titles as string[])
        .filter((t: string) => t && !/^[-–—\s]/.test(t))
        .sort((a: string, b: string) => b.length - a.length);
      r.title = clean[0] || (r.titles as string[]).sort((a: string, b: string) => b.length - a.length)[0] || r.sku || "Untitled";
      delete r.titles;
    }
    rows.sort((a: any, b: any) => String(a.title).localeCompare(String(b.title)));

    const total = await col.aggregate([
      { $match: { "metadata.brand": projectId, "metadata.type": "product" } },
      { $group: { _id: "$sourceUrl" } }, { $count: "n" },
    ]).toArray();

    return {
      products: rows.map(({ _id, ...r }) => ({ url: _id, ...r })),
      totalProducts: total[0]?.n ?? 0,
    };
  }

  async getCatalogueItem(projectId: string, url: string) {
    const col = await this.getCollection();
    const chunks = await col
      .find({ $and: [{ $or: [{ projectId }, { "metadata.brand": projectId }] }, { sourceUrl: url }] })
      .project({ _id: 0, title: 1, chunk: 1, chunkIndex: 1, metadata: 1, updatedAt: 1 })
      .sort({ chunkIndex: 1 })
      .toArray();

    if (!chunks.length) return null;

    const merged: any = { specs: {}, images: [], variants: [], documents: [], finishes: [] };
    let title = "";
    for (const c of chunks as any[]) {
      const m = c.metadata || {};
      if (c.title && !/^[-–—\s]/.test(c.title) && c.title.length > title.length) title = c.title;
      Object.assign(merged.specs, m.specs || {});
      for (const k of ["images", "variants", "documents", "finishes"] as const) {
        for (const v of m[k] || []) {
          if (!merged[k].some((x: any) => JSON.stringify(x) === JSON.stringify(v))) merged[k].push(v);
        }
      }
      for (const k of ["sku", "price", "currency", "category", "collection", "description", "availability", "type"]) {
        if (merged[k] == null && m[k] != null) merged[k] = m[k];
      }
    }

    return {
      url,
      title: title || (chunks[0] as any).title,
      ...merged,
      updatedAt: (chunks[0] as any).updatedAt,
      chunks: (chunks as any[]).map((c) => ({ index: c.chunkIndex, text: String(c.chunk || "").slice(0, 1200) })),
    };
  }
}

