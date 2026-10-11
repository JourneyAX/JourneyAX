import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import type {
  KnowledgeRetrievalPort,
  KnowledgeRetrievalPortResolver,
  KnowledgeRetrievalResult,
  LegacyKnowledgeRetrievalPortResolver,
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
    private readonly resolveKnowledgePort?: KnowledgeRetrievalPortResolver,
    private readonly resolveLegacyKnowledgePort?: LegacyKnowledgeRetrievalPortResolver
  ) {}

  async execute(input: KnowledgeSearchInput, ctx: ExecutionContext): Promise<any> {
    const rawQuery = (input.query || '').trim();
    const query = rawQuery.toLowerCase();
    const limit = Math.min(input.limit || 5, 20);
    const scope = input.knowledgeScope;
    if (!scope) {
      if (!this.resolveLegacyKnowledgePort) {
        return {
          found: false,
          resultCount: 0,
          results: [],
          documents: [],
          verified: false,
          message: 'Knowledge retrieval unavailable: no legacy tenant knowledge port is configured.',
        };
      }
      try {
        const port = await this.resolveLegacyKnowledgePort(ctx.tenantId);
        const result = await port.search({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          correlationId: ctx.correlationId,
        }, { query: rawQuery, category: input.category, type: input.type, limit, gender: input.gender });
        return {
          found: result.found,
          resultCount: result.results.length,
          results: result.results,
          documents: result.results.map((item) => ({
            id: item.sku || item.title,
            title: item.title,
            summary: item.content,
            content: item.content,
            specifications: item.specs,
            sourceUrl: item.url,
          })),
          // A legacy connector result is grounded but is not a checksum-pinned
          // OKF verification. Keep the distinction explicit for presentation.
          verified: false,
          message: result.message,
        };
      } catch {
        return { found: false, resultCount: 0, results: [], documents: [], verified: false,
          errorCode: 'knowledge_unavailable', message: 'Knowledge retrieval is temporarily unavailable.' };
      }
    }
    if (!scope.releaseId || !scope.version || !scope.checksum || scope.sourceRefs.length === 0) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        documents: [],
        verified: false,
        message: 'Knowledge retrieval blocked: the supplied OKF evidence scope is incomplete.',
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
    } catch {
      // Typed unavailable/not-found result when retrieval fails
      return {
        found: false,
        resultCount: 0,
        results: [],
        documents: [],
        verified: false,
        errorCode: 'knowledge_unavailable',
        message: 'Knowledge retrieval is temporarily unavailable.',
      };
    }
  }
}
