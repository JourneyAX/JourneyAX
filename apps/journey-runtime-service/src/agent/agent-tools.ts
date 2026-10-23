import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CARD_TYPES, type CardType, CARD_TYPE_NAMES } from '@journeyax/ui-cards';
import type { BusinessPackRelease, BusinessPackContent, JourneyPlaybookStage } from '@journeyax/business-pack';
import type { ClaimClass, OkfReleaseContent, OkfEvidenceChunk, OkfConcept } from '@journeyax/knowledge';
import { effectiveVerification, scopedClaims, verifiedEvidenceRefs, mergeSearchScopes } from '@journeyax/knowledge';
import type { WorkspaceState } from '@journeyax/journey-core';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import {
  extractRelevantOkfNotes,
  findRelevantOkfConcepts,
  resolveAgentRelationshipTypes,
  OKF_ALLOWED_RELATIONSHIP_TYPES,
} from '../kernel/business-knowledge';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
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
import { deriveJourneyChecklist } from './journey-checklist';

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
  knowledgeGapRepo?: KnowledgeGapRepository;
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
  agentRelationshipTypes?: string[] | Set<string>;
  agentPlaybook?: JourneyPlaybookStage[];
  customerEvent?: any;
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
  okfContent?: any
): AgentToolDefinition[] {
  const calculators =
    (release as any)?.calculators ||
    (okfContent as any)?.calculators ||
    [];

  const hasCalculators = Array.isArray(calculators) && calculators.length > 0;

  return AGENT_TOOL_DEFINITIONS.filter((tool) => {
    if (tool.name === 'calculate_quantity' && !hasCalculators) {
      return false;
    }
    return true;
  }).map((tool) => {
    if (tool.name === 'search_products') {
      return specializeSearchProductsTool(tool, release);
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
          description: 'Product type or category name.',
        },
        attributes: {
          type: 'object',
          description: 'Structured product attribute filters (e.g. key-value pairs matching product specifications).',
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
      const categoryPaths = Array.isArray(args.categoryPaths) ? args.categoryPaths : undefined;
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
        };
      }

      return {
        found: true,
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
      const branch = String(args.branch || 'Main Branch').trim();

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
          branch,
          inStock: false,
          isDiscontinued: true,
          stockLevel: 'Discontinued (no longer stocked)',
          message: `SKU ${sku} is discontinued and no longer stocked. Do not claim this item is in stock.`,
        };
      }

      const inStock = cached ? Boolean(cached.inStock) : false;
      return {
        sku,
        branch,
        inStock,
        stockLevel: cached?.stockLevel || (inStock ? 'Available (in stock)' : 'Out of stock / special order'),
        message: inStock
          ? `SKU ${sku} is verified IN STOCK at ${branch}.`
          : `SKU ${sku} is currently OUT OF STOCK at ${branch}. Do not claim this item is in stock.`,
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
        return {
          ...p,
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
