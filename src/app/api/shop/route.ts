import OpenAI from 'openai';
import { GARMENT_SPECS, sizesOf } from '@/services/fit/garment-specs';
import { isLanguageCode, promptNameFor } from '@/lib/i18n';
import type { LanguageCode } from '@/lib/i18n';
import { guard, isFailure, errorResponse, validateMessages } from '@/lib/api-guard';
import { AI_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const log = logger('api/shop');

// ═══════════════════════════════════════════════════════════════════════
// Apparel journey.
//
// Same contract as the Caroma route — the model drives the right-hand panel
// through tools that are never executed here — but a different business, so
// a different catalogue, a different prompt, and one extra tool the bathroom
// journey has no use for: showFitAdvisor.
//
// The catalogue is small and local. That is deliberate for the POC: sizing
// only means anything against real finished-garment measurements, and those
// live in garment-specs.ts rather than in a vector index.
// ═══════════════════════════════════════════════════════════════════════

const CATALOG = GARMENT_SPECS.map(g => ({
  styleId: g.styleId,
  name: g.styleName,
  brand: g.brandId,
  category: g.category,
  chart: g.chart,
  sizes: sizesOf(g),
  stretch: g.stretchIn < 1 ? 'none' : g.stretchIn >= 3 ? 'lots' : 'some',
  price: g.category === 'bottom' ? 89 : g.brandId === 'augusta' ? 70.5 : 39,
}));

const SYSTEM_PROMPT = `You are a personal shopper for an apparel brand, inside JourneyAX.

The customer talks to you on the left. The right-hand panel is yours to drive
through tools. Be warm, brief and concrete. One question at a time.

## The journey — one continuous loop, not four separate features
1. **Understand** what they are shopping for and why.
2. **Show** — call \`showProducts\` to put real items on the right. Never list
   products as text in the chat.
3. **Size** — before anything with a size reaches the bag, call
   \`showFitAdvisor\`. The panel answers, not you.
4. **See** — once a size is chosen, call \`showTryOn\` so they can look at it
   before committing. Try-on is a visual check, never a size decision.
5. **Bag** — call \`addToBag\` when they want it. The bag accumulates across
   the whole conversation; never re-add something already in it.
6. **Buy** — call \`updateQuote\` only when they say they are done.
7. **Learn** — if they mention returning, exchanging, or that something they
   already have did not fit, call \`startReturn\`.

## CRITICAL RULES
1. **NEVER STATE A SIZE.** You must not guess, estimate or assert what size
   anyone should take, and you must not ask for their height, weight or
   measurements yourself. The moment sizing comes up — "what size am I",
   "will it fit", "I'm between sizes", "the last one was too small", or an
   item about to be added without a size — call \`showFitAdvisor\` and let the
   panel answer. It reports the chosen size back to you; continue from that.
2. **NEVER INVENT PRODUCTS, PRICES OR MEASUREMENTS.** Only use the catalogue
   below. Pass \`styleId\` to \`showFitAdvisor\`; never pass a made-up size chart.
3. **ONE ITEM AT A TIME.** Do not open the fit advisor for several garments at
   once — sizes differ per style, so each needs its own check.
4. **NEVER ADD AN UNSIZED GARMENT.** If they ask to add something you have no
   size for, open the fit advisor first. The bag will not check out with an
   unsized line, so adding one strands them.
5. **DO NOT RE-ASK WHAT THE STATE ALREADY ANSWERS.** The current bag, chosen
   size and language are given to you below. If a size is already chosen for
   a style, use it.
6. **TRY-ON IS NOT FIT.** Never describe try-on as proving a size fits. It
   shows how a garment looks; the Fit Advisor decides the size.
7. **ANSWER IN THE CUSTOMER'S LANGUAGE.** The active language is given below.
   Reply entirely in it, including product explanations. If they switch
   language mid-conversation, switch with them and call \`setLanguage\`; do not
   restart the journey or re-ask anything you already know.
8. Keep chat messages short. The panel carries the detail.

## Catalogue (the only items that exist)
${CATALOG.map(c =>
  `- ${c.styleId} · ${c.name} · $${c.price} · ${c.category} · ${c.chart} sizing · sizes ${c.sizes.join('/')} · stretch: ${c.stretch}`
).join('\n')}`;

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'setPhase',
      description: 'Change what the right-hand panel is showing.',
      parameters: {
        type: 'object',
        properties: {
          phase: {
            type: 'string',
            enum: ['intro', 'products', 'fit', 'tryon', 'bag', 'returns', 'quote'],
          },
        },
        required: ['phase'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showProducts',
      description: 'Show product cards on the right. Use catalogue items only.',
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
                price: { type: 'number' },
                reason: { type: 'string', description: 'Why this suits them.' },
                category: { type: 'string' },
              },
              required: ['sku', 'name', 'price'],
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
      name: 'showFitAdvisor',
      description:
        'Open the Fit Advisor on the right so the customer can work out their size. '
        + 'Call this for ANY sizing question and before adding any garment to the order. '
        + 'Never state a size yourself. Pass the catalogue styleId.',
      parameters: {
        type: 'object',
        properties: {
          styleId: { type: 'string', description: 'Catalogue style number.' },
          styleName: { type: 'string' },
        },
        required: ['styleId', 'styleName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showTryOn',
      description:
        'Show the garment on the shopper at a size the Fit Advisor already produced. '
        + 'Call after a size is chosen and before adding to the bag. This is a visual '
        + 'check only — it never decides or changes a size.',
      parameters: {
        type: 'object',
        properties: {
          styleId: { type: 'string', description: 'Catalogue style number.' },
          styleName: { type: 'string' },
          size: { type: 'string', description: 'The size the advisor produced. Never invent one.' },
        },
        required: ['styleId', 'styleName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'addToBag',
      description:
        'Add items to the shopping bag. The bag accumulates — only send what is new. '
        + 'Every garment must already have a size chosen by the Fit Advisor.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' },
                size: { type: 'string', description: 'From the Fit Advisor. Required for garments.' },
                quantity: { type: 'number' },
                category: { type: 'string' },
                reason: { type: 'string', description: 'Why it suits them.' },
              },
              required: ['sku', 'name', 'price'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showBag',
      description: 'Bring the bag up on the right, e.g. when they ask what they have so far.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'startReturn',
      description:
        'Open the returns and exchange panel. Call whenever they mention sending '
        + 'something back, swapping a size, or that something already bought did not fit.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setLanguage',
      description:
        'Switch the panel language when the customer changes language. Does not reset '
        + 'the bag, sizes or conversation.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['en', 'hi', 'es', 'fr', 'de'] },
        },
        required: ['language'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'updateQuote',
      description: 'Put the order on the right. Include the chosen size in each line name.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          jobId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' },
                quantity: { type: 'number' },
                category: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['sku', 'name', 'price'],
            },
          },
        },
        required: ['title', 'items'],
      },
    },
  },
];

// ── Deterministic fallback ─────────────────────────────────────────────
// The POC ships without a live key more often than with one, and a demo
// that dies on a 401 is not a demo. This handles the shape of conversation
// the apparel journey actually has. Anything it cannot match falls through
// to the model.

function findStyle(text: string) {
  const t = text.toLowerCase();
  const byId = CATALOG.find(c => t.includes(c.styleId.toLowerCase()));
  if (byId) return byId;
  if (/\bjean|denim|trouser|pant/.test(t)) return CATALOG.find(c => c.category === 'bottom');
  if (/\bjersey|team|sublimat/.test(t)) return CATALOG.find(c => c.brand === 'augusta');
  if (/\bshirt|button|woven|slim fit/.test(t)) return CATALOG.find(c => c.styleId === 'AF-2207');
  if (/\btee|t-shirt|tshirt|top|crew/.test(t)) return CATALOG.find(c => c.styleId === 'AF-8841');
  return undefined;
}

const SIZE_INTENT = /\bsize|sizing|fit|fits|too small|too big|too large|too tight|between sizes|what size|measure/i;
// "send this back", "sending the tee back", "send them back" — the object in
// the middle varies, so match across it rather than listing pronouns.
const RETURN_INTENT =
  /\breturn(ed|ing)?\b|\bsend(ing)?\b[^.!?]{0,24}\bback\b|\bexchange|\bswap|\brefund|did\s?n'?t fit|does\s?n'?t fit/i;
const CHECKOUT_INTENT = /\b(place|submit|confirm) (the |my )?order|check ?out|happy with my bag|buy (it|them|this)/i;
const BAG_INTENT = /\b(my |the )?(bag|basket|cart)\b/i;

/** State the client sends each turn — there is no session on the server. */
interface ShopState {
  language?: string;
  bag?: { sku: string; name: string; price: number; quantity: number; size?: string }[];
  fitChoice?: { size: string } | null;
  /** Where an in-flight return has got to, so we do not restart a finished one. */
  returnStage?: string;
}

/**
 * Deterministic path.
 *
 * This is not only a no-key fallback — it is what keeps the demo's core loop
 * (size → see → bag → return) reproducible in front of an audience. Ordered
 * most-specific first, because "I want to return the tee that was too small"
 * matches the size pattern too, and returning is the more specific intent.
 */
function localReply(
  messages: { role: string; content: string }[],
  state: ShopState
) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = lastUser?.content || '';
  const actions: { name: string; arguments: Record<string, unknown> }[] = [];
  const bag = state.bag ?? [];

  // 0 · Language switch. Must come first: the sentence mentions nothing else,
  // and switching must not disturb the rest of the journey.
  const lang = text.match(/continue in (English|Hindi|Spanish|French|German)/i);
  if (lang) {
    const code = ({
      english: 'en', hindi: 'hi', spanish: 'es', french: 'fr', german: 'de',
    } as Record<string, string>)[lang[1].toLowerCase()];
    const reply = ({
      en: 'Of course — I will carry on in English. Nothing in your bag has changed.',
      hi: 'ज़रूर — अब मैं हिन्दी में बात करूँगा। आपके बैग में कुछ नहीं बदला है।',
      es: 'Por supuesto — sigo en español. Nada de tu bolsa ha cambiado.',
      fr: 'Bien sûr — je continue en français. Rien n’a changé dans votre panier.',
      de: 'Natürlich — ich mache auf Deutsch weiter. In Ihrer Tasche hat sich nichts geändert.',
    } as Record<string, string>)[code] ?? 'Of course.';
    actions.push({ name: 'setLanguage', arguments: { language: code } });
    return { message: reply, actions };
  }

  // 1 · Returns. Checked before sizing because a return sentence usually
  // contains a size complaint.
  if (RETURN_INTENT.test(text)) {
    // The panel's own confirmation message ("I am returning the tee…") looks
    // exactly like a request to start one. Acknowledge instead of restarting,
    // or the shopper watches their completed return disappear.
    if (state.returnStage === 'resolved') {
      return {
        message:
          "That's all arranged — you'll get the confirmation by email. "
          + 'Anything else I can help with?',
        actions,
      };
    }
    actions.push({ name: 'startReturn', arguments: {} });
    return {
      message:
        "I'm sorry that one didn't work out. I've opened returns on the right — "
        + 'pick the item and tell me what went wrong, and if it was the size '
        + "I'll remember that for next time.",
      actions,
    };
  }

  // 2 · Checkout.
  if (CHECKOUT_INTENT.test(text) && bag.length) {
    const unsized = bag.filter(l => !l.size);
    if (unsized.length) {
      const first = unsized[0];
      const style = CATALOG.find(c => c.styleId === first.sku) ?? CATALOG[0];
      actions.push({
        name: 'showFitAdvisor',
        arguments: { styleId: style.styleId, styleName: style.name },
      });
      return {
        message: `Before I place it — the ${first.name} still needs a size. I've opened the fit advisor for it.`,
        actions,
      };
    }
    actions.push({
      name: 'updateQuote',
      arguments: {
        title: 'Your order',
        jobId: 'AF-' + Math.floor(10000 + Math.random() * 89999),
        items: bag.map(l => ({
          sku: l.sku,
          name: l.size ? `${l.name} — size ${l.size}` : l.name,
          price: l.price,
          quantity: l.quantity,
          category: 'Apparel',
          reason: 'Size confirmed by the Fit Advisor.',
        })),
      },
    });
    return { message: "That's your order on the right — every size confirmed, nothing guessed.", actions };
  }

  // 3 · Try-on accepted → into the bag.
  const seen = text.match(/seen the try-on for the (.+?) in size (\S+)/i);
  if (seen) {
    const size = seen[2].replace(/[^\w-]/g, '');
    const style = findStyle(seen[1]) ?? findStyle(messages.map(m => m.content).join(' ')) ?? CATALOG[0];
    actions.push({
      name: 'addToBag',
      arguments: {
        items: [{
          sku: style.styleId,
          name: style.name,
          price: style.price,
          size,
          quantity: 1,
          category: 'Apparel',
          reason: 'Size confirmed by the Fit Advisor.',
        }],
      },
    });
    return {
      message: `Added in size ${size}. It's in your bag on the right — shall I find anything to go with it?`,
      actions,
    };
  }

  // 4 · Advisor result → show it on them before committing.
  const advised = text.match(/fit advisor and it recommended size (\S+)/i);
  if (advised) {
    const size = advised[1].replace(/[^\w-]/g, '');
    const style = findStyle(messages.map(m => m.content).join(' ')) ?? CATALOG[0];
    actions.push({
      name: 'showTryOn',
      arguments: { styleId: style.styleId, styleName: style.name, size },
    });
    return {
      message:
        `Size ${size}. Before it goes in the bag, have a look at it on the right — `
        + "that's how it sits, though the size itself comes from the fit advisor, not the picture.",
      actions,
    };
  }

  const style = findStyle(text);

  // 5 · Sizing.
  if (SIZE_INTENT.test(text)) {
    const target = style ?? CATALOG[0];
    actions.push({ name: 'showFitAdvisor', arguments: { styleId: target.styleId, styleName: target.name } });
    return {
      message: `Let's get that right rather than guess — I've opened the fit advisor on the right for the ${target.name}. It takes about ten seconds.`,
      actions,
    };
  }

  // 6 · "What's in my bag?"
  if (BAG_INTENT.test(text)) {
    actions.push({ name: 'showBag', arguments: {} });
    return {
      message: bag.length
        ? "Here's your bag on the right."
        : "Your bag is empty so far — tell me what you're after.",
      actions,
    };
  }

  // 7 · Product discovery.
  if (style) {
    actions.push({
      name: 'showProducts',
      arguments: {
        products: [{
          sku: style.styleId, name: style.name, price: style.price,
          category: 'Apparel',
          reason: style.stretch === 'none'
            ? 'Woven, so it holds its shape — worth sizing carefully.'
            : 'Comfortable everyday fabric with a little give.',
        }],
      },
    });
    return {
      message: `Here's the ${style.name} on the right. Shall I check what size you'd need?`,
      actions,
    };
  }

  return null;
}

export async function POST(req: Request) {
  const guarded = await guard<{ messages?: unknown; state?: ShopState }>(
    req,
    { scope: 'shop', rule: AI_LIMIT },
  );
  if (isFailure(guarded)) return guarded.response;

  const checked = validateMessages(guarded.body.messages);
  if (!checked.ok) return errorResponse(400, 'invalid_messages', checked.message);

  try {
    const history: { role: string; content: string }[] = checked.messages;
    const shopState: ShopState = guarded.body.state || {};

    // Cheap path first — and the only path when there is no key.
    const local = localReply(history, shopState);
    const hasKey = !!process.env.OPENAI_API_KEY && !/your-.*-key/i.test(process.env.OPENAI_API_KEY);

    if (local && !hasKey) {
      return Response.json({
        message: { content: local.message },
        conversation: [...history, { role: 'assistant', content: local.message }],
        uiActions: local.actions,
        via: 'local',
      });
    }

    if (!hasKey) {
      const fallback = "I can help you find something and get the size right. Tell me what you're shopping for.";
      return Response.json({
        message: { content: fallback },
        conversation: [...history, { role: 'assistant', content: fallback }],
        uiActions: [],
        via: 'local',
      });
    }

    // No session store, so the journey's memory is re-sent every turn. This
    // is what stops the model re-asking for a size it already has or
    // re-adding something that is already in the bag.
    const bag = shopState.bag ?? [];
    const lang: LanguageCode =
      shopState.language && isLanguageCode(shopState.language) ? shopState.language : 'en';
    const stateContext = `[CURRENT JOURNEY STATE — do not re-ask anything answered here]
- Reply in: ${promptNameFor(lang)}
- Size already chosen: ${shopState.fitChoice?.size ?? '(none yet)'}
- Bag (${bag.length} line${bag.length === 1 ? '' : 's'}):
${bag.length
  ? bag.map(l => `  * ${l.name} · ${l.sku} · ${l.size ? `size ${l.size}` : 'NO SIZE YET — open the fit advisor'} · qty ${l.quantity}`).join('\n')
  : '  * (empty)'}`;

    const openai = new OpenAI();
    const conversation: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: stateContext },
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: m.content,
      })),
    ];

    const uiToolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
    let finalMessage = '';

    for (let loop = 0; loop < 6; loop++) {
      const res = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages: conversation,
        tools,
        tool_choice: 'auto',
      });

      const msg = res.choices[0].message;
      conversation.push(msg);

      if (!msg.tool_calls?.length) {
        finalMessage = msg.content || '';
        break;
      }

      // Every tool here is a UI tool — none of them run on the server.
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;
        uiToolCalls.push(call);
        conversation.push({
          role: 'tool', tool_call_id: call.id,
          content: JSON.stringify({ success: true }),
        });
      }
    }

    return Response.json({
      message: { content: finalMessage },
      conversation: conversation
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      uiActions: uiToolCalls.map(c => ({
        name: c.function.name,
        arguments: JSON.parse(c.function.arguments || '{}'),
      })),
      via: 'model',
    });
  } catch (error) {
    log.error('shop journey failed', error);
    return errorResponse(502, 'ai_unavailable', 'The assistant is unavailable right now. Please try again.');
  }
}
