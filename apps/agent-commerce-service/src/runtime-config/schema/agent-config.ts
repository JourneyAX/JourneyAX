/** Effective configuration consumed by the commerce agent.
 *
 * This is shaped around the published Backoffice project configuration. It
 * contains no code-owned products, relationships, executable tools, pack
 * metadata, or pack-specific evaluation data. The journey and stage fields
 * are tenant-neutral execution defaults, not tenant pack definitions.
 */

export interface AgentTenantConfig { projectId: string; name?: string; companyName?: string; formerNames?: string[]; configVersion?: number; source: 'backoffice' | 'platform-default' | 'fallback'; loadedAt?: string; }
export interface AgentAiConfig { provider?: string; model?: string; intentModel?: string; temperature?: number; maxTokens?: number; baseUrl?: string; }
export interface AgentPersonaConfig { systemName?: string; systemPromptOverrides?: string; journeyGuidance?: string; greetingMessage?: string; journeyGraph?: { nodes: any[]; edges: any[] }; }

export interface AgentContextDimensionValue { id: string; name: string; synonyms?: string[]; }
export interface AgentContextDimension { id: string; name: string; description: string; values: Array<AgentContextDimensionValue | string>; required?: boolean; multiSelect?: boolean; clarificationQuestion?: string; scoping?: boolean; filtersRetrieval?: boolean; askWhenMissing?: boolean; hardFilter?: boolean; aliases?: Record<string, string[]>; derive?: { from: string; map: Record<string, string> }; }
export interface AgentContextDimensions { main: AgentContextDimension[]; }
export interface AgentScopeConfig { rooms?: string[]; categories?: string[]; business?: any; dimensions: AgentContextDimensions; }

export interface AgentBehaviorConfig {
  /** Temporary generic persona fallback; Backoffice values override it when available. */
  personaBehavior: { tone: string; expertise: string; supportiveMessage: string };
  /** Temporary generic conversation experience; Backoffice values override it when available. */
  conversationExperience: { reclassifyGoalEachTurn: boolean; preserveLatestCustomerGoal: boolean; clarifyOnlyMissingContext: boolean; avoidRepeatingCompletedQuestions: boolean };
  /** Prompt: defines how generic and unknown tenant terminology is handled. */
  terminology: { genericConceptDefinitions: boolean; explainUnknownTerms: boolean; neverInferTenantTerms: boolean };
  /** Prompt/runtime: tenant vocabulary used to explain terms and interpret requests. */
  vocabulary: { concepts?: Record<string, string>; synonyms?: Record<string, string[]>; jargon?: Record<string, string>; glossary?: Record<string, string> };
  /** Prompt/runtime: controls goal reclassification and configured intent ordering. */
  conversationPolicy: { reclassifyGoalEachTurn: boolean; preserveLatestCustomerGoal: boolean; intentPrecedence: string[] };
  /** Prompt/runtime: controls verified recommendations and relationship claims. */
  recommendationPolicy: { requireVerifiedMatch: boolean; explainWhyItMatches: boolean; distinguishAlternativesFromComplements: boolean; neverInventRelationships: boolean };
  /** Prompt/runtime: controls source grounding, missing coverage, and handoff behavior. */
  supportPolicy: { answerFromConfiguredSources: boolean; discloseMissingCoverage: boolean; handoffWhenActionUnavailable: boolean };
  /** Prompt/runtime: controls query focus, search limits, and discovery suppression. */
  retrievalPolicy: { focusedQueries: boolean; queryWordRange?: { min: number; max: number }; maxSearchCallsPerTurn: number; skipDuringDiscovery: boolean };
  /** Prompt/runtime: controls preservation of identifiers, prices, and presentation surfaces. */
  presentationPolicy: { preserveRetrievedValues: boolean; doNotInventIdentifiers: boolean; doNotInventPrices: boolean; useConfiguredPresentationSurface: boolean };
  /** Reserved for a future Backoffice research policy; disabled in the generic fallback. */
  organizationResearch: { enabled: boolean; confirmDetailsBeforeUsing: boolean };
}

export interface AgentCapabilityConfig { enabled: string[]; }
export interface AgentSkillConfig { id: string; enabled: boolean; source?: 'platform' | 'tenant'; version?: string; name?: string; description?: string; }
export interface AgentCommerceConfig { mode: 'cart' | 'quote' | 'disabled'; pricing?: { currency: string; symbol: string; taxRate: number; discountRate: number }; canQuotePrices: boolean; canPlaceOrders: boolean; fulfilment?: any; handoffs?: any[]; purchaseLimits?: any[]; storageGuide?: any[]; demoCustomers?: any; configuratorType?: string; sizeScale?: string[]; }
export interface AgentIntegrationConfig { stripe?: { secretKey?: string; enabled: boolean }; whatsapp?: any; shopify?: any; commercetools?: any; woocommerce?: any; platforms?: { knowledge?: string; commerce?: string }; }

export interface AgentPresentationConfig {
  labels?: { items?: string; itemsSingular?: string; headerTitle?: string };
  quoteIntro?: string;
  complianceBadge?: string;
  uiTheme?: any;
  cardTemplates?: Record<string, any>;
  productPresentation: { enabled: boolean; useStructuredCards: boolean; requireVerifiedInformation: boolean; avoidRepeatingVisibleDetails: boolean; requireIdentifier: boolean; requirePrice: boolean; preserveRetrievedValues: boolean; useConfiguredPresentationSurface: boolean };
}

export interface AgentRetrievalConfig {
  enabled: boolean; strategy: string; collectionName: string; topK: number; minScore: number; systemPrompt: string; types: string[];
  defaultPolicy?: { allow?: boolean; allowedTypes?: string[]; guidance?: string };
  intentPolicies?: Record<string, { allow?: boolean; allowedTypes?: string[]; guidance?: string }>;
  queryWordRange?: { min: number; max: number }; maxSearchCallsPerTurn: number; skipDuringDiscovery: boolean;
}
export interface AgentRulesConfig { business: Array<{ id?: string; name?: string; scope?: string; condition?: string; action?: string; description?: string }>; constraints: { canQuotePrices?: boolean; canPlaceOrders?: boolean; restrictedTerms?: string[]; [key: string]: unknown }; communication?: Record<string, unknown>; }
export interface AgentJourneyConfig { default: { id: string; name: string; description: string; startStage?: string; stageSequence?: string[]; dimensionsToCollect: string[]; steps: Array<Record<string, any>> }; }
export interface AgentStageConfig { main: Array<{ id: string; name: string; sequence?: number; description: string; systemPromptOverlay: string; availableTools?: string[]; nextStage?: string; canShowItems?: boolean; canQuote?: boolean }>; }
export interface AgentIntentConfig { main: Array<{ id: string; name: string; description: string; examples?: string[]; priority?: number }>; unknown?: { name: string }; }

export interface EffectiveAgentConfig {
  /** Published tenant identity. Prompt: identifies the business; runtime: scopes every tenant operation. */
  tenant: AgentTenantConfig;
  /** Published AI settings. Runtime: selects the provider, model, endpoint, and generation limits. Secrets are never prompt content. */
  ai: AgentAiConfig;
  /** Published persona and journey copy. Prompt: supplies the assistant role and tenant journey guidance. */
  persona: AgentPersonaConfig;
  /** Published business scope and context dimensions. Prompt: explains scope; runtime: validates and filters extracted context. */
  scope: AgentScopeConfig;
  /** Published agent behavior policies. Prompt: supplies guidance; runtime: supplies policy inputs for enforcement. */
  behavior: AgentBehaviorConfig;
  /** Enabled Backoffice capability IDs. Runtime: controls the tenant capability/tool policy. */
  capabilities: AgentCapabilityConfig;
  /** Enabled Backoffice skills and their source/version metadata. Prompt: lists enabled skills; runtime: loads their bodies. */
  skills: AgentSkillConfig[];
  /** Commerce settings from Backoffice. Runtime: controls cart/quote, pricing, fulfilment, limits, and configurator behavior. */
  commerce: AgentCommerceConfig;
  /** Integration selection and credentials. Runtime-only; secrets and tokens must never enter prompts or traces. */
  integrations: AgentIntegrationConfig;
  /** Presentation settings from Backoffice. Runtime: card rendering and value validation; only selected policy is prompt-facing. */
  presentation: AgentPresentationConfig;
  /** Retrieval settings. Prompt: query/discovery guidance; runtime: search type, scope, and call-limit policy. */
  retrieval: AgentRetrievalConfig;
  /** Tenant-neutral intent definitions used by the classifier. Prompt: describes allowed customer needs. */
  intents: AgentIntentConfig;
  /** Tenant-neutral journey defaults. Prompt: provides the general journey context when Backoffice has no equivalent field. */
  journeys: AgentJourneyConfig;
  /** Tenant-neutral stage defaults. Prompt/runtime: supplies stage names and overlays used by the existing journey loop. */
  stages: AgentStageConfig;
  /** Runtime business constraints and active rules. Prompt: communicates applicable constraints; runtime: protects commerce decisions. */
  rules: AgentRulesConfig;
  /** Runtime-only blocks assembled from the published project and active rules. Prompt: injects scoped tenant guidance. */
  runtimeContext?: { persona?: string; journeyGuidance?: string; businessScope?: string; activeRules?: Array<{ name: string; scope: string; condition: string; action: string }>; brandHub?: string; skills?: string; genericBusinessBehavior?: string };

  /** Backoffice `console` navigation. Not used by the agent; owned by the admin console. */
  console?: unknown;
  /** Backoffice notification preferences. Not used by the agent; owned by operations/admin tooling. */
  notifications?: Record<string, boolean>;
  /** Backoffice embed/widget settings. Not used by the agent; owned by the storefront loader. */
  embed?: unknown;
  /** Backoffice channel switches. Not used by the agent; owned by channel adapters. */
  channels?: Record<string, boolean>;
  /** Backoffice knowledge ingestion sources. Not used as agent instructions; owned by ingestion services. */
  knowledgeSource?: unknown;
  /** Backoffice theme configuration. Not used for reasoning; owned by storefront presentation. */
  theme?: unknown;
  /** Backoffice dynamic component configuration. Not used by agent reasoning; owned by UI rendering. */
  components?: unknown;
  /** Backoffice bundle templates. Not used by the current agent loop; owned by commerce/presentation services. */
  multiTradeBundles?: unknown;
  /** Backoffice acceptance scenarios. Test/analytics data only; not agent instructions. */
  scenarios?: unknown;
  /** Backoffice intro copy. Storefront-facing and not used by the agent prompt. */
  intro?: unknown;
}
