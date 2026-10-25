/**
 * The conversation as a thread of messages made of typed blocks, the way Claude keeps it.
 *
 * A turn used to be remembered as two strings (what the customer said, what the assistant answered), so everything that was looked
 * up and shown was forgotten: "the second one", "same again but 10 m" or "what did the card ask?" meant searching all over again.
 * Here each message keeps what happened as blocks (text, a lookup, the products on a card, the questions on a card, a worked-out
 * quantity, a tap), every message points at the message it answers (`parentId`), and the history for the next turn is built from the
 * blocks along one path of the thread. A branch (edit and retry) is just a second child of an earlier message.
 *
 * Pure functions only: no database, no model. Nothing here stores credentials; text is redacted by the store before it is saved.
 */

export type ThreadBlock =
  | { type: 'text'; text: string }
  /** A tool the assistant used: what for (arguments in brief) and how many things it found. */
  | { type: 'lookup'; tool: string; ok: boolean; summary?: string; count?: number }
  /** The products on a card, in the order the customer saw them. */
  | { type: 'products'; heading?: string; items: Array<{ sku: string; title: string; price?: number; currency?: string }> }
  /** The questions on a question card, with the choices offered. */
  | { type: 'questions'; questions: Array<{ id: string; text: string; options?: string[]; unit?: string }> }
  /** A number worked out by the quantity tool. */
  | { type: 'quantity'; sku: string; title?: string; quantity: number; unit?: string }
  /** Any other card the customer saw. */
  | { type: 'card'; cardType: string; heading?: string; skus?: string[] }
  /** Something the customer tapped (an action, not typed words). */
  | { type: 'action'; action: string; detail?: string };

export interface ThreadMessage {
  id: string;
  parentId: string | null;
  role: 'customer' | 'assistant';
  turnId: string;
  at: string;
  blocks: ThreadBlock[];
}

export const customerMessageId = (turnId: string): string => `${turnId}:customer`;
export const assistantMessageId = (turnId: string): string => `${turnId}:assistant`;

const clip = (text: unknown, max: number): string => {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

const optionLabel = (option: unknown): string => {
  if (typeof option === 'string') return option;
  const labelled = option as { label?: unknown; value?: unknown } | null;
  return String(labelled?.label ?? labelled?.value ?? '');
};

/** What a tool call looked up, in a few words: the same arguments the model chose, never the results. */
export function lookupSummary(args: any): string {
  const parts = ['productType', 'topic', 'keywords', 'query', 'sku', 'question']
    .map((key) => (args?.[key] === undefined ? '' : `${key}: ${Array.isArray(args[key]) ? args[key].join(' ') : String(args[key])}`))
    .filter(Boolean);
  return clip(parts.join('; '), 120);
}

interface ProductLike {
  sku?: unknown;
  title?: unknown;
  name?: unknown;
  price?: unknown;
  currency?: unknown;
}

/** One block for one presented card; a card the thread has no special block for is kept as its type, heading and products. */
export function blockForCard(card: { cardType: string; state: any }, titleOf: (sku: string) => string | undefined): ThreadBlock {
  const state = card.state || {};
  const product = (item: ProductLike) => {
    const sku = String(item?.sku ?? '');
    const title = clip(item?.title ?? item?.name ?? titleOf(sku) ?? '', 120);
    const price = typeof item?.price === 'number' ? item.price : undefined;
    return { sku, title: title || sku, ...(price !== undefined ? { price } : {}), ...(typeof item?.currency === 'string' && price !== undefined ? { currency: item.currency } : {}) };
  };
  if (card.cardType === 'products' && Array.isArray(state.products)) {
    return { type: 'products', ...(state.heading ? { heading: clip(state.heading, 100) } : {}), items: state.products.slice(0, 8).map(product).filter((item: { sku: string }) => item.sku) };
  }
  if (card.cardType === 'productDetail' && state.product) {
    return { type: 'products', ...(state.heading ? { heading: clip(state.heading, 100) } : {}), items: [product(state.product)].filter((item) => item.sku) };
  }
  if (card.cardType === 'clarify' && Array.isArray(state.questions)) {
    return {
      type: 'questions',
      questions: state.questions.slice(0, 3).map((q: any) => ({
        id: String(q?.id ?? ''),
        text: clip(q?.text, 160),
        ...(Array.isArray(q?.options) && q.options.length > 0 ? { options: q.options.slice(0, 8).map(optionLabel).filter(Boolean) } : {}),
        ...(typeof q?.unit === 'string' && q.unit ? { unit: q.unit } : {}),
      })),
    };
  }
  if (card.cardType === 'quantity' && state.product) {
    const item = product(state.product);
    return { type: 'quantity', sku: item.sku, title: item.title, quantity: Number(state.quantity) || 0, ...(state.unitLabel ? { unit: clip(state.unitLabel, 40) } : {}) };
  }
  const skus: string[] = [];
  const collect = (item: ProductLike) => {
    const sku = String(item?.sku ?? '');
    if (sku) skus.push(sku);
  };
  if (Array.isArray(state.products)) state.products.forEach(collect);
  if (Array.isArray(state.groups)) state.groups.forEach((group: any) => (Array.isArray(group?.items) ? group.items.forEach(collect) : undefined));
  return { type: 'card', cardType: card.cardType, ...(state.heading ? { heading: clip(state.heading, 100) } : {}), ...(skus.length > 0 ? { skus: skus.slice(0, 12) } : {}) };
}

export interface TurnForThread {
  turnId: string;
  /** The message this turn answers: the previous assistant message, or an earlier one when the customer branched. */
  parentId: string | null;
  at: string;
  customerText: string;
  customerAction?: { action: string; detail?: string };
  tools?: Array<{ name: string; ok: boolean; arguments?: any; resultCount?: number }>;
  cards?: Array<{ cardType: string; state: any }>;
  titleOf?: (sku: string) => string | undefined;
  assistantText: string;
}

/** The two messages of one turn: what the customer said or tapped, and what the assistant looked up, showed and answered. */
export function buildTurnMessages(turn: TurnForThread): ThreadMessage[] {
  const customerBlocks: ThreadBlock[] = [];
  if (turn.customerAction) customerBlocks.push({ type: 'action', action: clip(turn.customerAction.action, 60), ...(turn.customerAction.detail ? { detail: clip(turn.customerAction.detail, 120) } : {}) });
  if (turn.customerText && turn.customerText.trim()) customerBlocks.push({ type: 'text', text: turn.customerText.trim() });

  const assistantBlocks: ThreadBlock[] = [];
  for (const tool of turn.tools || []) {
    if ((tool.arguments as any)?.auto) continue;
    const summary = lookupSummary(tool.arguments);
    assistantBlocks.push({ type: 'lookup', tool: tool.name, ok: tool.ok, ...(summary ? { summary } : {}), ...(typeof tool.resultCount === 'number' ? { count: tool.resultCount } : {}) });
  }
  for (const card of turn.cards || []) assistantBlocks.push(blockForCard(card, turn.titleOf || (() => undefined)));
  if (turn.assistantText && turn.assistantText.trim()) assistantBlocks.push({ type: 'text', text: turn.assistantText.trim() });

  const customerId = customerMessageId(turn.turnId);
  return [
    { id: customerId, parentId: turn.parentId, role: 'customer', turnId: turn.turnId, at: turn.at, blocks: customerBlocks },
    { id: assistantMessageId(turn.turnId), parentId: customerId, role: 'assistant', turnId: turn.turnId, at: turn.at, blocks: assistantBlocks },
  ];
}

/** A turn saved before the thread existed, read as a thread of two messages (words only), chained after the previous turn. */
export function messagesFromRecord(
  record: { turnId: string; customerMessage?: string; assistantReply?: string; thread?: ThreadMessage[]; timestamps?: { receivedAt?: string } },
  previousAssistantId: string | null,
): ThreadMessage[] {
  if (Array.isArray(record.thread) && record.thread.length > 0) return record.thread;
  return buildTurnMessages({
    turnId: record.turnId,
    parentId: previousAssistantId,
    at: record.timestamps?.receivedAt || '',
    customerText: record.customerMessage || '',
    assistantText: record.assistantReply || '',
  });
}

/** Every message of the turns kept for a conversation, oldest first; turns saved without a thread are chained in time order. */
export function threadFromRecords(
  records: Array<{ turnId: string; customerMessage?: string; assistantReply?: string; thread?: ThreadMessage[]; timestamps?: { receivedAt?: string } }>,
): ThreadMessage[] {
  const all: ThreadMessage[] = [];
  let previousAssistantId: string | null = null;
  for (const record of records) {
    const messages = messagesFromRecord(record, previousAssistantId);
    all.push(...messages);
    previousAssistantId = messages[messages.length - 1]?.id ?? previousAssistantId;
  }
  return all;
}

/**
 * The messages from the first one down to `leafId` (default: the newest message), following `parentId`. A message whose parent is
 * missing (an older turn was dropped from storage) starts the path.
 */
export function threadPath(messages: ThreadMessage[], leafId?: string | null): ThreadMessage[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  let leaf = leafId ? byId.get(leafId) : undefined;
  if (!leaf) leaf = leafId ? undefined : messages[messages.length - 1];
  if (!leaf) return [];
  const path: ThreadMessage[] = [];
  const seen = new Set<string>();
  for (let node: ThreadMessage | undefined = leaf; node && !seen.has(node.id); node = node.parentId ? byId.get(node.parentId) : undefined) {
    seen.add(node.id);
    path.push(node);
  }
  return path.reverse();
}

/** The products an earlier part of the thread showed or worked out a quantity for: SKU to title, oldest first. */
export function shownSkus(path: ThreadMessage[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const message of path) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'products') for (const item of block.items) found.set(item.sku, item.title);
      else if (block.type === 'quantity' && block.sku) found.set(block.sku, block.title || found.get(block.sku) || block.sku);
      else if (block.type === 'card') for (const sku of block.skus || []) if (!found.has(sku)) found.set(sku, sku);
    }
  }
  return found;
}

export interface RenderOptions {
  /** Room for the history in tokens (about four characters each). */
  maxTokens?: number;
  /** The newest turns always written in full when the budget allows. */
  fullTurns?: number;
}

export interface RenderedThread {
  text: string;
  turns: number;
  /** Turns written shorter than in full. */
  compacted: number;
}

interface TurnView {
  customer: ThreadMessage | undefined;
  assistant: ThreadMessage | undefined;
}

const textOf = (message: ThreadMessage | undefined): string => (message?.blocks || []).filter((b): b is Extract<ThreadBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ');
const firstSentence = (text: string, max: number): string => clip(text.split(/(?<=[.!?])\s/)[0] || text, max);
const money = (item: { price?: number; currency?: string }): string => (typeof item.price === 'number' ? ` ${item.price.toFixed(2)}${item.currency ? ` ${item.currency}` : ''}` : '');

function shownItems(assistant: ThreadMessage | undefined): Array<{ sku: string; title: string; price?: number; currency?: string }> {
  const items: Array<{ sku: string; title: string; price?: number; currency?: string }> = [];
  for (const block of assistant?.blocks || []) if (block.type === 'products') items.push(...block.items);
  return items;
}

function renderFull(view: TurnView): string {
  const lines: string[] = [];
  for (const block of view.customer?.blocks || []) {
    if (block.type === 'action') lines.push(`Customer tapped: ${block.action}${block.detail ? ` (${block.detail})` : ''}`);
    if (block.type === 'text') lines.push(`Customer: ${clip(block.text, 700)}`);
  }
  const lookups = (view.assistant?.blocks || []).filter((b): b is Extract<ThreadBlock, { type: 'lookup' }> => b.type === 'lookup');
  if (lookups.length > 0) {
    lines.push(`Looked up: ${lookups.slice(0, 5).map((l) => `${l.tool}${l.summary ? ` [${l.summary}]` : ''}${l.ok ? (typeof l.count === 'number' ? ` (${l.count} found)` : '') : ' (failed)'}`).join('; ')}`);
  }
  for (const block of view.assistant?.blocks || []) {
    if (block.type === 'products' && block.items.length > 0) {
      lines.push(`Shown on a card${block.heading ? ` "${block.heading}"` : ''}, in this order: ${block.items.map((item, index) => `${index + 1}. ${item.title} (SKU ${item.sku}${money(item) ? `,${money(item)}` : ''})`).join('; ')}`);
    } else if (block.type === 'questions') {
      lines.push(`Asked on a question card: ${block.questions.map((q) => `"${q.text}"${q.options && q.options.length > 0 ? ` [${q.options.join(' / ')}]` : ''}${q.unit ? ` in ${q.unit}` : ''}`).join('; ')}`);
    } else if (block.type === 'quantity') {
      lines.push(`Worked out: ${block.quantity}${block.unit ? ` ${block.unit}` : ''} of ${block.title || 'SKU ' + block.sku} (SKU ${block.sku})`);
    } else if (block.type === 'card') {
      lines.push(`Card shown: ${block.cardType}${block.heading ? ` "${block.heading}"` : ''}${block.skus && block.skus.length > 0 ? ` (SKUs ${block.skus.join(', ')})` : ''}`);
    }
  }
  const reply = textOf(view.assistant);
  if (reply) lines.push(`Assistant: ${clip(reply, 900)}`);
  return lines.join('\n');
}

function renderBrief(view: TurnView): string {
  const parts: string[] = [];
  const customer = (view.customer?.blocks || []).map((b) => (b.type === 'text' ? b.text : b.type === 'action' ? `[tapped ${b.action}]` : '')).filter(Boolean).join(' ');
  if (customer) parts.push(`Customer: ${clip(customer, 150)}`);
  const shown = shownItems(view.assistant);
  if (shown.length > 0) parts.push(`Shown: ${shown.slice(0, 6).map((item) => `${clip(item.title, 50)} (SKU ${item.sku})`).join(', ')}`);
  const reply = textOf(view.assistant);
  if (reply) parts.push(`Assistant: ${firstSentence(reply, 170)}`);
  return parts.join(' | ');
}

/**
 * The history for the next turn, written from the blocks of one path of the thread. The newest turns are kept in full (so "the second
 * one" resolves to a real SKU); older turns shrink to one line; if the budget is still exceeded the oldest turns become a single
 * "earlier in this conversation" line. Nothing is left out silently: the header says how many turns were shortened.
 */
export function renderThread(path: ThreadMessage[], options: RenderOptions = {}): RenderedThread {
  const maxChars = (options.maxTokens ?? 2200) * 4;
  const fullTurns = Math.max(1, options.fullTurns ?? 3);
  const views: TurnView[] = [];
  const byTurn = new Map<string, TurnView>();
  for (const message of path) {
    let view = byTurn.get(message.turnId);
    if (!view) {
      view = { customer: undefined, assistant: undefined };
      byTurn.set(message.turnId, view);
      views.push(view);
    }
    if (message.role === 'customer') view.customer = message;
    else view.assistant = message;
  }
  if (views.length === 0) return { text: '', turns: 0, compacted: 0 };

  const levels: Array<'full' | 'brief'> = views.map((_, index) => (index >= views.length - fullTurns ? 'full' : 'brief'));
  const write = (): string[] => views.map((view, index) => (levels[index] === 'full' ? renderFull(view) : renderBrief(view)));
  let rendered = write();
  const size = () => rendered.reduce((sum, text) => sum + text.length + 2, 0);

  // Over budget: shorten the oldest full turn first, but never the newest one.
  for (let index = Math.max(0, views.length - fullTurns); size() > maxChars && index < views.length - 1; index++) {
    levels[index] = 'brief';
    rendered = write();
  }
  let dropped = 0;
  while (size() > maxChars && views.length - dropped > 1) {
    dropped++;
    const earlier = views.slice(0, dropped).map((view) => clip((view.customer?.blocks || []).map((b) => (b.type === 'text' ? b.text : '')).join(' '), 60)).filter(Boolean);
    rendered = [`Earlier in this conversation (${dropped} turns, summarised): ${earlier.join('; ')}`, ...write().slice(dropped)];
  }

  const compacted = levels.filter((level) => level === 'brief').length;
  const header = `Conversation so far: ${views.length} turn${views.length === 1 ? '' : 's'}${compacted > 0 ? `, ${compacted} of them shortened` : ''}. The newest turn is last.`;
  return { text: `${header}\n\n${rendered.join('\n\n')}`, turns: views.length, compacted };
}
