import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CARD_TYPES, type CardType, CARD_TYPE_NAMES } from '@journeyax/ui-cards';
import type { BusinessPackRelease, BusinessPackContent, JourneyPlaybookStage } from '@journeyax/business-pack';
import { CUSTOMER_ACCOUNT_CONNECTOR, resolveAgentSkills, resolveCatalogMapping } from '@journeyax/business-pack';
import { dropAdded, RECOMMENDATION_CARDS, skusInCart } from './already-added';
import type { ClaimClass, OkfReleaseContent, OkfEvidenceChunk, OkfConcept } from '@journeyax/knowledge';
import { ClaimClassSchema, effectiveVerification, scopedClaims, verifiedEvidenceRefs, mergeSearchScopes } from '@journeyax/knowledge';
import type { WorkspaceState } from '@journeyax/journey-core';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import {
  extractRelevantOkfNotes,
  findRelevantOkfConcepts,
  resolveAgentRelationshipTypes,
  OKF_ALLOWED_RELATIONSHIP_TYPES,
} from '../kernel/business-knowledge';
import { CatalogSearchHandler, extractSearchSpecs } from '../capabilities/handlers/catalog-search.handler';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import { KnowledgeSearchHandler } from '../capabilities/handlers/knowledge-search.handler';
import { QuoteCreateHandler } from '../capabilities/handlers/quote-create.handler';
import { QuoteUpdateHandler } from '../capabilities/handlers/quote-update.handler';
import { CartUpdateHandler } from '../capabilities/handlers/cart-update.handler';
import {
  executeCalculator,
  findMatchingCalculator,
} from '../kernel/formula-evaluator';
import type { CapabilityGateway } from '../kernel/capability.gateway';
import type { ApprovalService } from '../kernel/approval.service';
import type { ExecutionRepository } from '../kernel/execution.repository';
import type { KnowledgeControlPlanePort } from '../kernel/knowledge-control-plane';
import type { KnowledgeGapRepository } from '../kernel/knowledge-gap.repository';
import type { ProductGuideRepository } from '../kernel/product-guide.repository';
import type { ContentPageRepository } from '../kernel/content-page.repository';
import type { FormSubmissionRepository } from '../kernel/form-submission.repository';
import { deriveJourneyChecklist } from './journey-checklist';
import { findForm, formCardState, formsOf, prefillFor } from './forms';
import { confirmCardState, createPendingConfirmation, defaultPrompt, type ConfirmationWording } from './confirmation';
import { browseRange, exampleOrder, goesWithForTrail, resolveCatalogPaths } from './range-browser';
import { productCardFacts } from './card-facts';
import { summariseOptions } from './option-facets';
import { normaliseCardState } from './card-state';
import { areaToSquareMetres, estimateQuantity, type QuantityHelperConfig, type QuantityEstimate } from './quantity-estimate';
import { generateVisual, type VisualiserConfig } from './visual-generator';
import { hasReadableText, readGuides } from './product-guides';
import { findPage, pageAsGuide, readableTitle, searchPages, type ContentPageRecord, type PageHit } from './content-pages';
import { buildReview, type ReviewLine, type ReviewState, type ReviewSuggestion } from './checkout-review';
import type { LastProducts } from './auto-card';
import { addOtherOption, checkShelfQuestions, type QuestionCardSettings, type Shelf } from './question-shelves';
import { connectorWordsForLocale } from '../capabilities/handlers/locale-stemmer';
import { CONNECTOR_META_TOOL_DEFINITIONS, executeConnectorMetaTool, isConnectorMetaTool, plainId } from './connector-tools';
import { CUSTOMER_ACCOUNT_TOOL_DEFINITIONS, customerAccountRecords, customerAccountSettings, executeCustomerAccountTool, isCustomerAccountTool } from './customer-account';
import { cardsShownNote, showRecordCards } from './record-cards';
import type { PersonCompany } from '../kernel/company-directory';
import type { ConnectorPerson, ConnectorRuntime } from '../kernel/connector.runtime';

export interface AgentToolContext {
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  workspaceId?: string;
  sessionId?: string;
  correlationId: string;
  principalId?: string;
  principalRole?: string;
  /** Who is asking, as far as groups and audience go: what the connector policy is worked out from. Absent: a shopper with no groups. */
  principal?: ConnectorPerson;
  /** The companies the team linked this signed-in customer to (looked up from the verified login, never from the browser or the model). Absent or empty: an ordinary shopper. */
  companies?: PersonCompany[];
  idempotencyKey?: string;
  release: BusinessPackRelease;
  workspace?: WorkspaceState | null;
  okfContent?: OkfReleaseContent | null;
  catalogSearchHandler: CatalogSearchHandler;
  branchStockHandler?: BranchStockCheckHandler;
  knowledgeSearchHandler?: KnowledgeSearchHandler;
  knowledgeControlPlane?: KnowledgeControlPlanePort;
  capabilityGateway?: CapabilityGateway;
  approvalService?: ApprovalService;
  executionRepo?: ExecutionRepository;
  knowledgeGapRepo?: KnowledgeGapRepository;
  /** The guides kept with products (specification guide, installation guide, manual), read by read_product_guide. */
  productGuideRepo?: ProductGuideRepository;
  /** The shop's own web pages kept as text (project how-tos, inspiration, compliance, the shop's own tools), read by read_content_page. */
  contentPageRepo?: ContentPageRepository;
  /** Where a sent form is kept. */
  formSubmissionRepo?: FormSubmissionRepository;
  inMemoryQuotes?: Map<string, any> | Record<string, any>;
  inMemoryCarts?: Map<string, any> | Record<string, any>;
  /** What each tool may do for this person (pack `extensions.toolStates`). Absent: every tool runs, as before the table existed. */
  toolStateOf?: (toolId: string) => { state: 'allow' | 'ask' | 'blocked'; prompt?: string };
  /** The shop's words on the ask-first card (pack `extensions.toolStates.wording`). */
  confirmationWording?: ConfirmationWording;
  turnProductSkus: Set<string>;
  /** Products an earlier turn of this conversation showed (read from the stored thread, never from the customer or the model): one of them may sit on a card after a catalogue lookup by SKU, without a new search. */
  earlierShownSkus?: Set<string>;
  catalogProductCache: Map<string, any>;
  /** What the latest product lookup of the turn found, so the reply's products can be shown even if the reply names none. */
  lastProducts?: LastProducts;
  /** The product group the turn's range overview was mainly about, kept in the conversation so the next turn can narrow within it. */
  lastRangeGroup?: { name: string; path: string[] };
  /** The groups of the department the customer is choosing within, with how many products each holds: what a "what kind?" question is checked against. */
  rangeShelves?: Shelf[];
  readSourceIds: Set<string>;
  allowedClaimClasses: Set<ClaimClass>;
  presentedCards: Array<{ cardType: string; state: any }>;
  isHumanHandoffRequested: boolean;
  handoffReason?: string;
  customerQuestion?: string;
  consultedConcepts?: Set<OkfConcept>;
  agentRelationshipTypes?: string[] | Set<string>;
  agentPlaybook?: JourneyPlaybookStage[];
  /** The skills the resolved agent carries (ids), so use_skill only opens one of them. */
  agentSkillIds?: string[];
  /** Skills the agent opened this turn (use_skill), for the trace. */
  usedSkillIds?: Set<string>;
  /** Reaches connectors (other systems over MCP). Absent: the connector tools are not offered. */
  connectorRuntime?: ConnectorRuntime;
  /** Connectors the agent loaded or called this turn, for the trace. */
  usedConnectorIds?: Set<string>;
  /** Connectors the person switched off for this chat: the three connector tools refuse them. */
  disabledConnectors?: Set<string>;
  /** The record cards already shown this turn (by their heading and rows), so the same lookup twice makes one card. */
  shownRecordCards?: Set<string>;
  /** The quantity estimates of this turn by SKU: a quantity card shows only a number the estimate tool returned. */
  lastEstimates?: Map<string, Extract<QuantityEstimate, { ok: true }> & { title: string; unitLabel: string; working: Array<{ label: string; value: string }>; ctaLabel: string }>;
  /** The picture made this turn: a picture card shows only this one. */
  lastVisual?: { id: string; urlPath: string; skus: string[] };
  /** Test seams for the picture tool: the HTTP client and the folder pictures are kept in. */
  imageFetch?: typeof fetch;
  visualStoreDir?: string;
  /** The review of the order made this turn: a review card shows only this. */
  lastReview?: ReviewState;
  /** Products already suggested as accessories earlier in this conversation: the same suggestions are not shown again. */
  shownAccessories?: Set<string>;
  customerEvent?: any;
  signal?: AbortSignal;
  emitUiAction?: (action: { name: string; arguments: any }) => void;
  emitTrace?: (name: string, payload: any) => void;
}

/**
 * The names this turn's tools returned: product titles and brands, the range group the customer is looking at and its shelves. The claim
 * guard sets them aside before it reads a sentence, so a word that is part of a product's own name ("Mounting Bracket", "Wire Wardrobe Kit")
 * is not taken for an instruction. `productNames` are the titles and brands among them.
 */
export function knownNamesOf(ctx: Pick<AgentToolContext, 'catalogProductCache' | 'lastRangeGroup' | 'rangeShelves'>): { names: string[]; productNames: string[] } {
  const names = new Set<string>();
  const productNames = new Set<string>();
  const add = (into: Set<string>, value: unknown) => {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (text.length >= 4) {
      names.add(text);
      into.add(text);
    }
  };
  for (const product of ctx.catalogProductCache.values()) {
    add(productNames, product?.title);
    add(productNames, product?.name);
    add(productNames, product?.brand);
  }
  const groupNames = new Set<string>();
  if (ctx.lastRangeGroup) {
    add(groupNames, ctx.lastRangeGroup.name);
    for (const part of ctx.lastRangeGroup.path || []) add(groupNames, part);
  }
  for (const shelf of ctx.rangeShelves || []) add(groupNames, shelf?.name);
  return { names: [...names], productNames: [...productNames] };
}

/** One product by SKU: from this turn's lookups, else from the catalogue (and then remembered for this turn). */
export async function findProductBySku(ctx: AgentToolContext, sku: string): Promise<any | undefined> {
  const cached = ctx.catalogProductCache.get(sku);
  if (cached) return cached;
  if (!sku) return undefined;
  const res = await ctx.catalogSearchHandler.execute({ sku, maxResults: 1 } as any, makeExecContext(ctx));
  const found = ((res.products || res.items || []) as any[]).find((p: any) => String(p.sku).toLowerCase() === sku.toLowerCase());
  if (found?.sku) {
    ctx.turnProductSkus.add(found.sku);
    ctx.catalogProductCache.set(found.sku, found);
  }
  return found;
}

/** Points the model at what search_guides cannot read: the guide kept with a product, and the shop's own pages. */
function productGuideHint(ctx: AgentToolContext): { productGuide?: string; sitePages?: string } {
  const extensions = (ctx.release as any)?.extensions || {};
  return {
    ...(ctx.productGuideRepo && extensions.productGuides?.enabled !== false ? { productGuide: 'These are general guides. For what the guide kept with a specific product says (its specification guide, installation guide or manual), call read_product_guide with that product\'s SKU: it returns the guide\'s own words. Do not tell the customer a guide is unavailable before you have tried it.' } : {}),
    ...(ctx.contentPageRepo && extensions.contentPages?.enabled !== false ? { sitePages: 'For the shop\'s own pages on projects, ideas, compliance (for example the energy-efficiency rules) and the tools and services it offers, call read_content_page with the customer\'s question.' } : {}),
  };
}

/** A product the model named by its full title instead of its SKU: taken only when exactly one product has that title, never the nearest match. */
async function findProductByTitle(ctx: AgentToolContext, asked: string): Promise<any | undefined> {
  const wanted = asked.replace(/\s+/g, ' ').trim().toLowerCase();
  if (wanted.length < 4) return undefined;
  const cached = [...ctx.catalogProductCache.values()].filter((p) => String(p.title || p.name || '').replace(/\s+/g, ' ').trim().toLowerCase() === wanted);
  if (cached.length === 1) return cached[0];
  const res = await ctx.catalogSearchHandler.execute({ query: asked, maxResults: 5 } as any, makeExecContext(ctx));
  const same = ((res.products || res.items || []) as any[]).filter((p: any) => String(p.title || p.name || '').replace(/\s+/g, ' ').trim().toLowerCase() === wanted);
  if (same.length !== 1 || !same[0]?.sku) return undefined;
  ctx.turnProductSkus.add(same[0].sku);
  ctx.catalogProductCache.set(same[0].sku, same[0]);
  return same[0];
}

/** Words that say what the customer wants done, not which product: left out when matching a product by its words. */
const GUIDE_WORDS_IGNORED = new Set(['the', 'and', 'for', 'with', 'how', 'can', 'you', 'please', 'guide', 'guides', 'installation', 'install', 'read', 'take', 'through', 'explain', 'steps', 'step', 'tell', 'show', 'about', 'what', 'does', 'say', 'from', 'this', 'that', 'bought', 'building', 'buy', 'got', 'have', 'need', 'want', 'putting', 'i', 'im', 'me', 'my', 'we', 'our', 'it', 'them', 'of', 'to', 'in', 'on', 'is', 'are', 'a', 'an']);

/** The words of a product description worth matching on: lower case, no filler, no single letters ("x" in "88 x 88"). */
function productWordsOf(text: string): string[] {
  return String(text || '').toLowerCase().replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[-.]+|[-.]+$/g, '')).filter((w) => w.length >= 2 && !GUIDE_WORDS_IGNORED.has(w));
}

/** True when the product's name carries every one of the words (a plural matches its singular), so it is the product that was described and not merely a near one. */
function namesEveryWord(product: any, words: string[]): boolean {
  if (words.length === 0) return false;
  const name = String(product.title || product.name || '').toLowerCase();
  return words.every((w) => name.includes(w) || (w.length > 3 && /s$/.test(w) && name.includes(w.replace(/es$|s$/, ''))));
}

/**
 * The products nearest to the words the model gave where a SKU was wanted (the product's description first, then what it passed as the SKU, then the customer's own sentence),
 * each marked with whether a guide is kept for it, those with a guide first.
 */
async function guideCandidates(ctx: AgentToolContext, ...asked: string[]): Promise<Array<{ sku: string; title: string; hasGuide: boolean; product: any; guideKey: string }>> {
  const queries = [...asked, ctx.customerQuestion].map((text) => productWordsOf(String(text || '')).join(' ').slice(0, 240)).filter((text, at, all) => text.length >= 3 && all.indexOf(text) === at);
  const found = new Map<string, any>();
  for (const query of queries) {
    try {
      const res = await ctx.catalogSearchHandler.execute({ query, maxResults: 5 } as any, makeExecContext(ctx));
      for (const p of (res.products || res.items || []) as any[]) if (p?.sku && !found.has(String(p.sku))) found.set(String(p.sku), p);
    } catch {
      // A search that fails leaves the model with the plain "look it up first" message.
    }
    if (found.size >= 3) break;
  }
  const out: Array<{ sku: string; title: string; hasGuide: boolean; product: any; guideKey: string }> = [];
  for (const p of [...found.values()].slice(0, 6)) {
    ctx.turnProductSkus.add(p.sku);
    ctx.catalogProductCache.set(p.sku, p);
    const kept = ctx.productGuideRepo ? await ctx.productGuideRepo.findForProducts(ctx.tenantId, [String(p.sku), String(p.parentSku || '')].filter(Boolean)).catch(() => []) : [];
    // What the guides kept for this product say, as one key: two products with the same key share the same guide, word for word.
    const guideKey = kept.length ? createHash('sha256').update(kept.map((record: any) => `${record.title}\n${record.text}`).sort().join('\n--\n')).digest('hex').slice(0, 16) : '';
    out.push({ sku: String(p.sku), title: String(p.title || p.name || p.sku), hasGuide: kept.length > 0, product: p, guideKey });
  }
  return [...out.filter((c) => c.hasGuide), ...out.filter((c) => !c.hasGuide)];
}

/** Words on the quantity card's working lines; the tenant's own words (pack `extensions.quantityHelper.labels`) replace these. */
const DEFAULT_QUANTITY_LABELS = {
  area: 'Your area', areaUnit: 'm²', perPiece: 'One piece covers', perPack: 'One pack covers', coats: 'Coats', allowance: 'Allowance for cuts and waste',
  exact: 'Needed for the area', total: 'To buy', pieces: 'pieces', packs: 'packs', add: 'Add',
};

function makeExecContext(ctx: AgentToolContext) {
  const primaryCurrency =
    (ctx.release as any)?.profile?.primaryCurrency ||
    (ctx.release as any)?.pricing?.currency;
  return {
    tenantId: ctx.tenantId,
    environmentId: ctx.environmentId,
    workspaceId: ctx.workspaceId || ctx.sessionId || 'agent_workspace',
    sessionId: ctx.sessionId || ctx.workspaceId || 'agent_session',
    principalId: ctx.principalId || 'customer',
    principalRole: ctx.principalRole || 'customer',
    stageId: 'agent_stage',
    packVersionId: ctx.release.manifest?.version || ctx.release.manifest?.packId || '1.0.0',
    correlationId: ctx.correlationId,
    idempotencyKey: ctx.idempotencyKey || ctx.correlationId,
    release: ctx.release,
    packSettings: ctx.release,
    okfRelease: ctx.okfContent,
    currency: primaryCurrency,
    pricing: (ctx.release as any)?.pricing || (primaryCurrency ? { currency: primaryCurrency } : undefined),
  };
}

/**
 * Where a branch's stock figures live, when the pack says so (`extensions.branchStock`): a connector tool of the business system, the name
 * of its SKU input (default `sku`), the name of its branch input when the tool takes the branch as the person says it (left out when the
 * system wants a code instead), any fixed extra inputs (a limit), and a note for the model. Without this setting check_stock has only the
 * catalogue's shop-wide flag, and says so. Nothing here names a system: the pack does.
 */
export interface BranchStockRoute { connector: string; tool: string; inputs?: { sku?: string; branch?: string }; extra?: Record<string, unknown>; note?: string }

export function branchStockRoute(release: unknown): BranchStockRoute | undefined {
  const raw = (release as any)?.extensions?.branchStock;
  if (!raw || typeof raw !== 'object') return undefined;
  const connector = plainId(raw.connector);
  const tool = plainId(raw.tool);
  if (!connector || !tool) return undefined;
  const inputs = raw.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs) ? raw.inputs : undefined;
  const extra = raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? raw.extra : undefined;
  return { connector, tool, inputs, extra, note: typeof raw.note === 'string' ? raw.note : undefined };
}

/**
 * A view or compare event names each product by SKU and by title. A model sometimes writes the title where a SKU belongs, and a
 * title is a free-text search that can land on a similar product. When the asked-for value is the title of a product the event
 * named, it is replaced by that product's SKU.
 */
export function skuFromEvent(asked: string, event: any): string {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const skus: string[] = (Array.isArray(payload.skus) ? payload.skus : [payload.sku]).filter(Boolean).map(String);
  const titles: string[] = (Array.isArray(payload.titles) ? payload.titles : [payload.title]).map((title: unknown) => String(title ?? '').trim().toLowerCase());
  const at = titles.indexOf(String(asked || '').trim().toLowerCase());
  return at >= 0 && skus[at] ? skus[at] : asked;
}

/** The SKUs a customer's card tap names (one SKU, a list, or the lines of an add-all). */
export function eventSkus(event: any): string[] {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const lines: any[] = Array.isArray(payload.items) ? payload.items : [];
  return [...new Set([payload.sku, ...(Array.isArray(payload.skus) ? payload.skus : []), ...lines.map((line) => line?.sku)].filter((value) => typeof value === 'string' && value.trim()).map((value: string) => value.trim()))];
}

export function hashPayload(val: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(val || {})).digest('hex').slice(0, 16);
  } catch {
    return 'nohash';
  }
}

export function isProductDiscontinued(p: any): boolean {
  if (!p || typeof p !== 'object') return false;
  if (p.discontinued === true) return true;
  const status = String(p.status || p.lifecycle?.status || p.lifecycleStatus || '').toLowerCase();
  return status === 'discontinued' || status === 'retired' || status === 'delisted';
}

/**
 * Resolves the bound capability ID for an agent tool from the Business Pack's tool bindings.
 * Returns the pack-configured toolId if bound, otherwise falls back to the neutral canonical capability ID.
 */
export function resolveBoundCapability(
  release: BusinessPackContent | null | undefined,
  toolName: string
): string {
  const toolBindings = release?.capabilities?.toolBindings || [];

  // 1. Explicit binding with agentTool === toolName
  const explicit = toolBindings.find((b: any) => b.agentTool === toolName);
  if (explicit?.toolId) return explicit.toolId;

  // 2. Direct match on toolId === toolName
  const direct = toolBindings.find((b: any) => b.toolId === toolName);
  if (direct?.toolId) return direct.toolId;

  // 3. Match from pack toolBindings (e.g. pack binding toolId matching toolName)
  const normTool = toolName.toLowerCase().replace(/[_.]/g, '');
  const boundMatch = toolBindings.find((b: any) => {
    const normBound = (b.toolId || '').toLowerCase().replace(/[_.]/g, '');
    return normBound.endsWith(normTool) || normTool.endsWith(normBound) || normBound.includes(normTool);
  });
  if (boundMatch?.toolId) return boundMatch.toolId;

  // 4. Neutral canonical platform fallback
  const neutralFallbacks: Record<string, string> = {
    search_products: 'catalog.search',
    get_product: 'catalog.get',
    get_related_products: 'catalog.related',
    check_stock: 'stock.check',
    consult_business_knowledge: 'knowledge.search',
    search_guides: 'knowledge.search',
    get_warranty: 'knowledge.search',
    calculate_quantity: 'quantity.calculate',
    present_card: 'ui.present_card',
    hand_off_to_human: 'agent.handoff',
    create_quote: 'quote.create',
    update_quote: 'quote.update',
    add_to_quote: 'quote.update',
    get_cart: 'cart.get',
    update_cart: 'cart.update',
    add_to_cart: 'cart.update',
    get_journey_checklist: 'journey.checklist',
  };

  return neutralFallbacks[toolName] || toolName;
}

export function isToolAllowed(
  toolName: string,
  allowedTools?: string[],
  release?: BusinessPackContent | null
): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;
  if (allowedTools.includes('*') || allowedTools.includes('all')) return true;
  if (allowedTools.includes(toolName)) return true;

  const boundCap = resolveBoundCapability(release, toolName);
  if (allowedTools.includes(boundCap)) return true;

  for (const allowed of allowedTools) {
    if (allowed.endsWith('.*')) {
      const prefix = allowed.slice(0, -2);
      if (
        toolName.startsWith(prefix) ||
        boundCap.startsWith(prefix) ||
        boundCap.includes(prefix)
      ) {
        return true;
      }
    }
  }

  const toolBindings = release?.capabilities?.toolBindings || [];
  for (const b of toolBindings as any[]) {
    if (
      (b.agentTool === toolName || b.toolId === toolName || b.toolId === boundCap) &&
      allowedTools.includes(b.toolId)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Dynamically specializes search_products parameters for the specific tenant based on
 * catalogue mapping (attributeAliases) and entity definitions.
 */
export function specializeSearchProductsTool(
  baseTool: AgentToolDefinition,
  release?: BusinessPackContent | null
): AgentToolDefinition {
  const specialized: AgentToolDefinition = {
    ...baseTool,
    parameters: {
      ...baseTool.parameters,
      properties: { ...baseTool.parameters.properties },
    },
  };

  const catalogMapping = release?.catalogMapping;
  const attributeAliases = catalogMapping?.attributeAliases;
  const attributeDefs = (catalogMapping as any)?.attributeDefinitions || {};
  const entities = (release as any)?.entities?.entities || [];

  const properties: Record<string, any> = {};

  if (attributeAliases && typeof attributeAliases === 'object') {
    for (const [attrName, aliases] of Object.entries(attributeAliases)) {
      const def = attributeDefs[attrName];
      const desc =
        def?.description ||
        (Array.isArray(aliases) && aliases.length > 0
          ? `Filter by ${attrName} (aliases: ${aliases.join(', ')})`
          : `Filter by ${attrName}`);
      properties[attrName] = {
        type: 'string',
        description: desc,
        ...(def?.examples ? { examples: def.examples } : {}),
      };
    }
  }

  if (attributeDefs && typeof attributeDefs === 'object') {
    for (const [attrName, def] of Object.entries<any>(attributeDefs)) {
      if (!properties[attrName]) {
        properties[attrName] = {
          type: 'string',
          description: def?.description || `Filter by ${attrName}`,
          ...(def?.examples ? { examples: def.examples } : {}),
        };
      }
    }
  }

  for (const entity of entities) {
    if (Array.isArray(entity.slots)) {
      for (const slot of entity.slots) {
        if (!properties[slot.name]) {
          properties[slot.name] = {
            type: slot.type || 'string',
            description: slot.description || `Filter by ${slot.name}`,
            ...(slot.examples ? { examples: slot.examples } : {}),
          };
        }
      }
    }
  }

  if (Object.keys(properties).length > 0) {
    specialized.parameters.properties.attributes = {
      type: 'object',
      description: `Structured product attribute filters matching this catalogue: ${Object.keys(properties).join(', ')}.`,
      properties,
    };
  }

  return specialized;
}

/**
 * Returns available agent tool definitions tailored to the tenant's pack and OKF release.
 * If the pack defines no calculators, calculate_quantity is omitted.
 */
export function getAgentToolDefinitions(
  release?: BusinessPackContent | null,
  okfContent?: any,
  person?: { audience: 'shopper' | 'staff'; groups: string[] }
): AgentToolDefinition[] {
  const calculators =
    (release as any)?.calculators ||
    (okfContent as any)?.calculators ||
    [];

  const hasCalculators = Array.isArray(calculators) && calculators.length > 0;

  const forms = formsOf(release, person);

  return AGENT_TOOL_DEFINITIONS.filter((tool) => {
    if (tool.name === 'calculate_quantity' && !hasCalculators) {
      return false;
    }
    // A shop with no forms has nothing to open.
    if (tool.name === 'open_form' && forms.length === 0) {
      return false;
    }
    if (isCustomerAccountTool(tool.name) && !customerAccountSettings(release).enabled) return false;
    return true;
  }).map((tool) => {
    if (tool.name === 'search_products') {
      return specializeSearchProductsTool(tool, release);
    }
    if (tool.name === 'open_form') {
      const list = forms.map((form) => `${form.formId}: ${form.title}${form.whenToOffer ? ` (${form.whenToOffer})` : ''}`).join('; ');
      return { ...tool, description: `${tool.description} The forms this shop offers: ${list}.` };
    }
    return tool;
  });
}

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'consult_business_knowledge',
    description: 'Look up verified business knowledge: project recipes, product family notes, relationships (what accessories go with what), care and installation notes, and document pointers. Returns compact notes with source IDs.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The project, product category, or technical question to consult.',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_products',
    description: 'Search the product catalogue using keywords, categories, and structured product attributes. Returns matching products with SKU, title, price, category, and description. To check branch inventory availability or whether an item is in stock, use check_stock.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search keywords or phrases for products.',
        },
        productType: {
          type: 'string',
          description: 'The kind of product, as a group or shelf name the catalogue or an earlier overview uses. A brand goes in brand, and what it is for or where it goes belongs in keywords. A name that matches no group makes the search drop this filter.',
        },
        attributes: {
          type: 'object',
          description: 'Structured product attribute filters (e.g. key-value pairs matching product specifications).',
        },
        brand: {
          type: 'string',
          description: 'Brand name filter, for a brand the customer named.',
        },
        category: {
          type: 'string',
          description: 'Optional category name filter.',
        },
        categoryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional category IDs for scoping search to specific shelf tree categories.',
        },
        categoryPaths: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Optional category hierarchy paths for scoping search.',
        },
        minPrice: {
          type: 'number',
          description: 'Minimum price filter.',
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price filter.',
        },
        inStockOnly: {
          type: 'boolean',
          description: 'Only show in-stock products.',
        },
        query: {
          type: 'string',
          description: 'Optional raw query keywords if not passing structured keywords array.',
        },
      },
    },
  },
  {
    name: 'browse_range',
    description: 'Describe what the range holds when the customer names a group of products rather than one item (a general word, a department, a material). Returns the product groups that match, the smaller groups each one splits into, how many products are in each, a few real example products, and the groups customers commonly buy with it. Use it only when the request is a general group word with nothing that narrows it down (no variant, brand or purpose): explain the groups to the customer and ask what you need to narrow down. A request that names any of those goes straight to search_products. After an overview, narrow with search_products, using a returned group path as categoryPaths if useful. goesWith entries are suggestions only, not confirmed compatible or required.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The customer\'s own word or phrase for the range.',
        },
        path: {
          type: 'array',
          items: { type: 'string' },
          description: 'A group path returned by an earlier browse_range call, to open that group.',
        },
      },
    },
  },
  {
    name: 'explore_options',
    description:
      'See what a group of products can be told apart by in this shop: the real brands, sizes, pack sizes and range variants (usually colours or finishes) the matching products come in, with counts. ' +
      'Use it for a broad request before you ask the customer anything, so every option you offer is one the shop really has. Give the same scope you would give search_products (productType, keywords, categoryPaths copied from browse_range).',
    parameters: {
      type: 'object',
      properties: {
        productType: { type: 'string', description: 'The group\'s name, as browse_range returned it.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Words the product names contain (a range, a brand, a feature the products state).' },
        categoryPaths: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Group paths returned by browse_range, to look inside those groups only.' },
      },
    },
  },
  {
    name: 'get_product',
    description: 'Retrieve full specifications, details, and pricing for a specific SKU from the catalogue. To check branch inventory availability or whether an item is in stock, use check_stock.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The exact SKU identifier of the product.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'get_related_products',
    description: 'Find companion items, accessories, system components, or alternatives for a product from verified OKF relationships and catalogue data.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The SKU of the main product.',
        },
        kind: {
          type: 'string',
          enum: ['required', 'recommended', 'alternative', 'accessory', 'system'],
          description: 'The kind of relationship: required accessories, recommended companion items, system parts, or alternatives.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'search_guides',
    description: 'Search the shop\'s verified general guides and how-to documents by topic. Returns guidance steps and document links. It does NOT read the guide that comes with one specific product (its specification guide, installation guide or manual): for that call read_product_guide with the product\'s SKU.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The installation, care, or how-to query.',
        },
        productOrCategory: {
          type: 'string',
          description: 'The product title, SKU, or category to focus on.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_product_guide',
    description: 'Read the supplier\'s own guide for ONE product (its specification guide, installation guide or instruction manual) as kept with the product record. Use it whenever the customer asks what a product\'s guide says, how to fix, install, apply or use it, or for a limit, spacing, coverage or drying figure. Returns the passages that answer the question, in the supplier\'s words, with the guide they came from.',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'The SKU of the product whose guide to read (the product the customer is looking at, if they opened one). Never invent one: if you do not have it, leave it out and give product instead.' },
        product: { type: 'string', description: 'When you do not have the SKU: the words that name the product, as the customer said them (for example "glulam post 88 x 88 2.7m pre-primed H5"). The guide is read if exactly one product fits; otherwise you get the closest products to choose from.' },
        question: { type: 'string', description: 'What the customer wants to know, in their own words (for example "how far apart do the fixings go"). Leave out to read the start of the guide.' },
        guide: { type: 'string', description: 'Optional: read only one guide, by part of its title (for example "Installation") when the product has several.' },
        from: { type: 'number', description: 'Optional, with one guide: the passage number to read from, to keep reading after a first read said there is more.' },
      },
      required: [],
    },
  },
  {
    name: 'review_cart',
    description: 'Make the last look at the customer\'s order before payment: quantities (what the numbers cover), what else the order may still need, pick-up or delivery and where it is in stock, and warranty and guides, from the shop\'s own records. Call it when the customer wants to check their order or is about to pay (the order\'s lines come from their action, or from items you pass). It returns the findings; then show them with present_card (cardType review: the runtime builds the card from this result).',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', description: 'Optional: the order\'s lines when the customer\'s action did not carry them, each {sku, quantity}.', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'number' } }, required: ['sku'] } },
      },
      required: [],
    },
  },
  {
    name: 'open_form',
    description: 'Open one of the shop\'s own forms in front of the customer so they can fill it in and send it (to contact the shop, make an enquiry, ask for a call back). Use it when the customer wants to get in touch, wants a person to follow something up, or asks to send the shop a message; do not collect their details in the chat instead. You may pass values the customer has already given, by field id. The form is the shop\'s: you cannot change its fields. Once the customer sends it you are told and can confirm.',
    parameters: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Which form, by the id in the list of forms below.' },
        prefill: { type: 'object', description: 'Optional: what the customer has already told you, as {fieldId: value}. Only fields the form has are used.' },
      },
      required: ['formId'],
    },
  },
  {
    name: 'read_content_page',
    description: 'Read the shop\'s OWN web pages: project how-tos and guides, inspiration and ideas, compliance and building-code notes (for example the energy-efficiency pages), and pages about the tools and services the shop offers. Give what the customer wants to know in their words and it finds the best pages and returns the passages that answer, with the page\'s link and the real products the page features. Use it for ideas, how a project is done and what it involves, compliance questions and how the shop\'s tools and services work. For the guide of one specific product use read_product_guide instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the customer wants to know, in their own words (for example "ideas for an outdoor entertaining area" or "how do I show a building meets the energy rules").' },
        page: { type: 'string', description: 'Optional: open one page, by the page id a previous result gave, its link, or its exact title.' },
        from: { type: 'number', description: 'Optional, with a page: the passage number to read from, to keep reading a long page.' },
      },
      required: [],
    },
  },
  {
    name: 'get_warranty',
    description: 'Retrieve verified warranty periods, terms, and compliance certificates for a product or brand.',
    parameters: {
      type: 'object',
      properties: {
        productOrBrand: {
          type: 'string',
          description: 'The product title, SKU, or brand name.',
        },
      },
      required: ['productOrBrand'],
    },
  },
  {
    name: 'calculate_quantity',
    description: 'Deterministically calculate material quantities, item counts, or coverage for a project from customer measurements using verified data-defined formulas. Returns missing inputs if required measurements are not provided.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'The project or calculation type matching an available calculator.',
        },
        measurements: {
          type: 'object',
          description: 'Key-value pairs of project measurements (e.g. area, length, width, height).',
        },
      },
      required: ['project', 'measurements'],
    },
  },
  {
    name: 'check_stock',
    description: 'Stock for a product SKU. When the business\'s stock system is connected it returns the figures branch by branch (on hand, reserved, available); otherwise it returns the catalogue\'s shop-wide in-stock flag and says so, and a branch\'s stock stays unverified. Only a check_stock result supports claiming an item is in stock or out of stock, and only a branch row from it supports saying what a branch holds.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The product SKU.',
        },
        branch: {
          type: 'string',
          description: 'The branch, store, or warehouse name.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'use_skill',
    description:
      'Open one of your on-demand skills: a set of instructions for a kind of request listed under "Skills you can open" in your instructions. ' +
      'Open the skill whose description fits the customer\'s request, read it, then follow it. Skills you already carry are in your instructions and need no call.',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The id of the skill to open, as listed under "Skills you can open".' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'estimate_quantity',
    description:
      'Work out how many of one product a customer needs for an area, from numbers that are really known: the customer\'s area, the size of one piece in the product\'s name, or the coverage of one pack (stated in the product\'s record, or read off the pack by the customer). ' +
      'Use it when the customer wants to buy something that covers an area before you offer to add it. If it says what is missing, ask the customer for exactly that. Never guess a coverage figure.',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'The SKU of the product, from an earlier tool result.' },
        area: { type: 'number', description: 'The area the customer gave, as a number.' },
        areaUnit: { type: 'string', description: 'The unit the customer used for the area: m2 (the default) or ft2.' },
        coveragePerPack: { type: 'number', description: 'Square metres one pack covers, only when the customer or the product\'s record states it.' },
        coats: { type: 'number', description: 'How many coats or layers, when the customer said (1 otherwise).' },
        allowancePercent: { type: 'number', description: 'An allowance for cuts and waste the customer asked for, when it differs from the shop\'s usual one.' },
      },
      required: ['sku', 'area'],
    },
  },
  {
    name: 'generate_visual',
    description:
      'Make an illustration of the customer\'s project with the products they are considering (for example their patio laid with the pavers they like), so they can picture it. ' +
      'Use it only when the customer asks to see it or when a picture would clearly help them decide. The picture is an illustration, not the exact product; the card says so. It takes several seconds.',
    parameters: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'What to show, in plain words from the customer\'s own description of their space and what they want (no product names needed).' },
        skus: { type: 'array', items: { type: 'string' }, description: 'Up to five SKUs of products from this turn\'s tool results to feature (their names set the colours and materials).' },
      },
      required: ['scene'],
    },
  },
  {
    name: 'present_card',
    description: 'Present an interactive UI card in the customer interface from the approved catalogue (e.g. products, productDetail, comparison, bundle, clarify, accessories, warranty, guide, plan). Every SKU on the card must come from a tool result of this turn.',
    parameters: {
      type: 'object',
      properties: {
        cardType: {
          type: 'string',
          enum: [
            'products',
            'productDetail',
            'comparison',
            'bundle',
            'quote',
            'cart',
            'orderStatus',
            'guide',
            'plan',
            'clarify',
            'suggestions',
            'accessories',
            'warranty',
            'quantity',
            'visual',
            'fitment',
            'disclosure',
            'hero',
            'working',
          ],
          description: 'The approved card type name.',
        },
        state: {
          type: 'object',
          description:
            'The card state data matching the card type schema. products: {"products":[{"sku":"...","reason":"why it fits"}]}. accessories: {"forSku":"...","heading":"...","groups":[{"key":"short-key","label":"group name","hint":"what it is for","items":[{"sku":"..."}]}]}. quantity: {"product":{"sku":"..."}} (the number and working are filled in from estimate_quantity). visual: {"caption":"..."} (the picture is filled in from generate_visual). For a clarify card the state is {"questions":[{"id":"a short key","text":"the question in plain words",' +
            '"options":["a tappable choice","another choice"],"inputType":"single_select" | "multi_select" | "number" | "text","unit":"shown beside a number","min":lowest usual number,"max":highest usual number}]} ' +
            'with at most three questions; leave options out for a number or text question, and give a unit for a number. For a number question give a min and a max taken from what you have looked up (the sizes the products really come in), never guessed: a number outside them is checked with the customer ("did you mean…?") instead of being taken as typed, so a slip such as 18 for 1.8 is caught. The options of one question must be different from each other: no choice may contain or overlap another (not "up to 3" beside "2 to 4"). The customer taps or types the answers, and they come back to you together as one message.',
        },
      },
      required: ['cardType', 'state'],
    },
  },
  {
    name: 'hand_off_to_human',
    description: 'Escalate the conversation to a qualified human staff member or customer service specialist when requested or out of scope.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'The reason for escalating to a human specialist.',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'create_quote',
    description: 'Request creation of a formal quote for specified items and quantities. The server verifies items against catalogue pricing, applies customer account terms, and checks required approvals. The model proposes, the server decides.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'List of items to include in the quote with sku and quantity.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Product SKU code.' },
              quantity: { type: 'number', description: 'Item quantity.' },
              name: { type: 'string', description: 'Optional item title or description.' },
            },
            required: ['sku', 'quantity'],
          },
        },
        category: { type: 'string', description: 'Optional project or item classification category.' },
        projectDimensions: { type: 'string', description: 'Optional project specifications or measurements.' },
        currency: { type: 'string', description: 'Optional currency code (must match pack currency).' },
        accountNumber: { type: 'string', description: 'Optional customer account number.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'update_quote',
    description: 'Update an existing quote with revised specifications, quantities, or line items. Modifying finalized quotes or exceeding approval thresholds triggers server approval.',
    parameters: {
      type: 'object',
      properties: {
        quoteId: { type: 'string', description: 'Existing quote identifier.' },
        items: {
          type: 'array',
          description: 'Updated line items for the quote.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Product SKU.' },
              quantity: { type: 'number', description: 'Quantity.' },
            },
            required: ['sku', 'quantity'],
          },
        },
        specs: { type: 'array', description: 'Optional project specifications or configuration items.' },
        notes: { type: 'string', description: 'Optional notes explaining the update.' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'add_to_quote',
    description: 'Add new items or specifications to an existing quote.',
    parameters: {
      type: 'object',
      properties: {
        quoteId: { type: 'string', description: 'Existing quote identifier.' },
        items: {
          type: 'array',
          description: 'Items to append to the quote.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Product SKU.' },
              quantity: { type: 'number', description: 'Quantity.' },
            },
            required: ['sku', 'quantity'],
          },
        },
      },
      required: ['quoteId', 'items'],
    },
  },
  {
    name: 'get_cart',
    description: 'Retrieve current customer cart items, quantities, and totals.',
    parameters: {
      type: 'object',
      properties: {
        cartId: { type: 'string', description: 'Optional cart identifier.' },
      },
    },
  },
  {
    name: 'update_cart',
    description: 'Update the customer cart by adding, modifying, or removing items.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Items and quantities to update in the cart.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'Product SKU.' },
              quantity: { type: 'number', description: 'Quantity.' },
            },
            required: ['sku', 'quantity'],
          },
        },
        cartId: { type: 'string', description: 'Optional cart identifier.' },
        category: { type: 'string', description: 'Optional category tag.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'get_journey_checklist',
    description: 'Inspect what has already happened in this conversation (e.g. products selected, accessories checked, guides read, quantity calculated, stock checked) and the progress through the agent playbook stages.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional filter for specific checklist aspects.',
        },
      },
      required: [],
    },
  },
  // Generic tools for reaching connectors; offered only when the pack declares connectors this person may use.
  ...CONNECTOR_META_TOOL_DEFINITIONS,
  // A signed-in trade customer's own account; offered only to a customer the team has linked to a company, and only when the pack turns it on.
  ...CUSTOMER_ACCOUNT_TOOL_DEFINITIONS,
];

/**
 * Checks if a tool is read-only (can be executed in parallel with other read-only tools).
 */
export function isReadOnlyTool(toolName: string): boolean {
  const mutatingTools = new Set([
    'present_card',
    'hand_off_to_human',
    'create_quote',
    'update_quote',
    'add_to_quote',
    'update_cart',
    'add_to_cart',
    // A connector tool may change data in the other system, so connector calls run one at a time.
    'call_connector_tool',
  ]);
  return !mutatingTools.has(toolName);
}

/**
 * Executes an individual tool call within the server-verified execution context.
 * Strictly enforces tenant isolation: no tool receives tenantId or environmentId from model arguments.
 */
/**
 * A tool whose state for this person is "ask first" does not run: the call is kept by the server and a card asks the person to allow it
 * once (see confirmation.ts). The model is told nothing has run and to wait. Without somewhere to keep the call it fails closed.
 */
function holdForConfirmation(toolName: string, args: Record<string, any>, prompt: string | undefined, ctx: AgentToolContext, detailsFrom?: Record<string, unknown>): any {
  if (!ctx.workspace) return { ok: false, error: 'This needs the person\'s yes and there is nowhere to keep the question, so it was not done. Say you cannot do it here.' };
  const wording = ctx.confirmationWording || {};
  const { pending, reused } = createPendingConfirmation(ctx.workspace as any, { toolId: toolName, args, summary: prompt || defaultPrompt(wording), principalId: ctx.principalId || 'anonymous', ...(detailsFrom ? { detailsFrom } : {}) });
  if (!reused) {
    const state = confirmCardState(pending, wording);
    ctx.presentedCards.push({ cardType: 'confirm', state });
    ctx.emitUiAction?.({ name: 'presentCard', arguments: { card: { id: `confirm-${pending.id}`, cardType: 'confirm', state } } });
  }
  return {
    ok: false,
    status: 'needs_confirmation',
    confirmationId: pending.id,
    message: 'The person has been asked to allow this and nothing has run yet. Do not call it again. Say in one short sentence what you are waiting for.',
  };
}

/** The shop's own "what the job needs" rule for this product, when one applies (pack `extensions.accessoryHelper.mustHave`). */
type MustHaveRule = { when: string[]; needs: Array<{ label: string; query: string; reason?: string; maxItems?: number }> };
export function mustHaveRuleFor(rules: unknown, product: any): MustHaveRule | undefined {
  if (!Array.isArray(rules) || !product) return undefined;
  const trail = (Array.isArray(product.categoryTrail) ? product.categoryTrail : []).map((segment: unknown) => String(segment).trim().toLowerCase());
  const nameWords = String(product.title || product.name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (rules as MustHaveRule[]).find((rule) => Array.isArray(rule?.when) && rule.when.some((word) => {
    const w = String(word).trim().toLowerCase();
    return Boolean(w) && (trail.includes(w) || nameWords.includes(w));
  }));
}

export async function executeAgentTool(
  toolName: string,
  rawArgs: Record<string, any>,
  ctx: AgentToolContext,
  options: { confirmed?: boolean } = {}
): Promise<any> {
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason || new Error('Agent turn aborted');
  }

  // Strip any model-injected tenant or environment properties
  const args = { ...rawArgs };
  delete args.tenantId;
  delete args.environmentId;

  // What this tool may do for this person: not at all, only with their yes, or freely (the pack's tool state table).
  if (ctx.toolStateOf && !options.confirmed) {
    const effective = ctx.toolStateOf(toolName);
    if (effective.state === 'blocked') {
      return { ok: false, blocked: true, error: `"${toolName}" is not available to this person. Do not try it again; say plainly that you cannot do that for them here.` };
    }
    if (effective.state === 'ask') return holdForConfirmation(toolName, args, effective.prompt, ctx);
  }

  switch (toolName) {
    case 'get_journey_checklist': {
      return deriveJourneyChecklist(ctx);
    }

    case 'consult_business_knowledge': {
      const topic = String(args.topic || '').trim();
      if (!ctx.okfContent || !topic) {
        if (topic && ctx.knowledgeGapRepo) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic,
            toolName: 'consult_business_knowledge',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return {
          found: false,
          knowledge: !ctx.okfContent
            ? 'No pinned business knowledge release available for this tenant.'
            : 'No topic specified.',
        };
      }

      const activeConcepts = findRelevantOkfConcepts(ctx.okfContent, {
        customerQuestion: topic,
        maxConcepts: 4,
      });

      const notesBlock = extractRelevantOkfNotes(ctx.okfContent, {
        customerQuestion: topic,
        maxChars: 3000,
      });

      if (!notesBlock || activeConcepts.length === 0) {
        if (ctx.knowledgeGapRepo && topic) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic,
            toolName: 'consult_business_knowledge',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return {
          found: false,
          topic,
          knowledge: 'No specific notes found for this topic.',
        };
      }

      // Extract source IDs mentioned in notes: [source: ...]
      const sourceMatches = notesBlock.matchAll(/\[source:\s*([^\]]+)\]/g);
      for (const m of sourceMatches) {
        if (m[1]) ctx.readSourceIds.add(m[1].trim());
      }

      // Add classes only when it returned notes from concepts whose OKF verification is currently valid
      // (reusing the gate's effectiveVerification / scopedClaims logic) and only for those classes.
      const now = new Date();
      const verifications = new Map((ctx.okfContent.verifications || []).map((v) => [v.recordId, v]));

      for (const concept of activeConcepts) {
        if (ctx.consultedConcepts) ctx.consultedConcepts.add(concept);

        // Concept verification record check
        const vRecord = concept.verificationRef
          ? verifications.get(concept.verificationRef)
          : (ctx.okfContent.verifications || []).find(
              (v) => v.targetType === 'concept' && v.targetId === concept.conceptId
            );
        if (vRecord && effectiveVerification(vRecord, now) !== 'verified') {
          continue;
        }

        // Use scopedClaims to get verified claim classes for this concept's relationships
        const { allowed } = scopedClaims(ctx.okfContent, concept.conceptId, now);
        for (const claimClass of allowed) {
          if (claimClass !== 'suggestion') {
            ctx.allowedClaimClasses.add(claimClass);
          }
        }
      }

      const concepts = ctx.okfContent.concepts || [];
      const relationships = ctx.okfContent.relationships || [];
      const conceptMap = new Map<string, OkfConcept>(concepts.map((c) => [c.conceptId, c]));
      const activeIds = new Set<string>(activeConcepts.map((c) => c.conceptId));
      const agentOverride =
        ctx.agentRelationshipTypes ||
        (ctx.release as any)?.agentConfig?.agentRelationshipTypes ||
        (ctx.release as any)?.extensions?.agentRelationshipTypes;
      const allowedRelationshipTypes = resolveAgentRelationshipTypes(ctx.okfContent, agentOverride);

      const relevantRels = relationships.filter(
        (r) => (activeIds.has(r.from) || activeIds.has(r.to)) && allowedRelationshipTypes.has(r.type)
      );

      // 1. Descriptions
      const descriptions = activeConcepts
        .filter((c) => c.description)
        .map((c) => ({ concept: c.name, description: c.description! }));

      // 2. Synonyms
      const synonyms = activeConcepts
        .filter((c) => Array.isArray(c.synonyms) && c.synonyms.length > 0)
        .map((c) => ({ concept: c.name, synonyms: c.synonyms! }));

      // 3. Relationships
      const structuredRelationships = relevantRels.map((r) => {
        const fromConcept = conceptMap.get(r.from);
        const toConcept = conceptMap.get(r.to);
        return {
          relationshipId: r.relationshipId,
          type: r.type,
          from: fromConcept?.name || r.from,
          to: toConcept?.name || r.to,
          label: r.customerLabel || `${r.type} ${toConcept?.name || r.to}`,
        };
      });

      // 4. Install and care notes
      const installAndCareNotes: Array<{ concept: string; type: string; notes: string }> = [];
      for (const c of activeConcepts) {
        if ((c as any).installNotes) {
          installAndCareNotes.push({ concept: c.name, type: 'install', notes: (c as any).installNotes });
        }
        if ((c as any).careNotes) {
          installAndCareNotes.push({ concept: c.name, type: 'care', notes: (c as any).careNotes });
        }
      }
      for (const r of relevantRels) {
        if (['installed_with', 'care_for'].includes(r.type)) {
          const fromConcept = conceptMap.get(r.from);
          const toConcept = conceptMap.get(r.to);
          installAndCareNotes.push({
            concept: fromConcept?.name || r.from,
            type: r.type,
            notes: r.customerLabel || `${r.type} ${toConcept?.name || r.to}`,
          });
        }
      }

      // 5. Evidence
      const evidence: Array<{ sourceId: string; title: string; kind?: string; uri?: string }> = [];
      for (const c of activeConcepts) {
        const refs = (c as any).evidenceRefs || (c as any).sourceRefs || [];
        for (const refId of refs) {
          const src = (ctx.okfContent.sources || []).find((s) => s.sourceId === refId);
          if (src && !evidence.some((e) => e.sourceId === src.sourceId)) {
            evidence.push({
              sourceId: src.sourceId,
              title: src.title,
              kind: src.kind,
              uri: (src as any).uri || (src as any).officialUri,
            });
          }
        }
      }

      // 6. Hints: flow fields (questions) only as hints, never forced questions or response modes
      const factRegistry = (ctx.okfContent.factRegistry || (ctx.okfContent as any).facts || []) as Array<{ factKey: string; question?: string }>;
      const factMap = new Map(factRegistry.map((f) => [f.factKey, f]));
      const hints: string[] = [];
      for (const c of activeConcepts) {
        if (Array.isArray(c.discriminators)) {
          for (const d of c.discriminators) {
            const f = factMap.get(d.factKey);
            if (f?.question && !hints.includes(f.question)) {
              hints.push(f.question);
            }
          }
        }
        if (Array.isArray(c.requiredFacts)) {
          for (const rf of c.requiredFacts) {
            const f = factMap.get(rf.factKey);
            if (f?.question && !hints.includes(f.question)) {
              hints.push(f.question);
            }
          }
        }
      }

      // 7. Search scopes from the shelf tree (used only as a map for scoping a search)
      const conceptScopes = activeConcepts
        .filter((c) => c.searchScope)
        .map((c) => ({
          catalogCategoryIds: c.searchScope?.catalogCategoryIds || [],
          catalogCategoryPaths: c.searchScope?.catalogCategoryPaths || [],
        }));
      const mergedScope = mergeSearchScopes(conceptScopes);
      const searchScopes = {
        categoryIds: mergedScope.categoryIds,
        categoryPaths: mergedScope.categoryPaths,
        byConcept: activeConcepts.map((c) => ({
          conceptId: c.conceptId,
          name: c.name,
          categoryIds: c.searchScope?.catalogCategoryIds || [],
          categoryPaths: c.searchScope?.catalogCategoryPaths || [],
        })),
      };

      return {
        found: true,
        topic,
        knowledge: notesBlock,
        descriptions,
        synonyms,
        relationships: structuredRelationships,
        installAndCareNotes,
        evidence,
        sourceIds: Array.from(ctx.readSourceIds),
        hints,
        searchScopes,
      };
    }

    case 'browse_range': {
      const topic = String(args.topic || '').trim();
      const path = Array.isArray(args.path) ? args.path.map(String).map((segment: string) => segment.trim()).filter(Boolean) : undefined;
      if (!topic && !(path && path.length > 0)) {
        return { found: false, message: 'Give a topic (the customer\'s own word for the range) or a group path from an earlier result.' };
      }
      const execCtx: any = makeExecContext(ctx);
      const result = await browseRange({
        okf: ctx.okfContent,
        locale: (ctx.release as any)?.profile?.primaryLocale,
        topic,
        alsoSaid: ctx.customerQuestion,
        path,
        count: (paths) => ctx.catalogSearchHandler.countInCategoryPaths(paths, execCtx),
        examples: async (groups, prefer) => {
          const lookUp = async (subset: typeof groups, keywords: string[]) => {
            const searched = await ctx.catalogSearchHandler.execute({ isAgentMode: true, groups: subset, ...(keywords.length > 0 ? { keywords } : {}) } as any, execCtx);
            return (Array.isArray(searched.groups) ? searched.groups : []) as any[];
          };
          // Examples that carry the customer's own extra words come first; a group with none of those shows its usual examples.
          let found = await lookUp(groups, prefer);
          const empty = prefer.length > 0 ? groups.filter((group) => !(found.find((f) => f.conceptId === group.conceptId)?.items || []).length) : [];
          if (empty.length > 0) found = [...found.filter((f) => (f.items || []).length > 0), ...(await lookUp(empty, []))];
          return found.map((group: any) => ({
            conceptId: group.conceptId,
            items: (Array.isArray(group.items) ? group.items : [])
              .filter((p: any) => p?.sku && !isProductDiscontinued(p))
              .map((p: any) => {
                // The same registration a search does, so these products can be put on a card this turn.
                ctx.turnProductSkus.add(p.sku);
                ctx.catalogProductCache.set(p.sku, p);
                return {
                  sku: p.sku,
                  title: p.title || p.name,
                  price: p.priceUSD?.min ?? p.price ?? null,
                  currency: p.currency || ctx.release.profile?.primaryCurrency,
                };
              }),
          }));
        },
      });
      if (!result.found) {
        if (ctx.knowledgeGapRepo && topic) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic,
            toolName: 'browse_range',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return { found: false, topic, message: 'No product group in the knowledge matches this. Use search_products with the customer\'s own words.' };
      }
      ctx.allowedClaimClasses.add('catalog_fact');
      const leadGroup = result.nodes.find((node) => node.match === 'direct' && node.path) || result.nodes.find((node) => node.path);
      if (leadGroup?.path) ctx.lastRangeGroup = { name: leadGroup.name, path: leadGroup.path };
      if (leadGroup?.children && leadGroup.children.length >= 2) ctx.rangeShelves = leadGroup.children.map((child) => ({ name: child.name, productCount: child.productCount ?? 0 }));
      const messages: string[] = [];
      if (result.interpretedAs) {
        messages.push(`The word was not found as written; the closest known word was used instead (${result.interpretedAs.changes.map((c: any) => `"${c.from}" as "${c.to}"`).join(', ')}). Tell the customer which word you took it as, in one short clause, so they can correct you.`);
      }
      if (result.qualifiers && result.qualifiers.length > 0) {
        // The request says more than a group: an overview would show products that do not fit what was asked for.
        messages.push(`The request also says ${result.qualifiers.map((q: string) => `"${q}"`).join(', ')}, which this overview does not cover, so it is not the answer. Call search_products with productType set to the group's name and those words as keywords, and answer from what it returns.`);
      } else if (result.nodes.some((node) => (node.children || [node]).some((group) => (group.examples || []).length > 0))) {
        const exampleSkus = exampleOrder(result.nodes.flatMap((node) => (node.children && node.children.length > 0 ? node.children : [node])), result.interpretedAs?.topic ?? topic, (ctx.release as any)?.profile?.primaryLocale);
        ctx.lastProducts = { skus: exampleSkus, relaxed: false, source: 'overview' };
        messages.push('The example products are shown to the customer on a card right after your reply, with their photos, so write the reply now and do not list products, prices or SKUs in your text.');
      }
      return messages.length > 0 ? { ...result, message: messages.join(' ') } : result;
    }

    case 'estimate_quantity': {
      const sku = skuFromEvent(String(args.sku || '').trim(), ctx.customerEvent);
      const product = await findProductBySku(ctx, sku);
      if (!product) return { ok: false, error: `No product with SKU "${sku}" was found. Look the product up first.` };
      const config: QuantityHelperConfig = (ctx.release as any)?.extensions?.quantityHelper || {};
      const labels = { ...DEFAULT_QUANTITY_LABELS, ...((ctx.release as any)?.extensions?.quantityHelper?.labels || {}) };
      const areaM2 = areaToSquareMetres(Number(args.area), args.areaUnit ? String(args.areaUnit) : undefined, config.areaUnits);
      const optionalNumber = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : Number(value));
      const estimate = estimateQuantity(
        { title: product.title || product.name, texts: [product.description, ...(Array.isArray(product.highlights) ? product.highlights : [])] },
        { areaM2, coveragePerPack: optionalNumber(args.coveragePerPack), coats: optionalNumber(args.coats), allowancePercent: optionalNumber(args.allowancePercent) },
        config,
      );
      if (estimate.ok === false) {
        const failed = estimate as Extract<QuantityEstimate, { ok: false }>;
        return {
          ok: false,
          sku,
          title: product.title || product.name,
          missing: failed.missing,
          message: failed.reason === 'no_coverage'
            ? 'Neither the product\'s name nor its record says how much one piece or pack covers, so there is no honest number yet. Say so plainly, and ask the customer to read the coverage off the pack or the manufacturer\'s notes (or give you the number of pieces they want), then call this again with coveragePerPack.'
            : 'The area is missing or not a usable number: ask the customer for it (a number and a unit).',
        };
      }
      const unitLabel = estimate.basis === 'piece_size' ? labels.pieces : labels.packs;
      const fmt = (value: number) => String(Math.round(value * 100) / 100);
      const working: Array<{ label: string; value: string }> = [
        { label: labels.area, value: `${fmt(estimate.areaM2)} ${labels.areaUnit}` },
        { label: estimate.basis === 'piece_size' ? labels.perPiece : labels.perPack, value: `${fmt(estimate.coveragePerUnitM2)} ${labels.areaUnit}` },
        ...(estimate.coats > 1 ? [{ label: labels.coats, value: String(estimate.coats) }] : []),
        { label: labels.exact, value: `${estimate.exactUnits} ${unitLabel}` },
        ...(estimate.allowancePercent > 0 ? [{ label: labels.allowance, value: `${fmt(estimate.allowancePercent)}%` }] : []),
        { label: labels.total, value: `${estimate.units} ${unitLabel}` },
      ];
      const title = String(product.title || product.name || sku);
      const remembered = { ...estimate, title, unitLabel, working, ctaLabel: `${labels.add} ${estimate.units}` };
      (ctx.lastEstimates ||= new Map()).set(String(product.sku || sku), remembered);
      return {
        ok: true,
        sku: product.sku || sku,
        title,
        basis: estimate.basis,
        units: estimate.units,
        unitLabel,
        exactUnits: estimate.exactUnits,
        allowancePercent: estimate.allowancePercent,
        coveragePerUnitM2: estimate.coveragePerUnitM2,
        coverageSource: estimate.coverageSource,
        working,
        message: 'Say the number and what it is based on in a sentence or two, then show it on a quantity card (present_card, cardType quantity, product only: the number and working come from this result). Remind the customer to check their own measurements.',
      };
    }

    case 'generate_visual': {
      const config: VisualiserConfig & { enabled?: boolean } | undefined = (ctx.release as any)?.extensions?.visualiser;
      if (!config || config.enabled === false) return { ok: false, error: 'Pictures of the finished job are not switched on for this shop, so say you cannot make one and describe the idea in words instead.' };
      const scene = String(args.scene || '').trim();
      if (!scene) return { ok: false, error: 'Describe what to show, in the customer\'s own words.' };
      const skus: string[] = (Array.isArray(args.skus) ? args.skus : []).map(String).map((value: string) => value.trim()).filter(Boolean).slice(0, config.maxProducts ?? 5);
      const unverified = skus.filter((sku) => !ctx.turnProductSkus.has(sku));
      if (unverified.length > 0) return { ok: false, error: `SKU "${unverified[0]}" was not returned by a product tool in this turn. Look the products up first.` };
      const titles = skus.map((sku) => String(ctx.catalogProductCache.get(sku)?.title || '')).filter(Boolean);
      try {
        const made = await generateVisual({
          tenantId: ctx.tenantId, scene, productTitles: titles, config, signal: ctx.signal,
          fetchImpl: ctx.imageFetch, storeDir: ctx.visualStoreDir,
        });
        ctx.lastVisual = { id: made.id, urlPath: made.urlPath, skus };
        return {
          ok: true,
          products: skus,
          message: 'The picture is ready. Show it with present_card (cardType visual, no imageUrl needed: the runtime attaches the picture), with a one-sentence caption of what it shows, and say it is an illustration.',
        };
      } catch (err: any) {
        if (ctx.signal?.aborted) throw err;
        return { ok: false, error: `The picture could not be made (${String(err?.message || err).slice(0, 160)}). Say so plainly and describe the idea in words instead.` };
      }
    }

    case 'explore_options': {
      const keywordsRaw = args.keywords;
      const keywords: string[] = Array.isArray(keywordsRaw) ? keywordsRaw.map(String).map((k) => k.trim()).filter(Boolean) : [];
      const productType = args.productType ? String(args.productType).trim() : undefined;
      const categoryPaths = resolveCatalogPaths(ctx.okfContent, args.categoryPaths);
      if (keywords.length === 0 && !productType && !(categoryPaths && categoryPaths.length > 0)) {
        return { ok: false, error: 'Give a productType, keywords or categoryPaths so there is a group of products to look at.' };
      }
      const sample = await ctx.catalogSearchHandler.execute({
        isAgentMode: true,
        keywords: keywords.length > 0 ? keywords : undefined,
        productType,
        categoryPaths,
        relaxKeywordsFirst: true,
        facetSample: true,
        maxResults: 800,
      } as any, makeExecContext(ctx));
      const products = (Array.isArray(sample.items) ? sample.items : sample.products || []).filter((p: any) => !isProductDiscontinued(p));
      if (products.length === 0) return { ok: true, matched: 0, facets: [], message: 'No products match this scope, so there is nothing to ask the customer to choose between yet.' };
      let mapping: any;
      try { mapping = resolveCatalogMapping((ctx.release as any)?.catalogMapping); } catch { mapping = undefined; }
      const attributeDefinitions = mapping?.attributeDefinitions || (ctx.release as any)?.catalogMapping?.attributeDefinitions || {};
      const summary = summariseOptions(products, {
        attributesFromTitle: Object.keys(attributeDefinitions).length > 0
          ? (title) => extractSearchSpecs({ query: title, attributeDefinitions }).attributes || {}
          : undefined,
      });
      ctx.allowedClaimClasses.add('catalog_fact');
      // What the customer is choosing between at this level: the real groups of the scope and how many products each holds. The facets
      // above come from a sample of the products, so a group the sample happens to miss would never be offered; the question card is
      // checked against these groups instead (see question-shelves.ts).
      const scopeTopic = productType || keywords.join(' ');
      if (scopeTopic && ctx.okfContent) {
        try {
          const range = await browseRange({
            okf: ctx.okfContent,
            locale: (ctx.release as any)?.profile?.primaryLocale,
            topic: scopeTopic,
            count: (paths) => ctx.catalogSearchHandler.countInCategoryPaths(paths, makeExecContext(ctx) as any),
            examples: async () => [],
          });
          const lead = range.nodes.find((node) => node.match === 'direct') || range.nodes[0];
          if (lead?.children && lead.children.length >= 2) ctx.rangeShelves = lead.children.map((child) => ({ name: child.name, productCount: child.productCount ?? 0 }));
        } catch { /* the check is a safeguard: without the groups the question is simply not checked */ }
      }
      return {
        ok: true,
        matched: summary.matched,
        ...(ctx.rangeShelves && ctx.rangeShelves.length >= 2 ? { groups: ctx.rangeShelves.map((shelf) => ({ group: shelf.name, products: shelf.productCount })) } : {}),
        facets: summary.facets,
        message: summary.facets.length === 0
          ? 'The matching products do not differ in anything the names show, so ask the customer about the job (where, how much) instead.'
          : 'Offer the customer only values listed here, for the facets that matter to their job; a facet that covers few of the products (low coverage) is a weak thing to ask about. When you ask what kind of thing they want, `groups` are the real groups of this range with their sizes: offer every group that holds a fair share, not only the ones in the facets.',
      };
    }

    case 'search_products': {
      const keywordsRaw = args.keywords;
      const keywords: string[] = Array.isArray(keywordsRaw)
        ? keywordsRaw.map(String).map((k) => k.trim()).filter(Boolean)
        : (typeof keywordsRaw === 'string' && keywordsRaw.trim())
          ? [keywordsRaw.trim()]
          : [];
      const query = String(args.query || '').trim();
      const productType = args.productType ? String(args.productType).trim() : undefined;
      const brand = args.brand ? String(args.brand).trim() : undefined;
      const filters = args.filters || {};
      const category = args.category ? String(args.category).trim() : (filters.category ? String(filters.category).trim() : undefined);
      const categoryIds = Array.isArray(args.categoryIds)
        ? args.categoryIds.map(String).filter(Boolean)
        : (typeof args.categoryIds === 'string' && args.categoryIds.trim())
          ? [args.categoryIds.trim()]
          : undefined;
      // A scope the model composed itself (rather than copied from an overview) would match nothing and hide every product.
      const categoryPaths = resolveCatalogPaths(ctx.okfContent, args.categoryPaths);
      const minPrice = args.minPrice ?? filters.minPrice;
      const maxPrice = args.maxPrice ?? filters.maxPrice;
      const inStockOnly = args.inStockOnly ?? filters.inStockOnly;

      // Generic attributes resolution (R7)
      const rawAttrs = args.attributes || {};
      const attributes: Record<string, any> = { ...rawAttrs };

      // Fold top-level attributes into attributes map
      const knownTopLevel = new Set([
        'keywords', 'productType', 'brand', 'category', 'categoryIds',
        'categoryPaths', 'minPrice', 'maxPrice', 'inStockOnly', 'query',
        'filters', 'attributes',
      ]);
      for (const [k, v] of Object.entries(args)) {
        if (!knownTopLevel.has(k) && v !== undefined && v !== null && v !== '') {
          attributes[k] = v;
        }
      }

      const searchInput: any = {
        isAgentMode: true,
        keywords: keywords.length > 0 ? keywords : undefined,
        productType,
        brand,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        attributeFilters: Object.keys(attributes).length > 0 ? attributes : undefined,
        query: query || (keywords.length > 0 ? keywords.join(' ') : undefined),
        category,
        categoryIds,
        categoryPaths,
        minPriceCents: minPrice !== undefined ? Math.round(Number(minPrice) * 100) : undefined,
        maxPriceCents: maxPrice !== undefined ? Math.round(Number(maxPrice) * 100) : undefined,
        inStockOnly,
        // The agent often writes the room or job into the keywords; keep the product type rather than fall to unrelated shelves.
        relaxKeywordsFirst: true,
        maxResults: 6,
      };

      const result = await ctx.catalogSearchHandler.execute(searchInput, makeExecContext(ctx));

      const rawProducts = result.products || result.items || [];
      const products = (Array.isArray(rawProducts) ? rawProducts : []).filter(
        (p: any) => !isProductDiscontinued(p)
      );
      for (const p of products) {
        if (p.sku) {
          ctx.turnProductSkus.add(p.sku);
          ctx.catalogProductCache.set(p.sku, p);
        }
      }
      if (products.length > 0) {
        // Dropping the stock filter says nothing about whether these are the products asked for; dropping anything else does.
        ctx.lastProducts = { skus: products.map((p: any) => p.sku).filter(Boolean), relaxed: Boolean((result.relaxedConstraints || []).some((c: string) => c !== 'inStockOnly')) };
      }

      const displayQuery =
        query ||
        keywords.join(' ') ||
        [productType, brand, ...Object.values(attributes).map(String)].filter(Boolean).join(' ') ||
        'catalogue search';

      if (products.length === 0) {
        return {
          query: displayQuery,
          count: 0,
          products: [],
          message: `Could not find any products matching "${displayQuery}" in the catalogue. Please inform the customer that no matching products were found in the catalogue. Do NOT say the product is out of stock.`,
        };
      }

      ctx.allowedClaimClasses.add('catalog_fact');

      const relaxedConstraints: string[] | undefined = result.relaxedConstraints;
      const stockFilterDropped = Boolean(result.stockFilterDropped || relaxedConstraints?.includes('inStockOnly'));
      const response: any = {
        query: displayQuery,
        count: products.length,
        ...(stockFilterDropped ? { stockFilterDropped: true } : {}),
        products: products.map((p) => ({
          sku: p.sku,
          title: p.title || p.name,
          brand: p.brand || p.Brand || (p.attributes as any)?.brand || (p.attributes as any)?.Brand || undefined,
          price: p.priceUSD?.min ?? p.price ?? null,
          currency: p.currency || ctx.release.profile?.primaryCurrency,
          category: p.category,
          excerpt: p.description?.slice(0, 140),
          // What the catalogue's own record says beyond the name: why it might suit the job, and any warning it gives about its use.
          ...(Array.isArray(p.highlights) && p.highlights.length > 0 ? { highlights: p.highlights.slice(0, 3) } : {}),
          ...(Array.isArray(p.cautions) && p.cautions.length > 0 ? { caution: p.cautions[0] } : {}),
        })),
      };

      if (relaxedConstraints && relaxedConstraints.length > 0) {
        response.relaxedConstraints = relaxedConstraints;
        let msg = `No exact match found. The following search constraints were relaxed: ${relaxedConstraints.join(', ')}. Inform the customer that these close alternatives were found.`;
        if (stockFilterDropped) {
          msg += ` Stock filter was dropped: inventory availability has NOT been verified. You must NOT say or imply products are in stock, and should offer check_stock.`;
        }
        response.message = msg;
      } else if (stockFilterDropped) {
        response.message = `Stock filter was dropped: inventory availability has NOT been verified. You must NOT say or imply products are in stock, and should offer check_stock.`;
      }

      return response;
    }

    case 'get_product': {
      const sku = skuFromEvent(String(args.sku || '').trim(), ctx.customerEvent);
      // The exact identifier first: a text search can put another product ahead of the one asked for. Only when no product has that
      // identifier (the model gave a title or part of one) is the text searched, and then the best match is taken.
      const isSku = (p: any) => String(p?.sku).toLowerCase() === sku.toLowerCase();
      const exact = await ctx.catalogSearchHandler.execute({ sku, maxResults: 1 }, makeExecContext(ctx));
      let rawItems: any[] = exact.products || exact.items || [];
      if (!rawItems.some(isSku)) {
        const text = await ctx.catalogSearchHandler.execute({ query: sku, maxResults: 5 }, makeExecContext(ctx));
        rawItems = text.products || text.items || [];
      }
      const found = (rawItems || []).find(isSku) || rawItems?.[0];

      if (found && found.sku) {
        if (isProductDiscontinued(found)) {
          return {
            found: true,
            isDiscontinued: true,
            sku: found.sku,
            product: {
              sku: found.sku,
              title: found.title || found.name,
              status: 'Discontinued',
            },
            message: `Product SKU "${found.sku}" is discontinued and cannot be recommended, quoted, or added to cart. Please recommend active alternatives from the catalogue.`,
          };
        }

        ctx.turnProductSkus.add(found.sku);
        ctx.catalogProductCache.set(found.sku, found);
        ctx.allowedClaimClasses.add('catalog_fact');

        return {
          found: true,
          product: {
            sku: found.sku,
            title: found.title || found.name,
            description: found.description,
            price: found.priceUSD?.min ?? found.price ?? null,
            currency: found.currency || ctx.release.profile?.primaryCurrency,
            category: found.category,
            specs: found.specs || found.attributes,
            ...(Array.isArray(found.highlights) && found.highlights.length > 0 ? { highlights: found.highlights } : {}),
            ...(Array.isArray(found.cautions) && found.cautions.length > 0 ? { cautions: found.cautions } : {}),
            ...(typeof found.rating === 'number' ? { rating: found.rating, ratingCount: found.ratingCount } : {}),
          },
        };
      }

      return { found: false, sku, message: `Product SKU '${sku}' not found in catalogue.` };
    }

    case 'get_related_products': {
      const sku = skuFromEvent(String(args.sku || '').trim(), ctx.customerEvent);
      const kind = String(args.kind || 'recommended').toLowerCase();

      // Look up target product first
      let mainProd = ctx.catalogProductCache.get(sku);
      if (!mainProd) {
        const res = await ctx.catalogSearchHandler.execute(
          { sku, maxResults: 1 },
          makeExecContext(ctx)
        );
        const rawCandidates = res.products || res.items || [];
        mainProd = (rawCandidates || []).find((p: any) => String(p.sku).toLowerCase() === sku.toLowerCase());
        if (mainProd?.sku) {
          ctx.turnProductSkus.add(mainProd.sku);
          ctx.catalogProductCache.set(mainProd.sku, mainProd);
        }
      }

      // For some kinds of product the shop says what the job really needs (a vanity needs a basin mixer and a waste). When one applies,
      // only those are offered, found by the shop's own words in the catalogue; the knowledge's "also bought" suggestions are left out.
      const mustHaveRule = mustHaveRuleFor((ctx.release as any)?.extensions?.accessoryHelper?.mustHave, mainProd);
      const goesWith = mustHaveRule ? [] : goesWithForTrail(ctx.okfContent, mainProd?.categoryTrail);
      const execCtx: any = makeExecContext(ctx);
      let groups: Array<{ key: string; label: string; hint?: string; required?: boolean; items: any[] }> = [];
      if (mustHaveRule) {
        for (const need of mustHaveRule.needs) {
          const found = await ctx.catalogSearchHandler.execute({ query: need.query, maxResults: Math.max(need.maxItems ?? 3, 3) + 4 } as any, execCtx).catch(() => undefined);
          const items = ((found?.products || found?.items || []) as any[])
            .filter((p: any) => p?.sku && p.sku !== sku && !isProductDiscontinued(p))
            .sort((a: any, b: any) => Number(Boolean(b.inStock)) - Number(Boolean(a.inStock)))
            .slice(0, need.maxItems ?? 3);
          if (items.length === 0) continue;
          for (const it of items) { ctx.turnProductSkus.add(it.sku); ctx.catalogProductCache.set(it.sku, it); }
          groups.push({ key: need.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label: need.label, ...(need.reason ? { hint: need.reason } : {}), required: true, items });
        }
      }
      if (goesWith.length > 0) {
        const looked = await ctx.catalogSearchHandler.execute({
          isAgentMode: true,
          groups: goesWith.filter((group) => group.path).slice(0, 6).map((group) => ({ conceptId: group.conceptId, label: group.name, categoryPaths: [group.path!], maxItems: 3 })),
        } as any, execCtx);
        const byConcept = new Map<string, any[]>(((Array.isArray(looked.groups) ? looked.groups : []) as any[]).map((entry: any) => [entry.conceptId, entry.items || []]));
        groups = goesWith
          .map((group) => ({
            key: group.conceptId,
            label: group.label || group.name,
            items: (byConcept.get(group.conceptId) || []).filter((p: any) => p?.sku && p.sku !== sku && !isProductDiscontinued(p)),
          }))
          .filter((group) => group.items.length > 0);
        for (const group of groups) {
          for (const it of group.items) {
            ctx.turnProductSkus.add(it.sku);
            ctx.catalogProductCache.set(it.sku, it);
          }
        }
      }
      // No goes-with links in the knowledge for this shelf: the shop's own "have you considered" list on the product's record is the next
      // best grounded source. Products on the product's own shelf are its colours and sizes, not accessories, so they are left out.
      let source: 'knowledge' | 'must_have' | 'shop_suggestions' | 'none' = groups.length > 0 ? (mustHaveRule ? 'must_have' : 'knowledge') : 'none';
      if (groups.length === 0 && !mustHaveRule && Array.isArray(mainProd?.accessorySkus) && mainProd.accessorySkus.length > 0) {
        const shelf = (p: any) => (Array.isArray(p?.categoryTrail) ? p.categoryTrail.join('\u0001').toLowerCase() : '');
        const mainShelf = shelf(mainProd);
        const suggested: any[] = [];
        for (const suggestedSku of mainProd.accessorySkus.slice(0, 8)) {
          if (suggestedSku === sku) continue;
          const found = await findProductBySku(ctx, suggestedSku);
          if (!found || isProductDiscontinued(found)) continue;
          if (mainShelf && shelf(found) === mainShelf) continue;
          suggested.push(found);
        }
        if (suggested.length > 0) {
          const labels = (ctx.release as any)?.extensions?.accessoryHelper?.labels || {};
          groups = [{ key: 'shop-suggestions', label: String(labels.shopSuggestions || 'Suggested by the shop'), items: suggested.slice(0, 5) }];
          source = 'shop_suggestions';
        }
      }
      const compact = (p: any) => ({
        sku: p.sku,
        title: p.title || p.name,
        price: p.priceUSD?.min ?? p.price ?? null,
        currency: p.currency || ctx.release.profile?.primaryCurrency,
        inStock: Boolean(p.inStock),
      });
      if (groups.length > 0) ctx.allowedClaimClasses.add('catalog_fact');

      return {
        forSku: sku,
        kind,
        grounded: groups.length > 0,
        source,
        ...(groups.length > 0 ? { note: String((ctx.release as any)?.extensions?.accessoryHelper?.labels?.suggestionsNote || 'Suggestions to check, not confirmed requirements or compatibility.') } : {}),
        groups: groups.map((group) => ({ key: group.key, label: group.label, ...(group.hint ? { hint: group.hint } : {}), ...(group.required ? { required: true } : {}), items: group.items.map(compact) })),
        relatedProducts: groups.flatMap((group) => group.items.map((p: any) => ({ ...compact(p), relation: group.label, ...(group.hint ? { reason: group.hint } : {}) }))),
        message: source === 'must_have'
          ? 'These are the things this job needs, as the shop sets them out: each group is something the customer must have, with a real product list. Offer only these, with each group\'s hint as the reason; do not add extras such as mirrors or showers, and do not call anything else a requirement.'
          : source === 'shop_suggestions'
          ? 'The knowledge has no goes-with links for this shelf, but the shop\'s own product record suggests these items with it (not its own colours or sizes). They are suggestions to check, not confirmed requirements or compatibility. Show them on an accessories card and say in one sentence what each is for; you may still search for other kinds that usually go with it.'
          : groups.length > 0
          ? 'These are the groups customers commonly buy with this product, from the shop\'s own knowledge; each group lists real products. They are suggestions to check, not confirmed requirements or compatibility. Show them on an accessories card (one group per card group), and say in one sentence what each is for.'
          : 'The knowledge has no goes-with links for this product\'s shelf, so there is no verified list. Name, as suggestions to check, the kinds of product that usually go with it (from consult_business_knowledge and the guides), search_products for each kind, and show what you find on an accessories card. Never present the product\'s own alternatives as accessories.',
      };
    }

    case 'search_guides': {
      const query = String(args.query || '').trim();
      const productOrCategory = String(args.productOrCategory || '').trim();

      // Check OKF sources and evidence chunks
      const matchedGuides: any[] = [];
      if (ctx.okfContent?.evidenceChunks) {
        for (const chunk of ctx.okfContent.evidenceChunks) {
          const contentLower = chunk.content.toLowerCase();
          const titleLower = chunk.title.toLowerCase();
          const qTokens = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[^\w]/g, '')).filter((t) => t.length > 2);
          const matchCount = qTokens.filter((tok) => contentLower.includes(tok) || titleLower.includes(tok)).length;
          const matches = qTokens.length === 0 ? false : qTokens.length <= 2 ? matchCount === qTokens.length : matchCount >= Math.ceil(qTokens.length * 0.5);
          if (matches && (chunk.claimClasses.includes('installation_step') || chunk.claimClasses.includes('care_safety'))) {
            matchedGuides.push({
              sourceId: chunk.sourceRef,
              title: chunk.title,
              snippet: chunk.content.slice(0, 200),
            });
            ctx.readSourceIds.add(chunk.sourceRef);
            const chunkVer = (ctx.okfContent.verifications || []).find(
              (v) => (v.targetId === chunk.chunkId || v.sourceRefs.includes(chunk.sourceRef))
            );
            if (chunkVer && effectiveVerification(chunkVer, new Date()) === 'verified') {
              if (chunk.claimClasses.includes('installation_step')) ctx.allowedClaimClasses.add('installation_step');
              if (chunk.claimClasses.includes('care_safety')) ctx.allowedClaimClasses.add('care_safety');
            }
          }
        }
      }

      // Also look for document sources
      if (ctx.okfContent?.sources) {
        const qLower = query.toLowerCase().trim();
        const pLower = productOrCategory.toLowerCase().trim();
        for (const s of ctx.okfContent.sources) {
          const sTitle = s.title.toLowerCase();
          const matchesTitle =
            (Boolean(qLower) && sTitle.includes(qLower)) ||
            (Boolean(pLower) && sTitle.includes(pLower));
          if (matchesTitle) {
            matchedGuides.push({
              sourceId: s.sourceId,
              title: s.title,
              kind: s.kind,
              url: (s as any).uri || (s as any).officialUri,
            });
            ctx.readSourceIds.add(s.sourceId);
          }
        }
      }

      if (matchedGuides.length === 0) {
        const gapTopic = query || productOrCategory || 'guides';
        if (ctx.knowledgeGapRepo && gapTopic) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic: gapTopic,
            toolName: 'search_guides',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return {
          found: false,
          query,
          productOrCategory,
          guides: [],
          count: 0,
          ...productGuideHint(ctx),
        };
      }

      return {
        found: true,
        query,
        productOrCategory,
        guides: matchedGuides.slice(0, 3),
        count: matchedGuides.length,
        ...productGuideHint(ctx),
      };
    }

    case 'read_product_guide': {
      const config: { enabled?: boolean; unlocks?: string[]; maxPassages?: number; passageChars?: number; wholeGuideChars?: number } = (ctx.release as any)?.extensions?.productGuides || {};
      if (config.enabled === false) return { ok: false, error: 'Reading product guides is not switched on for this shop. Say you cannot read it here and point to the product page.' };
      const productWords = String(args.product || '').replace(/\s+/g, ' ').trim();
      let sku = skuFromEvent(String(args.sku || '').trim(), ctx.customerEvent);
      if (!sku && !productWords) return { ok: false, error: 'Give the SKU of the product whose guide to read, or the words that name the product (the product argument).' };
      let product = sku ? (await findProductBySku(ctx, sku)) || (await findProductByTitle(ctx, sku)) : undefined;
      let readFor: string | undefined;
      if (!product) {
        // The model often passes the product's words, a code or part of a title instead of the SKU. Find the product from those words: it is taken only when exactly one product names every word;
        // otherwise the closest products come back, with whether each has a guide, so the model can choose and read in the same turn.
        const near = await guideCandidates(ctx, productWords, sku);
        // Only words given as the product are matched this way; something passed as a SKU that is not one is never taken for a product, however close.
        const words = productWordsOf(productWords);
        const fits = productWords ? near.filter((c) => namesEveryWord(c.product, words)) : [];
        // Several products that fit are still one answer when every one of them keeps the very same guide: it is read once, and the reply says which products it covers.
        const sameGuide = fits.length > 1 && !!fits[0].guideKey && fits.every((c) => c.guideKey === fits[0].guideKey);
        if (fits.length === 1 || sameGuide) {
          product = fits[0].product;
          sku = String(product.sku);
          readFor = sameGuide ? `${fits[0].title} (the same guide is kept for: ${fits.slice(1).map((c) => c.title).join('; ')})` : fits[0].title;
        } else {
          const shown = near.map(({ sku: candidate, title: candidateTitle, hasGuide }) => ({ sku: candidate, title: candidateTitle, hasGuide }));
          return {
            ok: false,
            error: `No single product matched ${sku ? `"${sku}"` : 'those words'}.${shown.length ? ' These are the closest products to what the customer described. Call read_product_guide again NOW with the SKU of the one that best fits their words (prefer one that has a guide) and say in your answer which product you read it for; ask the customer only if the candidates are really different products and nothing in what they said separates them.' : ' Look the product up first (search_products), then call this with its SKU.'}`,
            ...(shown.length ? { candidates: shown } : {}),
          };
        }
      }
      const title = String(product.title || product.name || sku);
      const records = ctx.productGuideRepo ? await ctx.productGuideRepo.findForProducts(ctx.tenantId, [String(product.sku || ''), String(product.parentSku || ''), sku]) : [];
      if (records.length === 0) {
        if (ctx.knowledgeGapRepo) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic: `product guide: ${title}`,
            toolName: 'read_product_guide',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return {
          ok: true,
          found: false,
          sku: product.sku || sku,
          title,
          message: 'We do not have the text of a guide for this product. Say so the way one of us would ("I don\'t have the guide for this one to hand"), and do not describe what a guide for this kind of product usually says. Offer what we know about the product from get_product, or a colleague who can check the maker\'s guide.',
        };
      }
      const reading = readGuides(records, {
        question: String(args.question || ''),
        guide: args.guide ? String(args.guide) : undefined,
        from: args.from === undefined || args.from === null || args.from === '' ? undefined : Number(args.from),
        maxPassages: config.maxPassages,
        passageChars: config.passageChars,
        wholeGuideChars: config.wholeGuideChars ?? 12000,
      });
      if ('error' in reading && reading.error === 'no_readable_text') {
        if (ctx.knowledgeGapRepo) {
          ctx.knowledgeGapRepo.recordGap({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            topic: `product guide with no readable text: ${title}`,
            toolName: 'read_product_guide',
            conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
          }).catch(() => {});
        }
        return {
          ok: true,
          found: false,
          readable: false,
          sku: product.sku || sku,
          title,
          guides: reading.unreadable.map((guide) => ({ guide: guide.title, kind: guide.kind, pages: guide.pages, link: guide.url })),
          message: 'We hold this guide only as the maker\'s file (a scan), so I cannot read its words from here. Say so plainly, the way one of us would ("the guide is there, but I can\'t read it from here"), give the file as a markdown link [guide title](address) when it has one so the customer can open it, and offer a colleague who can check it. Never say what such a guide contains, and never describe what a guide for this kind of product usually says. Offer what we do know about the product from get_product.',
        };
      }
      if ('error' in reading) return { ok: false, error: `This product has no guide called "${String(args.guide)}". It has: ${reading.available.join('; ')}.` };
      // What the supplier's own words may support in the reply is the tenant's choice; a class the platform does not know is ignored.
      for (const name of config.unlocks || []) {
        const parsed = ClaimClassSchema.safeParse(name);
        if (parsed.success) ctx.allowedClaimClasses.add(parsed.data);
      }
      return {
        ok: true,
        found: true,
        sku: product.sku || sku,
        title,
        ...(readFor ? { foundFromWords: `This guide is for "${readFor}", found from the customer's words and not from a SKU: say which product you read it for.` } : {}),
        guides: reading.guides.map((guide) => ({ guide: guide.title, kind: guide.kind, pages: guide.pages, link: guide.url, passages: guide.passages, ...(guide.outline ? { headings: guide.outline.map((entry) => `${entry.n}: ${entry.heading}`) } : {}), ...(guide.truncated ? { note: 'The stored text stops before the end of this guide.' } : {}) })),
        answeredFromGuide: reading.matched,
        ...(reading.unreadable ? { alsoKept: reading.unreadable.map((guide) => ({ guide: guide.title, kind: guide.kind, link: guide.url, note: 'no readable words are held for this one: give its link and do not say what it contains' })) } : {}),
        passages: reading.passages.map((passage) => ({ guide: passage.guide, passage: `${passage.n} of ${passage.of}`, text: passage.text })),
        ...(reading.next ? { continueWith: { guide: reading.guides[0].title, from: reading.next.from } } : {}),
        message: 'These passages are the maker\'s own words, copied from the guide(s) listed. Explain them in plain language, as a member of our team would, and say whose guide it is ("the Sika guide says…" using the brand, or "the guide that comes with it says…"). Keep every number, unit, spacing and limit exactly as written, and add no step, limit or compatibility from general knowledge. If the passages do not answer what was asked, do not say the guide is silent yet: a long guide lists its headings with the passage each is in ("headings": passage number, heading), so call again with from set to the passage of the section that fits (and the same guide), or with the guide\'s own words for the thing (the term in a heading, the unit) as the question. Only when the right section has been read and still does not say, tell the customer so and give the guide\'s link. For wet areas, structural fixing or anything where a mistake is costly, tell the customer to follow the full guide and offer its link.',
      };
    }

    case 'review_cart': {
      const config: { enabled?: boolean; labels?: Record<string, string>; deliveryLabels?: Record<string, string>; maxAccessories?: number } = (ctx.release as any)?.extensions?.checkoutReview || {};
      if (config.enabled === false) return { ok: false, error: 'The last look before payment is not switched on for this shop.' };
      const eventPayload = ctx.customerEvent?.payload && typeof ctx.customerEvent.payload === 'object' ? ctx.customerEvent.payload : {};
      let rawLines: any[] = Array.isArray(eventPayload.items) && eventPayload.items.length > 0 ? eventPayload.items : Array.isArray(args.items) ? args.items : [];
      if (rawLines.length === 0) {
        const cart: any = (await executeAgentTool('get_cart', {}, ctx))?.cart;
        rawLines = Array.isArray(cart?.items) ? cart.items : Array.isArray(cart?.lines) ? cart.lines : [];
      }
      const wanted = new Map<string, { quantity: number; branchStatus?: string }>();
      for (const entry of rawLines.slice(0, 30)) {
        const sku = String(entry?.sku ?? '').trim();
        if (!sku || wanted.has(sku)) continue;
        const quantity = Math.min(9999, Math.max(1, Math.floor(Number(entry?.quantity ?? entry?.qty ?? 1)) || 1));
        const status = typeof entry?.stock?.status === 'string' ? entry.stock.status : typeof entry?.branchStatus === 'string' ? entry.branchStatus : undefined;
        wanted.set(sku, { quantity, ...(status ? { branchStatus: status.slice(0, 80) } : {}) });
      }
      if (wanted.size === 0) return { ok: false, error: 'No order lines were given and none are in the cart. Ask the customer to add what they need first, then to tap the button that reviews their order.' };
      const branch = eventPayload.branch && typeof eventPayload.branch === 'object'
        ? { ...(typeof eventPayload.branch.id === 'string' ? { id: eventPayload.branch.id.slice(0, 40) } : {}), ...(typeof eventPayload.branch.name === 'string' ? { name: eventPayload.branch.name.slice(0, 80) } : {}) }
        : undefined;
      const quantityHelper = (ctx.release as any)?.extensions?.quantityHelper || {};
      const lines: ReviewLine[] = [];
      for (const [sku, want] of wanted) {
        const product = await findProductBySku(ctx, sku);
        if (!product) continue;
        const warranty: any = await executeAgentTool('get_warranty', { productOrBrand: String(product.sku || sku) }, ctx).catch(() => undefined);
        const terms = warranty?.found === true && typeof warranty?.warranty?.terms === 'string' ? warranty.warranty.terms.replace(/\s+/g, ' ').trim() : undefined;
        const guides = ctx.productGuideRepo ? await ctx.productGuideRepo.findForProducts(ctx.tenantId, [String(product.sku || ''), String(product.parentSku || ''), sku]) : [];
        lines.push({
          sku: String(product.sku || sku), title: String(product.title || product.name || sku), quantity: want.quantity,
          imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : undefined,
          discontinued: isProductDiscontinued(product),
          pickupOnly: typeof product.pickupOnly === 'boolean' ? product.pickupOnly : undefined,
          deliveryOptions: Array.isArray(product.deliveryOptions) ? product.deliveryOptions : undefined,
          branchesAvailable: typeof product.branchesAvailable === 'number' ? product.branchesAvailable : undefined,
          branchesTotal: typeof product.branchesTotal === 'number' ? product.branchesTotal : undefined,
          coverageTexts: [product.description, ...(Array.isArray(product.highlights) ? product.highlights : [])].filter((text) => typeof text === 'string'),
          ...(want.branchStatus ? { branchStatus: want.branchStatus } : {}),
          ...(terms ? { warranty: terms } : {}),
          // Only a guide with words in it can be explained, so only those are offered.
          guides: guides.filter((guide) => hasReadableText(guide.text)).map((guide) => guide.title),
        });
      }
      if (lines.length === 0) return { ok: false, error: 'None of the order\'s lines is a product in the catalogue, so there is nothing to review.' };
      // What else the order may need: the suggestions the knowledge and the shop's own records give for the first lines.
      const suggestions: ReviewSuggestion[] = [];
      const seen = new Set<string>();
      for (const line of lines.slice(0, 3)) {
        const related: any = await executeAgentTool('get_related_products', { sku: line.sku }, ctx).catch(() => undefined);
        for (const item of Array.isArray(related?.relatedProducts) ? related.relatedProducts : []) {
          const sku = String(item?.sku || '');
          if (!sku || seen.has(sku)) continue;
          seen.add(sku);
          const cached = ctx.catalogProductCache.get(sku);
          suggestions.push({ sku, title: String(item.title || cached?.title || sku), imageUrl: typeof cached?.imageUrl === 'string' ? cached.imageUrl : undefined, reason: typeof item.reason === 'string' ? item.reason : typeof item.relation === 'string' ? item.relation : undefined });
        }
      }
      const review = buildReview({
        lines, suggestions, branch, labels: config.labels, deliveryLabels: config.deliveryLabels,
        coveragePatterns: quantityHelper.coveragePatterns, minPieceSideMm: quantityHelper.minPieceSideMm, maxAccessories: config.maxAccessories,
      });
      ctx.lastReview = review;
      return {
        ok: true,
        lines: lines.length,
        summary: review.summary,
        sections: [review.quantity, review.accessories, review.fulfilment, review.warranty].map((part) => ({ section: part.title, looksRight: part.ok, notes: part.rows.slice(0, 6).map((entry) => `${entry.title}${entry.detail ? `: ${entry.detail}` : ''}`) })),
        message: 'The review card is ready: it is shown to the customer from this result (present_card with cardType review and no other state), and its buttons let them act on each finding. In two or three warm sentences, as one of our team, say what is worth a look and why it matters (for example a pick-up-only item, or a quantity to match their area), then ask if they would like to sort anything before paying. Do not list every finding again: the card has them. Suggestions are things to check, not confirmed requirements.',
      };
    }

    case 'open_form': {
      const form = findForm(ctx.release, args.formId, ctx.principal);
      if (!form) {
        const known = formsOf(ctx.release, ctx.principal).map((entry) => entry.formId);
        return { ok: false, error: `There is no form "${String(args.formId || '')}".${known.length ? ` The shop's forms are: ${known.join(', ')}.` : ' This shop has no forms.'}` };
      }
      const values = prefillFor(form, args.prefill, (ctx.workspace as any)?.facts);
      const state = formCardState(form, values);
      ctx.presentedCards.push({ cardType: 'form', state });
      ctx.emitUiAction?.({ name: 'presentCard', arguments: { card: { id: `form-${form.formId}-${Date.now()}`, cardType: 'form', state } } });
      return { ok: true, opened: form.formId, title: form.title, prefilled: Object.keys(values), message: 'The form is open in front of the customer. Say in one short sentence what it is for and that they can fill it in and send it; do not ask for the details again in the chat.' };
    }

    case 'read_content_page': {
      const config: { enabled?: boolean; unlocks?: string[]; maxPassages?: number; passageChars?: number; maxPages?: number } = (ctx.release as any)?.extensions?.contentPages || {};
      if (config.enabled === false) return { ok: false, error: 'Reading our own pages is not switched on here. Say you cannot read them here and help from what else you can see.' };
      const query = String(args.query || '').trim();
      const reference = String(args.page || '').trim();
      if (!query && !reference) return { ok: false, error: 'Give what the customer wants to know (query), or the page to open (page).' };
      const pages = ctx.contentPageRepo ? await ctx.contentPageRepo.listPages(ctx.tenantId) : [];
      if (pages.length === 0) return { ok: true, found: false, message: 'None of our pages can be read here right now. Say so plainly and do not describe what such a page would say.' };
      let chosen: ContentPageRecord;
      let hits: PageHit[] = [];
      if (reference) {
        const opened = findPage(pages, reference);
        if ('error' in opened) return { ok: false, error: opened.error === 'ambiguous' ? `More than one page has that title: ${opened.candidates.join('; ')}. Use the page id from a search.` : `No page "${reference}". Search with a query first (the result lists page ids).` };
        chosen = opened;
      } else {
        hits = searchPages(pages, query, config.maxPages ?? 5);
        if (hits.length === 0) {
          if (ctx.knowledgeGapRepo) {
            ctx.knowledgeGapRepo.recordGap({
              tenantId: ctx.tenantId, environmentId: ctx.environmentId, topic: `site page: ${query}`, toolName: 'read_content_page',
              conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
            }).catch(() => {});
          }
          return { ok: true, found: false, query, message: 'None of our pages matches this. Say you had a look and did not find a page on it, and do not describe what a page would say. You may try other words once.' };
        }
        chosen = pages.find((page) => page.pageId === hits[0].pageId)!;
      }
      const reading = readGuides([pageAsGuide(chosen)], {
        question: query,
        from: args.from === undefined || args.from === null || args.from === '' ? undefined : Number(args.from),
        maxPassages: config.maxPassages ?? 6,
        passageChars: config.passageChars,
      });
      if ('error' in reading) return { ok: false, error: 'That page has no readable text.' };
      // The products a page features are shown only if the catalogue still has them.
      const featured: Array<{ sku: string; title: string }> = [];
      for (const entry of chosen.products.slice(0, 16)) {
        if (featured.length >= 8) break;
        const found = await findProductBySku(ctx, entry.sku);
        if (!found || isProductDiscontinued(found)) continue;
        featured.push({ sku: String(found.sku), title: String(found.title || found.name || entry.name || found.sku) });
      }
      for (const name of config.unlocks || []) {
        const parsed = ClaimClassSchema.safeParse(name);
        if (parsed.success) ctx.allowedClaimClasses.add(parsed.data);
      }
      const guide = reading.guides[0];
      const tidyTitle = (value: string) => readableTitle(value, { keep: [String((ctx.release as any)?.profile?.companyName || '')].filter(Boolean), locale: (ctx.release as any)?.profile?.primaryLocale });
      return {
        ok: true,
        found: true,
        query,
        page: { page: chosen.pageId, title: tidyTitle(chosen.title), link: chosen.url, summary: chosen.summary, filedUnder: chosen.categories, passages: guide.passages, ...(guide.outline ? { headings: guide.outline.map((entry) => `${entry.n}: ${entry.heading}`) } : {}), ...(guide.truncated ? { note: 'The stored text stops before the end of this page.' } : {}) },
        answeredFromPage: reading.matched,
        passages: reading.passages.map((passage) => ({ passage: `${passage.n} of ${passage.of}`, text: passage.text })),
        ...(reading.next ? { continueWith: { page: chosen.pageId, from: reading.next.from } } : {}),
        featuredProducts: featured,
        ...(hits.length > 1 ? { otherPages: hits.slice(1).map((hit) => ({ page: hit.pageId, title: tidyTitle(hit.title), summary: hit.summary ? hit.summary.slice(0, 200) : undefined, link: hit.url })) } : {}),
        message: 'These passages are our own words from our website page named here. Explain them in plain language, as a member of our team would, and say which page they come from ("our page on ... says..."), with its link as a markdown link [page title](address). Keep every figure, name and rule exactly as written and add nothing from general knowledge. If the page does not cover what was asked, say so and look at otherPages or open another page (page = its id) before giving up. featuredProducts are real catalogue products the page features: if the customer wants ideas or products for the project, show them on a products card (present_card) and say in a sentence why each is there; never show a product that is not in this list or another tool result. For building-code, consent or structural questions the page is general information: tell the customer to confirm with the council, the designer or a licensed building practitioner.',
      };
    }

    case 'get_warranty': {
      const target = String(args.productOrBrand || '').trim();
      if (!target) {
        return {
          found: false,
          productOrBrand: '',
          message: 'No product or brand specified.',
        };
      }

      let matchedChunk: OkfEvidenceChunk | null = null;
      const now = new Date();
      const verifications = new Map((ctx.okfContent?.verifications || []).map((v) => [v.recordId, v]));

      if (ctx.okfContent?.evidenceChunks) {
        const targetLower = target.toLowerCase();
        let targetProduct = ctx.catalogProductCache.get(target);
        if (!targetProduct) {
          targetProduct = [...ctx.catalogProductCache.values()].find(
            (p) =>
              p.sku?.toLowerCase() === targetLower ||
              p.name?.toLowerCase() === targetLower ||
              p.title?.toLowerCase() === targetLower
          );
        }
        const targetSku = targetProduct?.sku?.toLowerCase();
        const targetName = (targetProduct?.name || targetProduct?.title)?.toLowerCase();

        for (const chunk of ctx.okfContent.evidenceChunks) {
          if (!chunk.claimClasses.includes('warranty')) {
            continue;
          }

          // Match the chunk to the asked product, brand or concept
          const refs = (chunk.applicability?.refs || []).map((r) => r.toLowerCase());
          const matchesRef = refs.some(
            (ref) =>
              ref === targetLower ||
              targetLower.includes(ref) ||
              ref.includes(targetLower) ||
              (targetSku && ref === targetSku) ||
              (targetName && (ref === targetName || targetName.includes(ref)))
          );

          let matchesConcept = false;
          if (chunk.conceptIds && ctx.okfContent.concepts) {
            for (const cId of chunk.conceptIds) {
              if (cId.toLowerCase() === targetLower) {
                matchesConcept = true;
                break;
              }
              const concept = ctx.okfContent.concepts.find((c) => c.conceptId === cId);
              if (concept) {
                const nameLower = concept.name.toLowerCase();
                if (
                  nameLower === targetLower ||
                  targetLower.includes(nameLower) ||
                  nameLower.includes(targetLower) ||
                  (targetName && (nameLower === targetName || targetName.includes(nameLower)))
                ) {
                  matchesConcept = true;
                  break;
                }
                if (
                  concept.synonyms?.some(
                    (s) =>
                      s.toLowerCase() === targetLower ||
                      targetLower.includes(s.toLowerCase()) ||
                      (targetName && s.toLowerCase() === targetName)
                  )
                ) {
                  matchesConcept = true;
                  break;
                }
              }
            }
          }

          // Also match title only if it explicitly mentions target or target product name
          const matchesTitle =
            chunk.title.toLowerCase().includes(targetLower) ||
            Boolean(targetName && chunk.title.toLowerCase().includes(targetName));

          if (!matchesRef && !matchesConcept && !matchesTitle) {
            continue;
          }

          // Require verified status: must be verified
          let isVerified = false;

          // 1. Direct verification record
          const directVer = (ctx.okfContent.verifications || []).find(
            (v) => v.targetId === chunk.chunkId || v.sourceRefs?.includes(chunk.sourceRef)
          );
          if (directVer && effectiveVerification(directVer, now) === 'verified') {
            isVerified = true;
          }

          // 2. Verified via concept evidence refs
          if (!isVerified && chunk.conceptIds && ctx.okfContent.concepts) {
            for (const cId of chunk.conceptIds) {
              const concept = ctx.okfContent.concepts.find((c) => c.conceptId === cId);
              if (concept) {
                const verifiedSources = verifiedEvidenceRefs(ctx.okfContent, concept, now);
                if (verifiedSources.includes(chunk.sourceRef)) {
                  isVerified = true;
                  break;
                }
              }
            }
          }

          // 3. Verified via relationship
          if (!isVerified && ctx.okfContent.relationships) {
            for (const rel of ctx.okfContent.relationships) {
              if (
                rel.claimClasses?.includes('warranty') &&
                rel.sourceRefs?.includes(chunk.sourceRef)
              ) {
                const relVer = rel.verificationRef ? verifications.get(rel.verificationRef) : undefined;
                if (effectiveVerification(relVer, now) === 'verified') {
                  isVerified = true;
                  break;
                }
              }
            }
          }

          if (isVerified) {
            matchedChunk = chunk;
            break;
          }
        }
      }

      if (matchedChunk) {
        ctx.readSourceIds.add(matchedChunk.sourceRef);
        ctx.allowedClaimClasses.add('warranty');
        return {
          productOrBrand: target,
          found: true,
          warranty: {
            sourceId: matchedChunk.sourceRef,
            title: matchedChunk.title,
            terms: matchedChunk.content,
          },
        };
      }

      if (ctx.knowledgeGapRepo && target) {
        ctx.knowledgeGapRepo.recordGap({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          topic: target,
          toolName: 'get_warranty',
          conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId,
        }).catch(() => {});
      }

      return {
        productOrBrand: target,
        found: false,
        warranty: {
          message: `No verified warranty certificate registered for '${target}'. Please consult store staff.`,
        },
      };
    }

    case 'my_company':
    case 'my_balance':
    case 'my_deliveries':
    case 'my_price': {
      const answer = await executeCustomerAccountTool(toolName, args, ctx, makeExecContext(ctx) as any);
      // The customer's own deliveries and balance can show as cards (pack `extensions.dashboard.cards`); the model is then told they are on screen.
      if (answer?.ok === true && (toolName === 'my_deliveries' || toolName === 'my_balance')) {
        const shown = showRecordCards(ctx, CUSTOMER_ACCOUNT_CONNECTOR, toolName, customerAccountRecords(toolName, answer));
        if (shown.length) return { ...answer, shownAsCards: cardsShownNote(shown) };
      }
      return answer;
    }

    case 'list_connectors':
    case 'get_connector_tools':
    case 'call_connector_tool': {
      return executeConnectorMetaTool(toolName, args, ctx, makeExecContext(ctx) as any, {
        confirmed: options.confirmed === true,
        hold: (heldArgs, details, prompt) => holdForConfirmation(toolName, heldArgs, prompt, ctx, details),
      });
    }

    case 'use_skill': {
      const skillId = String(args.skillId || '').trim();
      const carried = resolveAgentSkills({ skills: ctx.agentSkillIds }, (ctx.release as any)?.extensions?.skills);
      const skill = carried.find((candidate) => candidate.skillId === skillId);
      if (!skill) {
        return {
          ok: false,
          error: `No skill "${skillId}" is available to you.`,
          available: carried.filter((candidate) => candidate.tier === 'on_demand').map((candidate) => candidate.skillId),
        };
      }
      (ctx.usedSkillIds ||= new Set()).add(skill.skillId);
      return { ok: true, skillId: skill.skillId, name: skill.name, instructions: skill.instructions };
    }

    case 'calculate_quantity': {
      const project = String(args.project || args.calculatorId || '').trim();
      const rawMeasurements = args.measurements || {};
      const calculators =
        (ctx.release as any)?.calculators ||
        (ctx.okfContent as any)?.calculators ||
        [];

      const calc = findMatchingCalculator(calculators, project);
      if (!calc) {
        const available = calculators.map((c: any) => c.name || c.calculatorId).join(', ');
        return {
          ok: false,
          error: `No calculator available for "${project}".${available ? ` Available calculators: ${available}.` : ' No calculators defined for this tenant.'}`,
        };
      }

      const execRes = executeCalculator(calc, rawMeasurements);
      if (!execRes.ok || (execRes.missing && execRes.missing.length > 0)) {
        return {
          ok: false,
          calculatorId: calc.calculatorId,
          calculatorName: calc.name,
          missing: execRes.missing,
          message: execRes.message || `Missing required measurements for ${calc.name}: ${(execRes.missing || []).join(', ')}.`,
        };
      }

      // Unlock claim class only for a verified calculator
      if (execRes.verificationRef && execRes.claimClass) {
        ctx.allowedClaimClasses.add(execRes.claimClass as any);
      }

      return {
        ok: true,
        project: calc.name,
        calculatorId: calc.calculatorId,
        outputs: execRes.outputs,
        source: execRes.source,
        verificationRef: execRes.verificationRef,
        claimClass: execRes.claimClass,
      };
    }

    case 'check_stock': {
      const sku = String(args.sku || '').trim();
      const branchAsked = String(args.branch || '').trim();

      // 1. The branch figures, from the business system, when the pack names the tool that holds them (`extensions.branchStock`) and this
      //    person may use that connector. The policy gate applies as for any connector call.
      const route = branchStockRoute(ctx.release);
      const runtime = ctx.connectorRuntime;
      if (route && runtime && !ctx.disabledConnectors?.has(route.connector)) {
        const person = ctx.principal ?? { audience: 'shopper' as const, groups: [] };
        if (runtime.summaries(ctx.release as any, person).some((summary) => summary.connector === route.connector)) {
          const callArgs: Record<string, unknown> = { ...(route.extra ?? {}), [route.inputs?.sku || 'sku']: sku };
          // The branch goes along only when the pack says the tool takes it as the person says it: systems often want a code, not a name.
          if (branchAsked && route.inputs?.branch) callArgs[route.inputs.branch] = branchAsked;
          const called: any = await runtime.call(ctx.release as any, person, makeExecContext(ctx) as any, route.connector, route.tool, callArgs);
          ctx.emitTrace?.('connector_call', { connector: route.connector, tool: route.tool, outcome: called.ok ? 'success' : called.status });
          if (called.ok) {
            (ctx.usedConnectorIds ||= new Set()).add(route.connector);
            ctx.turnProductSkus.add(sku);
            ctx.allowedClaimClasses.add('catalog_fact');
            ctx.allowedClaimClasses.add('stock');
            return {
              sku,
              ...(branchAsked ? { branch: branchAsked } : {}),
              source: 'business_system',
              connector: route.connector,
              tool: route.tool,
              branchStock: called.result,
              message: `Branch stock for SKU ${sku} from the business system, branch by branch${branchAsked ? `: find ${branchAsked} among the rows` : ''}. "available" (on hand less reserved) is what can be sold. If the branch is not among the rows, say it is not listed in what the system returned (the list can be cut short), not that it holds none. Quote the figures as the system shows them, with the count date when it gives one.${route.note ? ` ${route.note}` : ''}`,
            };
          }
          // The system did not answer: the catalogue below is all that is left, and the branch is reported as not checked.
        }
      }

      // 2. Otherwise the catalogue's own in-stock flag. It is shop-wide and is said to be: never a branch figure with the branch pasted in.
      let cached = ctx.catalogProductCache.get(sku);
      if (!cached) {
        try {
          const res = await ctx.catalogSearchHandler.execute(
            { query: sku, maxResults: 1 },
            makeExecContext(ctx)
          );
          cached = (res.products || res.items || []).find(
            (p: any) => String(p.sku).toLowerCase() === sku.toLowerCase()
          );
          if (cached) {
            ctx.catalogProductCache.set(sku, cached);
          }
        } catch {}
      }

      ctx.turnProductSkus.add(sku);
      ctx.allowedClaimClasses.add('catalog_fact');
      ctx.allowedClaimClasses.add('stock');

      if (cached && isProductDiscontinued(cached)) {
        return {
          sku,
          ...(branchAsked ? { branch: branchAsked } : {}),
          inStock: false,
          isDiscontinued: true,
          stockLevel: 'Discontinued (no longer stocked)',
          message: `SKU ${sku} is discontinued and no longer stocked. Do not claim this item is in stock.`,
        };
      }

      const inStock = cached ? Boolean(cached.inStock) : false;
      const branchNote = branchAsked
        ? ` Stock at ${branchAsked} was NOT checked: this is the catalogue's shop-wide flag, not a branch figure. Do not say the item is in stock at ${branchAsked}; say the catalogue shows it as ${inStock ? 'in stock' : 'out of stock'} and that the branch's stock is unverified${runtime ? ', or read the branch figures from the business system through its connector' : ''}.`
        : '';
      return {
        sku,
        ...(branchAsked ? { branch: branchAsked } : {}),
        inStock,
        branchChecked: false,
        source: 'catalogue',
        stockLevel: cached?.stockLevel || (inStock ? 'Available (in stock)' : 'Out of stock / special order'),
        message: inStock
          ? `The catalogue lists SKU ${sku} as in stock (shop-wide).${branchNote}`
          : `The catalogue lists SKU ${sku} as out of stock or special order.${branchNote} Do not claim this item is in stock.`,
      };
    }

    case 'present_card': {
      const cardType = String(args.cardType || '').trim() as CardType;
      const cardDef = CARD_TYPES[cardType];
      if (!cardDef) {
        return {
          ok: false,
          error: `Rejected card: Unknown card type "${cardType}". Approved card types: ${CARD_TYPE_NAMES.join(', ')}.`,
        };
      }

      // The ask-first card is the server's: it is made from a call the server kept, never from what the model writes.
      if (cardType === 'confirm') {
        return { ok: false, error: 'Rejected card: an ask-first card is made by the system when a tool needs the person\'s yes. Call the tool and the system asks.' };
      }

      const state: any = normaliseCardState(cardType, args.state);

      // 1. Collect all product SKUs referenced in the card state
      const referencedSkus: string[] = [];
      const extractSkus = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.sku === 'string' && obj.sku.trim()) referencedSkus.push(obj.sku.trim());
        if (typeof obj.forSku === 'string' && obj.forSku.trim()) referencedSkus.push(obj.forSku.trim());
        if (Array.isArray(obj.skus)) {
          for (const s of obj.skus) if (typeof s === 'string' && s.trim()) referencedSkus.push(s.trim());
        }
        for (const val of Object.values(obj)) {
          if (Array.isArray(val)) {
            for (const item of val) extractSkus(item);
          } else if (val && typeof val === 'object') {
            extractSkus(val);
          }
        }
      };
      extractSkus(state);

      // 2. Enforce OKF Safety & Commerce Policy: block product presentation if safety.blocksProducts or commercePolicy is blocked
      const isProductCard =
        ['products', 'productDetail', 'comparison', 'bundle', 'accessories'].includes(cardType) ||
        referencedSkus.length > 0;

      if (isProductCard && ctx.okfContent) {
        const candidateConcepts = new Set<OkfConcept>();

        // Concepts from customer question
        if (ctx.customerQuestion) {
          for (const c of findRelevantOkfConcepts(ctx.okfContent, { customerQuestion: ctx.customerQuestion })) {
            candidateConcepts.add(c);
          }
        }

        // Concepts consulted via consult_business_knowledge during this turn
        if (ctx.consultedConcepts) {
          for (const c of ctx.consultedConcepts) {
            candidateConcepts.add(c);
          }
        }

        // Concepts mapped to referenced SKUs via evidence chunks
        if (ctx.okfContent.evidenceChunks && ctx.okfContent.concepts) {
          const skuSet = new Set(referencedSkus.map((s) => s.toLowerCase()));
          for (const chunk of ctx.okfContent.evidenceChunks) {
            const hasSku = chunk.applicability?.refs?.some((r) => skuSet.has(r.toLowerCase()));
            if (hasSku && chunk.conceptIds) {
              for (const cId of chunk.conceptIds) {
                const c = ctx.okfContent.concepts.find((item) => item.conceptId === cId);
                if (c) candidateConcepts.add(c);
              }
            }
          }
        }

        // Check safety.blocksProducts and commercePolicy
        for (const concept of candidateConcepts) {
          if (concept.safety?.blocksProducts) {
            return {
              ok: false,
              error: `Rejected card: Products cannot be shown because safety policy for "${concept.name}" blocks products (safety.blocksProducts). Deliver safety guidance first.`,
            };
          }
          if (
            concept.commercePolicy?.addToCart === 'blocked' &&
            concept.commercePolicy?.checkout === 'blocked'
          ) {
            return {
              ok: false,
              error: `Rejected card: Products cannot be shown because commerce policy for "${concept.name}" blocks commerce.`,
            };
          }
        }
      }

      // A product the customer's own tap named (the item they added, opened or ticked) is a verified product: look it up so its
      // facts are the catalogue's, and it can sit on a card this turn without the model having to search for it first.
      for (const sku of eventSkus(ctx.customerEvent)) {
        if (referencedSkus.includes(sku) && !ctx.turnProductSkus.has(sku)) await findProductBySku(ctx, sku);
      }

      // A product an earlier turn of this conversation showed is looked up by its SKU again, so its facts are the catalogue's today, and it can sit on a card without a new search.
      for (const sku of referencedSkus) {
        if (!ctx.turnProductSkus.has(sku) && ctx.earlierShownSkus?.has(sku)) await findProductBySku(ctx, sku);
      }

      // 3. SKU Provenance & Lifecycle Verification: Every product SKU must have been returned by a tool result and not discontinued
      for (const sku of referencedSkus) {
        if (!ctx.turnProductSkus.has(sku)) {
          return {
            ok: false,
            error: `Rejected card: SKU "${sku}" was not returned by a product search or lookup tool in this turn for tenant "${ctx.tenantId}". You must search or look up products first before presenting them.`,
          };
        }
        const cached = ctx.catalogProductCache.get(sku);
        if (cached && isProductDiscontinued(cached)) {
          return {
            ok: false,
            error: `Rejected card: SKU "${sku}" is discontinued and cannot be presented to the customer.`,
          };
        }
      }

      // 3. Overwrite / join authoritative pricing and stock facts from catalogue data, never model-authored text
      const enrichProduct = (p: any) => {
        if (!p || typeof p !== 'object' || !p.sku) return p;
        const cached = ctx.catalogProductCache.get(p.sku);
        if (!cached) return p;
        // What the catalogue says about the product, and which of it answers what the customer asked for: never model-written.
        // Examples shown to describe a range were not chosen for the customer's job, so none of them claims to fit it.
        const facts = productCardFacts(cached.highlights, { customerText: ctx.lastProducts?.source === 'overview' ? '' : ctx.customerQuestion, locale: (ctx.release as any)?.profile?.primaryLocale });
        const offered = typeof p.reason === 'string' ? p.reason.trim() : '';
        return {
          ...p,
          ...(offered ? {} : facts.reason ? { reason: facts.reason } : {}),
          ...(facts.highlights.length > 0 ? { highlights: facts.highlights } : {}),
          ...(Array.isArray(cached.cautions) && cached.cautions.length > 0 ? { cautions: cached.cautions.slice(0, 1) } : {}),
          ...(typeof cached.rating === 'number' ? { rating: cached.rating } : {}),
          ...(typeof cached.ratingCount === 'number' ? { ratingCount: cached.ratingCount } : {}),
          ...(typeof cached.branchesAvailable === 'number' ? { branchesAvailable: cached.branchesAvailable } : {}),
          ...(typeof cached.branchesTotal === 'number' ? { branchesTotal: cached.branchesTotal } : {}),
          title: cached.title || cached.name || p.title,
          price: cached.priceUSD?.min ?? cached.price ?? p.price,
          currency: cached.currency || ctx.release.profile?.primaryCurrency || p.currency,
          inStock: cached.inStock !== undefined ? Boolean(cached.inStock) : p.inStock,
          availability: cached.inStock ? 'in_stock' : 'out_of_stock',
          // The picture is a catalogue fact too: taken from the catalogue record, never from model-written text.
          imageUrl: cached.imageUrl || undefined,
        };
      };

      if (Array.isArray(state.products)) {
        state.products = state.products.map(enrichProduct);
      }
      if (state.product && typeof state.product === 'object') {
        state.product = enrichProduct(state.product);
      }
      if (Array.isArray(state.items)) {
        state.items = state.items.map(enrichProduct);
      }
      if (Array.isArray(state.lines)) {
        state.lines = state.lines.map(enrichProduct);
      }
      if (Array.isArray(state.groups)) {
        state.groups = state.groups.map((g: any) => ({
          ...g,
          items: Array.isArray(g.items) ? g.items.map(enrichProduct) : g.items,
        }));
      }

      // A quantity card shows only the number the estimate tool returned for that product, and a picture card only the picture made this turn.
      if (cardType === 'quantity') {
        const estimate = ctx.lastEstimates?.get(String(state.product?.sku || ''));
        if (!estimate) {
          return { ok: false, error: 'Rejected card: work the quantity out with estimate_quantity for this SKU first; a quantity card shows only that tool\'s number.' };
        }
        state.quantity = estimate.units;
        state.unitLabel = estimate.unitLabel;
        state.working = estimate.working;
        state.ctaLabel = estimate.ctaLabel;
      }
      if (cardType === 'accessories' && Array.isArray(state.groups)) {
        // What was suggested earlier in the conversation is not suggested again on every add.
        const shown = ctx.shownAccessories || (ctx.shownAccessories = new Set<string>());
        const fresh = state.groups
          .map((group: any) => ({ ...group, items: (Array.isArray(group?.items) ? group.items : []).filter((item: any) => item?.sku && !shown.has(String(item.sku))) }))
          .filter((group: any) => group.items.length > 0);
        if (fresh.length === 0) {
          return { ok: true, skipped: true, message: 'Every suggestion on that card was already shown earlier in this conversation, so no card was shown. Do not list them again: at most say in a few words that the same suggestions still apply.' };
        }
        state.groups = fresh;
        for (const group of fresh) for (const item of group.items) shown.add(String(item.sku));
      }
      // What the customer has already added is not recommended again (their own tap this turn counts too).
      if (RECOMMENDATION_CARDS.includes(cardType)) {
        const cartId = `cart-${ctx.workspaceId || 'default'}`;
        const added = skusInCart({
          carts: [(ctx as any).cart, (ctx as any).workspace?.facts?.cart?.value, ctx.inMemoryCarts instanceof Map ? (ctx.inMemoryCarts.get(cartId) || ctx.inMemoryCarts.get('default')) : undefined],
          event: ctx.customerEvent,
        });
        const dropped = dropAdded(cardType, state, added);
        if (dropped.empty) {
          return { ok: true, skipped: true, message: 'Everything on that card is already in the customer\'s cart, so no card was shown. Do not recommend those again: say in a sentence what they have, and move on to what they still need (a quantity, an accessory they have not added, or the order review).' };
        }
        if (dropped.removed.length > 0) Object.assign(state, dropped.state);
      }
      if (cardType === 'review') {
        if (!ctx.lastReview) {
          return { ok: false, error: 'Rejected card: review the order with review_cart first; a review card shows only that tool\'s findings.' };
        }
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, ctx.lastReview);
      }
      if (cardType === 'visual') {
        if (!ctx.lastVisual) {
          return { ok: false, error: 'Rejected card: make the picture with generate_visual first; a picture card shows only the picture made in this turn.' };
        }
        state.imageUrl = ctx.lastVisual.urlPath;
        const configured = (ctx.release as any)?.extensions?.visualiser?.disclaimer;
        if (typeof configured === 'string' && configured.trim()) state.disclaimer = configured.trim();
        if (!Array.isArray(state.products)) state.products = ctx.lastVisual.skus.map((sku) => enrichProduct({ sku }));
      }

      // A question that asks what kind of thing the customer wants must offer the real groups that hold a fair share of the range, and
      // carries the shop's own "something else" choice. The server knows the groups and their sizes; the model may have left one out.
      if (cardType === 'clarify' && Array.isArray(state.questions)) {
        const settings: QuestionCardSettings = (ctx.release as any)?.extensions?.questionCards || {};
        const joiners = connectorWordsForLocale((ctx.release as any)?.profile?.primaryLocale);
        const check = checkShelfQuestions(state.questions, ctx.rangeShelves || [], settings, joiners);
        if (check.missing.length > 0) {
          const list = check.missing.map((shelf) => `${shelf.name} (${shelf.productCount.toLocaleString('en')} products)`).join('; ');
          return {
            ok: false,
            error: `Rejected card: the question offers the groups of this range but leaves out ${list}. Each holds a fair share of the range, and a customer who wants one would have no choice to tap. Add a choice for each, in everyday words a customer would use, then present the card again.`,
          };
        }
        addOtherOption(state.questions, check.shelfQuestions, settings.otherOptionLabel);
      }

      // 4. Validate enriched state against Zod schema for card type
      const parsed = cardDef.state.safeParse(state);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Rejected card: State failed validation for card type "${cardType}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        };
      }

      // 5. Emit uiAction event for the web client
      const cardInstance = {
        id: `${cardType}-${Date.now()}`,
        cardType,
        state: parsed.data,
      };

      ctx.presentedCards.push({ cardType, state: parsed.data });

      if (ctx.emitUiAction) {
        ctx.emitUiAction({
          name: 'presentCard',
          arguments: { card: cardInstance },
        });
      }

      return {
        ok: true,
        cardType,
        presented: true,
        message: `Successfully presented ${cardType} card to the customer.`,
      };
    }

    case 'hand_off_to_human': {
      const reason = String(args.reason || 'Customer requested human assistance.').trim();
      ctx.isHumanHandoffRequested = true;
      ctx.handoffReason = reason;

      if (ctx.emitUiAction) {
        ctx.emitUiAction({
          name: 'handoff',
          arguments: { reason },
        });
      }

      return {
        ok: true,
        handedOff: true,
        reason,
        message: 'A human customer consultant has been requested and will assist shortly.',
      };
    }

    case 'create_quote': {
      const items = Array.isArray(args.items) ? args.items : [];
      if (items.length === 0) {
        return {
          ok: false,
          error: 'Cannot create quote: items list is empty.',
        };
      }

      // Authoritative SKU provenance check: The model proposes, the server decides
      for (const item of items) {
        if (!item.sku) {
          return { ok: false, error: 'Every quote line item must specify a product sku.' };
        }
        let prod = ctx.catalogProductCache.get(item.sku);
        if (!prod && !ctx.turnProductSkus.has(item.sku)) {
          try {
            const res = await ctx.catalogSearchHandler.execute(
              { query: item.sku, maxResults: 1 },
              makeExecContext(ctx)
            );
            const found = (res.products || res.items || []).find(
              (p: any) => String(p.sku).toLowerCase() === String(item.sku).toLowerCase()
            );
            if (found) {
              ctx.turnProductSkus.add(found.sku);
              ctx.catalogProductCache.set(found.sku, found);
              prod = found;
            }
          } catch {}
        }
        if (!prod && !ctx.turnProductSkus.has(item.sku)) {
          return {
            ok: false,
            error: `Cannot create quote: SKU "${item.sku}" could not be verified in the catalogue.`,
          };
        }
        if (prod && isProductDiscontinued(prod)) {
          return {
            ok: false,
            error: `Cannot create quote: SKU "${item.sku}" is discontinued and cannot be added to a quote.`,
          };
        }
      }

      const targetCapabilityId = resolveBoundCapability(ctx.release, 'create_quote');
      const inputPayload = {
        items: items.map((it: any) => ({
          sku: it.sku,
          quantity: Number(it.quantity) || 1,
          name: it.name,
        })),
        projectDimensions: args.projectDimensions,
        category: args.category || (args as any)?.classification || (args as any)?.projectCategory,
        currency: args.currency || ctx.release.profile?.primaryCurrency,
        accountNumber: args.accountNumber,
      };

      const idempotencyKey =
        ctx.idempotencyKey ||
        `${ctx.correlationId}:create_quote:${hashPayload(inputPayload)}`;

      // 1. Idempotency Check
      if (ctx.executionRepo) {
        const existing = await ctx.executionRepo.findExecution(
          ctx.tenantId,
          ctx.environmentId,
          ctx.workspaceId || 'agent_workspace',
          targetCapabilityId,
          idempotencyKey
        );
        if (existing) {
          if (existing.status === 'completed') {
            return {
              ok: true,
              status: 'success',
              quote: existing.outputPayload,
              idempotentReplay: true,
            };
          }
          if (existing.status === 'started') {
            return {
              ok: true,
              status: 'in_progress',
              inProgress: true,
              executionId: (existing as any).executionId,
              message: 'Quote creation is currently in progress.',
            };
          }
          if (existing.status === 'requires_approval') {
            return {
              ok: true,
              status: 'requires_approval',
              approvalRequestId: (existing as any).approvalRequestId,
              quote: {
                status: 'pending_approval',
                items: inputPayload.items,
              },
              message: 'Quote request submitted and requires approval.',
              idempotentReplay: true,
            };
          }
        }

        await ctx.executionRepo.recordExecution({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          workspaceId: ctx.workspaceId || 'agent_workspace',
          correlationId: ctx.correlationId,
          toolId: targetCapabilityId,
          idempotencyKey,
          status: 'started',
          inputPayload,
          executedBy: ctx.principalId,
          executedAt: new Date(),
        });
      }

      // 2. Server Approval Gate: The model proposes, the server decides
      const requiresApproval =
        args.requiresApproval === true ||
        (ctx.release as any)?.conversationPolicy?.requiresApproval?.includes(targetCapabilityId) ||
        (ctx.release as any)?.conversationPolicy?.requiresApproval?.includes('create_quote');

      if (requiresApproval && ctx.approvalService) {
        const pending = await ctx.approvalService.createPending(
          targetCapabilityId,
          inputPayload,
          makeExecContext(ctx)
        );

        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: targetCapabilityId,
            idempotencyKey,
            status: 'requires_approval',
            inputPayload,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }

        return {
          ok: true,
          status: 'requires_approval',
          approvalRequestId: pending.approvalRequestId,
          quote: {
            status: 'pending_approval',
            approvalRequestId: pending.approvalRequestId,
            items: inputPayload.items,
          },
          message: 'Quote request submitted and requires approval.',
        };
      }

      // 3. Dispatch to CapabilityGateway or Native Handler
      const startTime = Date.now();
      let quoteOutcome: any;
      try {
        if (ctx.capabilityGateway) {
          const execRes = await ctx.capabilityGateway.executeCapability(
            ctx.release,
            targetCapabilityId,
            inputPayload,
            makeExecContext(ctx)
          );
          if (execRes.status === 'requires_approval') {
            const pending = await ctx.approvalService?.createPending(
              targetCapabilityId,
              inputPayload,
              makeExecContext(ctx)
            );
            if (ctx.executionRepo) {
              await ctx.executionRepo.recordExecution({
                tenantId: ctx.tenantId,
                environmentId: ctx.environmentId,
                workspaceId: ctx.workspaceId || 'agent_workspace',
                correlationId: ctx.correlationId,
                toolId: targetCapabilityId,
                idempotencyKey,
                status: 'requires_approval',
                inputPayload,
                executedBy: ctx.principalId,
                executedAt: new Date(),
              });
            }
            return {
              ok: true,
              status: 'requires_approval',
              approvalRequestId: pending?.approvalRequestId || execRes.approvalRequestId,
              quote: {
                status: 'pending_approval',
                approvalRequestId: pending?.approvalRequestId || execRes.approvalRequestId,
                items: inputPayload.items,
              },
              message: execRes.error || 'Quote request requires approval.',
            };
          } else if (execRes.status === 'success') {
            quoteOutcome = execRes.output;
          } else {
            const nativeHandler =
              ctx.capabilityGateway.getNativeHandler(targetCapabilityId) ||
              ctx.capabilityGateway.getNativeHandler('quote.create') ||
              ctx.capabilityGateway.getNativeHandler('quote');
            if (nativeHandler) {
              quoteOutcome = await nativeHandler.execute(inputPayload, makeExecContext(ctx));
            } else {
              throw new Error(execRes.error || `${targetCapabilityId} capability execution failed`);
            }
          }
        } else {
          const handler = new QuoteCreateHandler(
            undefined,
            (ctx.inMemoryQuotes as any) || undefined,
            Array.from(ctx.catalogProductCache.values())
          );
          quoteOutcome = await handler.execute(inputPayload, makeExecContext(ctx));
        }

        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: targetCapabilityId,
            idempotencyKey,
            status: 'completed',
            inputPayload,
            outputPayload: quoteOutcome,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }

        if (ctx.inMemoryQuotes instanceof Map && quoteOutcome?.quoteId) {
          ctx.inMemoryQuotes.set(quoteOutcome.quoteId, quoteOutcome);
        }

        return {
          ok: true,
          status: 'success',
          quote: quoteOutcome,
          message: `Successfully created quote ${quoteOutcome?.quoteId || ''}.`,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: targetCapabilityId,
            idempotencyKey,
            status: 'failed',
            inputPayload,
            error: err.message,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }
        return {
          ok: false,
          error: `Failed to create quote: ${err.message}`,
        };
      }
    }

    case 'update_quote':
    case 'add_to_quote': {
      const quoteId = String(args.quoteId || '').trim();
      if (!quoteId) {
        return { ok: false, error: 'quoteId is required.' };
      }

      const inputPayload = {
        quoteId,
        items: args.items,
        specs: args.specs,
        spaceType: args.spaceType,
        finish: args.finish,
        totalAmountCents: args.totalAmountCents,
      };

      const idempotencyKey =
        ctx.idempotencyKey ||
        `${ctx.correlationId}:update_quote:${quoteId}:${hashPayload(inputPayload)}`;

      // 1. Idempotency Check
      if (ctx.executionRepo) {
        const existing = await ctx.executionRepo.findExecution(
          ctx.tenantId,
          ctx.environmentId,
          ctx.workspaceId || 'agent_workspace',
          'quote.update',
          idempotencyKey
        );
        if (existing) {
          if (existing.status === 'completed') {
            return {
              ok: true,
              status: 'success',
              quote: existing.outputPayload,
              idempotentReplay: true,
            };
          }
          if (existing.status === 'started') {
            return {
              ok: true,
              status: 'in_progress',
              inProgress: true,
              executionId: (existing as any).executionId,
              message: 'Quote update is currently in progress.',
            };
          }
          if (existing.status === 'requires_approval') {
            return {
              ok: true,
              status: 'requires_approval',
              approvalRequestId: (existing as any).approvalRequestId,
              message: 'Quote update submitted and requires approval.',
              idempotentReplay: true,
            };
          }
        }

        await ctx.executionRepo.recordExecution({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          workspaceId: ctx.workspaceId || 'agent_workspace',
          correlationId: ctx.correlationId,
          toolId: 'quote.update',
          idempotencyKey,
          status: 'started',
          inputPayload,
          executedBy: ctx.principalId,
          executedAt: new Date(),
        });
      }

      // 2. Server Approval Gate:
      const requiresApproval =
        args.requiresApproval === true ||
        (ctx.release as any)?.conversationPolicy?.requiresApproval?.includes('quote.update');

      if (requiresApproval && ctx.approvalService) {
        const pending = await ctx.approvalService.createPending(
          'quote.update',
          inputPayload,
          makeExecContext(ctx)
        );

        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'quote.update',
            idempotencyKey,
            status: 'requires_approval',
            inputPayload,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }

        return {
          ok: true,
          status: 'requires_approval',
          approvalRequestId: pending.approvalRequestId,
          message: 'Quote update submitted and requires approval.',
        };
      }

      // 3. Dispatch to CapabilityGateway or Native Handler
      const startTime = Date.now();
      let updateOutcome: any;
      try {
        if (ctx.capabilityGateway) {
          const execRes = await ctx.capabilityGateway.executeCapability(
            ctx.release,
            'quote.update',
            inputPayload,
            makeExecContext(ctx)
          );
          if (execRes.status === 'success') {
            updateOutcome = execRes.output;
          } else {
            const nativeHandler = ctx.capabilityGateway.getNativeHandler('quote.update');
            if (nativeHandler) {
              updateOutcome = await nativeHandler.execute(inputPayload, makeExecContext(ctx));
            } else {
              throw new Error(execRes.error || 'quote.update capability execution failed');
            }
          }
        } else {
          const handler = new QuoteUpdateHandler(
            undefined,
            ctx.inMemoryQuotes instanceof Map ? ctx.inMemoryQuotes : undefined
          );
          updateOutcome = await handler.execute(inputPayload, makeExecContext(ctx));
        }

        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'quote.update',
            idempotencyKey,
            status: 'completed',
            inputPayload,
            outputPayload: updateOutcome,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }

        return {
          ok: true,
          status: 'success',
          quote: updateOutcome?.quote || updateOutcome,
          message: `Successfully updated quote ${quoteId}.`,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'quote.update',
            idempotencyKey,
            status: 'failed',
            inputPayload,
            error: err.message,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }
        return {
          ok: false,
          error: `Failed to update quote: ${err.message}`,
        };
      }
    }

    case 'get_cart': {
      const cartId = String(args.cartId || `cart-${ctx.workspaceId || 'default'}`).trim();
      let cartData: any = null;

      if (ctx.inMemoryCarts instanceof Map) {
        cartData = ctx.inMemoryCarts.get(cartId) || ctx.inMemoryCarts.get('default');
      }

      if (!cartData && ctx.workspace?.facts?.cart?.value) {
        cartData = ctx.workspace.facts.cart.value;
      }

      if (!cartData) {
        cartData = {
          cartId,
          items: [],
          totalItems: 0,
          status: 'empty',
        };
      }

      return {
        ok: true,
        cart: cartData,
      };
    }

    case 'update_cart':
    case 'add_to_cart': {
      const items = Array.isArray(args.items) ? args.items : [];
      const cartId = String(args.cartId || `cart-${ctx.workspaceId || 'default'}`).trim();

      // Verify SKUs in catalogue
      for (const item of items) {
        if (!item.sku) {
          return { ok: false, error: 'Every cart item must specify a product sku.' };
        }
        let prod = ctx.catalogProductCache.get(item.sku);
        if (!prod && !ctx.turnProductSkus.has(item.sku)) {
          try {
            const res = await ctx.catalogSearchHandler.execute(
              { query: item.sku, maxResults: 1 },
              makeExecContext(ctx)
            );
            const found = (res.products || res.items || []).find(
              (p: any) => String(p.sku).toLowerCase() === String(item.sku).toLowerCase()
            );
            if (found) {
              ctx.turnProductSkus.add(found.sku);
              ctx.catalogProductCache.set(found.sku, found);
              prod = found;
            }
          } catch {}
        }
        if (!prod && !ctx.turnProductSkus.has(item.sku)) {
          return {
            ok: false,
            error: `Cannot update cart: SKU "${item.sku}" could not be verified in the catalogue.`,
          };
        }
        if (prod && isProductDiscontinued(prod)) {
          return {
            ok: false,
            error: `Cannot update cart: SKU "${item.sku}" is discontinued and cannot be added to a cart.`,
          };
        }
      }

      const inputPayload = {
        cartId,
        items: items.map((it: any) => ({
          sku: it.sku,
          quantity: Number(it.quantity) || 1,
        })),
        category: args.category,
      };

      const idempotencyKey =
        ctx.idempotencyKey ||
        `${ctx.correlationId}:update_cart:${cartId}:${hashPayload(inputPayload)}`;

      // 1. Idempotency Check
      if (ctx.executionRepo) {
        const existing = await ctx.executionRepo.findExecution(
          ctx.tenantId,
          ctx.environmentId,
          ctx.workspaceId || 'agent_workspace',
          'cart.update',
          idempotencyKey
        );
        if (existing) {
          if (existing.status === 'completed') {
            return {
              ok: true,
              status: 'success',
              cart: existing.outputPayload,
              idempotentReplay: true,
            };
          }
          if (existing.status === 'started') {
            return {
              ok: true,
              status: 'in_progress',
              inProgress: true,
              executionId: (existing as any).executionId,
              message: 'Cart update is currently in progress.',
            };
          }
        }

        await ctx.executionRepo.recordExecution({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          workspaceId: ctx.workspaceId || 'agent_workspace',
          correlationId: ctx.correlationId,
          toolId: 'cart.update',
          idempotencyKey,
          status: 'started',
          inputPayload,
          executedBy: ctx.principalId,
          executedAt: new Date(),
        });
      }

      // 2. Dispatch to CapabilityGateway or Native Handler
      const startTime = Date.now();
      let cartOutcome: any;
      try {
        if (ctx.capabilityGateway) {
          const execRes = await ctx.capabilityGateway.executeCapability(
            ctx.release,
            'cart.update',
            inputPayload,
            makeExecContext(ctx)
          );
          if (execRes.status === 'success') {
            cartOutcome = execRes.output;
          } else {
            const nativeHandler = ctx.capabilityGateway.getNativeHandler('cart.update');
            if (nativeHandler) {
              cartOutcome = await nativeHandler.execute(inputPayload, makeExecContext(ctx));
            } else {
              throw new Error(execRes.error || 'cart.update capability execution failed');
            }
          }
        } else {
          const handler = new CartUpdateHandler(
            undefined,
            ctx.inMemoryCarts instanceof Map ? ctx.inMemoryCarts : undefined
          );
          cartOutcome = await handler.execute(inputPayload, makeExecContext(ctx));
        }

        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'cart.update',
            idempotencyKey,
            status: 'completed',
            inputPayload,
            outputPayload: cartOutcome,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }

        return {
          ok: true,
          status: 'success',
          cart: cartOutcome?.cart || cartOutcome,
          message: 'Cart updated successfully.',
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'cart.update',
            idempotencyKey,
            status: 'failed',
            inputPayload,
            error: err.message,
            durationMs,
            executedBy: ctx.principalId,
            executedAt: new Date(),
          });
        }
        return {
          ok: false,
          error: `Failed to update cart: ${err.message}`,
        };
      }
    }

    default:
      return {
        ok: false,
        error: `Unknown tool "${toolName}". Available tools: ${AGENT_TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`,
      };
  }
}
