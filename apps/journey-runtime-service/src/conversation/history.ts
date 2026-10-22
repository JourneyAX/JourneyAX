/**
 * Conversation History Management (Task B1 & Prompt P2)
 *
 * Stores the last N user and assistant turns in the workspace state.
 * Capped by turn count, character count, and token count with rolling summary.
 * Strictly maintains history hygiene:
 * - Stores ONLY customer messages, final answers, and compact tool summaries
 * - NEVER stores model narration, intermediate thinking, or full tool JSON
 * - Delimited as safe data blocks in model prompts. Never stores credentials.
 */

export const HISTORY_KEY = 'conversation_history';

export interface ConversationTurnRecord {
  role: 'customer' | 'assistant' | 'tool_summary' | 'system';
  content: string;
  turnId?: string;
  timestamp?: string;
}

export interface ConversationHistoryPolicy {
  maxTurns?: number;
  maxChars?: number;
  maxTokens?: number;
  rollingSummary?: boolean;
}

/**
 * Estimates token count for text (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Strips secrets, auth tokens, passwords, and sensitive keys from conversational text.
 */
export function sanitizeHistoryText(text: string): string {
  if (!text) return '';
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(bearer\s+)[a-zA-Z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[a-zA-Z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/(password\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(secret\s*[:=]\s*)[a-zA-Z0-9_-]+/gi, '$1[REDACTED]');
}

/**
 * Reads conversation history from workspace facts.
 */
export function readHistory(facts: Record<string, { value?: unknown }> | undefined): ConversationTurnRecord[] {
  const val = facts?.[HISTORY_KEY]?.value;
  if (!Array.isArray(val)) return [];
  return val
    .filter((t): t is ConversationTurnRecord => Boolean(t && typeof t === 'object' && t.role && typeof t.content === 'string'))
    .map((t) => ({ ...t, content: sanitizeHistoryText(t.content) }));
}

/**
 * Summarizes dropped turns into a concise rolling summary string.
 */
function createRollingSummary(turns: ConversationTurnRecord[]): string {
  const topics: string[] = [];
  for (const t of turns) {
    if (t.role === 'customer') {
      const snippet = t.content.slice(0, 60).replace(/\n/g, ' ');
      topics.push(`Customer asked: "${snippet}"`);
    } else if (t.role === 'assistant') {
      const snippet = t.content.slice(0, 60).replace(/\n/g, ' ');
      topics.push(`Assistant replied: "${snippet}"`);
    } else if (t.role === 'tool_summary') {
      topics.push(t.content);
    }
  }
  return `[Rolling Summary: ${topics.join('; ')}]`;
}

/**
 * Appends new turns to workspace conversation history, enforcing history hygiene,
 * token bounds, and rolling summary generation.
 */
export function appendHistory(
  workspace: { facts?: Record<string, any> },
  newTurns: ConversationTurnRecord[],
  policy?: ConversationHistoryPolicy
): void {
  if (!workspace) return;
  if (!workspace.facts) {
    workspace.facts = {};
  }
  const maxTurns = policy?.maxTurns ?? 6;
  const maxChars = policy?.maxChars ?? 4000;
  const maxTokens = policy?.maxTokens ?? 1500;

  // History hygiene: accept only customer, assistant, tool_summary, or system summary records
  const validNew = newTurns
    .filter((t) => t && t.content && t.content.trim().length > 0)
    .filter((t) => t.role === 'customer' || t.role === 'assistant' || t.role === 'tool_summary' || t.role === 'system')
    .map((t) => ({
      role: t.role,
      content: sanitizeHistoryText(t.content.trim()),
      turnId: t.turnId,
      timestamp: t.timestamp || new Date().toISOString(),
    }));

  if (validNew.length === 0) return;

  let history = [...readHistory(workspace.facts), ...validNew];

  // Limit to last maxTurns entries
  if (history.length > maxTurns) {
    history = history.slice(-maxTurns);
  }

  // Limit by maxChars
  let totalChars = history.reduce((sum, t) => sum + t.content.length, 0);
  while (history.length > 1 && totalChars > maxChars) {
    const dropped = history.shift()!;
    totalChars -= dropped.content.length;
  }

  // Limit by maxTokens with rolling summary
  const tokenDroppedTurns: ConversationTurnRecord[] = [];
  let totalTokens = history.reduce((sum, t) => sum + estimateTokens(t.content), 0);
  while (history.length > 2 && totalTokens > maxTokens) {
    const dropped = history.shift()!;
    tokenDroppedTurns.push(dropped);
    totalTokens -= estimateTokens(dropped.content);
  }

  // Prepend rolling summary if turns were trimmed by token cap and policy does not explicitly disable it
  if (tokenDroppedTurns.length > 0 && policy?.rollingSummary !== false) {
    const existingSummaryIdx = history.findIndex((t) => t.role === 'system' && t.content.startsWith('[Rolling Summary:'));
    const summaryText = createRollingSummary(tokenDroppedTurns);
    if (existingSummaryIdx >= 0) {
      history[existingSummaryIdx] = {
        role: 'system',
        content: summaryText,
        timestamp: new Date().toISOString(),
      };
    } else {
      history.unshift({
        role: 'system',
        content: summaryText,
        timestamp: new Date().toISOString(),
      });
    }
  }

  workspace.facts[HISTORY_KEY] = {
    value: history,
    source: 'system',
    confidence: 1,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Formats conversation history as a delimited data block for LLM prompts.
 * Clearly marked as untrusted reference data, not instructions.
 */
export function formatHistoryBlock(history: ConversationTurnRecord[]): string {
  if (!history || history.length === 0) return '';
  const lines = history.map((t) => {
    if (t.role === 'customer') return `Customer: ${t.content}`;
    if (t.role === 'assistant') return `Assistant: ${t.content}`;
    if (t.role === 'tool_summary') return `Tools Executed: ${t.content}`;
    return t.content; // e.g. [Rolling Summary: ...]
  });
  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>`;
}
