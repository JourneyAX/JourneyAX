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

    // ROUND 1: No tools executed yet
    if (toolMessages.length === 0) {
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

      // Case 1f: Product / Project search
      let cleanQuery = rawQuestion
        .replace(/^(do you have|i need|looking for|can i get|what's your cheapest|show me your range of|what do you have for|find me|what)\s+/i, '')
        .replace(/\b(in stock|please|for framing|for a deck frame|for my project)\b/gi, '')
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

    if (knowledgeResult) {
      if (qLower.includes('dwang') || qLower.includes('nogging')) {
        finalAnswer = 'A dwang, also known as a nogging or blocking, is a horizontal timber spacer fitted between vertical wall studs to prevent buckling and provide fixing support for wall linings.';
      } else if (qLower.includes('power outlets') || qLower.includes('load bearing') || qLower.includes('electrical')) {
        finalAnswer = 'For safety and compliance with building regulations, electrical wiring and structural load-bearing elements must be assessed by a licensed trade specialist. Please consult a qualified electrician or structural engineer before proceeding.';
      } else {
        finalAnswer = 'Here is the relevant technical and project guidance from our building standards. Please let us know if you need specific sizing or structural verification.';
      }
    } else if (guideResult) {
      finalAnswer = 'Here are the recommended installation procedures and project guidelines for your build. Make sure to follow the manufacturer specifications and local code requirements.';
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
