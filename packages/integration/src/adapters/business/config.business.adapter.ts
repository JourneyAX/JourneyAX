/**
 * ConfigBusinessAdapter — the DEFAULT implementation of the Business layer.
 *
 * Deliberately NOT one adapter per vertical. It derives the whole profile from
 * two things a tenant already has:
 *
 *   1. its project config      — identity, model, audience, entity vocabulary
 *   2. its ingested catalogue  — brands, taxonomy, price band, help topics
 *
 * So onboarding a teamwear brand, a bathroom brand and a workwear brand is a
 * CONFIG change, not a code change. A vertical only needs its own adapter if it
 * has genuinely bespoke logic no config can express — and none has yet.
 *
 * Everything derived from the catalogue is computed, not inferred by a model, so
 * the profile cannot drift into confident fiction.
 */
import {
  AdapterContext,
  AdapterMeta,
  BusinessPort,
  BusinessProfile,
  BusinessEntityLookup,
} from '../../ports';

export class ConfigBusinessAdapter implements BusinessPort {
  readonly meta: AdapterMeta = { domain: 'business', platform: 'standalone' };

  constructor(
    private readonly productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083',
    private readonly projectServiceUrl = process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082',
  ) {}

  private headers(tenantId: string) {
    return {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenantId,
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    };
  }

  async getProfile(ctx: AdapterContext): Promise<BusinessProfile> {
    const [project, hub] = await Promise.all([
      this.fetchJson(`${this.projectServiceUrl}/api/v1/projects/${encodeURIComponent(ctx.tenantId)}`, ctx.tenantId),
      this.fetchJson(`${this.productServiceUrl}/api/v1/${encodeURIComponent(ctx.tenantId)}/products/brand-hub`, ctx.tenantId),
    ]);

    const biz = project?.business || {};          // operator-authored, wins
    const facts = hub?.facts || {};               // computed from the catalogue

    // Entity model: the single most vertical-specific idea, expressed as config.
    // Absent config, no entity is assumed — better a missing concept than a
    // wrong one ("team" would be nonsense for a bathroom brand).
    const entityModel = biz.entityModel
      ? {
          key: biz.entityModel.key,
          label: biz.entityModel.label,
          labelPlural: biz.entityModel.labelPlural,
          askPrompt: biz.entityModel.askPrompt,
          hasDirectory: biz.entityModel.hasDirectory ?? false,
          allowCreate: biz.entityModel.allowCreate ?? true,
          captureFields: biz.entityModel.captureFields || [],
          confirmWithCustomer: biz.entityModel.confirmWithCustomer || [],
        }
      : undefined;

    return {
      identity: {
        name: project?.companyName || project?.name || ctx.tenantId,
        brands: facts.brands || [],
        regions: biz.regions || [],
        currencies: [project?.pricing?.currency].filter(Boolean),
        summary: hub?.narrative || biz.summary || undefined,
      },
      model: {
        type: biz.type,
        sellsTo: biz.sellsTo,
        orderPattern: biz.orderPattern,
        customised: biz.customised,
        approvalRequired: biz.approvalRequired,
      },
      audience: biz.audience || [],
      entityModel,
      vocabulary: {
        primaryDimension: biz.vocabulary?.primaryDimension,
        primaryValues: hub?.taxonomy?.primary || [],
        secondaryDimension: biz.vocabulary?.secondaryDimension,
        secondaryValues: hub?.taxonomy?.secondary || [],
        audienceDimension: biz.vocabulary?.audienceDimension,
        audienceValues: hub?.taxonomy?.audience || [],
      },
      operating: {
        knownTopics: (hub?.topics || []).map((t: any) => t.title),
        priceBand: facts.priceBandUsd
          ? { ...facts.priceBandUsd, currency: project?.pricing?.currency || 'USD' }
          : undefined,
        catalogueSize: facts.productCount,
      },
      provenance: {
        identity: 'project config + computed catalogue facts',
        vocabulary: 'computed from the catalogue',
        summary: hub?.narrative ? 'model-written orientation — not authoritative' : 'none',
        entityModel: entityModel ? 'operator-configured' : 'not configured',
      },
    };
  }

  /** Generic entity lookup. Today this is backed by the team directory; the
   *  vocabulary comes from config, so the same call answers "which site?" for a
   *  workwear tenant without any change here. */
  async findEntities(ctx: AdapterContext, query: string, where: Record<string, string> = {}): Promise<BusinessEntityLookup> {
    const fallback: BusinessEntityLookup = {
      query, matches: [],
      guidance: 'No directory is available — ask the customer directly and record what they tell you.',
    };
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${encodeURIComponent(ctx.tenantId)}/products/teams`, {
        method: 'POST', headers: this.headers(ctx.tenantId),
        body: JSON.stringify({ query, ...where }),
      });
      if (!res.ok) return fallback;
      const d: any = await res.json();
      return {
        query: d.query ?? query,
        totalMatches: d.totalMatches,
        needsLocation: d.needsLocation,
        availableRegions: d.availableStates,
        guidance: d.guidance || fallback.guidance,
        matches: (d.matches || []).map((m: any) => ({
          key: m.slug,
          name: m.programme || m.institution,
          kind: m.kind,
          location: { city: m.city, state: m.state, country: m.country },
          attributes: {
            nickname: m.nickname, mascot: m.mascot, district: m.district,
            level: m.level, conference: m.conference, division: m.division,
            colours: m.colours, colourSource: m.colourSource,
            artworkPolicy: m.artworkPolicy,
          },
          confidence: m.confidence,
          source: m.source,
        })),
      };
    } catch {
      return fallback;
    }
  }

  async registerEntity(ctx: AdapterContext, entity: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.productServiceUrl}/api/v1/${encodeURIComponent(ctx.tenantId)}/products/teams/register`, {
        method: 'POST', headers: this.headers(ctx.tenantId),
        body: JSON.stringify(entity),
      });
      if (!res.ok) return { ok: false, message: `Could not save (HTTP ${res.status}).` };
      return (await res.json()) as { ok: boolean; message: string };
    } catch {
      return { ok: false, message: 'Could not save right now.' };
    }
  }

  private async fetchJson(url: string, tenantId: string): Promise<any | null> {
    try {
      const res = await fetch(url, { headers: this.headers(tenantId), signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;   // the profile degrades field by field rather than failing
    }
  }
}
