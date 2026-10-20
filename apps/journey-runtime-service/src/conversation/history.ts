/**
 * Conversation History Management (Task B1)
 *
 * Stores the last N user and assistant turns in the workspace state.
 * Capped by turn count and character count from conversation policy.
 * Delimited as safe data blocks in model prompts. Never stores credentials.
 */

export const HISTORY_KEY = 'conversation_history';

export interface ConversationTurnRecord {
  role: 'customer' | 'assistant';
  content: string;
  turnId?: string;
  timestamp?: string;
}

/**
 * Strips secrets, auth tokens, passwords, and sensitive keys from conversational text.
 */
export function sanitizeHistoryText(text: string): string {
  if (!text) return '';
  return text
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
 * Appends new turns to workspace conversation history and trims to limits.
 */
export function appendHistory(
  workspace: { facts: Record<string, any> },
  newTurns: ConversationTurnRecord[],
  policy?: { maxTurns?: number; maxChars?: number }
): void {
  const maxTurns = policy?.maxTurns ?? 6;
  const maxChars = policy?.maxChars ?? 4000;

  const validNew = newTurns
    .filter((t) => t && t.content && t.content.trim().length > 0)
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

  // Limit to maxChars total content
  let totalChars = history.reduce((sum, t) => sum + t.content.length, 0);
  while (history.length > 1 && totalChars > maxChars) {
    const dropped = history.shift()!;
    totalChars -= dropped.content.length;
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
  const lines = history.map((t) => `${t.role === 'customer' ? 'Customer' : 'Assistant'}: ${t.content}`);
  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>`;
}
