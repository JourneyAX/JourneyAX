import {
  BusinessProfile,
  BusinessEntityLookup,
} from './business.types';
export * from './business.types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JourneyAX — Integration Ports (Hexagonal Architecture)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A "Port" is a STABLE business interface that the agent-runtime and domain
 * services depend on. It is named by BUSINESS DOMAIN (Commerce, CRM, ...),
 * never by vendor. An "Adapter" (see ./adapters) implements a port for one
 * platform (standalone/internal, Shopify, Salesforce, ...). The Registry
 * (./registry) picks the right adapter per tenant.
 *
 * WHY: the agent must be backend-agnostic. It calls `commerce.searchProducts()`
 * and does not care whether that hits our internal product-service or Shopify.
 * Add a new platform = add ONE adapter file. Nothing above this layer changes.
 *
 * All methods are async and take a `ctx` (tenant + auth + correlation) so every
 * call is tenant-scoped and traceable.
 */

// ── Call Context ────────────────────────────────────────────────────────────
/** Passed to every port call. Carries tenant scope + tracing, never business data. */
export interface AdapterContext {
  tenantId: string;
  /** Opaque per-tenant credentials/config resolved from `integration_connections`. */
  connection?: Record<string, unknown>;
  /** Correlation id for audit/trace across the whole request. */
  correlationId?: string;
}

/** Which platform backs a given domain for a tenant. Drives Registry resolution. */
export type Platform =
  | 'standalone' // internal JourneyAX services (default)
  | 'shopify'
  | 'commercetools'
  | 'sap_erp'
  | 'salesforce'
  | 'hubspot';

/** Every adapter declares which domain + platform it serves. */
export interface AdapterMeta {
  domain: 'commerce' | 'crm' | 'fulfilment' | 'configurator' | 'knowledge' | 'business';
  platform: Platform;
}

// ── Shared value shapes (kept minimal; prices are INTEGER CENTS) ─────────────
export interface Money {
  /** Integer minor units (cents/paise). Never a float. */
  amountCents: number;
  currency: string; // e.g. "AUD"
}

export interface ProductRef {
  sku: string;
  name: string;
  category?: string;
  collection?: string;
  price?: Money;
  imageUrl?: string;
  specs?: Record<string, string>;
  url?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  A. COMMERCE PORT — catalog, pricing, inventory, cart, checkout
// ═══════════════════════════════════════════════════════════════════════════
export interface ProductSearchQuery {
  query: string;
  category?: string;
  /** Intent-scoped source hint (see retrieval-router): 'product' | 'design' | ... */
  type?: string;
  budgetCents?: number;
  limit?: number;
}

export interface CommercePort {
  readonly meta: AdapterMeta;
  searchProducts(ctx: AdapterContext, q: ProductSearchQuery): Promise<ProductRef[]>;
  getProduct(ctx: AdapterContext, sku: string): Promise<ProductRef | null>;
  getPricing(ctx: AdapterContext, sku: string, customerId?: string): Promise<Money>;
  checkInventory(ctx: AdapterContext, sku: string): Promise<{ inStock: boolean; quantity?: number }>;
  createCart(ctx: AdapterContext, items: { sku: string; quantity: number }[]): Promise<{ cartId: string }>;
  createCheckout(ctx: AdapterContext, cartId: string): Promise<{ checkoutUrl: string; externalOrderId?: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  D. CRM PORT — profile, contacts, cases, leads, segments
// ═══════════════════════════════════════════════════════════════════════════
export interface CrmContact {
  id?: string;
  email: string;
  name?: string;
  phone?: string;
  segments?: string[];
}

export interface CrmPort {
  readonly meta: AdapterMeta;
  upsertContact(ctx: AdapterContext, contact: CrmContact): Promise<{ contactId: string }>;
  pushLead(ctx: AdapterContext, lead: { contact: CrmContact; summary: string; valueCents?: number }): Promise<{ leadId: string; crmUrl?: string }>;
  createCase(ctx: AdapterContext, c: { contactId: string; subject: string; body: string }): Promise<{ caseId: string }>;
  getCustomer(ctx: AdapterContext, id: string): Promise<CrmContact | null>;
  getSegments(ctx: AdapterContext, contactId: string): Promise<string[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  C. FULFILMENT PORT — orders, shipment, returns, appointments, installers
// ═══════════════════════════════════════════════════════════════════════════
export interface FulfilmentPort {
  readonly meta: AdapterMeta;
  createOrder(ctx: AdapterContext, order: { cartId: string; contactId?: string }): Promise<{ orderId: string; status: string }>;
  trackShipment(ctx: AdapterContext, orderId: string): Promise<{ status: string; eta?: string }>;
  createReturn(ctx: AdapterContext, orderId: string, reason: string): Promise<{ returnId: string }>;
  bookAppointment(ctx: AdapterContext, req: { orderId?: string; type: 'plumber' | 'installer' | 'survey'; preferred?: string }): Promise<{ appointmentId: string; slot: string }>;
  assignInstaller(ctx: AdapterContext, appointmentId: string): Promise<{ installerId: string; name: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  B. CONFIGURATOR PORT — design options, BOM, cost, saved designs
// ═══════════════════════════════════════════════════════════════════════════
export interface DesignOption {
  id: string;
  title: string;
  products: ProductRef[];
  estimatedTotal: Money;
  rationale: string;
}

export interface ConfiguratorPort {
  readonly meta: AdapterMeta;
  createDesignOptions(ctx: AdapterContext, brief: Record<string, unknown>): Promise<DesignOption[]>;
  generateBom(ctx: AdapterContext, designId: string): Promise<{ items: ProductRef[]; total: Money }>;
  estimateCost(ctx: AdapterContext, items: { sku: string; quantity: number }[]): Promise<Money>;
  saveDesign(ctx: AdapterContext, design: DesignOption): Promise<{ designId: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  KNOWLEDGE PORT — RAG retrieval (grounding source for the agent)
// ═══════════════════════════════════════════════════════════════════════════
//
// Distinct from CommercePort on purpose. CommercePort returns clean structured
// products; KnowledgePort returns the FULL retrieval envelope the LLM grounds on
// (content chunk + specs + the found/message signal). Wiring the agent's
// `searchKnowledge` tool through this port removes the hardcoded service URL from
// the agent WITHOUT changing the shape the model sees — so grounding is preserved.
export interface KnowledgeQuery {
  query: string;
  /** content-type filter: 'product' | 'troubleshooting' | 'design' | 'installation' | ... */
  type?: string;
  category?: string;
  limit?: number;
  /** hard filter by shopper gender/division ('men'|'women'|'kids') — unisex always kept */
  gender?: string;
}

export interface KnowledgeResultItem {
  title?: string;
  type?: string;
  sku?: string;
  price?: number;
  collection?: string;
  finishes?: string[];
  images?: string[];
  imageUrl?: string;
  specs?: Record<string, string>;
  url?: string;
  /** The retrieved chunk text — what the model reads to stay grounded. */
  content?: string;
}

export interface KnowledgeSearchResult {
  found: boolean;
  resultCount: number;
  results: KnowledgeResultItem[];
  message?: string;
}

/** Structural relationships between catalogue items (collections, coordinated
 *  sets, adult/youth/ladies sizing). Distinct from `search`, which is semantic:
 *  these are exact facts, so a backend that cannot supply them returns empties
 *  rather than approximating. */
export interface KnowledgeRelated {
  sku: string;
  collections: Array<{ name: string; skus: string[] }>;
  outfittingSets: Array<{ name: string; skus: string[] }>;
  sizingGroup: { styleName?: string; adult?: string; youth?: string; ladies?: string } | null;
}

/** The choices a customer can actually make on a product, as the source
 *  platform defines them. Exact, not inferred. */
export interface KnowledgeOptions {
  sku: string;
  found: boolean;
  choices: Record<string, { value: string; swatchImage?: string }[]>;
  characteristics: Record<string, string>;
  goesWith: { sku?: string; name?: string }[];
  views: string[];
  variantCount?: number;
}

export interface KnowledgePort {
  readonly meta: AdapterMeta;
  search(ctx: AdapterContext, q: KnowledgeQuery): Promise<KnowledgeSearchResult>;
  /** Optional: backends without a relationship graph simply omit this. */
  related?(ctx: AdapterContext, sku: string): Promise<KnowledgeRelated>;
  /** Optional: backends that don't model a variant/option space omit this. */
  options?(ctx: AdapterContext, sku: string): Promise<KnowledgeOptions>;
  /** Optional: look up schools / teams the customer buys for. */
  teams?(ctx: AdapterContext, query: string, where?: { state?: string; city?: string }): Promise<KnowledgeTeams>;
  /** Optional: record a club/team the customer named (no public registry exists). */
  registerTeam?(ctx: AdapterContext, team: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
}

/** School / athletic-programme candidates. Deliberately a LIST plus guidance:
 *  the caller must confirm which one, and must not treat colours or marks as
 *  settled — those are confirmed with (or supplied by) the customer. */
export interface KnowledgeTeams {
  query: string;
  totalMatches?: number;
  /** True when the name is ambiguous and the customer must be asked where. */
  needsLocation?: boolean;
  availableStates?: string[];
  matches: Array<{
    programme?: string; institution?: string; nickname?: string; mascot?: string;
    conference?: string | null; division?: string | null; state?: string; country?: string;
    colours?: { name?: string; hex?: string }[];
    colourSource?: string; artworkPolicy?: string; confidence?: string; source?: string;
  }>;
  guidance: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUSINESS PORT — "what kind of business am I serving, and who for?"
// ═══════════════════════════════════════════════════════════════════════════
//
// The layer that makes the agent genuinely business-agnostic. Every other port
// answers "how do I do X"; this one answers "what IS this business" — its brands,
// model, buyers, vocabulary, and the entity its customers buy on behalf of.
//
// Without it, vertical assumptions leak into the agent as code ("findTeam"),
// and onboarding a different business means a code change rather than config.
export interface BusinessPort {
  readonly meta: AdapterMeta;
  /** The full picture of this business, for agent orientation. */
  getProfile(ctx: AdapterContext): Promise<BusinessProfile>;
  /** Find the entity the customer buys for — a team, a site, a room. */
  findEntities?(ctx: AdapterContext, query: string, where?: Record<string, string>): Promise<BusinessEntityLookup>;
  /** Record one the customer named that isn't on file (no directory covers clubs). */
  registerEntity?(ctx: AdapterContext, entity: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
}

/** Union used by the registry for typing convenience. */
export type AnyPort =
  | CommercePort
  | CrmPort
  | FulfilmentPort
  | ConfiguratorPort
  | KnowledgePort
  | BusinessPort;
