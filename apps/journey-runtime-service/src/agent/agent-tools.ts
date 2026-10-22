import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CARD_TYPES, type CardType, CARD_TYPE_NAMES } from '@journeyax/ui-cards';
import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { ClaimClass, OkfReleaseContent, OkfEvidenceChunk, OkfConcept } from '@journeyax/knowledge';
import { effectiveVerification, scopedClaims, verifiedEvidenceRefs, mergeSearchScopes } from '@journeyax/knowledge';
import type { WorkspaceState } from '@journeyax/journey-core';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import { extractRelevantOkfNotes, findRelevantOkfConcepts, OKF_ALLOWED_RELATIONSHIP_TYPES } from '../kernel/business-knowledge';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import { KnowledgeSearchHandler } from '../capabilities/handlers/knowledge-search.handler';
import { TradeQuoteCreateHandler } from '../capabilities/handlers/trade-quote-create.handler';
import { QuoteUpdateHandler } from '../capabilities/handlers/quote-update.handler';
import { CartUpdateHandler } from '../capabilities/handlers/cart-update.handler';
import type { CapabilityGateway } from '../kernel/capability.gateway';
import type { ApprovalService } from '../kernel/approval.service';
import type { ExecutionRepository } from '../kernel/execution.repository';
import type { KnowledgeControlPlanePort } from '../kernel/knowledge-control-plane';

export interface AgentToolContext {
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  workspaceId?: string;
  sessionId?: string;
  correlationId: string;
  principalId?: string;
  principalRole?: string;
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
  inMemoryQuotes?: Map<string, any> | Record<string, any>;
  inMemoryCarts?: Map<string, any> | Record<string, any>;
  turnProductSkus: Set<string>;
  catalogProductCache: Map<string, any>;
  readSourceIds: Set<string>;
  allowedClaimClasses: Set<ClaimClass>;
  presentedCards: Array<{ cardType: string; state: any }>;
  isHumanHandoffRequested: boolean;
  handoffReason?: string;
  customerQuestion?: string;
  consultedConcepts?: Set<OkfConcept>;
  signal?: AbortSignal;
  emitUiAction?: (action: { name: string; arguments: any }) => void;
  emitTrace?: (name: string, payload: any) => void;
}

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

export function hashPayload(val: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(val || {})).digest('hex').slice(0, 16);
  } catch {
    return 'nohash';
  }
}

export const TOOL_CAPABILITY_ALIASES: Record<string, string[]> = {
  search_products: ['catalog.search', 'catalog_search', 'catalog.*', 'search_products'],
  get_product: ['catalog.search', 'catalog_search', 'catalog.get', 'catalog_get', 'catalog.*', 'get_product'],
  get_related_products: ['catalog.search', 'catalog_search', 'catalog.related', 'catalog.*', 'get_related_products'],
  check_stock: ['branch.stock_check', 'branch_stock_check', 'inventory.check', 'inventory_check', 'stock.*', 'check_stock'],
  consult_business_knowledge: ['knowledge.search', 'knowledge_search', 'knowledge.*', 'consult_business_knowledge'],
  search_guides: ['knowledge.search', 'knowledge_search', 'knowledge.*', 'search_guides'],
  get_warranty: ['knowledge.search', 'knowledge_search', 'knowledge.*', 'get_warranty'],
  calculate_quantity: ['calculator.*', 'quantity.calculate', 'calculate_quantity'],
  present_card: ['ui.present_card', 'ui_cards', 'cards.*', 'present_card'],
  hand_off_to_human: ['handoff.*', 'human_handoff', 'agent.handoff', 'hand_off_to_human'],
  create_quote: ['trade.quote_create', 'quote.create', 'quote', 'create_quote', 'quotes.*'],
  update_quote: ['quote.update', 'quote_update', 'quote.*', 'update_quote', 'quotes.*'],
  add_to_quote: ['quote.update', 'quote_update', 'quote.*', 'add_to_quote', 'quotes.*'],
  get_cart: ['cart.get', 'cart.*', 'get_cart', 'cart'],
  update_cart: ['cart.update', 'cart_update', 'cart.*', 'update_cart', 'add_to_cart'],
  add_to_cart: ['cart.update', 'cart_update', 'cart.*', 'add_to_cart', 'update_cart'],
};

export function isToolAllowed(toolName: string, allowedTools?: string[]): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;
  if (allowedTools.includes('*') || allowedTools.includes('all')) return true;
  if (allowedTools.includes(toolName)) return true;

  const aliases = TOOL_CAPABILITY_ALIASES[toolName] || [toolName];
  for (const allowed of allowedTools) {
    if (aliases.includes(allowed)) return true;
    if (allowed.endsWith('.*')) {
      const prefix = allowed.slice(0, -2);
      if (toolName.startsWith(prefix) || aliases.some((a) => a.startsWith(prefix))) {
        return true;
      }
    }
  }
  return false;
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
          description: 'The project, product category, or technical question to consult (e.g. decking, plasterboard, tapware, screws).',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_products',
    description: "Search the product catalogue using structured parameters and exact dimension/treatment specifications. Copy codes like 'H3.2', 'R2.6', and '100x50' exactly as written by the customer. Returns matching products with SKU, title, price, category, and description. To check branch inventory availability or whether an item is in stock, use check_stock.",
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search keywords or phrases for products (e.g. ["composite decking", "screws"]).',
        },
        productType: {
          type: 'string',
          description: 'Product type or general noun (e.g. "timber", "screws", "insulation", "decking").',
        },
        size: {
          type: 'string',
          description: 'Dimension or size specification. Copy exactly as written (e.g. "100x50", "90x45", "150x50", "4x2").',
        },
        treatment: {
          type: 'string',
          description: 'Treatment grade or level. Copy code exactly as written (e.g. "H3.2", "H1.2", "H4", "CCA", "Boron", "Untreated").',
        },
        rValue: {
          type: 'string',
          description: 'Thermal resistance rating code. Copy code exactly as written (e.g. "R2.2", "R2.6", "R3.2").',
        },
        brand: {
          type: 'string',
          description: 'Brand name filter.',
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
    description: 'Search verified installation guides, technical specifications, and project how-to documents. Returns guidance steps and document links.',
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
    description: 'Deterministically calculate material quantities, sheet counts, linear metres, fixings, or paint coverage for a project with waste factors.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'The project type (e.g. decking, plasterboard, painting, tiling).',
        },
        measurements: {
          type: 'object',
          description: 'Key-value pairs of project measurements (e.g. area, length, width, height, studSpacing).',
        },
      },
      required: ['project', 'measurements'],
    },
  },
  {
    name: 'check_stock',
    description: 'Check real-time stock availability and inventory levels for a product SKU at a specific branch or location. Only a check_stock result supports claiming an item is in stock or out of stock.',
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
            'fitment',
            'disclosure',
            'hero',
            'working',
          ],
          description: 'The approved card type name.',
        },
        state: {
          type: 'object',
          description: 'The card state data matching the card type schema.',
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
    description: 'Request creation of a formal trade quote for specified items and quantities. The server verifies items against catalogue pricing, applies trade account terms, and checks required approvals. The model proposes, the server decides.',
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
        tradeCategory: { type: 'string', description: 'Optional trade category or project classification.' },
        projectDimensions: { type: 'string', description: 'Optional project specifications or measurements.' },
        currency: { type: 'string', description: 'Optional currency code (must match pack currency).' },
        accountNumber: { type: 'string', description: 'Optional trade account number.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'update_quote',
    description: 'Update an existing trade quote with revised specifications, quantities, or line items. Modifying finalized quotes or exceeding approval thresholds triggers server approval.',
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
    description: 'Add new items or specifications to an existing trade quote.',
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
  ]);
  return !mutatingTools.has(toolName);
}

/**
 * Executes an individual tool call within the server-verified execution context.
 * Strictly enforces tenant isolation: no tool receives tenantId or environmentId from model arguments.
 */
export async function executeAgentTool(
  toolName: string,
  rawArgs: Record<string, any>,
  ctx: AgentToolContext
): Promise<any> {
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason || new Error('Agent turn aborted');
  }

  // Strip any model-injected tenant or environment properties
  const args = { ...rawArgs };
  delete args.tenantId;
  delete args.environmentId;

  switch (toolName) {
    case 'consult_business_knowledge': {
      const topic = String(args.topic || '').trim();
      if (!ctx.okfContent || !topic) {
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

      const relevantRels = relationships.filter(
        (r) => (activeIds.has(r.from) || activeIds.has(r.to)) && OKF_ALLOWED_RELATIONSHIP_TYPES.has(r.type)
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
      const factMap = new Map((ctx.okfContent.facts || []).map((f) => [f.factKey, f]));
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

    case 'search_products': {
      const keywordsRaw = args.keywords;
      const keywords: string[] = Array.isArray(keywordsRaw)
        ? keywordsRaw.map(String).map((k) => k.trim()).filter(Boolean)
        : (typeof keywordsRaw === 'string' && keywordsRaw.trim())
          ? [keywordsRaw.trim()]
          : [];
      const query = String(args.query || '').trim();
      const productType = args.productType ? String(args.productType).trim() : undefined;
      const size = args.size ? String(args.size).trim() : undefined;
      const treatment = args.treatment ? String(args.treatment).trim() : undefined;
      const rValue = args.rValue ? String(args.rValue).trim() : undefined;
      const brand = args.brand ? String(args.brand).trim() : undefined;
      const filters = args.filters || {};
      const category = args.category ? String(args.category).trim() : (filters.category ? String(filters.category).trim() : undefined);
      const categoryIds = Array.isArray(args.categoryIds)
        ? args.categoryIds.map(String).filter(Boolean)
        : (typeof args.categoryIds === 'string' && args.categoryIds.trim())
          ? [args.categoryIds.trim()]
          : undefined;
      const categoryPaths = Array.isArray(args.categoryPaths) ? args.categoryPaths : undefined;
      const minPrice = args.minPrice ?? filters.minPrice;
      const maxPrice = args.maxPrice ?? filters.maxPrice;
      const inStockOnly = args.inStockOnly ?? filters.inStockOnly;

      const searchInput: any = {
        isAgentMode: true,
        keywords: keywords.length > 0 ? keywords : undefined,
        productType,
        size,
        treatment,
        rValue,
        brand,
        query: query || (keywords.length > 0 ? keywords.join(' ') : undefined),
        category,
        categoryIds,
        categoryPaths,
        minPriceCents: minPrice !== undefined ? Math.round(Number(minPrice) * 100) : undefined,
        maxPriceCents: maxPrice !== undefined ? Math.round(Number(maxPrice) * 100) : undefined,
        inStockOnly,
        maxResults: 6,
      };

      const result = await ctx.catalogSearchHandler.execute(searchInput, makeExecContext(ctx));

      const rawProducts = result.products || result.items || [];
      const products = Array.isArray(rawProducts) ? rawProducts : [];
      for (const p of products) {
        if (p.sku) {
          ctx.turnProductSkus.add(p.sku);
          ctx.catalogProductCache.set(p.sku, p);
        }
      }

      const displayQuery = query || keywords.join(' ') || [productType, size, treatment, rValue, brand].filter(Boolean).join(' ') || 'catalogue search';

      if (products.length === 0) {
        return {
          query: displayQuery,
          count: 0,
          products: [],
          message: `Could not find any products matching "${displayQuery}" in the catalogue. Please inform the customer that no matching products were found in the catalogue. Do NOT say the product is out of stock.`,
        };
      }

      ctx.allowedClaimClasses.add('catalog_fact');

      return {
        query: displayQuery,
        count: products.length,
        products: products.map((p) => ({
          sku: p.sku,
          title: p.title || p.name,
          price: p.priceUSD?.min ?? p.price ?? null,
          currency: p.currency || ctx.release.profile?.primaryCurrency,
          category: p.category,
          excerpt: p.description?.slice(0, 140),
        })),
      };
    }

    case 'get_product': {
      const sku = String(args.sku || '').trim();
      // Search by SKU in catalogue
      const result = await ctx.catalogSearchHandler.execute(
        { query: sku, maxResults: 1 },
        makeExecContext(ctx)
      );

      const rawItems = result.products || result.items || [];
      const found = (rawItems || []).find(
        (p: any) => String(p.sku).toLowerCase() === sku.toLowerCase()
      ) || rawItems?.[0];

      if (found && found.sku) {
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
          },
        };
      }

      return { found: false, sku, message: `Product SKU '${sku}' not found in catalogue.` };
    }

    case 'get_related_products': {
      const sku = String(args.sku || '').trim();
      const kind = String(args.kind || 'recommended').toLowerCase();

      // Look up target product first
      let mainProd = ctx.catalogProductCache.get(sku);
      if (!mainProd) {
        const res = await ctx.catalogSearchHandler.execute(
          { query: sku, maxResults: 1 },
          makeExecContext(ctx)
        );
        const rawCandidates = res.products || res.items || [];
        mainProd = (rawCandidates || []).find((p: any) => String(p.sku).toLowerCase() === sku.toLowerCase());
        if (mainProd?.sku) {
          ctx.turnProductSkus.add(mainProd.sku);
          ctx.catalogProductCache.set(mainProd.sku, mainProd);
        }
      }

      // Check OKF relationships if available
      const relatedTerms: string[] = [];
      if (ctx.okfContent?.relationships && Array.isArray(ctx.okfContent.relationships)) {
        for (const rel of ctx.okfContent.relationships) {
          const isMatch =
            (rel.from && mainProd?.category && rel.from.toLowerCase().includes(mainProd.category.toLowerCase())) ||
            (rel.from && mainProd?.name && rel.from.toLowerCase().includes(mainProd.name.toLowerCase()));
          if (isMatch) {
            relatedTerms.push(rel.to);
            const relVer = rel.verificationRef
              ? (ctx.okfContent.verifications || []).find((v) => v.recordId === rel.verificationRef)
              : undefined;
            if (effectiveVerification(relVer, new Date()) === 'verified') {
              for (const cc of rel.claimClasses || ['compatibility']) {
                ctx.allowedClaimClasses.add(cc);
              }
            }
          }
        }
      }

      // If no explicit OKF relationships, search related products by category or keywords
      const searchQuery = relatedTerms.length > 0 ? relatedTerms.join(' ') : mainProd?.category || 'accessories';
      const searchRes = await ctx.catalogSearchHandler.execute(
        { query: searchQuery, maxResults: 4 },
        makeExecContext(ctx)
      );

      const rawItems = searchRes.products || searchRes.items || [];
      const items = (rawItems || []).filter((p: any) => p.sku !== sku);
      for (const it of items) {
        if (it.sku) {
          ctx.turnProductSkus.add(it.sku);
          ctx.catalogProductCache.set(it.sku, it);
        }
      }

      if (items.length > 0) {
        ctx.allowedClaimClasses.add('catalog_fact');
      }

      return {
        forSku: sku,
        kind,
        relatedProducts: items.map((p: any) => ({
          sku: p.sku,
          title: p.title || p.name,
          price: p.priceUSD?.min ?? p.price ?? null,
          currency: p.currency || ctx.release.profile?.primaryCurrency,
          inStock: Boolean(p.inStock),
          relation: kind,
        })),
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
          const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
          const matches = qTokens.some((tok) => contentLower.includes(tok) || titleLower.includes(tok));
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
        for (const s of ctx.okfContent.sources) {
          if (s.title.toLowerCase().includes(query.toLowerCase()) || s.title.toLowerCase().includes(productOrCategory.toLowerCase())) {
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

      return {
        query,
        productOrCategory,
        guides: matchedGuides.slice(0, 3),
        count: matchedGuides.length,
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

      return {
        productOrBrand: target,
        found: false,
        warranty: {
          message: `No verified warranty certificate registered for '${target}'. Please consult store staff.`,
        },
      };
    }

    case 'calculate_quantity': {
      const project = String(args.project || '').toLowerCase();
      const m = args.measurements || {};

      let result: any;
      if (project.includes('deck')) {
        // Deck calculation: length (m) * width (m) => area
        const length = Number(m.length || m.l || 0);
        const width = Number(m.width || m.w || 0);
        const area = Number(m.area) || (length > 0 && width > 0 ? length * width : 12);
        const boardWidthM = Number(m.boardWidthMm || 140) / 1000;
        const wasteFactor = 1.1; // 10% waste
        const linearMetres = Math.ceil((area / boardWidthM) * wasteFactor);
        const screwsCount = Math.ceil(area * 35); // ~35 screws per m²

        result = {
          project: 'decking',
          areaSquareMetres: area,
          boardLinearMetres: linearMetres,
          screwsCount,
          wasteFactorPercentage: 10,
          recommendation: `For ${area}m² of decking, order approximately ${linearMetres} linear metres of 140mm board (includes 10% cut waste) and ${screwsCount} decking screws.`,
        };
      } else if (project.includes('plaster') || project.includes('wall') || project.includes('sheet')) {
        // Plasterboard / Wallboard calculation: area / 2.88 (standard 2.4x1.2 sheet)
        const area = Number(m.area || (Number(m.length || 0) * Number(m.height || 2.4)) || 20);
        const sheetArea = 2.4 * 1.2; // 2.88m²
        const sheetCount = Math.ceil((area / sheetArea) * 1.1); // 10% waste
        const screwsCount = sheetCount * 30; // 30 screws per sheet
        const compoundKg = Math.ceil(area * 0.5); // ~0.5kg per m²

        result = {
          project: 'plasterboard',
          areaSquareMetres: area,
          sheetCount,
          screwsCount,
          jointCompoundKg: compoundKg,
          recommendation: `For ${area}m² of wall area, you will need ${sheetCount} sheets of 2.4x1.2m board, ${screwsCount} wallboard screws, and approximately ${compoundKg}kg of joint compound.`,
        };
      } else if (project.includes('paint')) {
        // Paint calculation: area * coats / coverage (14m²/L)
        const area = Number(m.area || 30);
        const coats = Number(m.coats || 2);
        const litres = Math.ceil(((area * coats) / 14) * 1.1);

        result = {
          project: 'painting',
          areaSquareMetres: area,
          coats,
          litresRequired: litres,
          recommendation: `For ${area}m² with ${coats} coats, you need approximately ${litres} litres of paint (assuming 14m²/L coverage with 10% reserve).`,
        };
      } else {
        const area = Number(m.area || 10);
        result = {
          project,
          areaSquareMetres: area,
          recommendation: `Estimated project coverage based on ${area}m².`,
        };
      }

      ctx.allowedClaimClasses.add('requirement');
      return result;
    }

    case 'check_stock': {
      const sku = String(args.sku || '').trim();
      const branch = String(args.branch || 'Main Branch').trim();

      const cached = ctx.catalogProductCache.get(sku);
      ctx.turnProductSkus.add(sku);
      ctx.allowedClaimClasses.add('catalog_fact');
      ctx.allowedClaimClasses.add('stock');

      return {
        sku,
        branch,
        inStock: cached ? Boolean(cached.inStock) : true,
        stockLevel: cached?.stockLevel || (cached?.inStock ? 'Available (in stock)' : 'Special order / check branch'),
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

      const state = (args.state && typeof args.state === 'object') ? { ...args.state } : {};

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

      // 3. SKU Provenance Verification: Every product SKU must have been returned by a tool result this turn
      for (const sku of referencedSkus) {
        if (!ctx.turnProductSkus.has(sku)) {
          return {
            ok: false,
            error: `Rejected card: SKU "${sku}" was not returned by a product search or lookup tool in this turn for tenant "${ctx.tenantId}". You must search or look up products first before presenting them.`,
          };
        }
      }

      // 3. Overwrite / join authoritative pricing and stock facts from catalogue data, never model-authored text
      const enrichProduct = (p: any) => {
        if (!p || typeof p !== 'object' || !p.sku) return p;
        const cached = ctx.catalogProductCache.get(p.sku);
        if (!cached) return p;
        return {
          ...p,
          title: cached.title || cached.name || p.title,
          price: cached.priceUSD?.min ?? cached.price ?? p.price,
          currency: cached.currency || ctx.release.profile?.primaryCurrency || p.currency,
          inStock: cached.inStock !== undefined ? Boolean(cached.inStock) : p.inStock,
          availability: cached.inStock ? 'in_stock' : 'out_of_stock',
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
      }

      const inputPayload = {
        items: items.map((it: any) => ({
          sku: it.sku,
          quantity: Number(it.quantity) || 1,
          name: it.name,
        })),
        projectDimensions: args.projectDimensions,
        tradeCategory: args.tradeCategory,
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
          'trade.quote_create',
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
              message: 'Trade quote request submitted and requires approval.',
              idempotentReplay: true,
            };
          }
        }

        await ctx.executionRepo.recordExecution({
          tenantId: ctx.tenantId,
          environmentId: ctx.environmentId,
          workspaceId: ctx.workspaceId || 'agent_workspace',
          correlationId: ctx.correlationId,
          toolId: 'trade.quote_create',
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
        (ctx.release as any)?.conversationPolicy?.requiresApproval?.includes('trade.quote_create') ||
        (ctx.release as any)?.conversationPolicy?.requiresApproval?.includes('create_quote');

      if (requiresApproval && ctx.approvalService) {
        const pending = await ctx.approvalService.createPending(
          'trade.quote_create',
          inputPayload,
          makeExecContext(ctx)
        );

        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'trade.quote_create',
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
          message: 'Trade quote request submitted and requires approval.',
        };
      }

      // 3. Dispatch to CapabilityGateway or Native Handler
      const startTime = Date.now();
      let quoteOutcome: any;
      try {
        if (ctx.capabilityGateway) {
          const execRes = await ctx.capabilityGateway.executeCapability(
            ctx.release,
            'trade.quote_create',
            inputPayload,
            makeExecContext(ctx)
          );
          if (execRes.status === 'requires_approval') {
            const pending = await ctx.approvalService?.createPending(
              'trade.quote_create',
              inputPayload,
              makeExecContext(ctx)
            );
            if (ctx.executionRepo) {
              await ctx.executionRepo.recordExecution({
                tenantId: ctx.tenantId,
                environmentId: ctx.environmentId,
                workspaceId: ctx.workspaceId || 'agent_workspace',
                correlationId: ctx.correlationId,
                toolId: 'trade.quote_create',
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
              message: execRes.error || 'Trade quote request requires approval.',
            };
          } else if (execRes.status === 'success') {
            quoteOutcome = execRes.output;
          } else {
            const nativeHandler = ctx.capabilityGateway.getNativeHandler('trade.quote_create');
            if (nativeHandler) {
              quoteOutcome = await nativeHandler.execute(inputPayload, makeExecContext(ctx));
            } else {
              throw new Error(execRes.error || 'trade.quote_create capability execution failed');
            }
          }
        } else {
          const handler = new TradeQuoteCreateHandler(
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
            toolId: 'trade.quote_create',
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
          message: `Successfully created trade quote ${quoteOutcome?.quoteId || ''}.`,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        if (ctx.executionRepo) {
          await ctx.executionRepo.recordExecution({
            tenantId: ctx.tenantId,
            environmentId: ctx.environmentId,
            workspaceId: ctx.workspaceId || 'agent_workspace',
            correlationId: ctx.correlationId,
            toolId: 'trade.quote_create',
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
