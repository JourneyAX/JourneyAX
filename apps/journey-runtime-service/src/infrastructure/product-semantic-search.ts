import type { VectorSearchFunction } from '../capabilities/handlers/catalog-search.handler';

/** Reuse the existing document index/embedding service. It cannot supply prices, stock or fabricated catalogue rows. */
export function createProductSemanticSearcher(options: { baseUrl?: () => string | undefined; internalKey?: () => string | undefined; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): VectorSearchFunction {
  return async (query, scope) => {
    const base = (options.baseUrl?.() ?? process.env.PRODUCT_SERVICE_URL)?.replace(/\/+$/, '');
    const key = options.internalKey?.() ?? process.env.INTERNAL_API_KEY;
    if (!base || !key) return [];
    const url = new URL(base);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('Semantic service address is not allowed.');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const response = await (options.fetchImpl ?? fetch)(`${base}/api/v1/${encodeURIComponent(scope.tenantId)}/products/semantic-candidates`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({ query: query.slice(0, 500), limit: Math.min(scope.limit, 100) }),
      signal: scope.signal ? AbortSignal.any([scope.signal, timeout]) : timeout, redirect: 'error',
    });
    if (!response.ok) throw new Error(`Semantic service unavailable (${response.status}).`);
    const text = await response.text();
    if (text.length > 64_000) throw new Error('Semantic candidate response exceeds the limit.');
    const result = JSON.parse(text);
    if (result?.method !== 'vector' || !Array.isArray(result.candidates)) return [];
    return result.candidates.slice(0, scope.limit).flatMap((candidate: any) => typeof candidate?.sku === 'string' && candidate.sku.length <= 200 && Number.isFinite(candidate.score)
      ? [{ doc: null, candidateId: candidate.sku, score: candidate.score }] : []);
  };
}
