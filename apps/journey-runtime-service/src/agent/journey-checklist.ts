import type { AgentToolContext } from './agent-tools';
import { readHistory, type ConversationTurnRecord } from '../conversation/history';
import { normalizePlaybookStages, type JourneyPlaybookStage } from '@journeyax/business-pack';

export interface DerivedChecklistItem {
  sku?: string;
  title?: string;
  quantity?: number;
  source?: string;
  timestamp?: string;
}

export interface DerivedJourneyChecklist {
  productsSelected: DerivedChecklistItem[];
  accessoriesChecked: boolean;
  guidesRead: Array<{
    topic?: string;
    sourceId?: string;
  }>;
  quantityCalculated: boolean;
  stockChecked: boolean;
  eventsRecorded: Array<{
    type: string;
    timestamp?: string;
    payload?: any;
  }>;
  playbookStages?: Array<{
    name: string;
    goal: string;
    tools: string[];
    exitCondition: string;
    status: 'completed' | 'in_progress' | 'pending';
  }>;
  summary: string;
  nextStep?: string;
}

/**
 * Derives current journey checklist progress purely from session events, transcript history,
 * and workspace facts. Generic across any merchant or industry.
 */
export function deriveJourneyChecklist(ctx: AgentToolContext): DerivedJourneyChecklist {
  const facts = ctx.workspace?.facts || {};

  // 1. Gather recorded customer events
  const eventsLogVal = facts.customer_events_log?.value;
  const recordedEvents: Array<{ type: string; timestamp?: string; payload?: any }> = [];

  if (Array.isArray(eventsLogVal)) {
    for (const evt of eventsLogVal) {
      if (evt && typeof evt === 'object' && evt.type) {
        recordedEvents.push({
          type: String(evt.type),
          timestamp: evt.timestamp ? String(evt.timestamp) : undefined,
          payload: evt.payload,
        });
      }
    }
  } else if (facts.last_customer_event?.value) {
    const last = facts.last_customer_event.value as any;
    if (last && typeof last === 'object' && last.type) {
      recordedEvents.push({
        type: String(last.type),
        timestamp: last.timestamp ? String(last.timestamp) : undefined,
        payload: last.payload,
      });
    }
  }

  // Also include current turn customerEvent if available
  if (ctx.customerEvent && ctx.customerEvent.type) {
    const already = recordedEvents.some(
      (e) => e.type === ctx.customerEvent.type && JSON.stringify(e.payload) === JSON.stringify(ctx.customerEvent.payload)
    );
    if (!already) {
      recordedEvents.push({
        type: String(ctx.customerEvent.type),
        timestamp: ctx.customerEvent.timestamp ? String(ctx.customerEvent.timestamp) : new Date().toISOString(),
        payload: ctx.customerEvent.payload,
      });
    }
  }

  // 2. Read conversation history records
  const historyTurns: ConversationTurnRecord[] = readHistory(facts);

  // 3. Products Selected
  const selectedMap = new Map<string, DerivedChecklistItem>();

  // (a) From customer events (e.g. addToQuote, addToCart, selectItem)
  for (const evt of recordedEvents) {
    const isSelectionEvent =
      /add|select|choose|cart|quote/i.test(evt.type) && !/remove|delete/i.test(evt.type);
    if (isSelectionEvent && evt.payload) {
      const p = evt.payload;
      const sku = String(p.sku || p.partNumber || p.productId || p.id || '').trim();
      const title = String(p.title || p.name || p.label || sku || 'Selected item').trim();
      const quantity = typeof p.quantity === 'number' ? p.quantity : typeof p.qty === 'number' ? p.qty : 1;
      const key = sku || title;
      if (key) {
        selectedMap.set(key, {
          sku: sku || undefined,
          title,
          quantity,
          source: `event:${evt.type}`,
          timestamp: evt.timestamp,
        });
      }
    }
  }

  // (b) From history turn actions or tool summaries
  for (const t of historyTurns) {
    const content = t.content || '';
    const actionMatch = content.match(/\[Action:\s*([^\s\]]+)(?:\s*-\s*SKU:\s*([^\]]+))?\]/i);
    if (actionMatch) {
      const actType = actionMatch[1];
      const sku = actionMatch[2]?.trim();
      if (sku && (/add|select|cart|quote/i.test(actType) && !/remove/i.test(actType))) {
        if (!selectedMap.has(sku)) {
          selectedMap.set(sku, {
            sku,
            title: `Item ${sku}`,
            quantity: 1,
            source: `history:${actType}`,
            timestamp: t.timestamp,
          });
        }
      }
    }

    if (t.role === 'tool_summary') {
      const toolMatch = content.match(/Ran (create_quote|add_to_quote|update_quote|add_to_cart|update_cart) -> (.*)/i);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const detail = toolMatch[2];
        const skuFound = detail.match(/sku[:= ]\s*([a-zA-Z0-9_-]+)/i);
        if (skuFound?.[1] && !selectedMap.has(skuFound[1])) {
          selectedMap.set(skuFound[1], {
            sku: skuFound[1],
            title: `Product ${skuFound[1]}`,
            quantity: 1,
            source: `tool:${toolName}`,
            timestamp: t.timestamp,
          });
        }
      }
    }
  }

  // (c) From in-memory quotes or carts
  if (ctx.inMemoryQuotes) {
    const quotes = ctx.inMemoryQuotes instanceof Map
      ? Array.from(ctx.inMemoryQuotes.values())
      : Object.values(ctx.inMemoryQuotes);
    for (const q of quotes) {
      if (Array.isArray(q?.items)) {
        for (const it of q.items) {
          const sku = String(it.sku || it.id || '').trim();
          if (sku && !selectedMap.has(sku)) {
            selectedMap.set(sku, {
              sku,
              title: it.title || it.name || `Item ${sku}`,
              quantity: it.quantity || 1,
              source: 'quote',
            });
          }
        }
      }
    }
  }

  if (ctx.inMemoryCarts) {
    const carts = ctx.inMemoryCarts instanceof Map
      ? Array.from(ctx.inMemoryCarts.values())
      : Object.values(ctx.inMemoryCarts);
    for (const c of carts) {
      if (Array.isArray(c?.items)) {
        for (const it of c.items) {
          const sku = String(it.sku || it.id || '').trim();
          if (sku && !selectedMap.has(sku)) {
            selectedMap.set(sku, {
              sku,
              title: it.title || it.name || `Item ${sku}`,
              quantity: it.quantity || 1,
              source: 'cart',
            });
          }
        }
      }
    }
  }

  // (d) From workspace selected objects
  if (Array.isArray(ctx.workspace?.selectedObjects)) {
    for (const obj of ctx.workspace.selectedObjects) {
      const sku = String(obj?.sku || obj?.id || '').trim();
      const title = String(obj?.title || obj?.name || sku).trim();
      const key = sku || title;
      if (key && !selectedMap.has(key)) {
        selectedMap.set(key, {
          sku: sku || undefined,
          title,
          quantity: obj?.quantity || 1,
          source: 'workspace.selectedObjects',
        });
      }
    }
  }

  const productsSelected = Array.from(selectedMap.values());

  // 4. Accessories / Related Items Checked
  let accessoriesChecked = false;
  for (const t of historyTurns) {
    const c = t.content.toLowerCase();
    if (
      c.includes('ran get_related_products') ||
      (c.includes('ran consult_business_knowledge') && (c.includes('accessor') || c.includes('relat') || c.includes('compatib') || c.includes('pair'))) ||
      (c.includes('ran search_products') && (c.includes('accessor') || c.includes('hardware') || c.includes('relat') || c.includes('trim') || c.includes('matching') || c.includes('addon') || c.includes('extra') || c.includes('pair') || c.includes('compatib')))
    ) {
      accessoriesChecked = true;
      break;
    }
  }

  // 5. Guides / Business Knowledge Read
  const guidesReadMap = new Map<string, { topic?: string; sourceId?: string }>();
  for (const t of historyTurns) {
    const c = t.content;
    const guideMatch = c.match(/Ran (?:consult_business_knowledge|search_guides|get_warranty) -> (?:topic="([^"]+)"|([^\n]+))/i);
    if (guideMatch) {
      const topic = (guideMatch[1] || guideMatch[2] || '').trim();
      if (topic && !guidesReadMap.has(topic)) {
        guidesReadMap.set(topic, { topic });
      }
    }
  }
  if (ctx.readSourceIds) {
    for (const sId of ctx.readSourceIds) {
      if (!guidesReadMap.has(sId)) {
        guidesReadMap.set(sId, { sourceId: sId });
      }
    }
  }
  if (ctx.consultedConcepts) {
    for (const concept of ctx.consultedConcepts) {
      if (concept.name && !guidesReadMap.has(concept.name)) {
        guidesReadMap.set(concept.name, { topic: concept.name });
      }
    }
  }
  const guidesRead = Array.from(guidesReadMap.values());

  // 6. Quantity Calculated
  let quantityCalculated = Boolean(facts.quantity_calculation?.value);
  if (!quantityCalculated) {
    for (const t of historyTurns) {
      if (t.content.toLowerCase().includes('ran calculate_quantity')) {
        quantityCalculated = true;
        break;
      }
    }
  }

  // 7. Stock Checked
  let stockChecked = false;
  for (const t of historyTurns) {
    if (t.content.toLowerCase().includes('ran check_stock')) {
      stockChecked = true;
      break;
    }
  }

  // 8. Journey Playbook Stages Progression
  const rawPlaybook =
    ctx.agentPlaybook ||
    (ctx.release as any)?.agents?.find((a: any) => a.agentId === (ctx as any).agentId)?.journeyPlaybook ||
    (ctx.release as any)?.agents?.[0]?.journeyPlaybook;

  const stages: JourneyPlaybookStage[] = normalizePlaybookStages(rawPlaybook);
  let playbookStages:
    | Array<{
        name: string;
        goal: string;
        tools: string[];
        exitCondition: string;
        status: 'completed' | 'in_progress' | 'pending';
      }>
    | undefined;

  let currentPendingStageName: string | undefined;

  if (stages.length > 0) {
    let completedPrior = true;
    playbookStages = stages.map((st) => {
      const stageTools = st.tools || [];
      let isStageComplete = false;

      // Stage completion heuristics based on stage goals & tools
      const requiresSearchOrSelect = stageTools.some((t) => t.includes('search') || t.includes('catalog'));
      const requiresQuote = stageTools.some((t) => t.includes('quote'));
      const requiresCart = stageTools.some((t) => t.includes('cart'));
      const requiresStock = stageTools.some((t) => t.includes('stock'));
      const requiresCalc = stageTools.some((t) => t.includes('calc') || t === 'calculate_quantity' || t.startsWith('quantity.'));
      const requiresKnowledge = stageTools.some((t) => t.includes('knowledge') || t.includes('guide') || t.includes('warranty'));

      const quoteExecuted = Boolean(
        (ctx.inMemoryQuotes && (ctx.inMemoryQuotes instanceof Map ? ctx.inMemoryQuotes.size > 0 : Object.keys(ctx.inMemoryQuotes).length > 0)) ||
        historyTurns.some((t) => /create_quote|add_to_quote|update_quote/i.test(t.content))
      );
      const cartExecuted = Boolean(
        (ctx.inMemoryCarts && (ctx.inMemoryCarts instanceof Map ? ctx.inMemoryCarts.size > 0 : Object.keys(ctx.inMemoryCarts).length > 0)) ||
        historyTurns.some((t) => /update_cart|add_to_cart/i.test(t.content))
      );

      if (requiresQuote) {
        isStageComplete = quoteExecuted;
      } else if (requiresCart) {
        isStageComplete = cartExecuted;
      } else if (requiresStock) {
        isStageComplete = stockChecked;
      } else if (requiresCalc) {
        isStageComplete = quantityCalculated;
      } else if (requiresKnowledge) {
        isStageComplete = Boolean(guidesRead.length > 0 || accessoriesChecked);
      } else if (requiresSearchOrSelect) {
        isStageComplete = productsSelected.length > 0;
      }

      let status: 'completed' | 'in_progress' | 'pending';
      if (isStageComplete) {
        status = 'completed';
      } else if (completedPrior) {
        status = 'in_progress';
        completedPrior = false;
        if (!currentPendingStageName) currentPendingStageName = st.name;
      } else {
        status = 'pending';
      }

      return {
        name: st.name,
        goal: st.goal,
        tools: stageTools,
        exitCondition: st.exitCondition,
        status,
      };
    });
  }

  const summaryParts: string[] = [];
  summaryParts.push(
    productsSelected.length > 0
      ? `${productsSelected.length} product(s) selected: ${productsSelected.map((p) => p.sku || p.title).join(', ')}.`
      : 'No products selected yet.'
  );
  if (accessoriesChecked) summaryParts.push('Complementary accessories/items checked.');
  if (guidesRead.length > 0) summaryParts.push(`${guidesRead.length} knowledge note(s)/guide(s) read.`);
  if (quantityCalculated) summaryParts.push('Quantities calculated.');
  if (stockChecked) summaryParts.push('Stock availability verified.');

  const nextStep = currentPendingStageName
    ? `Continue with: ${currentPendingStageName}`
    : 'Proceed with final confirmation.';

  return {
    productsSelected,
    accessoriesChecked,
    guidesRead,
    quantityCalculated,
    stockChecked,
    eventsRecorded: recordedEvents,
    playbookStages,
    summary: summaryParts.join(' '),
    nextStep,
  };
}
