/**
 * Canonical knowledge-retrieval port for the journey runtime.
 *
 * The runtime core depends only on this structural contract. Concrete retrieval backends
 * (tenant-scoped connectors, search indexes, ...) are supplied by the composition root through
 * CapabilityGatewayOptions.knowledgePortResolver; the core never imports or constructs them.
 */
export interface KnowledgeRetrievalContext {
  tenantId: string;
  environmentId: string;
  correlationId?: string;
}

export interface KnowledgeRetrievalRequest {
  query: string;
  category?: string;
  type?: string;
  limit?: number;
  gender?: string;
  /** Exact immutable OKF release and evidence allow-list for this request. */
  knowledgeScope: {
    releaseId: string;
    version: string;
    checksum: string;
    conceptIds: string[];
    sourceRefs: string[];
    requestedClaimClass?: string;
  };
}

export interface KnowledgeRetrievalItem {
  sourceId: string;
  releaseId: string;
  title: string;
  content?: string;
  sku?: string;
  specs?: Record<string, unknown>;
  url?: string;
}

export interface KnowledgeRetrievalResult {
  found: boolean;
  results: KnowledgeRetrievalItem[];
  message?: string;
}

export interface KnowledgeRetrievalPort {
  search(ctx: KnowledgeRetrievalContext, req: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalResult>;
}

/** Resolves the tenant-scoped retrieval port. Must fail (throw/reject) when none is configured for the tenant. */
export type KnowledgeRetrievalPortResolver = (
  tenantId: string
) => Promise<KnowledgeRetrievalPort> | KnowledgeRetrievalPort;
