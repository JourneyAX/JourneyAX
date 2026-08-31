/**
 * Project Service — Domain Types
 *
 * Data Isolation Model:
 *
 *   Organization  →  just a billing/naming container
 *   Project       →  THE isolation unit. All data is scoped by projectId.
 *
 * Every MongoDB collection in the platform has projectId as the
 * mandatory isolation key. There is no "tenantId" at the data layer.
 *
 * Collections and their projectId filter:
 *   documents       { projectId }  ← product knowledge chunks
 *   quotes          { projectId }  ← customer BOMs and quotes
 *   users           { projectId }  ← auth users
 *   project_members { projectId }  ← member roles
 *   tenant_configs  { projectId }  ← this service's collection
 */

export type ProjectStatus = 'active' | 'draft' | 'archived';

/** The storefront's closing surface. 'quote' = B2B project quote (BOM, finishes,
 *  approve & pay); 'cart' = B2C retail (bag, sizes, checkout). Declared per brand. */
export type CommerceMode = 'quote' | 'cart';
export type MemberRole    = 'owner' | 'admin' | 'manager' | 'analyst' | 'viewer';

// ── Project Configuration ──────────────────────────────────────

export interface ProjectScope {
  rooms: string[];             // ["Bathroom", "Ensuite", "Powder Room"]
  finishes: string[];          // ["Chrome", "Matte Black", "Brushed Brass"]
  categories: string[];        // ["basin", "toilet", "tapware"]
  complianceTags?: string[];   // ["WELS", "WaterMark", "AS1428"]
  excludedSkus?: string[];     // blocked product SKUs
}

/**
 * A project-configured CONTEXT DIMENSION the agent extracts from the conversation
 * and (optionally) uses to scope retrieval — the generic replacement for the fixed
 * bathroom "space/rooms" classifier. Each business defines its own:
 *   Caroma:   { key:"space", values:["Bathroom","Kitchen","Laundry"] }, { key:"projectType", values:["renovation","new-build","replacement"] }
 *   Fashion:  { key:"occasion", values:["work","party","casual"] }, { key:"fit", values:["slim","regular","relaxed"] }
 *   Workwear: { key:"industry", ... }, { key:"role", ... }, { key:"climate", ... }
 */
export interface ContextDimension {
  key: string;                 // machine key, e.g. "space", "occasion", "industry"
  label?: string;              // human label for the back office
  values?: string[];           // allowed values (omit for an open/free-text dimension)
  description?: string;        // hint for the extractor
  /** If true, a request whose value falls outside `values` is out-of-scope for this business. */
  scoping?: boolean;
  /** If true, the extracted value is used as a retrieval metadata filter/hint. */
  filtersRetrieval?: boolean;
}

export interface ProjectPricing {
  currency: string;            // "AUD"
  symbol: string;              // "$"
  taxRate: number;             // 0.10
  discountRate: number;        // 0.12
  monthlyCap?: number;         // optional spend cap in cents
}

export interface ProjectPersona {
  systemName: string;          // "Caroma Stylist"
  systemPromptOverrides: string;
  greetingMessage?: string;
  escalationEmail?: string;
  // Journey guidance: approved GOAL/OUTCOME statements the agent reasons over to
  // shape the flow (NOT a fixed stage sequence — see docs §6.3). Configured in the
  // back office; injected into agent context each turn. Empty = base behaviour.
  journeyGuidance?: string;
  /**
   * Raw editable Journey Builder canvas graph (node positions, types, data) —
   * persisted SEPARATELY from the compiled `journeyGuidance` prose so re-opening
   * the canvas doesn't require parsing text back into nodes. The compiler in
   * JourneyBuilder.tsx walks this graph to (re)generate `journeyGuidance` on
   * save; the agent runtime only ever reads `journeyGuidance`, never this field.
   */
  journeyGraph?: { nodes: any[]; edges: any[] };
}

export interface ProjectTheme {
  primaryColor: string;        // "#FFD600"
  accentColor: string;         // "#0A0A0A"
  fontFamily: string;          // "Space Grotesk, sans-serif"
  logoUrl?: string;
  visualizerEnabled: boolean;
}

export interface ProjectAiConfig {
  provider: string;            // "openai" | "anthropic" | "gemini" | "ollama"
  model: string;               // "gpt-4o" | "claude-sonnet-5" | "gemini-2.5-pro" | "llama3.3:70b"
  temperature: number;         // 0.0 – 1.0
  embeddingModel?: string;     // "text-embedding-3-small" | "voyage-3-large"
  /** Model used for bulk INGESTION work (product narratives, catalogue
   *  extraction). Separate from the conversational `model` so heavy offline jobs
   *  can run on a cheaper/faster model without touching the live agent. */
  ingestModel?: string;
  /** Model for RELATIONSHIP extraction (collections, outfitting sets, adult/
   *  youth/ladies sizing groups). Harder reasoning over messy catalogue layout
   *  than narrative writing, so it may point at a stronger model than
   *  `ingestModel`. Falls back to `ingestModel` when unset. */
  extractModel?: string;
  apiKey?: string;            // per-project LLM key (SECRET — redacted on read; falls back to platform env)
  baseUrl?: string;            // optional endpoint override (self-hosted / proxy / Azure-style)
}

// ── Per-project channels & connectors ────────────────────────────────
// All credentials are tenant-scoped and configured via the back office —
// NEVER via shared env. The webhook/agents resolve config per project.
export interface WhatsAppConfig {
  enabled: boolean;
  phoneNumberId?: string;      // routes inbound → this project
  accessToken?: string;        // used to send replies for this project
  verifyToken?: string;        // webhook handshake for this project
  wabaId?: string;
}
export interface ShopifyConfig {
  enabled: boolean;
  shopDomain?: string;         // "my-store.myshopify.com"
  accessToken?: string;
}
export interface CommerceToolsConfig {
  enabled: boolean;
  projectKey?: string;
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;
  authUrl?: string;
  searchLocale?: string;   // e.g. "en-AU" — locale for product text search + names
}
export interface WooCommerceConfig {
  enabled: boolean;
  storeUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
}
export interface StripeConfig {
  enabled: boolean;
  secretKey?: string;          // sk_… — SECRET (redacted on read); falls back to platform STRIPE_SECRET_KEY
  publishableKey?: string;     // pk_… — safe to expose
}
export interface ProjectIntegrations {
  whatsapp?: WhatsAppConfig;
  shopify?: ShopifyConfig;
  commercetools?: CommerceToolsConfig;
  woocommerce?: WooCommerceConfig;
  stripe?: StripeConfig;
  /**
   * Which platform backs each agent domain for THIS project — the runtime switch
   * the adapter registry resolves (B3). Unset domain = 'standalone' (internal).
   * e.g. { knowledge: 'commercetools' } → the agent's searchKnowledge hits the
   * tenant's commercetools project instead of the internal product-service.
   */
  platforms?: {
    knowledge?: 'standalone' | 'shopify' | 'commercetools';
    commerce?: 'standalone' | 'shopify' | 'commercetools';
  };
}

export interface ProjectChannels {
  web: boolean;
  mobile: boolean;
  whatsapp: boolean;
  email: boolean;
  voice: boolean;
  kiosk: boolean;
  partner: boolean;
  csr: boolean;
}

export interface ProjectMember {
  email: string;
  fullName: string;
  role: MemberRole;
  isActive: boolean;
  invitedAt: string;
  lastLoginAt?: string;
}

/**
 * BUSINESS LAYER config — what KIND of business this is and who its customers
 * buy for. Read by the BusinessPort so the agent can serve any vertical without
 * vertical logic in code: a teamwear tenant declares an entity of "team", a
 * bathroom tenant "room", a workwear tenant "site crew".
 */
export interface ProjectBusiness {
  /** 'wholesale' | 'retail' | 'd2c' | 'decorator' | 'b2b-trade' | 'services' */
  type?: string;
  /** Plain words: "coaches, athletic directors and dealers". */
  sellsTo?: string;
  orderPattern?: 'single-item' | 'bulk-roster' | 'project-bundle' | 'replenishment';
  /** Goods customised/decorated per order → artwork + approval belong in the journey. */
  customised?: boolean;
  approvalRequired?: boolean;
  regions?: string[];
  summary?: string;
  audience?: { role: string; buysFor?: string; authority?: string; notes?: string }[];
  /** The entity every order is FOR. THE vertical-specific idea, as config. */
  entityModel?: {
    key: string;                 // 'team' | 'room' | 'crew' | 'location'
    label: string;               // what to call it to a customer
    labelPlural?: string;
    askPrompt?: string;          // how to ask for it
    hasDirectory?: boolean;      // is there a directory to search?
    allowCreate?: boolean;       // may a customer name one not on file?
    captureFields?: { key: string; label: string; required?: boolean; hint?: string }[];
    /** Attributes that must be CONFIRMED with the customer, never asserted
     *  (team colours, logos) — the provenance rule expressed as config. */
    confirmWithCustomer?: string[];
  };
  vocabulary?: {
    primaryDimension?: string;   // 'sport' | 'room' | 'trade'
    secondaryDimension?: string; // 'garment type' | 'fixture type'
    audienceDimension?: string;  // 'Adult/Youth/Ladies'
  };
}

export interface ProjectConfig {
  // ── Primary Isolation Key ────────────────────────────────────
  projectId: string;           // "caroma-aus" — THE isolation key

  // ── Parent Reference ──────────────────────────────────────────
  orgId: string;               // parent organization ID

  // ── Identity ─────────────────────────────────────────────────
  name: string;                // "Caroma Australia"
  companyName: string;         // "Caroma Industries Ltd"
  /**
   * Names this business used to trade under.
   *
   * Knowledge is derived from the customer's own site, so it keeps whatever
   * name that site carried when it was crawled — which is the OLD name after a
   * rebrand, and re-crawling only brings it back. Listing the old names here
   * lets every rendered surface say the current one, and it survives the next
   * ingest because it lives in configuration rather than in the crawled data.
   */
  formerNames?: string[];
  slug: string;                // "caroma-australia"
  domain: string;              // "caroma.journeyax.com"
  status: ProjectStatus;

  // ── Config Domains ────────────────────────────────────────────
  scope: ProjectScope;
  /** What kind of business this is (BusinessPort). Optional — absent means the
   *  agent works from catalogue facts alone, with no assumed entity. */
  business?: ProjectBusiness;
  // Per-project context dimensions the agent extracts + scopes retrieval by.
  // Empty/undefined = synthesised from scope.rooms (a "space" dimension) for back-compat.
  contextDimensions?: ContextDimension[];
  pricing: ProjectPricing;
  persona: ProjectPersona;
  theme: ProjectTheme;
  channels: ProjectChannels;
  ai?: ProjectAiConfig;
  integrations?: ProjectIntegrations;
  // Which agent capabilities (tools) are ENABLED for this project — the toolset is
  // assembled at runtime from this, not hardcoded. Empty/undefined = all (back-compat).
  // e.g. ["products","accessories","installGuide","warranty","quote","choice","steps"].
  capabilities?: string[];
  // Customer-facing display labels the storefront applies (so "Products" can read
  // "Services"/"Programs" per business). Optional; sensible defaults if unset.
  labels?: {
    items?: string;          // plural noun for recommended items ("Products", "Services")
    itemsSingular?: string;  // singular ("Product", "Service")
    headerTitle?: string;    // storefront header subtitle ("Bathroom Configurator")
  };
  // Back-office console per-project nav config: which sections show + how they're
  // labelled. Empty = full catalog with default labels. See console-sections.ts.
  console?: {
    labels?: Record<string, string>;  // sectionId → label override
    hidden?: string[];                // sectionIds to hide
    order?: string[];                 // optional custom ordering
  };
  // Where this project's knowledge corpus is ingested from (B4).
  knowledgeSource?: KnowledgeSourceConfig;
  // Per-project notification preferences (B5) — which events alert operators.
  notifications?: Record<string, boolean>;
  // How the AX surface embeds on the customer's e-commerce site (the widget loader).
  embed?: EmbedConfig;
  // Commerce surface for the storefront's closing step. DECLARED per brand — never
  // inferred from other config — so a B2C retailer never inherits the B2B project
  // -quote template (finishes, BOM, "how many bathrooms"). Unset ⇒ 'quote'.
  //   'quote' → B2B project quote (Caroma fixtures, Augusta team kits)
  //   'cart'  → B2C retail bag + checkout (Abercrombie, M&M'S)
  commerceMode?: CommerceMode;

  // ── Metadata ──────────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
  version: number;             // draft mutation counter ($inc on every update)
  // Which published ConfigVersion the runtime consumes (see ConfigVersion below).
  // Unset = never published → runtime falls back to the draft (back-compat).
  activeVersion?: number;
}

// ── Knowledge ingestion source (B4 — per-project, configured in the back office) ──
// Where THIS project's knowledge corpus comes from. The ingest job runner reads
// this; no more Caroma-hardcoded CLI scripts. Docs land tagged with projectId.
/**
 * ONE configured ingestion source. A project declares as many as it needs and
 * the pipeline runs them in order — so onboarding a new tenant is configuration,
 * never code. Nothing about any specific brand lives in the codebase.
 */
export interface KnowledgeSourceItem {
  id: string;                 // stable id, e.g. "us-product"
  type: 'csv-feed' | 'websphere-rest' | 'pdf' | 'kb-articles' | 'html' | 'team-directory';
  enabled?: boolean;          // default true
  label?: string;             // shown in the back office
  url?: string;               // csv / pdf / page url
  /** What this source contributes to the catalogue. */
  role?: 'product' | 'inventory' | 'decoration' | 'sizing' | 'design' | 'articles';
  currency?: string;          // csv price feeds: "USD" | "CAD"
  sublimation?: boolean;      // csv feed carries custom-sublimation products
  docType?: string;           // pdf → knowledge `type` (decoration/installation/design…)
  // websphere-rest
  storeId?: string;
  catalogId?: string;
  // html / kb-articles
  sitemapUrl?: string;
  urlIncludes?: string;
  urlExcludes?: string;
  maxPages?: number;
}

export interface KnowledgeSourceConfig {
  /**
   * Declarative source list — the productised path (config, not scripts).
   * When present, the pipeline runs these; the legacy single-`type` fields below
   * remain for back-compat with earlier projects.
   */
  sources?: KnowledgeSourceItem[];
  /** Legacy single-strategy fields (pre-`sources`). */
  type?: 'html' | 'websphere-rest';
  domain?: string;       // primary site, e.g. "https://www.caroma.com/au"
  seedUrls?: string[];   // explicit start pages to ingest
  sitemapUrl?: string;   // product/page sitemap (XML) to expand
  maxPages?: number;     // safety cap per run (default 50)
  urlIncludes?: string;  // only crawl sitemap URLs containing this (e.g. "ProductDisplay")
  urlExcludes?: string;  // skip sitemap URLs containing this
  // ── WebSphere REST connector (type: 'websphere-rest') ──
  storeId?: string;      // WebSphere store id (e.g. "10251")
  catalogId?: string;    // catalogue id (e.g. "10601")
  categoryIds?: string[]; // optional explicit categories; else auto-enumerated
  currency?: string;     // price currency for the feed (default "USD")
  notes?: string;        // operator notes
}

/**
 * Embed / front-end config — how the agentic-commerce (AX) surface is presented
 * when dropped onto the customer's own e-commerce website via the widget loader.
 */
export interface EmbedConfig {
  launcherLabel?: string;              // "Ask our expert", "Find my book", …
  position?: 'right' | 'left';         // corner the launcher sits in
  launcherColor?: string;              // defaults to theme.primaryColor
  allowedOrigins?: string[];           // sites permitted to embed (["*"] = any)
}

// ── Config versioning (FR-CONFIG-002: draft → publish → rollback) ──────────
// The project doc is the mutable WORKING DRAFT (edited in the back office).
// Publishing snapshots it into an IMMUTABLE ConfigVersion; the runtime consumes
// the active published version, never the draft. Rollback re-points the active
// version at an older snapshot (history is append-only = the audit trail).
export interface ConfigVersion {
  projectId: string;           // isolation key
  version: number;             // monotonically increasing per project
  config: ProjectConfig;       // full immutable snapshot of the draft at publish time
  publishedAt: string;         // ISO timestamp
  publishedBy?: string;        // who published (email/id when auth context available)
  note?: string;               // release note shown in the versions panel
}

// ── DTOs ──────────────────────────────────────────────────────

export interface CreateProjectDto {
  projectId: string;           // must be unique platform-wide
  orgId: string;
  name: string;
  companyName: string;
  slug: string;
  domain: string;
  scope: ProjectScope;
  pricing: ProjectPricing;
  persona: ProjectPersona;
  theme: ProjectTheme;
  channels?: Partial<ProjectChannels>;
  /** Optional: seed ingestion sources at creation (onboarding brand probe). */
  knowledgeSource?: KnowledgeSourceConfig;
}

export interface UpdateProjectDto {
  business?: ProjectBusiness;
  name?: string;
  companyName?: string;
  formerNames?: string[];      // prior trading names, rewritten to companyName on display
  domain?: string;
  status?: ProjectStatus;
  scope?: Partial<ProjectScope>;
  contextDimensions?: ContextDimension[];
  pricing?: Partial<ProjectPricing>;
  persona?: Partial<ProjectPersona>;
  theme?: Partial<ProjectTheme>;
  channels?: Partial<ProjectChannels>;
  ai?: Partial<ProjectAiConfig>;
  integrations?: Partial<ProjectIntegrations>;
  capabilities?: string[];
  labels?: { items?: string; itemsSingular?: string; headerTitle?: string };
  console?: { labels?: Record<string, string>; hidden?: string[]; order?: string[] };
  knowledgeSource?: KnowledgeSourceConfig;
  notifications?: Record<string, boolean>;
  embed?: EmbedConfig;
  /** Per-project 3D product configurator (generic; sportswear kit, etc.). */
  configurator?: ConfiguratorConfig;
  /** Storefront opening-screen copy — starters + input placeholder, per tenant. */
  intro?: IntroConfig;
  /** Commerce surface: 'quote' (B2B project quote) vs 'cart' (B2C retail). */
  commerceMode?: CommerceMode;
}

/**
 * The storefront's opening screen. Each tenant sets its own vertical-true
 * starters and input-placeholder example (a school-led sportswear prompt vs. a
 * fixtures prompt) instead of a hardcoded generic one; when unset the storefront
 * derives label-based defaults.
 */
export interface IntroConfig {
  starters?: { label: string; prompt: string }[];
  inputPlaceholder?: string;
  heroHeadline?: string;
  heroSubtitle?: string;
}

/**
 * Config-driven 3D configurator. A sportswear brand configures a "jersey" with
 * team colours + name/number fields; another vertical could configure a different
 * product. Nothing about the product is hardcoded in the storefront.
 */
export interface ConfiguratorConfig {
  enabled?: boolean;
  productType?: string;                       // 'jersey' | 'tee' | …
  title?: string;                             // "Design your kit in 3D"
  colors?: { name: string; hex: string }[];   // selectable base colours
  accentColors?: { name: string; hex: string }[];
  fields?: { key: string; label: string; max?: number }[]; // name/number text on the garment
  /** Imaging platform that turns a design into real garment images (AUG-21). */
  renderer?: RendererConfig;
}

/**
 * How this tenant's imaging platform renders a design.
 *
 * Modelled as config because every vendor names things differently: the camera
 * vocabulary, the template colour/text slots and the two id namespaces are all
 * Momentec/Scene7 specifics that must not leak into code.
 */
export interface RendererConfig {
  /** 3D render endpoint — takes a texture and a camera, returns an image. */
  renderUrl?: string;
  /** Imaging server that composites the texture. */
  textureBase?: string;
  /** Texture id pattern ({style} substituted). NOT publicly fetchable. */
  texturePattern?: string;
  /** Flat catalogue photo id pattern ({style} substituted). Publicly fetchable. */
  flatPattern?: string;
  /** Cameras offered, in display order (e.g. angle, front, back, left, right). */
  sides?: string[];
  width?: number;
  /** Template colour slots, in layer order. */
  colourSlots?: string[];
  /** Which garment location each text field maps to. */
  textSlots?: { key: string; slot: string; fontSize?: number; weight?: number }[];
  defaultFont?: string;
}

// ── Isolation Context ─────────────────────────────────────────
// Returned to all downstream services so they always have the
// correct MongoDB filter for every query.

export interface ProjectIsolationContext {
  projectId: string;
  orgId: string;
  status: ProjectStatus;
  /** Apply this filter on EVERY MongoDB query in this project */
  mongoFilter: { projectId: string };
  /** Product search scope */
  searchScope: ProjectScope;
  /** Pricing rules */
  pricing: ProjectPricing;
  /** Agent persona */
  persona: ProjectPersona;
}

// ── Business Rules (configured in the back office, consumed by the agent) ──────
// A rule is a condition → action pair the agent must honour. Admins create/edit
// these in the back office; the agent loads the active ones per turn and injects
// them into its prompt. This is the "config over code" seam (see ARCHITECTURE §6).
export type RuleScope =
  | 'pricing'
  | 'compliance'
  | 'recommendation'
  | 'conversation'
  | 'escalation';

export type RuleStatus = 'draft' | 'in_review' | 'approved' | 'published';

export interface BusinessRule {
  ruleId: string;
  projectId: string;          // isolation key
  name: string;
  scope: RuleScope;
  /** Human-readable trigger, e.g. "Customer is configuring a Kitchen or Laundry". */
  condition: string;
  /** Instruction applied when active, e.g. "Recommend only kitchen/laundry products". */
  action: string;
  priority: number;           // lower = evaluated first
  isActive: boolean;
  /** Publish-gate status. Only 'published' rules are honoured by getActiveRules. */
  status: RuleStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateBusinessRuleDto {
  name: string;
  scope: RuleScope;
  condition: string;
  action: string;
  priority?: number;
  isActive?: boolean;
  status?: RuleStatus;
}

export interface UpdateBusinessRuleDto {
  name?: string;
  scope?: RuleScope;
  condition?: string;
  action?: string;
  priority?: number;
  isActive?: boolean;
  status?: RuleStatus;
}
