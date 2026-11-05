import type { AgentExecutionRequest, AgentToolCall } from '../../src/kernel/model.gateway';

/**
 * Scripted fake model server for testing Agent Mode offline without live network dependencies.
 *
 * Simulates autonomous model reasoning:
 * 1. Evaluates customer intent from messages
 * 2. Selects appropriate tools (search_products, consult_business_knowledge, search_guides, etc.)
 * 3. Inspects tool results and presents approved UI cards (present_card)
 * 4. Formulates and streams concise, grounded, claim-guarded answers.
 */
export function createScriptedAgentExecutor() {
  return async (req: AgentExecutionRequest, onDelta?: (delta: string) => void) => {
    // 1. Extract customer message
    const lastUserMsg = req.messages.slice().reverse().find((m) => m.role === 'user');
    const userContent = lastUserMsg?.content || '';
    const match = userContent.match(/<customer_message>\s*([\s\S]*?)\s*<\/customer_message>/i);
    const rawQuestion = (match ? match[1] : userContent).trim();
    const qLower = rawQuestion.toLowerCase();

    // Extract earlier conversation context from history block if present (Prompt P2)
    const historyMsg = req.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        (m.content.includes('<conversation_history>') || m.content.includes('[Previous Conversation History]'))
    );
    let previousTopic = '';
    if (historyMsg && typeof historyMsg.content === 'string') {
      const lines = historyMsg.content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('Customer:')) {
          const topic = line.replace(/^Customer:\s*/, '').trim();
          if (topic) {
            previousTopic = topic
              .replace(/^(do you have|i need|looking for|can i get|show me your range of|show me|find me|what)\s+/i, '')
              .replace(/[?!.]/g, '')
              .trim();
            break;
          }
        }
      }
    }

    // 2. Inspect previous tool calls & results
    const toolMessages = req.messages.filter((m) => m.role === 'tool');
    const searchToolResult = toolMessages.find((m) => m.name === 'search_products' || m.name === 'catalog.search');
    const cardToolResult = toolMessages.find((m) => m.name === 'present_card');
    const knowledgeResult = toolMessages.find((m) => m.name === 'consult_business_knowledge');
    const guideResult = toolMessages.find((m) => m.name === 'search_guides');
    const warrantyResult = toolMessages.find((m) => m.name === 'get_warranty');
    const checklistResult = toolMessages.find((m) => m.name === 'get_journey_checklist');
    const stockResult = toolMessages.find((m) => m.name === 'check_stock');
    const quoteResult = toolMessages.find((m) => m.name === 'create_quote');
    const cartResult = toolMessages.find((m) => m.name === 'update_cart');

    // ROUND 1: No tools executed yet
    if (toolMessages.length === 0) {
      // Case 1-event: Customer Action Event (Prompt P3 & P4)
      if (userContent.includes('<customer_event>')) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-chk-evt-1',
              name: 'get_journey_checklist',
              arguments: {},
            },
          ],
        };
      }

      // Case 1-checklist: Journey checklist & progress inquiry (Prompt P4)
      if (
        qLower.includes('checklist') ||
        qLower.includes('progress') ||
        qLower.includes('playbook') ||
        qLower.includes('what has been done') ||
        qLower.includes('what have we done')
      ) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'tc-chk-1',
              name: 'get_journey_checklist',
              arguments: {},
            },
          ],
        };
      }

      // Case 1a: Garbled / gibberish (e.g. asdkfj)
      if (qLower.includes('asdkfj') || rawQuestion.length < 3) {
        const text = "I'm sorry, I didn't quite catch that. Could you please clarify which materials or products you are looking for?";
        for (const w of text.split(' ')) {
          onDelta?.(w + ' ');
        }
        return { content: text, toolCalls: [] };
      }

      // Case 1b: Safety / legal / structural code questions
      if (
        qLower.includes('power outlets') ||
        qLower.includes('electrical wiring') ||
        qLower.includes('load bearing') ||
        qLower.includes('load-bearing') ||
        qLower.includes('structural calculation') ||
        qLower.includes('safe to use')
      ) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call_know_${Date.now()}`,
              name: 'consult_business_knowledge',
              arguments: { topic: 'safety_compliance' },
            },
          ],
        };
      }

      // Case 1c: Installation / Guide request
      if (
        qLower.includes('how do i') ||
        qLower.includes('how to install') ||
        qLower.includes('installation guide') ||
        qLower.includes('steps to')
      ) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call_guide_${Date.now()}`,
              name: 'search_guides',
              arguments: { query: rawQuestion },
            },
          ],
        };
      }

      // Case 1d: Warranty request
      if (qLower.includes('warranty') || qLower.includes('guarantee')) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call_warr_${Date.now()}`,
              name: 'get_warranty',
              arguments: { productOrBrand: rawQuestion },
            },
          ],
        };
      }

      // Case 1e: Vocabulary / education (what's a dwang, difference between...)
      if (
        qLower.includes("what's a dwang") ||
        qLower.includes('difference between') ||
        qLower.includes('what is a')
      ) {
        return {
          content: '',
          toolCalls: [
            {
              id: `call_know_${Date.now()}`,
              name: 'consult_business_knowledge',
              arguments: { topic: rawQuestion },
            },
          ],
        };
      }

      // Case 1e-stock: Explicit stock verification inquiry
      if (
        (qLower.includes('in stock') || qLower.includes('check stock') || qLower.includes('stock check') || qLower.includes('stock for') || qLower.includes('available at')) &&
        (qLower.includes('sku') || /\b1000\d{3}\b/.test(rawQuestion) || /\banf-[\w-]+\b/i.test(rawQuestion))
      ) {
        const skuMatch = rawQuestion.match(/\b(1000\d{3}|ANF-[\w-]+)\b/i) || rawQuestion.match(/sku[:\s]+(\S+)/i);
        const sku = skuMatch ? skuMatch[1] : '1000100';
        return {
          content: '',
          toolCalls: [
            {
              id: `call_stock_${Date.now()}`,
              name: 'check_stock',
              arguments: { sku, branch: 'Auckland Central' },
            },
          ],
        };
      }

      // Case 1e-quote: Direct quote creation request
      if (qLower.includes('create a quote') || qLower.includes('quote sku') || qLower.includes('add to quote') || qLower.includes('quote for sku')) {
        const skuMatch = rawQuestion.match(/\b(1000\d{3}|DISC-\d|ANF-[\w-]+)\b/i) || rawQuestion.match(/sku[:\s]+(\S+)/i);
        const sku = skuMatch ? skuMatch[1] : '1000100';
        return {
          content: '',
          toolCalls: [
            {
              id: `call_quote_${Date.now()}`,
              name: 'create_quote',
              arguments: { items: [{ sku, quantity: 10 }] },
            },
          ],
        };
      }

      // Case 1e-cart: Direct cart addition request
      if (qLower.includes('add to cart') || qLower.includes('cart for sku') || qLower.includes('put in cart') || qLower.includes('add sku')) {
        const skuMatch = rawQuestion.match(/\b(ANF-[\w-]+|1000\d{3})\b/i) || rawQuestion.match(/sku[:\s]+(\S+)/i);
        const sku = skuMatch ? skuMatch[1] : 'ANF-HOODIE-BLK';
        return {
          content: '',
          toolCalls: [
            {
              id: `call_cart_${Date.now()}`,
              name: 'update_cart',
              arguments: { items: [{ sku, quantity: 1 }] },
            },
          ],
        };
      }

      // Case 1f: Product / Project search
      let cleanQuery = rawQuestion
        .replace(/^(?:do you have|i need|looking for|i am looking for|i'm looking for|can i get|what's your cheapest|show me your range of|show me all|show me your|show me|find me|find|what do you have for|what)\s+(?:a\s+|an\s+|the\s+)?/i, '')
        .replace(/\b(?:for\s+(?:my\s+)?(?:deck\s+framing\s+project|deck\s+framing|deck\s+frame|project|framing)|in stock|please)\b/gi, '')
        .replace(/[?!.]/g, '')
        .trim();

      if (/\b4x2\b/i.test(cleanQuery)) cleanQuery += ' 100x50';
      if (/\b6x2\b/i.test(cleanQuery)) cleanQuery += ' 150x50';
      if (/\bjib\b/i.test(cleanQuery)) cleanQuery = cleanQuery.replace(/\bjib\b/i, 'gib plasterboard');

      // Resolve short or ambiguous follow-up using previous conversation topic (Prompt P2)
      const isShortFollowUp =
        cleanQuery.split(/\s+/).length <= 2 ||
        qLower.includes('for that') ||
        qLower.includes('for those') ||
        qLower.includes('and what');

      let resolvedQuery = cleanQuery || rawQuestion;
      if (isShortFollowUp && previousTopic) {
        const prevLower = previousTopic.toLowerCase();
        const cleanLower = cleanQuery.toLowerCase();
        if (!cleanLower.includes(prevLower)) {
          resolvedQuery = `${previousTopic} ${cleanQuery}`.trim();
        }
      }

      const searchToolDef = req.tools?.find((t) => t.name === 'catalog.search' || t.name === 'search_products');
      const searchToolName = searchToolDef?.name || 'search_products';

      return {
        content: '',
        toolCalls: [
          {
            id: `call_search_${Date.now()}`,
            name: searchToolName,
            arguments: { query: resolvedQuery },
          },
        ],
      };
    }

    // ROUND 2: search_products or catalog.search returned, now present_card
    if (searchToolResult && !cardToolResult) {
      let parsedProducts: any[] = [];
      try {
        const parsed = JSON.parse(searchToolResult.content || '{}');
        parsedProducts = Array.isArray(parsed.products)
          ? parsed.products
          : Array.isArray(parsed.items)
          ? parsed.items
          : [];
      } catch {}

      if (parsedProducts.length > 0) {
        const topProducts = parsedProducts.slice(0, 3).map((p: any) => ({
          sku: String(p.sku),
          title: String(p.title || p.name || 'Product'),
        }));

        return {
          content: '',
          toolCalls: [
            {
              id: `call_card_${Date.now()}`,
              name: 'present_card',
              arguments: {
                cardType: 'products',
                state: {
                  heading: 'Matching Products',
                  products: topProducts,
                },
              },
            },
          ],
        };
      }
    }

    // FINAL ROUND: Write grounded, concise answer and stream tokens
    let finalAnswer = '';

    if (checklistResult) {
      let parsed: any = {};
      try {
        parsed = JSON.parse(checklistResult.content || '{}');
      } catch {}
      const summary = parsed.summary || 'Checked journey checklist progress.';
      const nextStep = parsed.nextStep || 'Proceed with the next step.';

      if (userContent.includes('<customer_event>')) {
        const typeMatch = userContent.match(/Type:\s*([^\n]+)/i);
        const eventType = typeMatch ? typeMatch[1].trim() : '';
        const payloadMatch = userContent.match(/Payload:\s*([\s\S]*?)<\/customer_event>/i);
        let payload: any = null;
        if (payloadMatch) {
          try {
            payload = JSON.parse(payloadMatch[1].trim());
          } catch {}
        }
        const title = payload?.title || payload?.name || payload?.sku || 'item';
        if (eventType.toLowerCase().includes('quote')) {
          finalAnswer = `I see the quote action for ${title}. Review the saved quote before proceeding. ${summary}`;
        } else {
          finalAnswer = `I see the cart action for ${title}. Review the saved cart before proceeding. ${summary}`;
        }
      } else {
        finalAnswer = `Here is your current journey progress: ${summary} Now ${nextStep.toLowerCase()}`;
      }
    } else if (knowledgeResult) {
      let parsedKnowledge: any = {};
      try {
        parsedKnowledge = JSON.parse(knowledgeResult.content || '{}');
      } catch {}

      if (
        parsedKnowledge.found === false ||
        parsedKnowledge.knowledge?.includes('No specific notes') ||
        parsedKnowledge.knowledge?.includes('No pinned business knowledge')
      ) {
        finalAnswer = 'I have no verified information on that topic in our records. Would you like me to connect you with a specialist, or could you provide more details so I can check further?';
      } else if (qLower.includes('dwang') || qLower.includes('nogging')) {
        finalAnswer = 'A dwang, also known as a nogging or blocking, is a horizontal timber spacer fitted between vertical wall studs to prevent buckling and provide fixing support for wall linings.';
      } else if (qLower.includes('power outlets') || qLower.includes('load bearing') || qLower.includes('electrical')) {
        finalAnswer = 'For safety and compliance with building regulations, electrical wiring and structural load-bearing elements must be assessed by a licensed trade specialist. Please consult a qualified electrician or structural engineer before proceeding.';
      } else {
        finalAnswer = 'Here is the relevant technical and project guidance from our building standards. Please let us know if you need specific sizing or structural verification.';
      }
    } else if (guideResult) {
      let parsedGuide: any = {};
      try {
        parsedGuide = JSON.parse(guideResult.content || '{}');
      } catch {}

      if (parsedGuide.found === false || parsedGuide.count === 0 || (Array.isArray(parsedGuide.guides) && parsedGuide.guides.length === 0)) {
        finalAnswer = 'I have no verified information on that guide topic in our records. Would you like me to connect you with a team specialist, or could you provide more details about your project?';
      } else {
        const title = parsedGuide.guides?.[0]?.title || 'our verified project guide';
        finalAnswer = `According to verified guidance in ${title}, follow the recommended installation procedures and project guidelines for your build.`;
      }
    } else if (warrantyResult) {
      let parsedWarranty: any = {};
      try {
        parsedWarranty = JSON.parse(warrantyResult.content || '{}');
      } catch {}

      if (parsedWarranty.found === false || !parsedWarranty.warranty?.terms) {
        finalAnswer = 'I have no verified information on that item in our records. Would you like me to connect you with our store team to check warranty terms, or could you clarify the exact model?';
      } else {
        finalAnswer = `According to verified warranty terms for ${parsedWarranty.productOrBrand}, coverage is: ${parsedWarranty.warranty.terms}.`;
      }
    } else if (stockResult) {
      let parsedStock: any = {};
      try {
        parsedStock = JSON.parse(stockResult.content || '{}');
      } catch {}
      const rows = parsedStock.branchStock?.records;
      const row = Array.isArray(rows) && rows.find((entry: any) => entry.branchName === parsedStock.branch);
      if (parsedStock.source === 'business_system' && row && typeof row.available === 'number') {
        finalAnswer = row.available > 0
          ? `The source lists SKU ${parsedStock.sku} in stock at ${row.branchName}: ${row.available} available. Would you like a quote?`
          : `The source lists SKU ${parsedStock.sku} out of stock at ${row.branchName}. Would you like to check another branch?`;
      } else {
        finalAnswer = 'Current stock has not been confirmed. Would you like the branch team to check availability?';
      }
    } else if (quoteResult) {
      let parsedQuote: any = {};
      try {
        parsedQuote = JSON.parse(quoteResult.content || '{}');
      } catch {}
      if (parsedQuote.ok === false) {
        finalAnswer = `I cannot create a quote for that item: ${parsedQuote.error} Would you like to select an active item from our catalogue?`;
      } else {
        finalAnswer = 'Your quote has been created successfully. Would you like to proceed with checkout or delivery scheduling?';
      }
    } else if (cartResult) {
      let parsedCart: any = {};
      try {
        parsedCart = JSON.parse(cartResult.content || '{}');
      } catch {}
      if (parsedCart.ok === false) {
        finalAnswer = `I cannot add that item to your cart: ${parsedCart.error} Would you like to view active items from our store?`;
      } else {
        finalAnswer = 'Your cart has been updated successfully. Would you like to proceed to checkout?';
      }
    } else if (cardToolResult || searchToolResult) {
      // Products were found
      let parsedProducts: any[] = [];
      try {
        const parsed = JSON.parse(searchToolResult?.content || '{}');
        parsedProducts = Array.isArray(parsed.products)
          ? parsed.products
          : Array.isArray(parsed.items)
          ? parsed.items
          : [];
      } catch {}

      if (parsedProducts.length > 0) {
        const top = parsedProducts[0];
        finalAnswer = `We have ${top.title || top.name} (SKU ${top.sku}) available for your project. Please see the matching options shown in the card above.`;
      } else {
        finalAnswer = 'We do not currently have an exact match in our online catalogue for that specification. Please speak with our branch team or explore related sizes in our catalogue.';
      }
    } else {
      finalAnswer = 'Here are options from the catalogue. Please let us know if you need additional assistance with sizing or quantities.';
    }

    // Stream tokens
    const words = finalAnswer.split(' ');
    for (let i = 0; i < words.length; i++) {
      onDelta?.(words[i] + (i < words.length - 1 ? ' ' : ''));
    }

    return {
      content: finalAnswer,
      toolCalls: [],
      usage: {
        promptTokens: 120,
        completionTokens: 40,
        totalTokens: 160,
      },
    };
  };
}
