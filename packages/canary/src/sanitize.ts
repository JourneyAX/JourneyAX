import defaults from './defaults/canary-invariants.json';

export interface SanitizeRule { id: string; pattern: string; replace: string }

/**
 * A report must be safe to hand to anyone: contact details, tokens, cookies and long identifiers are replaced, text is bounded,
 * and session identifiers become stable placeholders so a transcript still reads as one conversation.
 */
export function sanitizeText(text: string, rules: SanitizeRule[] = defaults.sanitize, maxChars: number = defaults.maxTextChars): string {
  let out = text;
  for (const rule of rules) out = out.replace(new RegExp(rule.pattern, 'gi'), rule.replace);
  return out.length > maxChars ? `${out.slice(0, maxChars)}… [truncated ${out.length - maxChars} characters]` : out;
}

export function makeAliaser(prefix: string): (value: string) => string {
  const seen = new Map<string, string>();
  return (value) => {
    if (!seen.has(value)) seen.set(value, `${prefix}-${seen.size + 1}`);
    return seen.get(value)!;
  };
}

/** Deep copy with every string sanitised and identifier fields aliased. */
export function sanitizeValue(value: unknown, aliasSession: (id: string) => string, rules?: SanitizeRule[], maxChars?: number): unknown {
  if (typeof value === 'string') return sanitizeText(value, rules, maxChars);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, aliasSession, rules, maxChars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      [key, ['sessionId', 'workspaceId'].includes(key) && typeof entry === 'string' ? aliasSession(entry) : sanitizeValue(entry, aliasSession, rules, maxChars)]));
  }
  return value;
}
