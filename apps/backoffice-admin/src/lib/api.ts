/**
 * Back-Office API client.
 *
 * Centralises every JourneyAX microservice base URL + the auth header, so tabs
 * don't each hardcode `http://localhost:80xx`. Override per-service in
 * NEXT_PUBLIC_* env vars for staging/prod.
 */

// P0-02 R4: project + org calls go through the SAME-ORIGIN BFF proxy (/api/bff)
// so the browser sends the HttpOnly auth cookie automatically — the token is
// never read by JS. The BFF attaches it as a Bearer to the real service.
export const SERVICES = {
  auth: process.env.NEXT_PUBLIC_AUTH_API || 'http://localhost:8080',
  org: '/api/bff',
  project: '/api/bff',
  data: process.env.NEXT_PUBLIC_DATA_API || 'http://localhost:8086',
  agent: process.env.NEXT_PUBLIC_AGENT_API || 'http://localhost:8087',
};

// ── Types (mirror the service DTOs we consume) ─────────────────────────
export interface Organization {
  orgId: string;
  name: string;
  domain: string;
  status: string;
  plan: string;
  tenantIds: string[];
  billing: { contactEmail: string; country: string; currency: string };
}

export interface ProjectTheme {
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl?: string;
  visualizerEnabled: boolean;
}

// A project-configured context dimension the agent extracts + scopes retrieval by.
// Generic across verticals: Caroma space/projectType, Fashion occasion/fit, Workwear industry/role.
export interface ContextDimension {
  key: string;
  label?: string;
  values?: string[];
  description?: string;
  scoping?: boolean;          // value outside `values` ⇒ out-of-scope for this business
  filtersRetrieval?: boolean; // extracted value scopes retrieval
  askWhenMissing?: boolean;   // asked as chips when still unknown (the journey's own question)
  question?: string;          // wording for those chips
  hardFilter?: boolean;       // a known value excludes items naming a sibling value
  aliases?: Record<string, string[]>; // per-value aliases read from the customer's words
  derive?: { from: string; map: Record<string, string> }; // filled from another dimension, never asked
}

export interface Project {
  projectId: string;
  orgId: string;
  name: string;
  companyName: string;
  slug: string;
  domain: string;
  status: string;
  scope: { rooms: string[]; finishes: string[]; categories: string[]; complianceTags?: string[] };
  pricing: { currency: string; symbol: string; taxRate: number; discountRate: number };
  persona: {
    systemName: string; systemPromptOverrides: string; greetingMessage?: string; journeyGuidance?: string;
    // Raw Journey Builder canvas graph — persisted alongside the compiled `journeyGuidance`
    // prose so re-opening the canvas loads real nodes instead of re-parsing text.
    journeyGraph?: { nodes: any[]; edges: any[] };
  };
  theme: ProjectTheme;
  ai?: {
    provider: string; model: string; temperature: number; embeddingModel?: string;
    ingestModel?: string; extractModel?: string;   // offline ingestion only
    baseUrl?: string;
    // API key is write-only from the UI: reads return a masked hint + configured flag
    // (P0-01 secret redaction). Send `apiKey` only when the admin types a new one.
    apiKey?: string; apiKeyHint?: string; apiKeyConfigured?: boolean;
  };
  capabilities?: string[];
  contextDimensions?: ContextDimension[];
  /** Acceptance scenarios for the one journey loop — examples and a test list, never agent instructions. */
  scenarios?: { id: string; say: string; expect: string; stage?: string }[];
  intro?: { heroHeadline?: string; heroSubtitle?: string; starters?: { label: string; prompt: string }[] };
  console?: { labels?: Record<string, string>; hidden?: string[]; order?: string[] };
  knowledgeSource?: {
    /** Declarative source list — the productised, config-driven path. */
    sources?: KnowledgeSourceItem[];
    domain?: string; seedUrls?: string[]; sitemapUrl?: string; maxPages?: number; notes?: string;
    type?: string; storeId?: string; catalogId?: string; urlIncludes?: string; urlExcludes?: string;
  };
  notifications?: Record<string, boolean>;
  embed?: { launcherLabel?: string; position?: 'right' | 'left'; launcherColor?: string; allowedOrigins?: string[] };
  activeVersion?: number;   // published config version the runtime consumes
  updatedAt?: string;       // last draft edit (vs. published → "unpublished changes")
  version?: number;         // draft mutation counter
  channels?: Record<string, boolean>;
  // ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ──────────────────
  /** Theme layers 1+2: --jx-* design tokens + per-card settings. */
  uiTheme?: import('@journeyax/ui-cards').UiTheme;
  /** Layer 3: tenant overrides of the platform default card templates. */
  cardTemplates?: Record<string, { cardType: string; spec: unknown; variant?: string; note?: string; updatedAt?: string }>;
  fulfilment?: { mode?: 'delivery' | 'collect' | 'both'; label?: string; badge?: string; branches?: { id: string; name: string; address?: string }[] };
  integrations?: {
    whatsapp?: { enabled: boolean; phoneNumberId?: string; accessToken?: string; verifyToken?: string; wabaId?: string };
    shopify?: { enabled: boolean; shopDomain?: string; accessToken?: string };
    commercetools?: { enabled: boolean; projectKey?: string; clientId?: string; clientSecret?: string; apiUrl?: string; authUrl?: string; searchLocale?: string };
    woocommerce?: { enabled: boolean; storeUrl?: string; consumerKey?: string; consumerSecret?: string };
    // Which platform backs each agent domain (the runtime switch — B3). Unset = standalone.
    platforms?: { knowledge?: string; commerce?: string };
  };
}

/** One configured ingestion source (mirrors KnowledgeSourceItem in project-service). */
export interface KnowledgeSourceItem {
  id: string;
  type: 'csv-feed' | 'websphere-rest' | 'pdf' | 'kb-articles' | 'html' | 'team-directory';
  enabled?: boolean;
  label?: string;
  url?: string;
  role?: 'product' | 'inventory' | 'decoration' | 'sizing' | 'design' | 'articles';
  currency?: string;
  sublimation?: boolean;
  docType?: string;
  storeId?: string;
  catalogId?: string;
  sitemapUrl?: string;
  urlIncludes?: string;
  urlExcludes?: string;
  maxPages?: number;
}

/** Source types the ingestion pipeline can run, for the back-office picker. */
export const SOURCE_TYPES: { type: KnowledgeSourceItem['type']; label: string; hint: string }[] = [
  { type: 'csv-feed', label: 'CSV product feed', hint: 'Official product/inventory data feed (CSV). Supports multi-currency price books.' },
  { type: 'pdf', label: 'PDF document', hint: 'Catalogue, decoration guide, size charts, swatches — text is extracted and embedded.' },
  { type: 'kb-articles', label: 'Help-centre articles', hint: 'Sitemap of knowledge-base articles (fit guides, care, lead times, policies).' },
  { type: 'websphere-rest', label: 'WebSphere REST catalogue', hint: 'IBM WebSphere Commerce store — pulls the full catalogue via REST.' },
  { type: 'team-directory', label: 'Team / school directory', hint: 'Public SPARQL endpoint of schools & athletic programmes (names, nickname, conference, division). Colours and artwork are never taken from here.' },
  { type: 'html', label: 'Website crawl', hint: 'Generic Playwright crawl of a sitemap/site for standards-based catalogues.' },
];

/** Ingestion stages that can be run selectively from the back office. */
export const INGEST_STAGES: { id: string; label: string }[] = [
  { id: 'csv-feed', label: 'Product feeds' },
  { id: 'merge', label: 'Merge + reconcile' },
  { id: 'narratives', label: 'Narratives (AI)' },
  { id: 'pdf', label: 'PDF documents' },
  { id: 'kb-articles', label: 'Help articles' },
  { id: 'option-space', label: 'Colours, sizes & options' },
  { id: 'catalog-extract', label: 'Collections & sizing (AI)' },
  { id: 'taxonomy', label: 'Sport & garment taxonomy' },
  { id: 'team-directory', label: 'Team / school directory' },
  { id: 'brand-hub', label: 'Brand context (AI)' },
];

export const LLM_OPTIONS: Record<string, { label: string; models: string[]; keyEnv?: string; keyHelp?: string }> = {
  jax: { label: 'JAX Enterprise Model (NVIDIA L4 Cloud)', models: ['jax-placemakers-1.0', 'placemaker-gemma-9b-fused'], keyHelp: 'Cloud Run L4 GPU - No key needed' },
  placemaker: { label: 'PlaceMaker Custom Model (JAX / GPU)', models: ['jax-placemakers-1.0', 'placemaker-gemma-9b-fused'], keyHelp: 'Local (:8085) or Cloud GPU - No key needed' },
  openai:    { label: 'OpenAI',              models: ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'], keyEnv: 'OPENAI_API_KEY',    keyHelp: 'sk-…' },
  anthropic: { label: 'Anthropic (Claude)',  models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'], keyEnv: 'ANTHROPIC_API_KEY', keyHelp: 'sk-ant-…' },
  gemini:    { label: 'Google Gemini',       models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'], keyEnv: 'GEMINI_API_KEY',   keyHelp: 'AIza…' },
  ollama:    { label: 'Ollama (self-hosted)', models: ['llama3.3:70b', 'qwen2.5:32b', 'mistral-small'], keyHelp: 'no key needed' },
};

export const EMBEDDING_OPTIONS = ['text-embedding-3-small', 'text-embedding-3-large', 'voyage-3-large', 'voyage-3.5'];

// The agent capabilities an admin can enable per project. The agent assembles its
// runtime toolset from these — a products business, a services business, and a
// program business each enable a different set. Must match the agent's registry.
export const CAPABILITY_CATALOG: { id: string; label: string; description: string }[] = [
  { id: 'products',     label: 'Item / product cards',   description: 'Recommend items (products, services…) as cards on the panel' },
  { id: 'accessories',  label: 'Accessories & add-ons',  description: 'Suggest related add-ons / parts after a selection' },
  { id: 'installGuide', label: 'Guide documents (PDFs)', description: 'Attach official how-to / installation documents to view & download' },
  { id: 'warranty',     label: 'Warranty / info panel',  description: 'Surface warranty, terms or policy info before the quote' },
  { id: 'quote',        label: 'Quote builder',          description: 'Assemble a final quote / bill of materials' },
  { id: 'choice',       label: 'Decisions',              description: 'Present selectable path decisions (e.g. DIY vs professional)' },
  { id: 'steps',        label: 'Step-by-step guides',    description: 'Interactive checklists (troubleshooting / install steps)' },
  { id: 'configurator', label: '3D configurator',        description: 'Open an interactive 3D product designer (colours, name/number, live preview)' },
  { id: 'roster',       label: 'Team roster',            description: 'Read a pasted roster (name/number/size per player) for a team order' },
  { id: 'teamColours',  label: 'Team colours lookup',     description: 'Look up a school/team’s official colours to ground a design' },
  { id: 'customDesign', label: 'Custom design upload',    description: 'Match a customer-uploaded design to a make-able template and apply it in 3D' },
  { id: 'teamOrder',    label: 'Team design generation',  description: 'Generate flat front/back/sleeve views for a whole team from a text brief' },
  { id: 'photoUpload3D', label: 'Real-photo 3D match',    description: 'Upload up to 4 real photos of an actual garment and bake them onto the real 3D mesh (no AI-generated artwork)' },
  { id: 'fitmentGuide', label: 'Fitment / sizing guide',  description: 'Ask a few sizing questions and recommend a size, grounded in a real per-tenant size chart' },
  { id: 'customerHistory', label: 'Customer history (demo)', description: 'Read-only tools over the project’s sample-customer fixtures (orders, current offers, staff inventory), bound to the profile picked under “Explore a sample customer”. All data fictional; nothing is written.' },
  { id: 'domainClarify', label: 'Trade diagnostic questions', description: 'When the agent asks about wet areas, leaks or linings without giving options, fall back to the built-in trade question set (NZ building-supply vocabulary). Off by default — only for building/plumbing supply brands.' },
  { id: 'openSpacePlanner', label: 'Interactive space planner', description: 'Open a live 3D/2D room or space planner (e.g. cabinetry, modular units) the customer configures directly' },
  { id: 'buildProjectPlan', label: 'Structural project plan', description: 'Calculate a materials plan for a structural build (decking, fencing, framing, cladding) from dimensions' },
  { id: 'checkBranchStock', label: 'Branch stock lookup', description: 'Check real, live stock and pickup/delivery availability at a specific branch or location' },
];

// ── Auth header ────────────────────────────────────────────────────────
// R4: no token in JS. Same-origin requests to the BFF carry the HttpOnly auth
// cookie automatically; we only set the content type here.
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message || `${res.status} ${res.statusText} @ ${url}`);
  }
  return data as T;
}

// ── Organizations ──────────────────────────────────────────────────────
export const orgApi = {
  list: () => req<Organization[]>(`${SERVICES.org}/api/v1/organizations`),
  get: (orgId: string) => req<Organization>(`${SERVICES.org}/api/v1/organizations/${orgId}`),
  create: (dto: {
    name: string; domain: string; plan?: string;
    billing: { contactEmail: string; country: string; currency: string };
    ownerEmail: string; ownerFullName: string;
  }) => req<any>(`${SERVICES.org}/api/v1/organizations`, { method: 'POST', body: JSON.stringify(dto) }),
  linkProject: (orgId: string, projectId: string) =>
    req<any>(`${SERVICES.org}/api/v1/organizations/${orgId}/projects/${projectId}`, { method: 'POST' }),
};

// ── Projects (tenants/workspaces) ──────────────────────────────────────
export const projectApi = {
  list: (orgId?: string) =>
    req<Project[]>(`${SERVICES.project}/api/v1/projects${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  get: (projectId: string) => req<Project>(`${SERVICES.project}/api/v1/projects/${projectId}`),
  create: (dto: any) => req<any>(`${SERVICES.project}/api/v1/projects`, { method: 'POST', body: JSON.stringify(dto) }),
  update: (projectId: string, dto: any) =>
    req<any>(`${SERVICES.project}/api/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  // ── Config versioning (FR-CONFIG-002): draft → publish → rollback ──
  publish: (projectId: string, body?: { note?: string; publishedBy?: string }) =>
    req<{ success: boolean; version: number }>(`${SERVICES.project}/api/v1/projects/${projectId}/publish`, {
      method: 'POST', body: JSON.stringify(body || {}),
    }),
  versions: (projectId: string) =>
    req<ConfigVersionMeta[]>(`${SERVICES.project}/api/v1/projects/${projectId}/versions`),
  rollback: (projectId: string, version: number) =>
    req<any>(`${SERVICES.project}/api/v1/projects/${projectId}/rollback/${version}`, { method: 'POST' }),
};

// ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ────────────────────────
// The "Cards & Theme" studio's API surface. Reads the DRAFT (same convention
// as every other config screen in this app — publish is a separate, explicit
// step via projectApi.publish). Card specs are validated server-side
// (project-service's validateCardSpec) before they're ever stored, so a
// malformed template can't reach the storefront renderer.
export interface CardListEntry {
  cardType: string;
  source: 'tenant' | 'default';
  spec: any;
  settings: Record<string, unknown> | null;
  updatedAt?: string;
  updatedBy?: string;
  note?: string;
}

export const cardsApi = {
  list: (projectId: string) =>
    req<{ cards: CardListEntry[] }>(`${SERVICES.project}/api/v1/projects/${projectId}/cards`),
  putCard: (projectId: string, cardType: string, spec: unknown, opts?: { note?: string; variant?: string }) =>
    req<{ success: boolean; cardTemplate?: any }>(`${SERVICES.project}/api/v1/projects/${projectId}/cards/${cardType}`, {
      method: 'PUT',
      body: JSON.stringify({ spec, ...(opts?.note ? { note: opts.note } : {}), ...(opts?.variant ? { variant: opts.variant } : {}) }),
    }),
  deleteCard: (projectId: string, cardType: string) =>
    req<{ success: boolean; removed?: boolean }>(`${SERVICES.project}/api/v1/projects/${projectId}/cards/${cardType}`, { method: 'DELETE' }),
  /** Theme tokens + per-card settings are layers 1+2 — plain fields on the
   *  project doc, so they PATCH through the same endpoint every other config
   *  screen uses rather than a card-specific route. */
  patchTheme: (projectId: string, uiTheme: import('@journeyax/ui-cards').UiTheme) =>
    projectApi.update(projectId, { uiTheme }),
  patchFulfilment: (projectId: string, fulfilment: Project['fulfilment']) =>
    projectApi.update(projectId, { fulfilment }),
};

export interface ConfigVersionMeta {
  projectId: string;
  version: number;
  publishedAt: string;
  publishedBy?: string;
  note?: string;
  active: boolean;
}

/**
 * Onboard a customer end-to-end: create the org (billing container), then its
 * first project (the real tenant/workspace holding catalogue + AI config), then
 * link them. Returns { orgId, projectId }.
 */
export async function onboardCustomer(input: {
  companyName: string;
  domain: string;
  ownerEmail: string;
  ownerFullName: string;
  currency?: string;
  country?: string;
  primaryColor?: string;
  accentColor?: string;
  logoUrl?: string;
  /** Confirmed ingestion sources from the brand probe — seeds the Knowledge tab
   *  so a new tenant is ready to ingest instead of starting empty. */
  sources?: KnowledgeSourceItem[];
}): Promise<{ orgId: string; projectId: string }> {
  const currency = input.currency || 'AUD';
  const country = input.country || 'AU';

  const orgRes = await orgApi.create({
    name: input.companyName,
    domain: input.domain,
    plan: 'enterprise',
    billing: { contactEmail: input.ownerEmail, country, currency },
    ownerEmail: input.ownerEmail,
    ownerFullName: input.ownerFullName,
  });
  const orgId: string = orgRes.organization?.orgId || orgRes.orgId || orgRes.org?.orgId;
  if (!orgId) throw new Error('Org created but no orgId returned.');

  const slug = input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const projectId = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  await projectApi.create({
    projectId,
    orgId,
    name: input.companyName,
    companyName: input.companyName,
    slug,
    domain: `${slug}.journeyax.com`,
    scope: { rooms: [], finishes: [], categories: [], complianceTags: [] },
    pricing: { currency, symbol: currency === 'AUD' || currency === 'USD' ? '$' : currency, taxRate: 0.1, discountRate: 0.1 },
    persona: {
      systemName: `${input.companyName} Advisor`,
      systemPromptOverrides: `You are the ${input.companyName} consultant. Understand each customer's real goal and guide them with ${input.companyName}'s own products and documentation.`,
      greetingMessage: `Hi! I'm your ${input.companyName} consultant — what are you trying to achieve?`,
    },
    theme: {
      primaryColor: input.primaryColor || '#FFD600',
      accentColor: input.accentColor || '#0A0A0A',
      fontFamily: 'Space Grotesk, sans-serif',
      visualizerEnabled: true,
      ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}),
    },
    // Seed the knowledge source from the customer's own site so the new tenant
    // can ingest immediately; previously `domain` was collected and discarded.
    ...(input.sources?.length
      ? { knowledgeSource: { domain: input.domain, sources: input.sources } }
      : {}),
  } as any);

  await orgApi.linkProject(orgId, projectId).catch(() => { /* link is best-effort */ });

  return { orgId, projectId };
}
