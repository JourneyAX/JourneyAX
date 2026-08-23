import OpenAI from 'openai';
import { searchOrders, getOrder } from '@/services/csr/mock-data';
import { guard, isFailure, errorResponse, validateCommand } from '@/lib/api-guard';
import { requireStaff, isUnauthorised } from '@/lib/auth/guard';
import { AI_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const log = logger('api/csr');

/** Workspace state echoed into the prompt. Never trusted for logic. */
interface CsrContext {
  sNumber?: string;
  accountName?: string;
  colorway?: string;
  roster?: { number: string; name: string; size: string }[];
}

// ═══════════════════════════════════════════════════════════════════════
// CSR assist endpoint.
//
// Same split as the Caroma chat route: `lookupOrder` runs server-side, the
// rest are UI tools that are never executed here — they are collected and
// replayed in the browser as reducer dispatches.
//
// Difference from the customer journey: the CSR is on a live call, so the
// contract is one short command in, one panel update out. No conversation
// loop, no multi-turn state. Latency is the feature.
// ═══════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the assist bar inside a Momentec/Augusta CSR workspace.

A customer service rep is ON A LIVE PHONE CALL with a dealer or a coach. They type
shorthand. You translate it into panel actions. Speed matters more than prose.

RULES
1. Be terse. One short sentence, maximum. Never explain what you are about to do.
2. Always prefer a tool call over talking. If a command maps to an action, call it.
3. Never invent an S number, style number, price, roster name or account. If you
   cannot find something, say so plainly and call nothing.
4. Roster edits: "swap 12 Jenkins for Gajji" means edit the line matching 12 or
   Jenkins. "drop 7" means remove. "add Guru 23 large" means add.
5. Never state whether a new proof is required — the workspace computes that.
   Do not guess at it.
6. Never state a size conclusion, a growth estimate or how confident it is.
   Anything about sizes, growth or fit is a checkSizes call. The workspace
   owns that answer, shows its evidence and asks the CSR to accept it.
7. Do not offer to place, cancel or release an order. The CSR does that.`;

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'lookupOrder',
      description: 'Search COMS for orders. Use whenever the CSR names a school, dealer, sport, season, S number, PO or style.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Any identifier or description the CSR gave' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findOrder',
      description: 'Put a search into the workspace search box and show results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          openFirst: { type: 'boolean', description: 'True when exactly one order clearly matches' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'openOrder',
      description: 'Open a specific order by its S number.',
      parameters: {
        type: 'object',
        properties: { sNumber: { type: 'string' } },
        required: ['sNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editRoster',
      description: 'Add, remove or edit roster lines on the open order.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add', 'remove', 'edit'] },
                match: { type: 'string', description: 'For edit: the existing name or number to find' },
                name: { type: 'string' },
                number: { type: 'string' },
                size: { type: 'string', description: 'YS YM YL XS S M L XL 2XL 3XL' },
              },
              required: ['op'],
            },
          },
        },
        required: ['operations'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkSizes',
      description:
        'Run a size review over the roster on the open order. Use whenever the caller '
        + 'asks about sizes, growth, fit, whether anyone has grown, or whether last '
        + "year's sizes still apply. Takes no arguments — the workspace decides what to "
        + 'suggest and why. Never state a size conclusion yourself.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setColorway',
      description: 'Change the colourway on the open order.',
      parameters: {
        type: 'object',
        properties: { colorway: { type: 'string' } },
        required: ['colorway'],
      },
    },
  },
];

// ── Deterministic fallback ─────────────────────────────────────────────
// Keeps the spine demoable with no API key and no spend. Handles the
// commands a CSR types most often; anything else falls through to the model.
function localParse(command: string, hasOpenOrder: boolean) {
  const c = command.trim();
  const actions: { name: string; arguments: Record<string, unknown> }[] = [];

  const drop = c.match(/^(?:drop|remove|delete)\s+(.+)$/i);
  if (drop && hasOpenOrder) {
    const t = drop[1].trim();
    actions.push({
      name: 'editRoster',
      arguments: { operations: [{ op: 'remove', ...(/^\d+$/.test(t) ? { number: t } : { name: t }) }] },
    });
    return { actions, message: `Removed ${t}.` };
  }

  const add = c.match(/^add\s+([A-Za-z.\-'\s]+?)\s+(\d+)(?:\s+(\w+))?$/i);
  if (add && hasOpenOrder) {
    const size = (add[3] || 'M').toUpperCase()
      .replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L');
    actions.push({
      name: 'editRoster',
      arguments: { operations: [{ op: 'add', name: add[1].trim(), number: add[2], size }] },
    });
    return { actions, message: `Added ${add[1].trim()} #${add[2]} (${size}).` };
  }

  const swap = c.match(/^swap\s+(\S+)\s+(?:\S+\s+)?for\s+(.+)$/i);
  if (swap && hasOpenOrder) {
    actions.push({
      name: 'editRoster',
      arguments: { operations: [{ op: 'edit', match: swap[1], name: swap[2].trim() }] },
    });
    return { actions, message: `Replaced ${swap[1]} with ${swap[2].trim()}.` };
  }

  // Size questions. Deliberately checked after the edit verbs above: "change
  // 12 to large" is an edit that happens to mention a size, not a question
  // about sizes, and matching the broad pattern first would swallow it.
  const isEdit = /^(add|drop|remove|delete|swap|change|set|make|edit)\b/i.test(c);
  if (hasOpenOrder && !isEdit
      && /\b(size|sizes|sizing|grew|grow|grown|growth|outgrow\w*|fit|bigger|smaller|still fit)\b/i.test(c)) {
    return { actions: [{ name: 'checkSizes', arguments: {} }], message: 'Checked the roster.' };
  }

  const sNum = c.match(/\b(S\d{5,7})\b/i);
  if (sNum) {
    const found = getOrder(sNum[1]);
    return found
      ? { actions: [{ name: 'openOrder', arguments: { sNumber: found.sNumber } }], message: `Opened ${found.sNumber}.` }
      : { actions: [], message: `No order found for ${sNum[1]}.` };
  }

  return null;
}

export async function POST(req: Request) {
  // The reorder desk exposes real customer orders and rosters. The proxy
  // redirects unauthenticated browsers, but this is the check that matters —
  // the proxy never sees a direct API call.
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard<{ command?: unknown; context?: CsrContext }>(
    req,
    { scope: 'csr', rule: AI_LIMIT },
  );
  if (isFailure(guarded)) return guarded.response;

  const checked = validateCommand(guarded.body.command);
  if (!checked.ok) return errorResponse(400, 'invalid_command', checked.message);

  const command = checked.command;
  const context = guarded.body.context;
  const hasOpenOrder = !!context?.sNumber;

  // Try the cheap path first — most CSR commands are formulaic.
  const local = localParse(command, hasOpenOrder);
  if (local) {
    return Response.json({ message: local.message, uiActions: local.actions, via: 'local' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({
      message: 'Assist needs OPENAI_API_KEY. Search and editing still work.',
      uiActions: [],
      via: 'none',
    });
  }

  const openai = new OpenAI();
  const uiActions: { name: string; arguments: unknown }[] = [];

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content: `[WORKSPACE STATE]
Open order: ${context?.sNumber || '(none)'}
Account: ${context?.accountName || '(none)'}
Colourway: ${context?.colorway || '(none)'}
Roster (${context?.roster?.length || 0}): ${(context?.roster || [])
          .map((r: { number: string; name: string; size: string }) => `#${r.number} ${r.name} ${r.size}`)
          .join(' · ') || '(empty)'}`,
      },
      { role: 'user', content: command },
    ];

    // Two passes at most: one to look data up, one to act on it.
    for (let loop = 0; loop < 3; loop++) {
      const res = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages,
        tools,
        tool_choice: 'auto',
      });

      const msg = res.choices[0].message;
      messages.push(msg);

      if (!msg.tool_calls?.length) {
        return Response.json({ message: msg.content || '', uiActions, via: 'model' });
      }

      let needsAnotherPass = false;
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;
        const args = JSON.parse(call.function.arguments || '{}');

        if (call.function.name === 'lookupOrder') {
          const hits = searchOrders(args.query).slice(0, 5);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              found: hits.length > 0,
              results: hits.map(h => ({
                sNumber: h.order.sNumber,
                account: h.order.accountName,
                sport: h.order.sport,
                season: h.order.season,
                style: h.order.product.styleId,
                styleName: h.order.product.styleName,
                units: h.order.roster.length,
                status: `${h.order.stage} | ${h.order.subState}`,
                matchedOn: h.matchedOn,
              })),
            }),
          });
          needsAnotherPass = true;
        } else {
          // UI tool — collected, answered with a stub, replayed in the browser.
          uiActions.push({ name: call.function.name, arguments: args });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: true }) });
          needsAnotherPass = true;
        }
      }

      if (!needsAnotherPass) break;
    }

    return Response.json({ message: '', uiActions, via: 'model' });
  } catch (error) {
    log.error('CSR assist failed', error);
    return errorResponse(502, 'ai_unavailable', 'Assist is unavailable right now.', { uiActions: [] });
  }
}
