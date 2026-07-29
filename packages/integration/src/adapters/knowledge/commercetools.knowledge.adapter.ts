/**
 * CommercetoolsKnowledgeAdapter — RAG-style retrieval over a tenant's
 * commercetools project (Composable Commerce HTTP API).
 *
 * Same KnowledgePort contract as the standalone adapter: returns the FULL
 * retrieval envelope (found + results[] with content/specs/imageUrl) so the
 * agent's grounding behaviour is identical regardless of backend — the whole
 * point of the port layer.
 *
 * Credentials come from the project's back-office Integrations config
 * (`integrations.commercetools`: projectKey/clientId/clientSecret/apiUrl/authUrl,
 * optional searchLocale), passed in by the registry — NEVER from env/hardcode.
 *
 * Auth: OAuth2 client-credentials against `{authUrl}/oauth/token`, scope
 * `view_products:{projectKey}` (granted at API-client creation in the CT
 * Merchant Center). Tokens are cached per clientId until ~1 min before expiry.
 */
import {
  AdapterContext,
  AdapterMeta,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeResultItem,
  KnowledgeSearchResult,
} from '../../ports';

export interface CommercetoolsConnection {
  projectKey?: string;
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;        // e.g. https://api.australia-southeast1.gcp.commercetools.com
  authUrl?: string;       // e.g. https://auth.australia-southeast1.gcp.commercetools.com
  searchLocale?: string;  // e.g. "en-AU" — the locale used for text search + names
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

async function getToken(conn: CommercetoolsConnection): Promise<string> {
  const key = `${conn.authUrl}|${conn.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`${String(conn.authUrl).replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=view_products:${conn.projectKey}`,
  });
  if (!res.ok) throw new Error(`commercetools auth failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  const data: any = await res.json();
  tokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 300) - 60) * 1000,
  });
  return data.access_token;
}

/** Pull a localized string with sensible fallbacks. */
function loc(v: any, locale: string): string | undefined {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v : undefined;
  return v[locale] ?? v['en-AU'] ?? v['en-GB'] ?? v['en-US'] ?? v['en'] ?? Object.values(v)[0] as string | undefined;
}

/** Flatten CT attributes into a plain specs map. */
function attrsToSpecs(attrs: any[] | undefined, locale: string): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const a of attrs ?? []) {
    let val = a?.value;
    if (val && typeof val === 'object') val = (val.label && (loc(val.label, locale) ?? val.label)) ?? loc(val, locale) ?? val.key ?? JSON.stringify(val);
    if (a?.name != null && val != null) specs[String(a.name)] = String(val);
  }
  return specs;
}

export class CommercetoolsKnowledgeAdapter implements KnowledgePort {
  readonly meta: AdapterMeta = { domain: 'knowledge', platform: 'commercetools' };

  constructor(private readonly connection?: CommercetoolsConnection) {}

  async search(ctx: AdapterContext, q: KnowledgeQuery): Promise<KnowledgeSearchResult> {
    const conn = (this.connection ?? (ctx.connection as CommercetoolsConnection | undefined)) || {};
    if (!conn.projectKey || !conn.clientId || !conn.clientSecret || !conn.apiUrl || !conn.authUrl) {
      return {
        found: false,
        resultCount: 0,
        results: [],
        message:
          'commercetools is selected as the knowledge platform for this project, but its ' +
          'connection is not fully configured (projectKey/clientId/clientSecret/apiUrl/authUrl). ' +
          'Configure it in the back office → Integrations, then Publish.',
      };
    }

    const locale = conn.searchLocale || 'en-AU';
    try {
      const token = await getToken(conn);
      const params = new URLSearchParams({
        [`text.${locale}`]: q.query,
        limit: String(q.limit ?? 8),
        markMatchingVariants: 'true',
        staged: 'false',
      });
      const res = await fetch(
        `${String(conn.apiUrl).replace(/\/$/, '')}/${conn.projectKey}/product-projections/search?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        return { found: false, resultCount: 0, results: [], message: `commercetools search failed: HTTP ${res.status}` };
      }
      const data: any = await res.json();
      const results: KnowledgeResultItem[] = (data.results ?? []).map((p: any) => {
        const v = p.masterVariant ?? {};
        const name = loc(p.name, locale) ?? 'Unnamed product';
        const description = loc(p.description, locale) ?? '';
        const priceCents = v.prices?.[0]?.value?.centAmount;
        const specs = attrsToSpecs(v.attributes, locale);
        return {
          title: name,
          type: q.type || 'product',
          sku: v.sku,
          // Port convention: prices in integer minor units; UI formats.
          price: typeof priceCents === 'number' ? priceCents / 100 : undefined,
          imageUrl: v.images?.[0]?.url,
          images: (v.images ?? []).map((i: any) => i.url).filter(Boolean),
          specs,
          url: p.slug ? `product/${loc(p.slug, locale)}` : undefined,
          // The grounding chunk the model reads — name + description + key specs.
          content: [
            name,
            description,
            Object.entries(specs).slice(0, 12).map(([k, val]) => `${k}: ${val}`).join(' · '),
          ].filter(Boolean).join('\n'),
        };
      });
      return {
        found: results.length > 0,
        resultCount: results.length,
        results,
        message: results.length ? undefined : `No commercetools products matched "${q.query}".`,
      };
    } catch (err) {
      return { found: false, resultCount: 0, results: [], message: `commercetools error: ${(err as Error).message}` };
    }
  }
}
