import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import type {
  KnowledgeRetrievalPort,
  KnowledgeRetrievalPortResolver,
  KnowledgeRetrievalResult,
} from '../../kernel/knowledge-retrieval.port';

export interface KnowledgeSearchInput {
  query?: string;
  category?: string;
  limit?: number;
  type?: string;
  gender?: string;
  knowledgeScope?: {
    releaseId: string;
    version: string;
    checksum: string;
    conceptIds: string[];
    sourceRefs: string[];
    requestedClaimClass?: string;
  };
}

export class KnowledgeSearchHandler implements NativeCapabilityHandler {
  constructor(
    private readonly inMemoryDocs?: any[],
    private readonly resolveKnowledgePort?: KnowledgeRetrievalPortResolver
  ) {}

  async execute(input: KnowledgeSearchInput, ctx: ExecutionContext): Promise<any> {
    const rawQuery = (input.query || '').trim();
    const query = rawQuery.toLowerCase();
    const limit = Math.min(input.limit || 5, 20);
    const scope = input.knowledgeScope;
    if (!scope || !scope.releaseId || !scope.version || !scope.checksum || scope.sourceRefs.length === 0) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        documents: [],
        verified: false,
        message: 'Knowledge retrieval blocked: exact pinned OKF evidence scope is required.',
      };
    }
    const allowedSources = new Set(scope.sourceRefs);

    // 1. In-memory documents (for isolated tests / fixtures)
    if (this.inMemoryDocs && this.inMemoryDocs.length > 0) {
      const documents = this.inMemoryDocs
        .filter((doc) => {
          if (doc.releaseId !== scope.releaseId || !allowedSources.has(doc.sourceId)) return false;
          if (!query) return true;
          return (
            doc.title?.toLowerCase().includes(query) ||
            doc.summary?.toLowerCase().includes(query) ||
            doc.content?.toLowerCase().includes(query) ||
            doc.id?.toLowerCase().includes(query) ||
            (doc.specifications && JSON.stringify(doc.specifications).toLowerCase().includes(query))
          );
        })
        .slice(0, limit);

      const found = documents.length > 0;
      return {
        found,
        resultCount: documents.length,
        documents,
        results: documents.map((d) => ({
          sourceId: d.sourceId,
          releaseId: d.releaseId,
          title: d.title || d.id,
          content: d.content || d.summary || '',
          sku: d.sku,
          specs: d.specifications || d.specs,
          url: d.url || d.sourceUrl,
        })),
        verified: found,
      };
    }

    // 2. Authoritative tenant-scoped retrieval via the injected canonical knowledge port
    try {
      if (!this.resolveKnowledgePort) {
        throw new Error('no knowledge retrieval port is configured for this runtime');
      }
      const knowledgePort: KnowledgeRetrievalPort = await this.resolveKnowledgePort(ctx.tenantId);

      const searchResult: KnowledgeRetrievalResult = await knowledgePort.search(
        {
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          correlationId: ctx.correlationId,
        },
        {
          query: rawQuery,
          category: input.category,
          type: input.type,
          limit,
          gender: input.gender,
          knowledgeScope: scope,
        }
      );

      const results = (searchResult.results || []).filter((result) =>
        result.releaseId === scope.releaseId && allowedSources.has(result.sourceId)
      );
      const found = Boolean(searchResult.found && results.length > 0);

      return {
        found,
        resultCount: results.length,
        results,
        documents: results.map((r) => ({
          id: r.sku || r.title,
          sourceId: r.sourceId,
          releaseId: r.releaseId,
          title: r.title,
          summary: r.content,
          content: r.content,
          specifications: r.specs,
          sourceUrl: r.url,
        })),
        verified: found,
        message: searchResult.message,
      };
    } catch (err: any) {
      // Typed unavailable/not-found result when retrieval fails
      return {
        found: false,
        resultCount: 0,
        results: [],
        documents: [],
        verified: false,
        message: `Knowledge retrieval unavailable: ${err.message}`,
      };
    }
  }
}
