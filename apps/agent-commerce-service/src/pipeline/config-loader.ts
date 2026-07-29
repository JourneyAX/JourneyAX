import { adapterRegistry } from '@journeyax/integration';
/**
 * Step 0 — Config Loader (config over code).
 *
 * Loads the tenant's ACTIVE business rules from the back office (project-service)
 * and renders them as a system block the agent must honour. This is what makes
 * the agent config-driven: an admin edits a rule in the back office and the next
 * conversation reflects it — no code change, no deploy.
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

/** The slice of published project config the agent runtime consumes per turn. */
export interface LoadedProjectConfig {
  provider?: string;              // ai.provider — openai | anthropic | gemini | ollama
  model?: string;                 // ai.model — per-project reasoning model
  temperature?: number;           // ai.temperature
  apiKey?: string;                // ai.apiKey — per-project LLM key (un-redacted via internal-key fetch)
  baseUrl?: string;               // ai.baseUrl — optional endpoint override
  companyName?: string;           // the business's CURRENT trading name
  formerNames?: string[];         // prior names, rewritten to companyName in derived text
  systemName?: string;            // persona.systemName
  systemPromptOverrides?: string; // persona.systemPromptOverrides
  journeyGuidance?: string;       // persona.journeyGuidance (goals, not stages)
  capabilities?: string[];        // enabled agent capabilities (runtime toolset)
  pricing?: { currency: string; symbol: string; taxRate: number; discountRate: number }; // project.pricing (authoritative money rules)
  stripe?: { secretKey?: string; enabled: boolean };  // integrations.stripe (per-project payment key)
  scope?: ProjectScopeSlice;      // scope.rooms/categories — which spaces this business serves
  contextDimensions?: ContextDimension[]; // project-configured dims the agent extracts + scopes by
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
}

export class ConfigLoader {
  constructor(
    private readonly projectServiceUrl = process.env.PROJECT_SERVICE_URL_HTTP ||
      process.env.PROJECT_SERVICE_URL ||
      'http://localhost:8082',
  ) {}

  /**
   * Load the tenant's published config (model + persona + journey guidance).
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
      if (!res.ok) return {};
      const p: any = await res.json();
      return {
        provider: p?.ai?.provider,
        model: p?.ai?.model,
        temperature: p?.ai?.temperature,
        apiKey: p?.ai?.apiKey,
        baseUrl: p?.ai?.baseUrl,
        companyName: p?.companyName || p?.name,
        formerNames: Array.isArray(p?.formerNames) ? p.formerNames : undefined,
        systemName: p?.persona?.systemName,
        systemPromptOverrides: p?.persona?.systemPromptOverrides,
        journeyGuidance: p?.persona?.journeyGuidance,
        capabilities: Array.isArray(p?.capabilities) ? p.capabilities : undefined,
        scope: {
          rooms: Array.isArray(p?.scope?.rooms) ? p.scope.rooms : undefined,
          categories: Array.isArray(p?.scope?.categories) ? p.scope.categories : undefined,
        },
        contextDimensions: this.resolveDimensions(p),
        configVersion: typeof p?.activeVersion === 'number' ? p.activeVersion : undefined,
        // 'garment' (Three.js over a per-SKU mesh) vs 'candy' (a client-side
        // composited disc). The agent must NOT try to server-render a candy —
        // there is no mesh to render, so the garment validate would report the
        // design "not displayable" and the agent would apologise over a panel
        // that opened fine.
        configuratorType: p?.configurator?.productType || undefined,
        sizeScale: Array.isArray(p?.configurator?.sizeScale) ? p.configurator.sizeScale : undefined,
        pricing: {
          currency: p?.pricing?.currency || 'AUD',
          symbol: p?.pricing?.symbol || '$',
          taxRate: typeof p?.pricing?.taxRate === 'number' ? p.pricing.taxRate : 0,
          discountRate: typeof p?.pricing?.discountRate === 'number' ? p.pricing.discountRate : 0,
        },
        stripe: {
          // Per-project Stripe key (integrations.stripe.secretKey), un-redacted via
          // the internal-key fetch. Falls back to platform env in the order service.
          secretKey: p?.integrations?.stripe?.secretKey,
          enabled: !!p?.integrations?.stripe?.enabled,
        },
      };
    } catch (err) {
      console.warn('[ConfigLoader] could not load project config, using defaults:', (err as Error).message);
      return {};
    }
  }

  /**
   * Resolve the project's context dimensions. If the project configures them
   * explicitly, use those. Otherwise synthesise a scoping "space" dimension from
   * scope.rooms so existing room-based projects (Caroma) keep working unchanged.
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

  async loadActiveRules(tenantId: string): Promise<LoadedRule[]> {
    try {
      const res = await fetch(
        `${this.projectServiceUrl}/api/v1/projects/${encodeURIComponent(tenantId)}/rules/active`,
        { headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } },
      );
      if (!res.ok) return [];
      const rules = await res.json();
      return Array.isArray(rules) ? rules : [];
    } catch (err) {
      console.warn('[ConfigLoader] could not load rules, proceeding without:', (err as Error).message);
      return [];
    }
  }

  /** Render active rules as a prompt block the agent must obey. */
  renderRulesBlock(rules: LoadedRule[]): string {
    if (!rules.length) return '';
    const lines = rules
      .map((r, i) => `${i + 1}. [${r.scope}] When ${r.condition} → ${r.action}`)
      .join('\n');
    return `[BUSINESS RULES — configured in the back office. You MUST honour these]\n${lines}`;
  }
}
