import { adapterRegistry } from '@journeyax/integration';
import { EffectiveAgentConfig } from '../runtime-config';
import { PLATFORM_DEFAULT_AGENT_CONFIG } from '../runtime-config/defaults-platform';
import { mergeGenericBusinessConfig, renderGenericBusinessConfig } from '../runtime-config/generic-business-config';

/**
 * Step 0 — Config Loader (config over code).
 *
 * Loads the tenant's ACTIVE business rules from the back office (project-service)
 * and renders them as a system block the agent must honour. This is what makes
 * the agent config-driven: an admin edits a rule in the back office and the next
 * conversation reflects it — no code change, no deploy.
 *
 * Applies published Backoffice configuration over the tenant-neutral platform
 * fallback. Code-owned tenant packs are no longer required at runtime.
 *
 * Resilient: if project-service is unavailable, returns no rules and the agent
 * proceeds on its base prompt (graceful degradation).
 *
 * (Reaches project-service by URL for now; can move behind a ConfigPort in
 * @journeyax/integration later, like KnowledgePort.)
 */
export interface LoadedRule {
  name: string;
  scope: string;
  condition: string;
  action: string;
}
export interface ActiveRulesLoadResult {
  ok: boolean;
  rules: LoadedRule[];
}
/** The slice of published project config the agent runtime consumes per turn. */
export interface LoadedProjectConfig {
  provider?: string;              // ai.provider — openai | anthropic | gemini | ollama
  model?: string;                 // ai.model — per-project reasoning model
  temperature?: number;           // ai.temperature
  maxTokens?: number;             // ai.maxTokens — open-model reply budget (default 768 in the agent)
  intentModel?: string;           // ai.intentModel — 'project' = classify on the project's own model/provider
  /** Sample-customer demo fixtures (profiles, orders, offers, inventory) — read
   *  through the customerHistory tools, bound to the request's demo principal. */
  demoCustomers?: any;
  /** Product-matching config: quantity caps enforced at bag time, and storage
   *  capacity facts for the recommendStorage tool. (hand-offs are storefront-side.) */
  purchaseLimits?: any[];
  storageGuide?: any[];
  handoffs?: any[];
  apiKey?: string;                // ai.apiKey — per-project LLM key (un-redacted via internal-key fetch)
  baseUrl?: string;               // ai.baseUrl — optional endpoint override
  companyName?: string;           // the business's CURRENT trading name
  formerNames?: string[];         // prior names, rewritten to companyName in derived text
  systemName?: string;            // persona.systemName
  systemPromptOverrides?: string; // persona.systemPromptOverrides
  journeyGuidance?: string;       // persona.journeyGuidance (goals, not stages)
  greetingMessage?: string;
  journeyGraph?: { nodes: any[]; edges: any[] };
  business?: any;
  labels?: { items?: string; itemsSingular?: string; headerTitle?: string };
  quoteIntro?: string;
  complianceBadge?: string;
  uiTheme?: any;
  cardTemplates?: Record<string, any>;
  fulfilment?: any;
  components?: any;
  multiTradeBundles?: any[];
  capabilities?: string[];        // enabled agent capabilities (runtime toolset)
  commerceMode?: string;          // 'cart' (B2C guided journey) | 'quote' (B2B/fixtures)
  pricing?: { currency: string; symbol: string; taxRate: number; discountRate: number }; // project.pricing (authoritative money rules)
  pricingConfigured?: boolean;      // true only when the published tenant supplied pricing
  stripe?: { secretKey?: string; enabled: boolean };  // integrations.stripe (per-project payment key)
  integrations?: any;
  scope?: ProjectScopeSlice;      // scope.rooms/categories — which spaces this business serves
  contextDimensions?: ContextDimension[]; // project-configured dims the agent extracts + scopes by
  agentBehavior?: any;           // optional behavior overrides currently migrating into Backoffice
  configVersion?: number;         // which PUBLISHED config version this turn runs on (audit/trace)
  /**
   * configurator.sizeScale — the sizes this brand actually sells. Roster import
   * checks against it; with no scale we report a size as UNVERIFIED rather than
   * accepting it, because an unchecked size ships garments nobody can wear.
   */
  sizeScale?: string[];
  /**
   * configurator.productType — 'garment' (Three.js over a per-SKU mesh) or
   * 'candy' (a client-side composited disc, no server render). The agent skips
   * the garment render/validate for a candy so it never reports a design
   * "not displayable" over a panel that opened fine.
  */
  configuratorType?: string;
  /** Back Office explicitly enables the tenant's configurator component. */
  configuratorEnabled?: boolean;

  /** Effective tenant agent configuration loaded at conversation startup. */
  agentConfig?: EffectiveAgentConfig;
  configSource?: 'backoffice' | 'fallback';
}

/** The scope slice the agent uses to classify + bound the journey by space. */
export interface ProjectScopeSlice {
  rooms?: string[];       // ["Bathroom","Kitchen","Laundry"] — served spaces
  categories?: string[];  // ["basin","toilet","tapware"] — served product categories
}

/** A project-configured context dimension (generic replacement for the fixed space classifier). */
export interface ContextDimension {
  key: string;
  label?: string;
  values?: string[];
  description?: string;
  scoping?: boolean;         // value outside `values` ⇒ out-of-scope
  filtersRetrieval?: boolean; // extracted value scopes retrieval
  /** Ask this as tappable chips when still unknown (the business's own journey question). */
  askWhenMissing?: boolean;
  /** The question wording for those chips ("Which game are the cards for?"). */
  question?: string;
  /** Once known, an item naming a SIBLING value never reaches a card ("Standard" vs "Japanese"). */
  hardFilter?: boolean;
  /** Per-value aliases read straight from the customer's words ("commander", "edh" → Magic). */
  aliases?: Record<string, string[]>;
  /** Filled in code from another dimension — size from game — never asked. `*` = default. */
  derive?: { from: string; map: Record<string, string> };
}

export class ConfigLoader {
  constructor(
    private readonly projectServiceUrl = process.env.PROJECT_SERVICE_URL_HTTP ||
      process.env.PROJECT_SERVICE_URL ||
      'http://localhost:8082',
  ) {
  }

  /**
   * Load the tenant's published config (model + persona + journey guidance).
   * Normalizes Backoffice configuration for config-driven intents, dimensions, tools, etc.
   * Resilient: on any failure returns {} so the agent falls back to env defaults.
   */
  async loadProjectConfig(tenantId: string): Promise<LoadedProjectConfig> {
    try {
      // PUBLISHED config, not the live draft (FR-CONFIG-002): back-office edits only
      // reach conversations after an explicit Publish. Falls back to the draft server-side
      // for projects that have never been published.
      const res = await fetch(
        `${this.projectServiceUrl}/api/v1/projects/${encodeURIComponent(tenantId)}/published`,
        { headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } },
      );
      if (!res.ok) return this.attachEffectiveAgentConfig({ configSource: 'fallback' }, tenantId);
      const p: any = await res.json();

      const config: LoadedProjectConfig = {
        provider: p?.ai?.provider,
        model: p?.ai?.model,
        temperature: p?.ai?.temperature,
        maxTokens: p?.ai?.maxTokens,
        intentModel: typeof p?.ai?.intentModel === 'string' ? p.ai.intentModel : undefined,
        demoCustomers: p?.demoCustomers && typeof p.demoCustomers === 'object' ? p.demoCustomers : undefined,
        purchaseLimits: Array.isArray(p?.purchaseLimits) ? p.purchaseLimits : undefined,
        storageGuide: Array.isArray(p?.storageGuide) ? p.storageGuide : undefined,
        handoffs: Array.isArray(p?.handoffs) ? p.handoffs : undefined,
        apiKey: p?.ai?.apiKey,
        baseUrl: p?.ai?.baseUrl,
        companyName: p?.companyName || p?.name,
        formerNames: Array.isArray(p?.formerNames) ? p.formerNames : undefined,
        systemName: p?.persona?.systemName,
        systemPromptOverrides: p?.persona?.systemPromptOverrides,
        journeyGuidance: p?.persona?.journeyGuidance,
        greetingMessage: p?.persona?.greetingMessage,
        journeyGraph: p?.persona?.journeyGraph,
        business: p?.business,
        labels: p?.labels,
        quoteIntro: p?.quoteIntro,
        complianceBadge: p?.complianceBadge,
        uiTheme: p?.uiTheme,
        cardTemplates: p?.cardTemplates,
        fulfilment: p?.fulfilment,
        components: p?.components,
        multiTradeBundles: Array.isArray(p?.multiTradeBundles) ? p.multiTradeBundles : undefined,
        capabilities: Array.isArray(p?.capabilities) ? p.capabilities : undefined,
        // Commerce surface — a retail 'cart' brand sells the guided journey, so the
        // agent must not force show-first over the occasion/fit/size clarify. 'quote'
        // (or unset) keeps the direct-ask show-first behaviour for fixtures/kits.
        commerceMode: p?.commerceMode === 'cart' ? 'cart' : 'quote',
        scope: {
          rooms: Array.isArray(p?.scope?.rooms) ? p.scope.rooms : undefined,
          categories: Array.isArray(p?.scope?.categories) ? p.scope.categories : undefined,
        },
        contextDimensions: this.resolveDimensions(p),
        agentBehavior: p?.agentBehavior && typeof p.agentBehavior === 'object' ? p.agentBehavior : undefined,
        configVersion: typeof p?.activeVersion === 'number' ? p.activeVersion : undefined,
        // 'garment' (Three.js over a per-SKU mesh) vs 'candy' (a client-side
        // composited disc). The agent must NOT try to server-render a candy —
        // there is no mesh to render, so the garment validate would report the
        // design "not displayable" and the agent would apologise over a panel
        // that opened fine.
        configuratorType: p?.configurator?.productType || undefined,
        configuratorEnabled: p?.configurator?.enabled === true,
        sizeScale: Array.isArray(p?.configurator?.sizeScale) ? p.configurator.sizeScale : undefined,
        pricing: {
          currency: p?.pricing?.currency || 'AUD',
          symbol: p?.pricing?.symbol || '$',
          taxRate: typeof p?.pricing?.taxRate === 'number' ? p.pricing.taxRate : 0,
          discountRate: typeof p?.pricing?.discountRate === 'number' ? p.pricing.discountRate : 0,
        },
        pricingConfigured: !!p?.pricing && typeof p.pricing.currency === 'string' && typeof p.pricing.taxRate === 'number',
        stripe: {
          // Per-project Stripe key (integrations.stripe.secretKey), un-redacted via
          // the internal-key fetch. Falls back to platform env in the order service.
          secretKey: p?.integrations?.stripe?.secretKey,
          enabled: !!p?.integrations?.stripe?.enabled,
        },
        integrations: p?.integrations,
        configSource: 'backoffice',
      };

      return this.attachEffectiveAgentConfig(config, tenantId);
    } catch (err) {
      console.warn('[ConfigLoader] could not load project config, using defaults:', (err as Error).message);
      return this.attachEffectiveAgentConfig({ configSource: 'fallback' }, tenantId);
    }
  }

  /** Resolve the tenant-neutral fallback when project-service is unavailable. The
   * platform defaults are a safe generic fallback; published project settings still
   * supply tenant-specific dimensions and persona when they are available. */
  private async attachEffectiveAgentConfig(
    config: LoadedProjectConfig,
    tenantId: string,
  ): Promise<LoadedProjectConfig> {
    // Tenant-specific behavior comes from the published Backoffice project.
    // Platform defaults are only the tenant-neutral runtime fallback.
    config.agentConfig = PLATFORM_DEFAULT_AGENT_CONFIG;
    // Enrich a per-request copy so prompt assembly has one typed source. Never
    // mutate the cached pack singleton with another project's identity/settings.
    const effectiveAgentConfig = JSON.parse(JSON.stringify(config.agentConfig)) as EffectiveAgentConfig;
    const genericBehavior = mergeGenericBusinessConfig(config.agentBehavior);
    const configuredRetrieval = config.agentBehavior?.retrievalPolicy;
    if (effectiveAgentConfig.retrieval) {
      if (configuredRetrieval?.queryWordRange) effectiveAgentConfig.retrieval.queryWordRange = configuredRetrieval.queryWordRange;
      if (typeof configuredRetrieval?.maxSearchCallsPerTurn === 'number') effectiveAgentConfig.retrieval.maxSearchCallsPerTurn = configuredRetrieval.maxSearchCallsPerTurn;
      if (typeof configuredRetrieval?.skipDuringDiscovery === 'boolean') effectiveAgentConfig.retrieval.skipDuringDiscovery = configuredRetrieval.skipDuringDiscovery;
    }
    effectiveAgentConfig.tenant = {
      ...effectiveAgentConfig.tenant,
      projectId: tenantId,
      name: config.companyName || tenantId,
      companyName: config.companyName,
      formerNames: config.formerNames,
      configVersion: config.configVersion,
      source: config.configSource || 'fallback',
      loadedAt: new Date().toISOString(),
    };
    effectiveAgentConfig.ai = {
      ...effectiveAgentConfig.ai,
      provider: config.provider || effectiveAgentConfig.ai.provider,
      model: config.model || effectiveAgentConfig.ai.model,
      intentModel: config.intentModel || effectiveAgentConfig.ai.intentModel,
      temperature: typeof config.temperature === 'number' ? config.temperature : effectiveAgentConfig.ai.temperature,
      maxTokens: config.maxTokens,
      baseUrl: config.baseUrl,
    };
    effectiveAgentConfig.persona = {
      ...effectiveAgentConfig.persona,
      systemName: config.systemName || effectiveAgentConfig.persona.systemName,
      systemPromptOverrides: config.systemPromptOverrides,
      journeyGuidance: config.journeyGuidance,
      greetingMessage: config.greetingMessage,
      journeyGraph: config.journeyGraph,
    };
    effectiveAgentConfig.scope = {
      ...effectiveAgentConfig.scope,
      rooms: config.scope?.rooms,
      categories: config.scope?.categories,
      business: config.business,
    };
    effectiveAgentConfig.capabilities = { enabled: config.capabilities || [] };
    effectiveAgentConfig.commerce = {
      ...effectiveAgentConfig.commerce,
      mode: config.commerceMode === 'cart' ? 'cart' : config.commerceMode === 'quote' ? 'quote' : 'disabled',
      pricing: config.pricing,
      purchaseLimits: config.purchaseLimits,
      storageGuide: config.storageGuide,
      handoffs: config.handoffs,
      configuratorType: config.configuratorType,
      sizeScale: config.sizeScale,
      canQuotePrices: config.pricingConfigured === true && config.commerceMode !== 'cart',
      canPlaceOrders: false,
      fulfilment: config.fulfilment,
    };
    effectiveAgentConfig.presentation = {
      ...effectiveAgentConfig.presentation,
      labels: config.labels,
      quoteIntro: config.quoteIntro,
      complianceBadge: config.complianceBadge,
      uiTheme: config.uiTheme,
      cardTemplates: config.cardTemplates,
    };
    effectiveAgentConfig.components = config.components;
    effectiveAgentConfig.multiTradeBundles = config.multiTradeBundles;
    effectiveAgentConfig.integrations = {
      ...effectiveAgentConfig.integrations,
      ...(config.integrations || {}),
      stripe: config.stripe,
    };
    effectiveAgentConfig.rules.constraints = {
      ...(effectiveAgentConfig.rules.constraints || {}),
      canQuotePrices: effectiveAgentConfig.commerce.canQuotePrices,
      canPlaceOrders: effectiveAgentConfig.commerce.canPlaceOrders,
    };
    const normalizedBehavior = mergeGenericBusinessConfig(config.agentBehavior);
    effectiveAgentConfig.behavior = {
      ...normalizedBehavior,
      vocabulary: {
        concepts: config.agentBehavior?.vocabulary?.concepts,
        synonyms: config.agentBehavior?.vocabulary?.synonyms,
        jargon: config.agentBehavior?.vocabulary?.jargon,
        glossary: config.agentBehavior?.vocabulary?.glossary,
      },
    };
    effectiveAgentConfig.runtimeContext = {
      ...(config.systemPromptOverrides ? { persona: config.systemPromptOverrides } : {}),
      ...(config.journeyGuidance ? { journeyGuidance: config.journeyGuidance } : {}),
      ...(config.scope?.rooms?.length || config.scope?.categories?.length
        ? { businessScope: [
            ...(config.scope.rooms?.length ? [`Served spaces: ${config.scope.rooms.join(', ')}`] : []),
            ...(config.scope.categories?.length ? [`Served categories: ${config.scope.categories.join(', ')}`] : []),
          ].join('. ') }
        : {}),
      genericBusinessBehavior: renderGenericBusinessConfig(genericBehavior),
    };
    const configuredSkills = Array.isArray(config.agentBehavior?.skills)
      ? config.agentBehavior.skills.filter((skill: any) => skill?.enabled && typeof skill.id === 'string')
      : [];
    if (configuredSkills.length) {
      effectiveAgentConfig.skills = configuredSkills.map((skill: any) => ({
        id: skill.id,
        enabled: true,
        source: skill.source,
        version: skill.version,
        name: skill.name || skill.id,
        description: skill.description || `Configured ${skill.source || 'platform'} skill: ${skill.id}`,
      }));
    }
    if (config.contextDimensions?.length) {
      const configured = config.contextDimensions.map((dimension) => ({
        id: dimension.key,
        name: dimension.label || dimension.key,
        description: dimension.description || `Context used to understand the customer's request (${dimension.key}).`,
        values: dimension.values || [],
        scoping: dimension.scoping,
        filtersRetrieval: dimension.filtersRetrieval,
        askWhenMissing: dimension.askWhenMissing,
        clarificationQuestion: dimension.question,
        hardFilter: dimension.hardFilter,
        aliases: dimension.aliases,
        derive: dimension.derive,
      }));
      const keys = new Set(configured.map((dimension) => dimension.id));
      effectiveAgentConfig.scope.dimensions.main = [
        ...effectiveAgentConfig.scope.dimensions.main.filter((dimension) => !keys.has(dimension.id)),
        ...configured,
      ];
    }
    config.agentConfig = effectiveAgentConfig;
    return config;
  }

  /**
   * Resolve the project's context dimensions. If the project configures them
   * explicitly, use those. Otherwise synthesise a scoping "space" dimension from
   * scope.rooms so existing room-based projects keep working unchanged.
   */
  private resolveDimensions(p: any): ContextDimension[] | undefined {
    if (Array.isArray(p?.contextDimensions) && p.contextDimensions.length) {
      return p.contextDimensions
        .filter((d: any) => d && typeof d.key === 'string')
        .map((d: any) => ({
          key: d.key,
          label: d.label,
          values: Array.isArray(d.values) ? d.values : undefined,
          description: d.description,
          scoping: d.scoping !== false,          // default: dimensions with values gate scope
          filtersRetrieval: d.filtersRetrieval !== false, // default: used as a retrieval hint
          askWhenMissing: d.askWhenMissing === true,
          question: typeof d.question === 'string' ? d.question : undefined,
          hardFilter: d.hardFilter === true,
          aliases: d.aliases && typeof d.aliases === 'object' ? d.aliases : undefined,
          derive: d.derive && typeof d.derive.from === 'string' && d.derive.map && typeof d.derive.map === 'object' ? { from: d.derive.from, map: d.derive.map } : undefined,
        }));
    }
    const rooms = Array.isArray(p?.scope?.rooms) ? p.scope.rooms.filter(Boolean) : [];
    if (rooms.length) {
      return [{ key: 'space', label: 'Space', values: rooms, scoping: true, filtersRetrieval: true }];
    }
    return undefined;
  }

  /** Render per-project persona + journey guidance as a context block. */
  /* ── Brand hub (AUG-14) ──────────────────────────────────────────────
   * A per-project orientation brief injected into every conversation. Cached
   * because it changes only when ingestion re-runs, and it would otherwise cost
   * a service round-trip on every single turn. */
  private hubCache = new Map<string, { at: number; hub: any }>();
  private static readonly HUB_TTL_MS = 5 * 60 * 1000;

  async loadBrandHub(tenantId: string): Promise<any | null> {
    const hit = this.hubCache.get(tenantId);
    if (hit && Date.now() - hit.at < ConfigLoader.HUB_TTL_MS) return hit.hub;
    try {
      // Through the BUSINESS PORT, not a service URL — the agent asks "what
      // business am I serving?" and the integration layer decides how to answer.
      // Swap the tenant's business adapter and this code is unchanged.
      const business = await adapterRegistry.getBusiness(tenantId);
      const profile = await business.getProfile({ tenantId });
      this.hubCache.set(tenantId, { at: Date.now(), hub: profile });
      return profile;
    } catch {
      // Orientation is an enhancement — never block a conversation on it.
      this.hubCache.set(tenantId, { at: Date.now(), hub: null });
      return null;
    }
  }

  /**
   * Speak the business's CURRENT name, whatever the crawl found.
   *
   * The brand hub is derived from the customer's own site, so it preserves
   * whatever that site said when it was ingested — including a company name
   * from before a rebrand. Editing the stored document would not hold: the next
   * ingest re-derives it and the old name returns. So the substitution happens
   * where the text is rendered, from configuration the tenant owns
   * (`formerNames`), and it therefore survives re-ingestion.
   *
   * Longest first, so "Augusta Sportswear" is replaced before a bare "Augusta"
   * can turn it into "Momentec Brands Sportswear".
   */
  private useCurrentName(text: string, config?: any): string {
    const current = config?.companyName;
    const former: string[] = Array.isArray(config?.formerNames) ? config.formerNames : [];
    if (!current || !former.length || !text) return text;
    return [...former]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .reduce((out, name) =>
        out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), current), text);
  }

  /** Render the hub as a system block. Computed facts are presented as reliable;
   *  the narrative and topic list are explicitly marked as orientation only, so
   *  the model still retrieves before asserting specifics to a customer. */
  renderBrandHubBlock(profile: any, capabilities?: string[], config?: any): string {
    if (!profile) return '';
    const { identity = {}, model = {}, audience = [], entityModel, vocabulary = {}, operating = {} } = profile;
    const lines: string[] = [];

    if (identity.name) lines.push(`Business: ${identity.name}.`);
    if (model.type || model.sellsTo) {
      lines.push(`Model: ${[model.type, model.sellsTo && `sells to ${model.sellsTo}`].filter(Boolean).join(', ')}.`);
    }
    if (operating.catalogueSize) lines.push(`Catalogue size: ${operating.catalogueSize} products.`);
    if (identity.brands?.length) {
      lines.push(`Brands sold: ${identity.brands.map((b: any) => `${b.name} (${b.productCount ?? b.products})`).join(', ')}.`);
    }
    if (operating.priceBand?.median) {
      const p = operating.priceBand;
      lines.push(`Typical price band: ${p.currency || ''} ${p.low}–${p.high}, median ${p.median}.`);
    }
    if (audience.length) {
      lines.push(`Typical buyers: ${audience.map((a: any) => `${a.role}${a.buysFor ? ` (buying for ${a.buysFor})` : ''}`).join(', ')}.`);
    }
    if (vocabulary.primaryDimension && vocabulary.primaryValues?.length) {
      lines.push(`Catalogue is organised by ${vocabulary.primaryDimension}: ` +
        `${vocabulary.primaryValues.slice(0, 14).map((v: any) => `${v.value}${v.productCount ? ` (${v.productCount})` : ''}`).join(', ')}.`);
    }

    // The entity the customer buys FOR is the thing the agent must pin down
    // before recommending — stated in this business's own vocabulary.
    const entityBlock = entityModel
      ? `\nEvery order is for a ${entityModel.label}. ` +
        `${entityModel.askPrompt || `Identify which ${entityModel.label} before recommending anything.`}` +
        (entityModel.confirmWithCustomer?.length
          ? ` Always CONFIRM these with the customer rather than asserting them: ${entityModel.confirmWithCustomer.join(', ')}.`
          : '')
      : '';

    const topics = (operating.knownTopics || []).slice(0, 40);

    /* Customised goods need to be SEEN, not described. A business that decorates
     * per order gets an explicit instruction to render the design rather than
     * narrate it — gated on the tenant actually customising AND having the
     * configurator enabled, so it never fires for a catalogue-only business. */
    const canRender = model.customised && (!capabilities?.length || capabilities.includes('configurator'));
    const renderRule = canRender
      ? '\nThis business customises goods per order, so a design must be SHOWN. The moment the '
        + 'customer names a style, colour, name or number, call showConfigurator with what they said — '
        + 'it renders the real garment from every angle. Writing "let me show you" or describing the '
        + 'design in words leaves the customer looking at nothing: call the tool in the SAME turn, and '
        + 'call it again on every change so the preview keeps up with the conversation.'
      : '';

    const block = [
      '[BUSINESS CONTEXT — orientation only, derived from this business\'s own configuration and catalogue.',
      'The catalogue figures below are computed and reliable. Everything else is background:',
      'NEVER quote a policy, lead time, price or availability from this block — retrieve it first.]',
      lines.join('\n'),
      entityBlock,
      renderRule,
      identity.summary ? `\nAbout the business:\n${identity.summary}` : '',
      topics.length
        ? `\nHelp topics that exist (retrieve before answering on any of them):\n${topics.join(' · ')}`
        : '',
    ].filter(Boolean).join('\n');
    // Everything above is derived text; normalise it to the current name before
    // the agent ever reads it.
    return this.useCurrentName(block, config);
  }

  renderConfigBlock(cfg: LoadedProjectConfig): string {
    const parts: string[] = [];
    const rooms = cfg.scope?.rooms?.filter(Boolean) ?? [];
    if (rooms.length) {
      parts.push(
        `[BUSINESS SCOPE — configured in the back office. This business serves these spaces: ` +
        `${rooms.join(', ')}. Stay within them: help across ANY of these spaces, but if the ` +
        `customer asks about a space this business does NOT serve, say so honestly and offer the ` +
        `spaces you do cover — do not invent products outside scope]`,
      );
    }
    if (cfg.systemPromptOverrides?.trim()) {
      parts.push(`[PROJECT PERSONA — configured in the back office]\n${cfg.systemPromptOverrides.trim()}`);
    }
    if (cfg.journeyGuidance?.trim()) {
      parts.push(
        `[JOURNEY GUIDANCE — configured in the back office. These are GOALS to shape a complete, ` +
        `helpful journey, NOT a fixed script. Use your judgement each turn to decide the next best ` +
        `step toward them]\n${cfg.journeyGuidance.trim()}`,
      );
    }
    return parts.join('\n\n');
  }

  async loadActiveRules(tenantId: string): Promise<ActiveRulesLoadResult> {
    try {
      const res = await fetch(
        `${this.projectServiceUrl}/api/v1/projects/${encodeURIComponent(tenantId)}/rules/active`,
        { headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } },
      );
      if (!res.ok) return { ok: false, rules: [] };
      const rules = await res.json();
      return { ok: true, rules: Array.isArray(rules) ? rules : [] };
    } catch (err) {
      console.warn('[ConfigLoader] could not load rules, proceeding without:', (err as Error).message);
      return { ok: false, rules: [] };
    }
  }

}
