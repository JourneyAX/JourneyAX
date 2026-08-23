/**
 * Keeping a conversation inside a budget.
 *
 * Every turn resends the entire history, because there is no server-side
 * session. That makes cost grow with the square of conversation length — turn
 * 40 pays to re-read turns 1 through 39 — and eventually the request simply
 * exceeds the model's context window and the journey dies mid-quote, at the
 * point the customer has invested the most.
 *
 * `validateMessages` already caps the *count* at 100, but 100 messages of
 * 4,000 characters is 400KB of prompt. A count is the wrong unit; this trims
 * on size.
 *
 * What survives, in priority order:
 *
 *   1. Every system message. They carry the rules and the current state.
 *   2. The first user message — the original brief. Dropping it is how an
 *      assistant forgets it is designing a bathroom by turn 30.
 *   3. As many of the most recent messages as fit.
 *
 * Anything dropped from the middle is replaced by one note, so the model
 * knows the history is abridged rather than believing it has the whole thing.
 */

export interface TrimmableMessage {
  role: string;
  /**
   * Deliberately `unknown`: the OpenAI types allow content to be a string, an
   * array of content parts, or null depending on the message variant, and
   * narrowing it here would reject half of them at the call site.
   */
  content?: unknown;
  /** Present on assistant turns that call tools. */
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/**
 * Roughly four characters per token for English. Deliberately crude: an exact
 * tokeniser is a dependency and a per-model detail, and being approximately
 * right here is enough to stop the failure this prevents.
 */
export const CHARS_PER_TOKEN = 4;

/** Default budget for the replayed history, in characters. */
export const DEFAULT_BUDGET_CHARS = 48_000;

function sizeOf(message: TrimmableMessage): number {
  // Content may be a string, an array of parts, or absent. Measure whatever
  // it actually is rather than assuming a string and undercounting arrays.
  let content = 0;
  if (typeof message.content === 'string') {
    content = message.content.length;
  } else if (message.content != null) {
    try {
      content = JSON.stringify(message.content).length;
    } catch {
      content = 0;
    }
  }

  // Tool calls carry JSON arguments that cost real tokens too.
  const tools = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  // A little overhead per message for role and framing.
  return content + tools + 16;
}

export interface TrimResult<T> {
  messages: T[];
  /** How many were dropped from the middle. */
  dropped: number;
  /** Approximate token count of what remains. */
  approxTokens: number;
}

/**
 * Trim a conversation to fit a character budget.
 *
 * Preserves ordering. Never drops system messages — if the system messages
 * alone exceed the budget, they are all kept anyway and the caller has a
 * prompt-size problem this function cannot solve for them.
 */
export function trimConversation<T extends TrimmableMessage>(
  messages: T[],
  budgetChars: number = DEFAULT_BUDGET_CHARS,
): TrimResult<T> {
  const total = messages.reduce((n, m) => n + sizeOf(m), 0);
  if (total <= budgetChars) {
    return { messages, dropped: 0, approxTokens: Math.ceil(total / CHARS_PER_TOKEN) };
  }

  const keep = new Set<number>();
  let used = 0;

  // 1. System messages are non-negotiable.
  messages.forEach((m, i) => {
    if (m.role === 'system') { keep.add(i); used += sizeOf(m); }
  });

  // 2. The opening brief.
  const firstUser = messages.findIndex(m => m.role === 'user');
  if (firstUser !== -1 && !keep.has(firstUser)) {
    keep.add(firstUser);
    used += sizeOf(messages[firstUser]);
  }

  // 3. Recent turns, newest first, until the budget is spent.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const size = sizeOf(messages[i]);
    if (used + size > budgetChars) break;
    keep.add(i);
    used += size;
  }

  const kept = messages.filter((_, i) => keep.has(i));
  const dropped = messages.length - kept.length;

  // Tell the model its history is abridged. Without this it treats the gap as
  // "nothing happened" and re-asks questions the customer already answered.
  if (dropped > 0) {
    const marker = {
      role: 'system',
      content:
        `[${dropped} earlier message(s) omitted to stay within context. ` +
        `Do not re-ask for details the customer has already given; if you are ` +
        `unsure whether something was covered, ask once rather than assuming.]`,
    } as unknown as T;

    // Insert after the leading system messages, before the first kept turn.
    const firstNonSystem = kept.findIndex(m => m.role !== 'system');
    if (firstNonSystem === -1) kept.push(marker);
    else kept.splice(firstNonSystem, 0, marker);

    used += sizeOf(marker);
  }

  return { messages: kept, dropped, approxTokens: Math.ceil(used / CHARS_PER_TOKEN) };
}
