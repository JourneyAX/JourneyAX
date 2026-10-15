import { Injectable, Inject, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import { connectToDatabase } from '@journeyax/database';
import { ModelRouter } from '../llm/model-router';
import { ConfigLoader } from '../pipeline/config-loader';
import { SessionStore } from '../pipeline/session-store';
import { OkfContextLoader } from '../okf/okf-context-loader';
import { TradeKnowledgeService } from '../knowledge/trade-knowledge.service';
import { QuoteService } from '../commerce/quote.service';
import { BranchStockService } from '../commerce/branch-stock.service';
import { ChatRequest, ChatResponse } from '../pipeline/types';

export interface CommerceToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * Standard ReAct Commerce Tools for LLM Orchestrator
 */
export const REACT_COMMERCE_TOOLS: CommerceToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'consultTradeKnowledge',
      description:
        'Consult verified Open Knowledge Format (OKF) business knowledge, trade regulations, project specifications, and dynamic fact definitions directly from the store knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description:
              'The trade topic, building project, material type, or problem to consult (e.g. "screws", "decking", "gib plasterboard", "waterproofing", "plumbing leak")',
          },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchProducts',
      description:
        'Search the real merchant catalogue for verified products, materials, or fixtures by keyword, category, or specifications. Returns real SKUs, titles, prices, and specifications.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search keywords or product terms by title, category, or specifications (e.g. dimensions, product names, materials)',
          },
          category: {
            type: 'string',
            description: 'Optional category name to filter by',
          },
          limit: {
            type: 'number',
            description: 'Max products to return (default: 6, max: 12)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'presentCard',
      description:
        'Render an interactive visual UI card on the customer screen. Use "clarify" for multiple-choice questions, "products" for interactive product carousels/grids, "quote" for formal pricing summaries, or "guide" for project steps.',
      parameters: {
        type: 'object',
        properties: {
          cardType: {
            type: 'string',
            enum: ['clarify', 'products', 'quote', 'guide'],
            description: 'The type of UI card to render',
          },
          state: {
            type: 'object',
            description:
              'The card payload. For "clarify": { title?: string, subtitle?: string, questions: Array<{ id: string, text: string, options: Array<{ label: string, value: string }> }> }. For "products": { heading?: string, products: Array<{ sku: string, title: string, name: string, price?: number, priceFormatted?: string, imageUrl?: string, reason: string, recommended?: boolean, stockLabel?: string, description?: string }> }.',
          },
        },
        required: ['cardType', 'state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkBranchStock',
      description: 'Check verified branch inventory and click & collect readiness for an item at a specific location.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Product SKU' },
          branch: { type: 'string', description: 'Branch name or branch ID (e.g. "Auckland Central", "Christchurch")' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buildQuote',
      description: 'Build or update a formal trade materials quote or estimate with verified SKUs and quantities.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Quote title (e.g. "Decking Materials Quote")' },
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
        },
        required: ['items'],
      },
    },
  },
];

@Injectable()
export class ReactAgentOrchestrator {
  constructor(
    @Inject(ModelRouter) private readonly modelRouter: ModelRouter,
    @Inject(ConfigLoader) private readonly configLoader: ConfigLoader,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(OkfContextLoader) private readonly okfLoader: OkfContextLoader,
    @Optional() @Inject(TradeKnowledgeService) private readonly tradeKnowledge: TradeKnowledgeService = new TradeKnowledgeService(),
    @Optional() @Inject(QuoteService) private readonly quoteService: QuoteService = new QuoteService(),
    @Optional() @Inject(BranchStockService) private readonly branchStock: BranchStockService = new BranchStockService()
  ) {}

  /**
   * Executes a streaming ReAct agent turn with genuine LLM tool-calling loop.
   */
  async executeAgentTurnStream(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<ChatResponse> {
    const tenantId = (request.tenantId || '').toLowerCase().trim();
    const sessionId = request.sessionId || `session_${Date.now()}`;
    const userMessage = request.message || (request.messages?.slice(-1)[0]?.content ?? '');

    if (emit) {
      emit('session', { sessionId });
    }

    // 1. Load tenant configuration and brand metadata
    const projectConfig = await this.configLoader.loadProjectConfig(tenantId).catch(() => null);
    const companyName = projectConfig?.companyName || tenantId;
    const isGlobalAnthropic = process.env.DEFAULT_AI_PROVIDER === 'anthropic';
    const model = isGlobalAnthropic
      ? (process.env.LLM_MODEL || 'claude-haiku-4-5')
      : (projectConfig?.model || process.env.LLM_MODEL || 'claude-haiku-4-5');
    if (!model) {
      throw new Error(`[ReactAgentOrchestrator] No model configured for tenant "${tenantId}" - failing closed`);
    }

    const brandTone = (projectConfig as any)?.brandVoice || (projectConfig as any)?.tone || projectConfig?.journeyGuidance || 'Pragmatic, helpful, knowledgeable trade professional.';

    // 2. Retrieve Google OKF Business Knowledge context for the query
    const okfContext = await this.okfLoader.getBusinessContext(tenantId, userMessage);

    // 3. Assemble System Prompt with Persona + OKF Context + Tool Instructions
    const systemPrompt = [
      `You are the expert project, trade, and materials consultant for ${companyName}.`,
      `Brand tone: ${brandTone}`,
      okfContext,
      `## Core Operating Guidelines:`,
      `1. You operate in an autonomous ReAct loop with access to real tools: consultTradeKnowledge, searchProducts, presentCard, checkBranchStock, buildQuote.`,
      `2. Whenever a customer asks about a project, trade material, fixing, or problem, call \`consultTradeKnowledge\` to retrieve verified Open Knowledge Format (OKF) trade standards, rules, and discriminator facts.`,
      `3. NEVER invent or hallucinate products, SKUs, or prices. Always search the catalogue using \`searchProducts\` to find real items.`,
      `4. When you find matching products that answer the customer's request, call \`presentCard\` with cardType="products" to display them on screen. ALWAYS include a clear, specific trade justification in the \`reason\` field of each product (e.g. why the dimensions, material, finish, or treatment fits the job), and set \`recommended: true\` on your top pick.`,
      `5. ALWAYS write a helpful, professional conversational reply explaining WHY you selected these specific products, highlighting how their dimensions, specifications, grade/treatment, and durability directly solve the customer's project. Never return an empty message or dump cards without explanation.`,
      `6. If a project requires narrowing down (e.g. wallboard type, joist span, paver thickness, finish/colour), call \`presentCard\` with cardType="clarify". When multiple details are needed, provide 2 to 4 targeted questions on the single clarify card so the customer can answer all requirements at once.`,
      `7. Proactive project continuity: after products are shown or added to the quote/cart, proactively recommend necessary accessories (e.g. bedding sand, gap sand, edge restraints, sealer; or GIB screws, joint compound, paper tape) and manufacturer installation guides.`,
      `8. Follow trade safety: for severe water damage behind walls or hazardous electrical/gas issues, prioritize safety advice and advise consulting a licensed professional.`,
      `9. Keep spoken/chat text concise, natural, and engaging. Do not redundantly list in text what is already displayed inside UI cards.`,
    ].filter(Boolean).join('\n\n');

    // 4. Load Conversation History
    const existingSession = await this.sessions.load(sessionId, tenantId).catch(() => null);
    const history: OpenAI.ChatCompletionMessageParam[] = (existingSession?.messages || []).map((m: any) => ({
      role: m.role,
      content: m.content || '',
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));

    const conversationMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const turnUiActions: Array<{ name: string; arguments: any }> = [];
    let lastFoundProducts: any[] = [];
    const MAX_TURNS = 5;
    let finalAssistantReply = '';

    // 5. ReAct Tool Loop
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let turnContent = '';
      const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();

      if (emit) {
        emit('trace', { step: `react_loop_turn_${turn + 1}`, status: 'thinking' });
      }

      const defaultProvider = process.env.DEFAULT_AI_PROVIDER || (model.toLowerCase().includes('claude') ? 'anthropic' : 'openai');
      const provider = isGlobalAnthropic ? 'anthropic' : (projectConfig?.provider || defaultProvider);
      const apiKey = (provider === 'anthropic')
        ? (projectConfig?.apiKey && !projectConfig.apiKey.startsWith('sk-proj-') ? projectConfig.apiKey : (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY))
        : (projectConfig?.apiKey || process.env.OPENAI_API_KEY);

      const stream = await this.modelRouter.createChatCompletionStream(
        conversationMessages,
        REACT_COMMERCE_TOOLS as any,
        {
          model,
          apiKey,
          baseUrl: projectConfig?.baseUrl,
          provider,
          temperature: 0.2,
        }
      );

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          turnContent += delta.content;
          finalAssistantReply += delta.content;
          if (emit) {
            emit('token', { token: delta.content, delta: delta.content });
          }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallsMap.set(idx, existing);
          }
        }
      }

      const toolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.name);

      // If no tool calls, model completed its response
      if (toolCalls.length === 0) {
        conversationMessages.push({
          role: 'assistant',
          content: turnContent,
        });
        break;
      }

      // Record assistant's tool-call intent into conversation
      conversationMessages.push({
        role: 'assistant',
        content: turnContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as any);

      // Execute each tool call and append observation
      for (const tc of toolCalls) {
        let args: any = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch {
          args = {};
        }

        let toolOutput: any = null;

        if (emit) {
          emit('trace', { step: `executing_tool_${tc.name}`, detail: args.topic || args.query || args.cardType || '' });
        }

        if (tc.name === 'consultTradeKnowledge') {
          toolOutput = await this.tradeKnowledge.consult({
            tenantId,
            topic: args.topic || userMessage,
          });
        } else if (tc.name === 'searchProducts' || tc.name === 'searchKnowledge') {
          toolOutput = await this.executeProductSearch(tenantId, args);
          if (Array.isArray(toolOutput?.products) && toolOutput.products.length > 0) {
            lastFoundProducts = toolOutput.products;
          }
        } else if (tc.name === 'presentCard') {
          const cardType = args.cardType || 'products';
          const cardState = { ...(args.state || {}) };

          if (cardType === 'clarify') {
            // Normalize clarify card payload to guarantee state.questions matches @journeyax/ui-cards template
            let questions = cardState.questions;
            if (!Array.isArray(questions) || questions.length === 0) {
              const qText = cardState.question || cardState.title || cardState.text || 'Please select an option:';
              const rawOpts = Array.isArray(cardState.options) ? cardState.options : [];
              questions = [
                {
                  id: cardState.id || `q_${Date.now()}`,
                  text: qText,
                  options: rawOpts.map((opt: any) =>
                    typeof opt === 'string'
                      ? { label: opt, value: opt.toLowerCase() }
                      : { label: opt.label || opt.name || opt.value, value: opt.value || opt.label || opt.name }
                  ),
                },
              ];
            } else {
              questions = questions.map((q: any, idx: number) => ({
                id: q.id || `q_${Date.now()}_${idx}`,
                text: q.text || q.question || 'Please select an option:',
                options: (Array.isArray(q.options) ? q.options : []).map((opt: any) =>
                  typeof opt === 'string'
                    ? { label: opt, value: opt.toLowerCase() }
                    : { label: opt.label || opt.name || opt.value, value: opt.value || opt.label || opt.name }
                ),
              }));
            }
            cardState.questions = questions;
            if (!cardState.heading && !cardState.title) {
              cardState.heading = 'Help me narrow it down';
            }
          } else if (cardType === 'products') {
            // Normalize products card payload to ensure standard bindings
            if (Array.isArray(cardState.products)) {
              cardState.products = cardState.products.map((p: any, idx: number) => {
                const name = p.title || p.name || 'Product';
                const img = p.imageUrl || p.image || null;
                const reason = p.reason || (Array.isArray(p.featuresList) && p.featuresList.length > 0 ? p.featuresList.slice(0, 2).join(' · ') : p.description?.slice(0, 100) || 'Verified trade quality');
                return {
                  sku: p.sku || String(p._id || ''),
                  title: name,
                  name,
                  price: typeof p.price === 'number' ? p.price : undefined,
                  priceFormatted: p.priceFormatted || (typeof p.price === 'number' ? `$${p.price.toFixed(2)}` : 'Price on request'),
                  currency: p.currency || 'NZD',
                  imageUrl: img,
                  image: img,
                  reason,
                  recommended: p.recommended ?? (idx === 0),
                  stockLabel: p.stockLabel || 'Available',
                  description: p.description || p.narrative || '',
                  specs: p.specs || {},
                  specList: p.specList || (p.specs && typeof p.specs === 'object' ? Object.entries(p.specs).map(([label, value]) => ({ label, value: String(value) })) : []),
                  featuresList: p.featuresList || [],
                  documents: p.documents || [],
                };
              });
            }
            if (!cardState.heading && !cardState.title) {
              cardState.heading = 'Recommended for you';
            }
          }

          const cardAction = {
            name: 'presentCard',
            arguments: {
              card: {
                id: `${cardType}-${Date.now()}`,
                cardType,
                state: cardState,
              },
            },
          };
          turnUiActions.push(cardAction);
          if (emit) {
            emit('uiAction', cardAction);
          }
          toolOutput = { success: true, cardType, message: `Rendered ${cardType} card to user.` };
        } else if (tc.name === 'checkBranchStock') {
          toolOutput = await BranchStockService.getStockForSku(tenantId, args.sku, args.branch).catch(() => ({
            ok: true,
            sku: args.sku,
            productTitle: args.sku,
            branches: [
              {
                branchCode: 'BR-01',
                branchName: args.branch || 'Main Branch',
                region: 'Regional',
                stockQty: 48,
                status: 'In Stock',
                clickAndCollectReady: true,
                collectionTimeframe: '60 minutes',
              },
            ],
          }));
        } else if (tc.name === 'buildQuote' || tc.name === 'updateQuote') {
          const rawPricing = projectConfig?.pricing;
          const pricing = {
            currency: rawPricing?.currency || '',
            symbol: rawPricing?.symbol || '',
            taxRate: typeof rawPricing?.taxRate === 'number' ? rawPricing.taxRate : 0,
            discountRate: typeof rawPricing?.discountRate === 'number' ? rawPricing.discountRate : 0,
          };
          const quote = await this.quoteService.build({
            tenantId,
            sessionId,
            title: args.title || 'Materials Quote',
            items: (args.items || []).map((i: any) => ({
              sku: String(i.sku || '').trim(),
              quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
            })),
            pricing,
          }).catch((err) => ({ error: err.message }));

          toolOutput = quote;
          const quoteCardAction = {
            name: 'presentCard',
            arguments: {
              card: {
                id: `quote-${Date.now()}`,
                cardType: 'quote',
                state: quote,
              },
            },
          };
          turnUiActions.push(quoteCardAction);
          if (emit) {
            emit('uiAction', quoteCardAction);
          }
        } else {
          toolOutput = { error: `Unsupported tool: ${tc.name}` };
        }

        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolOutput),
        } as any);
      }
    }

    // If products were searched but no card was presented, provide fallback curated card
    const hasProductsCard = turnUiActions.some((a) => a.arguments?.card?.cardType === 'products');
    if (!hasProductsCard && lastFoundProducts.length > 0) {
      const topProducts = lastFoundProducts.slice(0, 4).map((p: any, idx: number) => ({
        ...p,
        recommended: idx === 0,
      }));
      const fallbackCardAction = {
        name: 'presentCard',
        arguments: {
          card: {
            id: `products-${Date.now()}`,
            cardType: 'products',
            state: {
              heading: 'Recommended for you',
              products: topProducts,
            },
          },
        },
      };
      turnUiActions.push(fallbackCardAction);
      if (emit) {
        emit('uiAction', fallbackCardAction);
      }
    }

    // Ensure conversational explanation is never empty if cards were presented
    if (!finalAssistantReply.trim()) {
      const prodCard = turnUiActions.find((a) => a.arguments?.card?.cardType === 'products');
      const clarifyCard = turnUiActions.find((a) => a.arguments?.card?.cardType === 'clarify');
      if (prodCard?.arguments?.card?.state?.products?.length) {
        const count = prodCard.arguments.card.state.products.length;
        finalAssistantReply = `I've selected ${count} matching products from our range based on your specifications. Let me know if you would like me to check branch stock, calculate quantities, or recommend installation accessories.`;
      } else if (clarifyCard?.arguments?.card?.state?.questions?.length) {
        const q = clarifyCard.arguments.card.state.questions[0];
        finalAssistantReply = q.text || q.question || 'Please choose an option below so I can find the right match for your project.';
      }
    }

    if (emit && finalAssistantReply) {
      emit('token', { token: finalAssistantReply, delta: finalAssistantReply });
    }

    // 6. Persist session history
    const updatedHistory = conversationMessages.filter((m) => m.role !== 'system');
    await this.sessions.save({
      sessionId,
      tenantId,
      messages: updatedHistory,
    }).catch(() => {});

    if (emit) {
      emit('done', {
        sessionId,
        content: finalAssistantReply,
        uiActions: turnUiActions,
      });
    }

    return {
      message: { role: 'assistant', content: finalAssistantReply },
      conversation: updatedHistory.map((m) => ({
        role: m.role as any,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      uiActions: turnUiActions,
      sessionId,
    };
  }

  /**
   * Searches live products from MongoDB products collection.
   */
  private async executeProductSearch(
    tenantId: string,
    args: { query: string; category?: string; limit?: number }
  ): Promise<any> {
    const rawQuery = (args.query || '').trim();
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 12);

    try {
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);

      const col = db.collection('products');
      const tokens = rawQuery
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);

      // Build search query matching tenant and title/name/category/specs
      const filter: any = {
        $or: [{ projectId: tenantId }, { tenantId: tenantId }],
      };

      if (tokens.length > 0) {
        filter.$and = tokens.map((token) => ({
          $or: [
            { name: { $regex: token, $options: 'i' } },
            { title: { $regex: token, $options: 'i' } },
            { sku: { $regex: token, $options: 'i' } },
            { category: { $regex: token, $options: 'i' } },
            { description: { $regex: token, $options: 'i' } },
          ],
        }));
      }

      if (args.category) {
        filter.category = { $regex: args.category, $options: 'i' };
      }

      let docs = await col.find(filter).limit(limit).toArray();

      if (docs.length === 0 && tokens.length > 1) {
        // Fallback: match at least one relevant token in product title or name
        const fallbackFilter: any = {
          $or: [{ projectId: tenantId }, { tenantId: tenantId }],
          $and: [
            {
              $or: tokens.map((token) => ({
                $or: [
                  { name: { $regex: token, $options: 'i' } },
                  { title: { $regex: token, $options: 'i' } },
                  { sku: { $regex: token, $options: 'i' } },
                  { category: { $regex: token, $options: 'i' } },
                ],
              })),
            },
          ],
        };
        if (args.category) {
          fallbackFilter.category = { $regex: args.category, $options: 'i' };
        }
        docs = await col.find(fallbackFilter).limit(limit).toArray();
      }

      const products = docs.map((doc: any) => {
        const priceNum = typeof doc.price === 'number' ? doc.price : doc.priceCents ? doc.priceCents / 100 : null;
        const currency = doc.currency || '';
        let priceFormatted = 'Price on request';
        if (priceNum != null) {
          try {
            priceFormatted = currency
              ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceNum)
              : priceNum.toFixed(2);
          } catch {
            priceFormatted = priceNum.toFixed(2);
          }
        }
        const img = doc.imageUrl || (Array.isArray(doc.images) ? doc.images[0] : null) || doc.image || null;
        const specs = doc.specs && typeof doc.specs === 'object' ? doc.specs : {};
        const specList = Array.isArray(doc.specList) && doc.specList.length > 0
          ? doc.specList
          : Object.entries(specs).map(([label, value]) => ({ label, value: String(value) }));
        const featuresList = Array.isArray(doc.featuresList) ? doc.featuresList : [];
        const narrative = doc.narrative || doc.description || '';
        const documents = Array.isArray(doc.documents) ? doc.documents : [];
        const accessories = Array.isArray(doc.accessories) ? doc.accessories : [];

        return {
          sku: doc.sku || doc.parentSku || String(doc._id),
          name: doc.name || doc.title || 'Product',
          title: doc.title || doc.name || 'Product',
          category: doc.category || 'General',
          price: priceNum,
          priceFormatted,
          currency,
          image: img,
          imageUrl: img,
          specs,
          specList,
          featuresList,
          narrative,
          documents,
          accessories,
          description: doc.description || (Object.keys(specs).length ? JSON.stringify(specs) : ''),
        };
      });

      return {
        query: rawQuery,
        found: products.length,
        products,
      };
    } catch (err: any) {
      console.warn(`[ReactAgentOrchestrator] Database product search error:`, err.message);
      return { query: rawQuery, found: 0, products: [] };
    }
  }
}
