import { connectToDatabase } from '@journeyax/database';
import {
  COLLECTION_OKF_EVIDENCE_CHUNKS,
  computeKnowledgeEntityHash,
  loadPinnedOkfRelease,
  type OkfEvidenceChunk,
} from '@journeyax/knowledge';
import type {
  KnowledgeRetrievalContext,
  KnowledgeRetrievalPort,
  KnowledgeRetrievalPortResolver,
  KnowledgeRetrievalRequest,
  KnowledgeRetrievalResult,
} from '../kernel/knowledge-retrieval.port';

type DbProvider = () => Promise<any>;

function tokens(value: string): string[] {
  return [...new Set((value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2))];
}

function relevance(chunk: OkfEvidenceChunk, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 1;
  const title = chunk.title.toLowerCase();
  const body = chunk.content.toLowerCase();
  return queryTokens.reduce((score, token) =>
    score + (title.includes(token) ? 5 : 0) + (body.includes(token) ? 1 : 0), 0);
}

/**
 * Canonical runtime adapter for immutable OKF evidence.
 *
 * It verifies the exact release envelope first, scopes the index query by tenant,
 * environment and release, and accepts only chunks that still match the verified
 * envelope. A tampered normalized/index record therefore cannot become evidence.
 */
export class MongoOkfKnowledgeRetrievalPort implements KnowledgeRetrievalPort {
  constructor(private readonly dbProvider: DbProvider = async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
    const { db } = await connectToDatabase(
      process.env.MONGODB_URI,
      process.env.MONGODB_DB_NAME || 'journeyx'
    );
    return db;
  }) {}

  async search(
    ctx: KnowledgeRetrievalContext,
    req: KnowledgeRetrievalRequest
  ): Promise<KnowledgeRetrievalResult> {
    if (!ctx.tenantId || !ctx.environmentId) {
      throw new Error('tenantId and environmentId are required for OKF evidence retrieval');
    }
    const scope = req.knowledgeScope;
    if (!scope?.releaseId || !scope.version || !scope.checksum || scope.sourceRefs.length === 0) {
      throw new Error('exact OKF release identity and source allow-list are required');
    }

    const db = await this.dbProvider();
    const { release } = await loadPinnedOkfRelease(db, {
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      releaseId: scope.releaseId,
      version: scope.version,
      checksum: scope.checksum,
    });

    const allowedSources = new Set(scope.sourceRefs);
    const allowedConcepts = new Set(scope.conceptIds || []);
    const canonical = new Map(
      release.content.evidenceChunks
        .filter((chunk) => allowedSources.has(chunk.sourceRef))
        .filter((chunk) => allowedConcepts.size === 0 || chunk.conceptIds.some((id) => allowedConcepts.has(id)))
        .filter((chunk) => !scope.requestedClaimClass || chunk.claimClasses.includes(scope.requestedClaimClass as any))
        .map((chunk) => [chunk.chunkId, chunk])
    );

    if (canonical.size === 0) {
      return { found: false, results: [], message: 'No verified evidence chunks exist in the pinned OKF scope.' };
    }

    const stored = await db.collection(COLLECTION_OKF_EVIDENCE_CHUNKS).find({
      tenantId: ctx.tenantId,
      environmentId: ctx.environmentId,
      releaseId: scope.releaseId,
    }).limit(Math.min(Math.max(canonical.size * 2, 20), 500)).toArray();

    const queryTokens = tokens(req.query);
    const verified = stored.flatMap((raw: any) => {
      const expected = canonical.get(raw.chunkId);
      if (!expected || raw.sourceRef !== expected.sourceRef) return [];
      const normalized = Object.fromEntries(
        Object.keys(expected).map((key) => [key, raw[key]])
      );
      if (computeKnowledgeEntityHash(normalized) !== expected.contentHash.replace(/^sha256:/, '')) return [];
      return [{ chunk: expected, score: relevance(expected, queryTokens) }];
    });

    const positive = verified.some((entry) => entry.score > 0)
      ? verified.filter((entry) => entry.score > 0)
      : verified;
    const limit = Math.min(Math.max(req.limit || 5, 1), 20);
    const results = positive
      .sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal)
      .slice(0, limit)
      .map(({ chunk }) => ({
        sourceId: chunk.sourceRef,
        releaseId: release.releaseId,
        title: chunk.title,
        content: chunk.content,
        url: chunk.uri,
      }));

    return {
      found: results.length > 0,
      results,
      message: results.length > 0 ? undefined : 'Pinned OKF evidence is unavailable.',
    };
  }
}

export function createMongoOkfKnowledgePortResolver(
  dbProvider?: DbProvider
): KnowledgeRetrievalPortResolver {
  const port = new MongoOkfKnowledgeRetrievalPort(dbProvider);
  return async () => port;
}
