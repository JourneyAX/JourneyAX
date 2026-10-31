/**
 * Try again and edit: continuing the conversation from an earlier message.
 *
 * The server keeps the conversation as a tree of messages (each turn is a customer message and the reply to it, named
 * `<turn>:customer` and `<turn>:assistant`); a new message may name the message it continues from, and then the assistant reads only
 * the path up to there. The browser learns the two ids at the end of every turn (`messageIds` on the `done` event) and keeps them on
 * its own messages. These helpers work out, from those ids alone, what may be retried or edited and what the next request names as
 * its parent. Nothing here guesses: where the chain is not known (a thread saved before ids existed, a turn that failed), no
 * control is offered rather than one that would continue from the wrong place.
 */

/** The parent name for "start again from the very first message". */
export const ROOT_MESSAGE = 'root';

export interface ChatMessage {
  role: string;
  content?: string;
  /** The id the server keeps this message under. */
  messageId?: string;
  /** The id of the message this one continues from (ROOT_MESSAGE for the first). Only on customer messages, set when the turn finished. */
  parentMessageId?: string;
  /** A tap on a card, sent with the words the thread shows; it may change something (a cart), so it is never replayed. */
  customerEvent?: unknown;
  /** Sent on the customer's behalf (a payment notice); never shown, never replayed. */
  silent?: boolean;
  tool_calls?: unknown;
}

export interface MessageIds {
  customer?: string;
  assistant?: string;
}

const isHidden = (m: ChatMessage): boolean => m.role === 'tool' || Boolean(m.tool_calls) || Boolean(m.silent);

const isAnswer = (m: ChatMessage): boolean => m.role === 'assistant' || m.role === 'ai';

/**
 * The messages after a turn finished, with the ids the server named: the newest customer message and the reply after it. The
 * customer message also records what it continues from, taken from the message before it, so a later edit never has to work that out
 * again (the saved thread keeps only the latest messages, so the start of the list is not always the start of the conversation).
 */
export function withMessageIds<T extends ChatMessage>(messages: T[], ids: MessageIds | undefined | null): T[] {
  if (!ids || (!ids.customer && !ids.assistant)) return messages;
  const out = messages.slice();
  let customerAt = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') { customerAt = i; break; }
  }
  if (customerAt === -1) return out;
  // The newest customer message is the one this turn answered, even when it was sent quietly on the customer's behalf.
  if (ids.customer && !out[customerAt].messageId) {
    const before = customerAt === 0 ? undefined : out[customerAt - 1];
    const parent = customerAt === 0 ? ROOT_MESSAGE : before && isAnswer(before) ? before.messageId : undefined;
    out[customerAt] = { ...out[customerAt], messageId: ids.customer, ...(parent ? { parentMessageId: parent } : {}) };
  }
  return out;
}

/** The reply a finished turn adds, carrying its id. */
export function answerWithId<T extends object>(answer: T, ids: MessageIds | undefined | null): T & { messageId?: string } {
  return ids?.assistant ? { ...answer, messageId: ids.assistant } : answer;
}

/** Whether the customer message at `index` can be sent again from the same place: typed by the person, and its place is known. */
export function canBranchAt(messages: ChatMessage[], index: number): boolean {
  const m = messages[index];
  if (!m || m.role !== 'user' || isHidden(m) || m.customerEvent) return false;
  if (!(m.content || '').trim()) return false;
  return typeof m.parentMessageId === 'string' && m.parentMessageId.length > 0;
}

/** The customer message whose reply can be tried again: the last one, when the reply after it is the last message and has its id. */
export function retryableIndex(messages: ChatMessage[]): number {
  const last = messages.length - 1;
  if (last < 1) return -1;
  const reply = messages[last];
  if (!isAnswer(reply) || !reply.messageId) return -1;
  const asked = last - 1;
  return canBranchAt(messages, asked) ? asked : -1;
}

/** Everything before the customer message at `index`: what the conversation holds once that message is replaced. */
export function branchBase<T extends ChatMessage>(messages: T[], index: number): T[] {
  return messages.slice(0, Math.max(0, index));
}

/**
 * Cards are placed in the thread by how many messages existed when they appeared (see ChatPanel's timeline: a card stamped `n` sits
 * after the n-th message, the greeting counting as the first). Replacing the message at `index` takes away the cards of that turn and
 * of everything after it.
 */
export function cardCountToKeep(index: number, greetingMessages = 1): number {
  return greetingMessages + Math.max(0, index);
}

export function keepCardsUpTo<T extends { createdAt?: unknown }>(cards: T[], count: number): T[] {
  return cards.filter((card) => {
    const stamped = Number(card.createdAt);
    return !Number.isFinite(stamped) || stamped <= count;
  });
}
