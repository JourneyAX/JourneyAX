import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { adapterRegistry, AdapterRegistry, KnowledgePort, KnowledgeSearchResult } from '@journeyax/integration';

export interface KnowledgeSearchInput {
  query?: string;
  category?: string;
  limit?: number;
  type?: string;
  gender?: string;
}

export class KnowledgeSearchHandler implements NativeCapabilityHandler {
  constructor(
    private readonly inMemoryDocs?: any[],
    private readonly registry?: AdapterRegistry
  ) {}

  async execute(input: KnowledgeSearchInput, ctx: ExecutionContext): Promise<any> {
    const rawQuery = (input.query || '').trim();
    const query = rawQuery.toLowerCase();
    const limit = Math.min(input.limit || 5, 20);

    // 1. In-memory documents (for isolated tests / fixtures)
    if (this.inMemoryDocs && this.inMemoryDocs.length > 0) {
      const documents = this.inMemoryDocs
        .filter((doc) => {
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
          title: d.title || d.id,
          content: d.content || d.summary || '',
          sku: d.sku,
          specs: d.specifications || d.specs,
          url: d.url || d.sourceUrl,
        })),
        verified: found,
      };
    }

    // 2. Authoritative tenant-scoped retrieval via AdapterRegistry
    try {
      const activeRegistry = this.registry || adapterRegistry;
      const knowledgePort: KnowledgePort = await activeRegistry.getKnowledge(ctx.tenantId);

      const searchResult: KnowledgeSearchResult = await knowledgePort.search(
        {
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
        },
        {
          query: rawQuery,
          category: input.category,
          type: input.type,
          limit,
          gender: input.gender,
        }
      );

      const found = Boolean(searchResult.found && Array.isArray(searchResult.results) && searchResult.results.length > 0);
      const results = searchResult.results || [];

      return {
        found,
        resultCount: results.length,
        results,
        documents: results.map((r) => ({
          id: r.sku || r.title,
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
