import type { ReplyStyle } from '../turn/fact-semantics';

export interface ShapeContext {
  style: ReplyStyle;
  /** Names of the company the customer is already shopping with. */
  companyNames: string[];
  /** Internal identifiers the system uses (concept and category ids); they never belong in a customer's reply. */
  internalIds: string[];
  /** A question card is on screen, so the reply must not ask anything of its own. */
  questionCardShown: boolean;
}

export interface ShapedReply { text: string; removed: Array<{ reason: string; sentence: string }> }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_LINE = /^\s*(?:[-*•–]|\d+[.)])\s+/;

/**
 * Shapes the words the model wrote for a customer. The model is asked to follow the style rules, but a model cannot be trusted to,
 * so what comes back is enforced: internal ids, list lines, a second question, "go and browse" directions, the company's own
 * name and anything past the sentence limit are removed. Sentences are removed whole, never rewritten, so nothing is added that
 * the model did not say. An empty result means nothing usable was left and the caller uses the tenant's own wording.
 */
export function shapeReply(text: string, context: ShapeContext): ShapedReply {
  const removed: ShapedReply['removed'] = [];
  const { style } = context;
  // A concept path can end in an ordinary product word such as "paint" or "vanities".
  // Only identifier-shaped fragments are internal; removing a sentence for a plain
  // category noun would erase the customer's actual answer.
  const ids = context.internalIds.map((id) => id.trim().toLowerCase())
    .filter((id) => id.length >= 6 && /[-_/:]/.test(id))
    .map((id) => new RegExp(`(?<![a-z0-9_-])${escape(id)}(?![a-z0-9_-])`, 'i'));
  const names = context.companyNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const phrases = style.forbiddenPhrases.map((phrase) => new RegExp(`(?<![A-Za-z])${escape(phrase.trim())}(?![A-Za-z])`, 'i'));

  const kept: string[] = [];
  for (const line of text.split(/\n+/)) {
    if (style.dropListLines && LIST_LINE.test(line)) { removed.push({ reason: 'list', sentence: line.trim() }); continue; }
    for (const raw of line.split(/(?<=[.!?:])\s+/)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const lower = sentence.toLowerCase();
      const reason =
        sentence.includes('`') || lower.includes('concept://') || ids.some((id) => id.test(sentence)) ? 'internal id'
        : context.questionCardShown && sentence.endsWith('?') ? 'second question'
        : phrases.some((pattern) => pattern.test(sentence)) ? 'sends the customer elsewhere'
        : style.dropCompanyName && names.some((name) => lower.includes(name)) ? 'company name'
        : undefined;
      if (reason) removed.push({ reason, sentence }); else kept.push(sentence);
    }
  }
  const limited = kept.slice(0, style.maxSentences);
  for (const sentence of kept.slice(style.maxSentences)) removed.push({ reason: 'too long', sentence });
  return { text: limited.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim(), removed };
}
