/**
 * StandaloneKnowledgeAdapter — RAG retrieval over JourneyAX's own product-service.
 *
 * Wraps the internal `product-service` /search endpoint and returns its response
 * verbatim (the full envelope: found + results[] with content/specs/imageUrl).
 * This is what the agent's `searchKnowledge` tool now calls, instead of building
 * the URL and fetch itself.
 *
 * WHY it returns the raw envelope (not clean ProductRefs): the LLM grounds on the
 * `content` chunk and needs the `found`/`message` signal to decide whether to ask
 * vs answer. Flattening to structured products here would regress grounding.
 */
import {
  AdapterContext,
  AdapterMeta,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeSearchResult,
  KnowledgeRelated,
  KnowledgeOptions,
  KnowledgeTeams,
} from '../../ports';

/** Remove markdown images, links and bare image URLs from retrieved text. */
function stripMedia(s: string): string {
  return s
    // ![alt](url) — URL may contain (nested) parens like Group_(1).png
    .replace(/!\[[^\]]*\]\([^)]*(?:\([^)]*\)[^)]*)*\)/g, '')
    .replace(/!\[[^\]]*\]/g, '')                              // dangling ![alt]
    .replace(/\[([^\]]*)\]\([^)]*(?:\([^)]*\)[^)]*)*\)/g, '$1')// [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')                           // bare URLs
    .replace(/\.(?:png|jpe?g|webp|avif|svg|gif)\)?/gi, '')     // stray ".png)" fragments
    .replace(/\(\s*\)/g, '')                                  // empty ()
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class StandaloneKnowledgeAdapter implements KnowledgePort {
  readonly meta: AdapterMeta = { domain: 'knowledge', platform: 'standalone' };

  constructor(
    private readonly productServiceUrl = process.env.PRODUCT_SERVICE_URL ||
      'http://localhost:8083',
  ) {}

  async registerTeam(ctx: AdapterContext, team: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/teams/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify(team),
      });
      if (!res.ok) return { ok: false, message: `Could not save the team (HTTP ${res.status}).` };
      return (await res.json()) as { ok: boolean; message: string };
    } catch {
      return { ok: false, message: 'Could not save the team right now.' };
    }
  }

  async teams(ctx: AdapterContext, query: string, where: { state?: string; city?: string } = {}): Promise<KnowledgeTeams> {
    const empty: KnowledgeTeams = { query, matches: [], guidance: 'Team directory unavailable — ask the customer for their school and colours directly.' };
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({ query, ...where }),
      });
      if (!res.ok) return empty;
      return (await res.json()) as KnowledgeTeams;
    } catch {
      return empty;
    }
  }

  async options(ctx: AdapterContext, sku: string): Promise<KnowledgeOptions> {
    const empty: KnowledgeOptions = { sku, found: false, choices: {}, characteristics: {}, goesWith: [], views: [] };
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({ sku }),
      });
      if (!res.ok) return empty;
      return (await res.json()) as KnowledgeOptions;
    } catch {
      return empty;
    }
  }

  async related(ctx: AdapterContext, sku: string): Promise<KnowledgeRelated> {
    const empty: KnowledgeRelated = { sku, collections: [], outfittingSets: [], sizingGroup: null };
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({ sku }),
      });
      if (!res.ok) return empty;
      return (await res.json()) as KnowledgeRelated;
    } catch {
      // Relationships are an enhancement, never a blocker — degrade to "unknown".
      return empty;
    }
  }

  async search(ctx: AdapterContext, q: KnowledgeQuery): Promise<KnowledgeSearchResult> {
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${ctx.tenantId}/products/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': ctx.tenantId },
        body: JSON.stringify({
          query: q.query,
          brand: ctx.tenantId,
          type: q.type,
          category: q.category,
          limit: q.limit ?? 8,
          gender: q.gender,
        }),
      });
      if (!res.ok) {
        return {
          found: false,
          resultCount: 0,
          results: [],
          message: `Knowledge search failed (HTTP ${res.status}).`,
        };
      }
      const data = (await res.json()) as KnowledgeSearchResult;
      // Strip image/URL markdown from the retrieved content so the model cannot
      // echo `![img](url)` links or raw URLs into the chat. The product cards
      // (rendered via showProducts) already carry the images and specs.
      if (Array.isArray(data.results)) {
        for (const r of data.results) {
          if (typeof r.content === 'string') r.content = stripMedia(r.content);
        }
      }
      return data;
    } catch (err) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        message: 'Knowledge search failed — product service unavailable.',
      };
    }
  }
}
