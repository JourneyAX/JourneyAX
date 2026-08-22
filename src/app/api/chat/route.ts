import OpenAI from 'openai';
import { embedText } from '@/services/knowledge/embedder';
import { searchWithReport } from '@/services/knowledge/mongo';
import { parseSpecs, parseImages } from '@/services/knowledge/page-parsers';
import { trimConversation } from '@/lib/conversation';
import { guard, isFailure, errorResponse, validateMessages } from '@/lib/api-guard';
import { AI_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const openai = new OpenAI();
const log = logger('api/chat');

/**
 * The slice of client journey state this route reads back to the model.
 * Loose on purpose — it is echoed into a prompt, never trusted for logic.
 */
interface ClientState {
  phase?: string;
  finish?: string;
  qty?: number;
  bom?: { name?: string; sku?: string; price?: number; category?: string; quantity?: number }[];
  recommendedProducts?: { name?: string; sku?: string }[];
}

const SYSTEM_PROMPT = `You are a multi-persona Caroma expert. You act seamlessly as a Customer Support Agent (CSA), Plumber, Store Stylist, and Sales Consultant. A customer is talking to you. Your job is to guide them through a COMPLETE end-to-end journey.

## Your Conversational Style
- Human-like, warm, and highly knowledgeable. Do not talk like a generic bot.
- You must hold a step-by-step conversation. Do NOT just give a one-shot answer and dump everything at once.
- NEVER invent or hallucinate products, prices, specifications, or design rules. ONLY use data retrieved from the \`searchKnowledge\` tool.
- If they ask for design help, search for "design brochure" or "bathroom design" in the knowledge base first.
- End your responses with a human-like follow-up question.

## The End-to-End Journey (Follow this strictly)

### Phase 1: Understand & Troubleshoot
- **MUST call \`setPhase\` with "clarify"** on your first response to render clarifying questions on the right panel.
- Act like a plumber or stylist to understand their actual problem or design vision.
- **CRITICAL:** Do NOT list the questions or options in your chat message text. The UI renders them on the right. Keep your chat message conversational, e.g. "I've got a few questions on the right to help me understand your needs."
- Search the knowledge base for troubleshooting guides or design rules. Do NOT guess.

### Phase 2: Product Recommendation
- Search the knowledge base for matching products.
- **CRITICAL:** DO NOT call 'setPhase("clarify")' more than once. Once the user provides their answers, you MUST transition to recommending products.
- **CRITICAL:** Whenever you recommend products or collections (e.g., Liano, Urbane), you MUST call the "showProducts" tool to render them visually on the right panel. Do NOT just output a text list of products or links in the chat bubble.
- In chat, act like a Sales/Stylist persona: explain EXACTLY WHY this product is the best fit. **CRITICAL:** You must brief the user on the product's style, look, and any customer feedback or reviews you found in the knowledge base.

### Phase 3: Installation & Preparation Guidance
- Do NOT skip Phase 2. You must show the products visually first before discussing installation.
- ONCE the user is happy with the products and is ready to install, OR if their initial request was purely troubleshooting an existing plumbing issue, transition to the Plumber persona.
- Search for the product's installation manual or troubleshooting guide.
- **CRITICAL:** Explicitly explain the warranty and guarantee in the chat.
- **CRITICAL:** Ask the user: "Do you need a plumber for this, or are you planning a DIY installation?"
- **CRITICAL:** Do NOT list the troubleshooting or installation steps in your chat message text. You MUST call the "showGuide" tool to render them as an interactive checklist on the right panel.

### Phase 4: Comprehensive Job Quote
- When the customer is fully ready, create the final Job Profile.
- Call \`updateQuote\` (which transitions to the 'quote' phase) and include:
  - A generated \`jobId\` (e.g. "JOB-2938")
  - ALL primary products and required accessories/sealants
  - A comprehensive \`installationSummary\` based on the manuals
  - A \`warrantySummary\` (guarantee, compliance, dimensions)

## CRITICAL RULES
1. **NO HALLUCINATIONS FOR PRODUCTS:** Every product, price, and spec must come from \`searchKnowledge\`.
2. **GENERIC TROUBLESHOOTING ALLOWED:** If you cannot find a specific troubleshooting guide in the knowledge base, you MAY use your general plumbing knowledge to generate generic troubleshooting or installation steps. ALWAYS call \`showGuide\` to display them. 
3. **USE IMAGES AND SPECS:** When calling the \`showProducts\` tool, you MUST pass the \`imageUrl\` and the full \`specs\` object returned directly from the \`searchKnowledge\` tool. Do NOT omit them or leave them empty, as they are required to render the product cards visually.
4. **DO NOT SKIP STEPS:** You must do Phase 3 (Installation Guidance) BEFORE generating the quote.
5. **ALWAYS call \`searchKnowledge\`** before answering a technical, design, or product question.
6. **ROOM SCOPE ENFORCEMENT:** If the user is configuring a Kitchen or Laundry room, you MUST recommend only kitchen/laundry products (e.g., sink mixers, kitchen sinks, laundry tubs, cabinet tubs). Do NOT recommend bathroom-specific products like basin mixers, bath/shower mixers, toilets, basins, baths, or showers.
7. **PRECISE SEARCH QUERIES:** When calling \`searchKnowledge\`, use short, precise search queries (2-4 words maximum) targeting the specific room, product type, and finish (e.g. "sink mixer chrome", "laundry tub", "kitchen sink", "Liano II mixer"). Do NOT use long conversational sentences as search queries.
8. **ACCUMULATE QUOTES (BOM PERSISTENCE):** If the user transitions from one room to another (e.g. adding kitchen items to an existing bathroom quote), you MUST preserve the previous items in the quote. Retrieve the previous items from the chat history and include them alongside the new items in the next \`updateQuote\` call so nothing is deleted.
9. **DEDUPLICATE SPECIFICATIONS:** Do NOT recommend or add the same base product in multiple different sizes or configurations (e.g. both a 220mm and 180mm wall mixer) at the same time. Choose the most common size first or ask the user to clarify before listing them.
10. **PREVENT REPEATING QUESTIONS & STEPS:** Do NOT repeat questions or ask to run steps that have already been completed (e.g. asking "Would you like me to generate the full bathroom spec?" if the BOM is already populated in the current system state, or asking "Do you need a plumber or DIY?" if they have already answered it). Check the current system state at the end of the prompt to see what has already been done, and move directly to the next logical step in the journey.
11. **RECOMMEND SURROUNDING PRODUCTS & ACCESSORIES:** When recommending a primary product (like a basin or toilet), you MUST proactively search the knowledge base for matching accessories (e.g. toilet roll holders, wastes, soap holders) and installation parts (e.g. in-wall bodies). Do NOT just list the main product alone; include these surrounding products in your recommendation list.
12. **WARRANTY & INSTALLATION SUMMARIES:** You must explicitly explain the warranty/guarantee periods (e.g., "20 year warranty on tapware") in your conversational response, but direct the user to the right-hand panel for the detailed installation steps (from the \`showGuide\` or \`updateQuote\` tools) rather than cluttering the chat with long lists of instructions.`;


const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchKnowledge',
      description: 'Search the Caroma knowledge base for products, troubleshooting guides, design inspiration, collections, installation info, or any other Caroma content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          type: { type: 'string', enum: ['product', 'troubleshooting', 'design', 'collection', 'installation', 'faq', 'general'], description: 'Optional filter by content type' },
          category: { type: 'string', description: 'Optional filter by category (Basins, Showers, Tapware, Toilet Suites, Baths, Accessories)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'setPhase',
      description: 'Update the UI phase. When transitioning to "clarify", you MUST provide dynamic questions tailored to the user\'s context. These questions will render on the right panel.',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['intro', 'clarify', 'validating', 'products', 'quote', 'ordered'] },
          questions: {
            type: 'array',
            description: 'Dynamic clarification questions to show on the right panel. Required when phase is "clarify".',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique ID for this question (e.g. "scope", "finish", "shower_type")' },
                title: { type: 'string', description: 'The question text shown to the user' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'The selectable answer options (2-5 options)'
                }
              },
              required: ['id', 'title', 'options']
            }
          }
        },
        required: ['phase']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateQuote',
      description: 'Update the Bill of Materials (quote) with real product data. Create a full Job Profile including installation guidelines and warranties.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the quote (e.g. "Your Liano II Shower Setup")' },
          jobId: { type: 'string', description: 'A generated unique Job ID (e.g. "JOB-2938")' },
          installationSummary: { type: 'string', description: 'Detailed installation instructions, what to remove, sealants needed, etc.' },
          warrantySummary: { type: 'string', description: 'Warranty, guarantee, dimensions, and compliance information' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', description: 'The product SKU' },
                name: { type: 'string', description: 'Product name' },
                price: { type: 'number', description: 'Product RRP price in AUD' },
                quantity: { type: 'number', default: 1 },
                imageUrl: { type: 'string', description: 'Product image URL from caroma.com.au' },
                category: { type: 'string', description: 'Product category (Showers, Tapware, Basins, etc.)' },
                reason: { type: 'string', description: 'Why this item is included' },
                required: { type: 'boolean', default: false, description: 'Whether this is a mandatory component' }
              },
              required: ['sku', 'name', 'price']
            }
          }
        },
        required: ['title', 'items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'showProducts',
      description: 'Show product recommendation cards on the right panel. Use this AFTER searchKnowledge to present products to the user for review BEFORE building the final quote.',
      parameters: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Product name' },
                sku: { type: 'string', description: 'Product SKU' },
                price: { type: 'number', description: 'Price in AUD' },
                imageUrl: { type: 'string', description: 'Product image URL' },
                category: { type: 'string', description: 'Product category (Shower Head, Mixer, In-wall Body, Basin, etc.)' },
                collection: { type: 'string', description: 'Caroma collection name (Liano II, Urbane II, etc.)' },
                description: { type: 'string', description: 'A 1-2 sentence explanation of WHY this product fits the user\'s brief' },
                features: { type: 'array', items: { type: 'string' }, description: '2-3 key features or benefits' },
                finishes: { type: 'array', items: { type: 'string' }, description: 'Available finishes' },
                specs: {
                  type: 'object',
                  description: 'Technical specifications as key-value pairs. Include: Material, WELS Rating, Flow Rate, Dimensions, Warranty, Installation Type, etc. CRITICAL: Do NOT guess or hallucinate any specs (especially Warranty). If it is not explicitly stated in the knowledge base, omit it.',
                  additionalProperties: { type: 'string' }
                },
                url: { type: 'string', description: 'Product page URL from caroma.com.au' },
                accessories: {
                  type: 'array',
                  description: 'Optional matching accessories (e.g. Robe Hook, Towel Rail). You MUST proactively suggest 1-2 accessories from the catalog that match the style, even if they are not explicitly linked in the product markdown.',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      sku: { type: 'string' },
                      price: { type: 'number' }
                    },
                    required: ['name']
                  }
                },
                installationParts: {
                  type: 'array',
                  description: 'Mandatory parts required for installation (e.g. In-wall body, Connector). You MUST proactively suggest at least 1 installation part if applicable.',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      sku: { type: 'string' },
                      price: { type: 'number' },
                      required: { type: 'boolean', description: 'True if this part is mandatory for installation' }
                    },
                    required: ['name']
                  }
                }
              },
              required: ['name', 'description']
            }
          }
        },
        required: ['products']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'showGuide',
      description: 'Show an interactive troubleshooting or installation guide on the right panel. Use this for step-by-step instructions (e.g. diagnosing a leak, installing a product).',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique identifier for the step (e.g., "step-1")' },
                title: { type: 'string', description: 'Short title for the step (e.g., "Turn Off Water Supply")' },
                description: { type: 'string', description: 'Detailed explanation of what to do.' }
              },
              required: ['id', 'title', 'description']
            }
          }
        },
        required: ['steps']
      }
    }
  }
];

export async function POST(req: Request) {
  const guarded = await guard<{ messages?: unknown; state?: ClientState }>(
    req,
    { scope: 'chat', rule: AI_LIMIT },
  );
  if (isFailure(guarded)) return guarded.response;

  const checked = validateMessages(guarded.body.messages);
  if (!checked.ok) return errorResponse(400, 'invalid_messages', checked.message);

  const messages = checked.messages;
  const state = guarded.body.state;

  const stateContext = state ? `
[CURRENT SYSTEM STATE (Do NOT repeat questions for items/phases already completed here)]
- Active Phase: ${state.phase}
- Selected Finish: ${state.finish}
- Selected Quantity: ${state.qty}
- Current BOM (Bill of Materials):
${state.bom && state.bom.length > 0 
  ? state.bom.map(item => `  * ${item.name} (${item.sku || 'No SKU'}) - Price: $${item.price} - Category: ${item.category} - Quantity: ${item.quantity}`).join('\n')
  : '  * (Empty)'}
- Recommended Products currently showing on the right:
${state.recommendedProducts && state.recommendedProducts.length > 0
  ? state.recommendedProducts.map(item => `  * ${item.name} (${item.sku || 'No SKU'})`).join('\n')
  : '  * (None)'}
` : '';

  // Trim before sending. There is no server-side session, so the whole history
  // is resent every turn — without this, cost grows with the square of the
  // conversation length and a long journey eventually exceeds the context
  // window and dies at the point the customer has invested the most.
  const trimmed = trimConversation<OpenAI.ChatCompletionMessageParam>([
    { role: 'system', content: SYSTEM_PROMPT },
    ...(stateContext ? [{ role: 'system' as const, content: stateContext }] : []),
    ...(messages as OpenAI.ChatCompletionMessageParam[])
  ]);

  if (trimmed.dropped > 0) {
    log.info(`trimmed ${trimmed.dropped} message(s); ~${trimmed.approxTokens} tokens sent`);
  }

  const conversation: OpenAI.ChatCompletionMessageParam[] = trimmed.messages;

  const maxLoops = 8; // Allow enough loops for multiple search + UI tool calls
  let loops = 0;
  let finalMessage: OpenAI.ChatCompletionMessage | null = null;
  // UI tool calls are collected, never executed here, and replayed in the browser.
  // Narrowed to the function variant — we never register custom tools, and the
  // wider union has no `.function` to read.
  const uiToolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];

  try {
    while (loops < maxLoops) {
    loops++;
    const response = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: conversation,
      tools,
      tool_choice: 'auto'
    });

    const msg = response.choices[0].message;
    finalMessage = msg;
    conversation.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      let requiresAnotherCall = false;

      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;

        if (call.function.name === 'searchKnowledge') {
          // Execute server-side — search MongoDB
          try {
            const args = JSON.parse(call.function.arguments);
            
            // Try to get embedding, but don't fail if it doesn't work
            let queryEmbedding: number[] | null = null;
            try {
              queryEmbedding = await embedText(args.query);
            } catch (embedErr) {
              log.warn('embedding failed — falling back to keyword search', embedErr);
            }
            
            // `searchWithReport`, not `search` — the report says whether this
            // came from semantic search or a degraded keyword scan, and the
            // model has to know. Answering off keyword-matched chunks with the
            // same confidence as a good vector hit is how a customer gets told
            // the wrong thing about an in-wall component.
            const { results, degraded } = await searchWithReport(queryEmbedding, {
              query: args.query,
              brand: 'caroma',
              type: args.type,
              category: args.category,
              limit: 8,
            });

            const retrievalNote = degraded
              ? 'DEGRADED RETRIEVAL: semantic search is unavailable and these results come from a keyword match, so they may be less relevant. Rely only on what the content plainly states, do not infer, and say you are not certain if the answer is not clearly present.'
              : undefined;

             let toolResult;
            if (results.length === 0) {
              toolResult = {
                found: false,
                message: 'No relevant documents found for this query. Try a broader search.',
                retrievalNote,
              };
            } else {
              toolResult = {
                found: true,
                resultCount: results.length,
                retrievalNote,
                results: results.map(r => {
                  const specs = parseSpecs(r.document.content);
                  const images = parseImages(r.document.content);
                  return {
                    title: r.document.title,
                    type: r.document.metadata?.type,
                    sku: r.document.metadata?.sku || specs['Item Code'] || '',
                    price: r.document.metadata?.price,
                    collection: r.document.metadata?.collection,
                    finishes: r.document.metadata?.finishes || (specs['Colour'] ? [specs['Colour']] : []),
                    images: images,
                    imageUrl: images[0] || '', // Pre-fill first image for AI
                    specs: specs, // Pre-fill specs for AI
                    url: r.document.metadata?.url || r.document.sourceUrl,
                    content: r.document.chunk.slice(0, 2500) // Give AI more context
                  };
                })
              };
            }

            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(toolResult)
            });
            requiresAnotherCall = true;

          } catch (err) {
            log.error('knowledge search failed', err);
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ found: false, message: 'Knowledge search failed.' })
            });
            requiresAnotherCall = true;
          }

        } else if (call.function.name === 'setPhase' || call.function.name === 'updateQuote' || call.function.name === 'showProducts' || call.function.name === 'showGuide') {
          // UI tool calls — collect them, provide a dummy response to OpenAI, and continue
          uiToolCalls.push(call);
          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ success: true })
          });
          // After UI tools, let the AI generate a text response explaining what happened
          requiresAnotherCall = true;
        }
      }

      if (!requiresAnotherCall) {
        break;
      }
    } else {
      // No tools called — we have a final text response
      break;
    }
  }

    // The loop can exhaust `maxLoops` while the model is still calling tools.
    // `finalMessage` is then an assistant turn whose content is null, because
    // its substance was in `tool_calls` — the browser rendered that as an
    // empty bubble, which reads as the assistant ignoring you. The UI actions
    // it produced are still good, so keep them and supply words to go with.
    if (loops >= maxLoops && !finalMessage?.content) {
      log.warn(`tool loop exhausted after ${maxLoops} iterations`);
      finalMessage = {
        role: 'assistant',
        content: uiToolCalls.length > 0
          ? "I've updated the panel on the right with what I found. Tell me what you'd like to do next."
          : "That took longer than expected to work through. Could you narrow it down a little for me?",
        refusal: null,
      } as OpenAI.ChatCompletionMessage;
    }

    // Return both the final message text AND any UI tool calls
    return new Response(JSON.stringify({
      message: finalMessage,
      conversation: conversation.filter(m => m.role !== 'system'), // Exclude system messages to keep it clean and save bandwidth
      uiActions: uiToolCalls.map(call => ({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments)
      }))
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    // Log the detail, return a generic message. The previous version echoed
    // `error.message` to the browser, which leaks upstream provider errors
    // and occasionally connection strings.
    log.error('chat turn failed', error);
    return errorResponse(502, 'ai_unavailable', 'The assistant is unavailable right now. Please try again.');
  }
}
