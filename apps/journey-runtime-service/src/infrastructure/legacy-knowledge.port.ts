import type {
  LegacyKnowledgeRetrievalPort,
  LegacyKnowledgeRetrievalPortResolver,
} from '../kernel/knowledge-retrieval.port';

/**
 * Compatibility bridge for tenants whose published Business Pack does not yet
 * reference OKF. It talks only to JourneyAX's tenant-scoped product/knowledge
 * service. External platforms remain behind that service or an authenticated
 * Activepieces binding; the modern runtime never imports legacy connectors.
 */
export function createLegacyKnowledgePortResolver(): LegacyKnowledgeRetrievalPortResolver {
  const baseUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
  const port: LegacyKnowledgeRetrievalPort = {
    async search(ctx, req) {
      const response = await fetch(`${baseUrl}/api/v1/${encodeURIComponent(ctx.tenantId)}/products/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': ctx.tenantId,
          ...(ctx.correlationId ? { 'X-Correlation-ID': ctx.correlationId } : {}),
        },
        body: JSON.stringify({
          query: req.query,
          brand: ctx.tenantId,
          category: req.category,
          type: req.type,
          gender: req.gender,
          limit: req.limit,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return { found: false, results: [], message: `Tenant knowledge service failed (HTTP ${response.status}).` };
      }
      const result: any = await response.json();
      return {
        found: Boolean(result.found),
        message: result.message,
        results: (result.results || []).map((item: any) => ({
          sourceId: 'legacy:tenant-knowledge-service',
          releaseId: 'legacy-unpinned',
          title: item.title || item.name || item.sku || 'Knowledge result',
          content: item.content,
          sku: item.sku,
          specs: item.specs || item.specifications,
          url: item.url,
        })),
      };
    },
  };
  return async () => port;
}
