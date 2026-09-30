/**
 * @deprecated FROZEN LEGACY TOOL DISPATCHER
 * Preserved strictly for unmigrated tenants behind the legacy boundary.
 * Canonical runtime paths must NEVER import or invoke this module.
 */

import { Injectable, Optional, Inject } from '@nestjs/common';
import OpenAI from 'openai';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { TradeOrchestrator } from './trade-orchestrator';
import { TurnSearchMemo } from '../pipeline/turn-search-memo';
import { IntentResult, TraceEntry } from '../pipeline/types';
import { QuoteService } from '../commerce/quote.service';
import { OrderService } from '../commerce/order.service';
import { SchoolResearchService } from '../commerce/school-research.service';

/**
 * Parses tool arguments defensively.
 */
export function safeParseArgs(raw: string | Record<string, any> | undefined): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Parses balanced TOOL_CALL: name(...) expressions for open / self-hosted models.
 */
export function findBalancedToolCall(
  buffer: string
): { fullMatch: string; toolName: string; rawArgs: string; endIndex: number } | null {
  const prefixMatch = /TOOL_CALL:\s*([a-zA-Z0-9_]+)\s*\(/i.exec(buffer);
  if (!prefixMatch) return null;

  const startIndex = prefixMatch.index;
  const toolName = prefixMatch[1];
  const parenOpenIndex = startIndex + prefixMatch[0].length - 1;

  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escape = false;

  for (let i = parenOpenIndex; i < buffer.length; i++) {
    const ch = buffer[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inString) {
      if (ch === quoteChar) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          const rawArgs = buffer.slice(parenOpenIndex + 1, i);
          const fullMatch = buffer.slice(startIndex, i + 1);
          return { fullMatch, toolName, rawArgs, endIndex: i + 1 };
        }
      }
    }
  }

  return null;
}

/**
 * Registered executable tool handlers in generic runtime.
 * Every advertised tool MUST have an executable registered handler.
 */
export const REGISTERED_TOOL_HANDLERS = new Set<string>([
  'openSpacePlanner',
  'spacePlanner.open',
  'calculateMaterials',
  'project.calculate_materials',
  'checkBranchStock',
  'branch.stock_check',
  'trade.branch_stock',
  'searchKnowledge',
  'catalog.search',
  'knowledge.search',
  'showItems',
  'products.present',
  'showGuide',
  'guide.present',
  'setPhase',
  'journey.set_phase',
  'journey.clarify',
  'updateQuote',
  'trade.quote_create',
  'quote.update',
  'cart.mutate',
  'researchSchool',
  'school.research',
]);

export function isExecutableTool(toolName: string): boolean {
  return REGISTERED_TOOL_HANDLERS.has(toolName);
}

/**
 * Baseline generic tool definitions.
 */
export const BASE_TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchKnowledge',
      description: 'Search knowledge base or catalogue for items, guides, warranty, or policy.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords' },
          type: { type: 'string', enum: ['product', 'installation', 'troubleshooting', 'faq', 'all'] },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showItems',
      description: 'Present catalogue product cards to the customer on screen.',
      parameters: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'number' },
                image: { type: 'string' },
              },
              required: ['sku'],
            },
          },
        },
        required: ['products'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showGuide',
      description: 'Render step-by-step guidance, installation steps, or troubleshooting checklist.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setPhase',
      description: 'Advance the customer journey stage or present interactive clarification questions.',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'options'],
            },
          },
        },
        required: ['phase'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updateQuote',
      description: 'Update the customer quote or bag with verified SKUs and quantities.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                quantity: { type: 'number' },
              },
              required: ['sku', 'quantity'],
            },
          },
          remove: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'openSpacePlanner',
      description: 'Open the 2D/3D space planner canvas for layout, bathroom, or room configuration.',
      parameters: {
        type: 'object',
        properties: {
          roomType: { type: 'string' },
          wallWidthMm: { type: 'number' },
          installType: { type: 'string', enum: ['diy', 'trade'] },
          finish: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkBranchStock',
      description: 'Check verified stock at a specific branch or location via inventory connector.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          branch: { type: 'string' },
        },
        required: ['sku', 'branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculateMaterials',
      description: 'Calculate trade project structural materials and bill of quantities.',
      parameters: {
        type: 'object',
        properties: {
          projectType: { type: 'string' },
          lengthM: { type: 'number' },
          widthM: { type: 'number' },
          heightM: { type: 'number' },
          areaM2: { type: 'number' },
          material: { type: 'string' },
        },
        required: ['projectType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'researchSchool',
      description: 'Research organization, team, or school brand colors and mascot.',
      parameters: {
        type: 'object',
        properties: {
          school: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['school'],
      },
    },
  },
];

export interface BuildToolsetOptions {
  pack?: BusinessPackRelease;
  journeyId?: string;
  stageId?: string;
  enabledCapabilities?: string[];
  closing?: 'bag' | 'quote';
  customTools?: OpenAI.ChatCompletionTool[];
}

export interface ToolExecutionContext {
  tenantId: string;
  intent: IntentResult;
  searchMemo?: TurnSearchMemo;
  retrievalCtx?: any;
  pack?: BusinessPackRelease;
  projectConfig?: any;
  quoteService?: QuoteService;
  orderService?: OrderService;
  schoolResearch?: SchoolResearchService;
  emit?: (event: string, data: any) => void;
  pushTrace?: (entry: TraceEntry) => void;
}

/**
 * Builds the available toolset strictly from active pack capabilities, stage permissions,
 * and registered executable handlers.
 */
export function buildToolset(
  optionsOrEnabled?: BuildToolsetOptions | string[],
  entityModel?: { label?: string; labelPlural?: string },
  closingArg: 'bag' | 'quote' = 'quote',
  customToolsArg?: OpenAI.ChatCompletionTool[]
): OpenAI.ChatCompletionTool[] {
  let pack: BusinessPackRelease | undefined;
  let journeyId: string | undefined;
  let stageId: string | undefined;
  let enabled: string[] | undefined;
  let closing = closingArg;
  let customTools = customToolsArg;

  if (optionsOrEnabled && typeof optionsOrEnabled === 'object' && !Array.isArray(optionsOrEnabled)) {
    const opts = optionsOrEnabled as BuildToolsetOptions;
    pack = opts.pack;
    journeyId = opts.journeyId;
    stageId = opts.stageId;
    enabled = opts.enabledCapabilities;
    closing = opts.closing || 'quote';
    customTools = opts.customTools;
  } else if (Array.isArray(optionsOrEnabled)) {
    enabled = optionsOrEnabled;
  }

  // 1. Pack-driven canonical toolset assembly
  if (pack?.capabilities?.toolDefinitions && pack.capabilities.toolDefinitions.length > 0) {
    const stageBindings = pack.capabilities.stageBindings || [];
    let allowedToolIds: Set<string> | null = null;

    if (journeyId && stageId && stageBindings.length > 0) {
      const stageMatch = stageBindings.find(
        (sb) => sb.journeyId === journeyId && sb.stageId === stageId
      );
      if (stageMatch) {
        allowedToolIds = new Set(stageMatch.tools.map((t) => t.toolId));
      }
    }

    if (!allowedToolIds && pack.capabilities.toolBindings && pack.capabilities.toolBindings.length > 0) {
      allowedToolIds = new Set(
        pack.capabilities.toolBindings
          .filter((b) => b.enabled !== false)
          .map((b) => b.toolId)
      );
    }

    // Fail closed: Do not expose all tools when mappings/bindings are absent
    if (!allowedToolIds) {
      return [];
    }

    const packTools: OpenAI.ChatCompletionTool[] = [];
    for (const def of pack.capabilities.toolDefinitions) {
      if (!allowedToolIds.has(def.toolId)) {
        continue;
      }
      // Every advertised tool must have an executable registered handler
      const hasHandler =
        isExecutableTool(def.toolId) ||
        (customTools && customTools.some((ct) => (ct as any).function?.name === def.toolId));
      if (!hasHandler) {
        continue;
      }

      packTools.push({
        type: 'function',
        function: {
          name: def.toolId,
          description: def.description || def.displayName,
          parameters:
            def.inputSchema && Object.keys(def.inputSchema).length > 0
              ? (def.inputSchema as any)
              : { type: 'object', properties: {} },
        },
      });
    }

    return packTools;
  }

  // 2. Capability-based fallback assembly (when pack definitions are absent)
  // Fail closed: Do NOT expose tools when mappings / enabled capabilities are absent
  if (!Array.isArray(enabled) || enabled.length === 0) {
    return [];
  }

  const allowed = new Set<string>();
  if (closing === 'bag') {
    allowed.add('updateQuote');
  }

  for (const cap of enabled) {
    if (cap === 'products') {
      allowed.add('showItems');
      allowed.add('searchKnowledge');
    } else if (cap === 'troubleshooting' || cap === 'installation') {
      allowed.add('showGuide');
    } else if (cap === 'spacePlanner') {
      allowed.add('openSpacePlanner');
      allowed.add('calculateMaterials');
    } else if (cap === 'branchStock') {
      allowed.add('checkBranchStock');
    } else if (cap === 'schoolResearch') {
      allowed.add('researchSchool');
    } else if (cap === 'quote') {
      allowed.add('updateQuote');
    } else if (cap === 'phase' || cap === 'journey') {
      allowed.add('setPhase');
    }
  }

  const pool = [...BASE_TOOL_DEFINITIONS, ...(customTools || [])];
  return pool.filter(
    (t) => t.type === 'function' && allowed.has(t.function.name) && isExecutableTool(t.function.name)
  );
}

/**
 * Dispatches an executed tool call to the appropriate domain service or trade orchestrator.
 * Unknown or unbound tools fail closed (never return { executed: true }).
 */
export async function executeTool(
  toolName: string,
  rawArgs: string | Record<string, any>,
  ctx: ToolExecutionContext
): Promise<any> {
  const args = safeParseArgs(rawArgs);

  switch (toolName) {
    case 'openSpacePlanner':
    case 'spacePlanner.open': {
      return TradeOrchestrator.handleOpenSpacePlanner(ctx.tenantId, args, ctx.pack);
    }

    case 'calculateMaterials':
    case 'project.calculate_materials': {
      return TradeOrchestrator.handleBuildProjectPlan(args);
    }

    case 'checkBranchStock':
    case 'branch.stock_check':
    case 'trade.branch_stock': {
      return TradeOrchestrator.handleCheckBranchStock(ctx.tenantId, args);
    }

    case 'searchKnowledge':
    case 'catalog.search':
    case 'knowledge.search': {
      if (ctx.searchMemo) {
        const query = args.query || args.tradeCategory || args.room_dimensions || '';
        const searchType = args.type || (toolName.includes('knowledge') ? 'installation' : 'product');
        return ctx.searchMemo.search({
          query,
          type: searchType,
          limit: args.limit,
          reason: 'model_tool',
        });
      }
      return { results: [] };
    }

    case 'showItems':
    case 'products.present': {
      const items = Array.isArray(args.products) ? args.products : Array.isArray(args.items) ? args.items : [];
      return { ok: true, count: items.length, products: items };
    }

    case 'showGuide':
    case 'guide.present': {
      return { ok: true, title: args.title || 'Guide', steps: Array.isArray(args.steps) ? args.steps : [] };
    }

    case 'setPhase':
    case 'journey.set_phase':
    case 'journey.clarify': {
      return { ok: true, phase: args.phase, questions: Array.isArray(args.questions) ? args.questions : [] };
    }

    case 'updateQuote':
    case 'trade.quote_create':
    case 'quote.update':
    case 'cart.mutate': {
      const items = Array.isArray(args.items) ? args.items : [];
      const quoteService = ctx.quoteService || new QuoteService();
      const pricing = ctx.projectConfig?.pricing || (ctx.pack?.profile as any)?.pricing;
      return quoteService.build({
        tenantId: ctx.tenantId,
        sessionId: (ctx as any).sessionId,
        title: args.title || 'Quote',
        items: items.map((i: any) => ({
          sku: String(i.sku || '').trim(),
          quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
        })),
        roomType: args.roomType,
        plannerContext: args.plannerContext,
        pack: ctx.pack,
        pricing: pricing || { currency: '', symbol: '', taxRate: 0, discountRate: 0 },
      });
    }

    case 'researchSchool':
    case 'school.research': {
      const schoolService = ctx.schoolResearch || new SchoolResearchService();
      return schoolService.research({
        tenantId: ctx.tenantId,
        school: args.school,
        location: args.location,
        force: args.force,
        provider: ctx.projectConfig?.provider,
        apiKey: ctx.projectConfig?.apiKey,
        baseUrl: ctx.projectConfig?.baseUrl,
        model: ctx.projectConfig?.researchModel,
      });
    }

    default:
      // FAIL CLOSED: Unknown or unbound tools are rejected
      throw new Error(`[ToolDispatcher] Unknown or unbound tool: "${toolName}". Execution blocked (fail closed).`);
  }
}

@Injectable()
export class ToolDispatcher {
  constructor(
    @Optional() @Inject(QuoteService) private readonly quoteService: QuoteService = new QuoteService(),
    @Optional() @Inject(OrderService) private readonly orderService: OrderService = new OrderService(),
    @Optional() @Inject(SchoolResearchService) private readonly schoolResearch: SchoolResearchService = new SchoolResearchService()
  ) {}

  buildToolset(
    optionsOrEnabled?: BuildToolsetOptions | string[],
    entityModel?: { label?: string; labelPlural?: string },
    closing: 'bag' | 'quote' = 'quote',
    customTools?: OpenAI.ChatCompletionTool[]
  ): OpenAI.ChatCompletionTool[] {
    return buildToolset(optionsOrEnabled, entityModel, closing, customTools);
  }

  async executeTool(
    toolName: string,
    rawArgs: string | Record<string, any>,
    ctx: ToolExecutionContext
  ): Promise<any> {
    return executeTool(toolName, rawArgs, {
      ...ctx,
      quoteService: ctx.quoteService || this.quoteService,
      orderService: ctx.orderService || this.orderService,
      schoolResearch: ctx.schoolResearch || this.schoolResearch,
    });
  }

  static buildToolset = buildToolset;
  static executeTool = executeTool;
  static safeParseArgs = safeParseArgs;
  static findBalancedToolCall = findBalancedToolCall;
}
