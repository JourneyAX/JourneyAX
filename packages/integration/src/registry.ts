/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AdapterRegistry — resolves the right adapter per tenant + domain
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The agent-runtime asks: "give me the KnowledgePort for tenant X." The registry
 * resolves that tenant's configured platform + connection (from the PUBLISHED
 * project config's `integrations` — set in the back office, versioned by B2)
 * and returns the matching adapter instance, already carrying its credentials.
 *
 * WHY a registry: it's the single switchboard between "which platform" (config,
 * per tenant) and "which code" (adapter). The agent never branches on platform.
 *
 * Register new platforms by adding to the maps below — one line per adapter.
 */
import { CommercePort, CrmPort, FulfilmentPort, ConfiguratorPort, KnowledgePort, BusinessPort, Platform } from './ports';
import { StandaloneCommerceAdapter } from './adapters/commerce/standalone.commerce.adapter';
import { ShopifyCommerceAdapter } from './adapters/commerce/shopify.commerce.adapter';
import { SalesforceCrmAdapter } from './adapters/crm/salesforce.crm.adapter';
import { StandaloneKnowledgeAdapter } from './adapters/knowledge/standalone.knowledge.adapter';
import { CommercetoolsKnowledgeAdapter } from './adapters/knowledge/commercetools.knowledge.adapter';
import { ConfigBusinessAdapter } from './adapters/business/config.business.adapter';

/** Per-tenant platform selection + the connection (credentials) for each domain. */
export interface TenantPlatforms {
  commerce: Platform;
  crm: Platform;
  fulfilment: Platform;
  configurator: Platform;
  knowledge: Platform;
  /** Which implementation answers "what business is this?" (see BusinessPort). */
  business: Platform;
}

export interface TenantResolution {
  platforms: TenantPlatforms;
  /** domain → opaque connection/credentials object (from project.integrations). */
  connections?: Partial<Record<keyof TenantPlatforms, Record<string, unknown> | undefined>>;
}

/** Default: everything internal (standalone). */
export const DEFAULT_PLATFORMS: TenantPlatforms = {
  commerce: 'standalone',
  crm: 'standalone',
  fulfilment: 'standalone',
  configurator: 'standalone',
  knowledge: 'standalone',
  business: 'standalone',
};

export type TenantResolver = (tenantId: string) => TenantResolution | Promise<TenantResolution>;

const DEFAULT_RESOLVER: TenantResolver = () => ({ platforms: DEFAULT_PLATFORMS });

export class AdapterRegistry {
  // domain → platform → factory (receives the tenant's connection). Add adapters here.
  private commerce: Partial<Record<Platform, (conn?: any) => CommercePort>> = {
    standalone: () => new StandaloneCommerceAdapter(),
    shopify: () => new ShopifyCommerceAdapter(),
  };
  private business: Partial<Record<Platform, (conn?: any) => BusinessPort>> = {
    standalone: () => new ConfigBusinessAdapter(),
  };
  private crm: Partial<Record<Platform, (conn?: any) => CrmPort>> = {
    salesforce: () => new SalesforceCrmAdapter(),
    // TODO: standalone (customer-service), hubspot
  };
  private fulfilment: Partial<Record<Platform, (conn?: any) => FulfilmentPort>> = {
    // TODO: standalone (order-service)
  };
  private configurator: Partial<Record<Platform, (conn?: any) => ConfiguratorPort>> = {
    // TODO: standalone (project-service)
  };
  private knowledge: Partial<Record<Platform, (conn?: any) => KnowledgePort>> = {
    standalone: () => new StandaloneKnowledgeAdapter(),
    commercetools: (conn) => new CommercetoolsKnowledgeAdapter(conn),
  };

  constructor(private resolver: TenantResolver = DEFAULT_RESOLVER) {}

  /**
   * Install the config-driven resolver (e.g. one that reads the tenant's PUBLISHED
   * project config). Called once at service bootstrap; before that, everything
   * resolves to standalone (safe default).
   */
  setResolver(resolver: TenantResolver) {
    this.resolver = resolver;
  }

  async getCommerce(tenantId: string): Promise<CommercePort> {
    const r = await this.resolver(tenantId);
    return this.pick('commerce', this.commerce, r.platforms.commerce, r.connections?.commerce);
  }
  async getCrm(tenantId: string): Promise<CrmPort> {
    const r = await this.resolver(tenantId);
    return this.pick('crm', this.crm, r.platforms.crm, r.connections?.crm);
  }
  async getFulfilment(tenantId: string): Promise<FulfilmentPort> {
    const r = await this.resolver(tenantId);
    return this.pick('fulfilment', this.fulfilment, r.platforms.fulfilment, r.connections?.fulfilment);
  }
  async getConfigurator(tenantId: string): Promise<ConfiguratorPort> {
    const r = await this.resolver(tenantId);
    return this.pick('configurator', this.configurator, r.platforms.configurator, r.connections?.configurator);
  }
  async getKnowledge(tenantId: string): Promise<KnowledgePort> {
    const r = await this.resolver(tenantId);
    return this.pick('knowledge', this.knowledge, r.platforms.knowledge, r.connections?.knowledge);
  }
  /** "What kind of business is this, and who does its customer buy for?" */
  async getBusiness(tenantId: string): Promise<BusinessPort> {
    const r = await this.resolver(tenantId);
    return this.pick('business', this.business, r.platforms.business ?? 'standalone', r.connections?.business);
  }

  private pick<T>(
    domain: string,
    map: Partial<Record<Platform, (conn?: any) => T>>,
    platform: Platform,
    connection?: Record<string, unknown>,
  ): T {
    const factory = map[platform];
    if (!factory) {
      throw new Error(
        `No ${domain} adapter registered for platform "${platform}". ` +
          `Add one in packages/integration/src/registry.ts.`,
      );
    }
    return factory(connection);
  }
}

/** Shared singleton; install the config-driven resolver at service bootstrap via setResolver(). */
export const adapterRegistry = new AdapterRegistry();

/**
 * Build a resolver that reads the tenant's PUBLISHED project config from
 * project-service and maps `integrations.platforms` + per-platform connections.
 * Cached per tenant for `ttlMs` so a chat turn doesn't refetch repeatedly.
 */
export function createPublishedConfigResolver(
  projectServiceUrl: string,
  ttlMs = 60_000,
): TenantResolver {
  const cache = new Map<string, { value: TenantResolution; expiresAt: number }>();
  return async (tenantId: string): Promise<TenantResolution> => {
    const hit = cache.get(tenantId);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
    let value: TenantResolution = { platforms: DEFAULT_PLATFORMS };
    try {
      const res = await fetch(
        `${projectServiceUrl}/api/v1/projects/${encodeURIComponent(tenantId)}/published`,
        { headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } },
      );
      if (res.ok) {
        const p: any = await res.json();
        const sel = p?.integrations?.platforms || {};
        const platforms: TenantPlatforms = { ...DEFAULT_PLATFORMS, ...sel };
        // Map each domain's selected platform to that platform's connection object.
        const connFor = (platform: Platform) =>
          platform === 'standalone' ? undefined : p?.integrations?.[platform];
        value = {
          platforms,
          connections: {
            knowledge: connFor(platforms.knowledge),
            commerce: connFor(platforms.commerce),
            crm: connFor(platforms.crm),
            fulfilment: connFor(platforms.fulfilment),
            configurator: connFor(platforms.configurator),
          },
        };
      }
    } catch {
      /* project-service down → safe standalone default */
    }
    cache.set(tenantId, { value, expiresAt: Date.now() + ttlMs });
    return value;
  };
}
