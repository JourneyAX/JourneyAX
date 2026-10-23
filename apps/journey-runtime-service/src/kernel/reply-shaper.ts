import type { ReplyStyle, TurnKind } from '../turn/fact-semantics';
import type { ClaimClass } from '@journeyax/knowledge';
import { validateOkfGeneratedClaims } from './okf-claim-validator';

export interface ShapeContext {
  style: ReplyStyle;
  /** Names of the company the customer is already shopping with. */
  companyNames: string[];
  /** Internal identifiers the system uses (concept and category ids); they never belong in a customer's reply. */
  internalIds: string[];
  /** A question card is on screen, so the reply must not ask anything of its own. */
  questionCardShown: boolean;
  /** The kind of turn being handled (fact, card, answer, recommend, howto). */
  turnKind?: TurnKind;
}

export interface ShapedReply { text: string; removed: Array<{ reason: string; sentence: string }> }

export interface CompiledShapeContext {
  style: ReplyStyle;
  companyNames: string[];
  compiledIds: RegExp[];
  compiledPhrases: RegExp[];
  questionCardShown: boolean;
  turnKind?: TurnKind;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_LINE = /^\s*(?:[-*•–]|\d+[.)])\s+/;

/**
 * Resolves effective reply style by overlaying turn-specific rules when available.
 */
export function resolveEffectiveReplyStyle(baseStyle: ReplyStyle, turnKind?: TurnKind): ReplyStyle {
  if (!turnKind || !baseStyle.turnStyles?.[turnKind]) {
    return baseStyle;
  }
  const turnStyle = baseStyle.turnStyles[turnKind]!;
  return {
    ...baseStyle,
    maxSentences: turnStyle.maxSentences ?? baseStyle.maxSentences,
    dropListLines: turnStyle.dropListLines ?? baseStyle.dropListLines,
    allowFollowUpQuestion: turnStyle.allowFollowUpQuestion ?? baseStyle.allowFollowUpQuestion ?? false,
    maxQuestions: turnStyle.maxQuestions ?? baseStyle.maxQuestions ?? (turnStyle.allowFollowUpQuestion ? 1 : 0),
    forbiddenPhrases: turnStyle.forbiddenPhrases ?? baseStyle.forbiddenPhrases,
    rules: turnStyle.rules ?? baseStyle.rules,
  };
}

/**
 * Pre-compiles regexes and normalized sets for sentence-by-sentence reply shaping.
 */
export function compileShapeContext(context: ShapeContext): CompiledShapeContext {
  const effectiveStyle = resolveEffectiveReplyStyle(context.style, context.turnKind);
  const ids = context.internalIds
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length >= 6 && /[-_/:]/.test(id))
    .map((id) => new RegExp(`(?<![a-z0-9_-])${escape(id)}(?![a-z0-9_-])`, 'i'));
  const names = context.companyNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const phrases = effectiveStyle.forbiddenPhrases.map(
    (phrase) => new RegExp(`(?<![A-Za-z])${escape(phrase.trim())}(?![A-Za-z])`, 'i')
  );

  return {
    style: effectiveStyle,
    companyNames: names,
    compiledIds: ids,
    compiledPhrases: phrases,
    questionCardShown: context.questionCardShown,
    turnKind: context.turnKind,
  };
}

/**
 * Evaluates an individual sentence or line against the compiled reply shaping rules.
 */
export function shapeSentence(
  sentence: string,
  context: CompiledShapeContext | ShapeContext,
  currentCount: number = 0,
  questionsSeen: number = 0
): { keep: boolean; reason?: string; sentence: string; isQuestion?: boolean } {
  const ctx = 'compiledIds' in context ? context : compileShapeContext(context);
  const { style } = ctx;
  const trimmed = sentence.trim();
  if (!trimmed) return { keep: false, sentence: trimmed };

  if (style.dropListLines && LIST_LINE.test(trimmed)) {
    return { keep: false, reason: 'list', sentence: trimmed };
  }
  if (currentCount >= style.maxSentences) {
    return { keep: false, reason: 'too long', sentence: trimmed };
  }

  const isQuestion = trimmed.endsWith('?');
  const maxQ = ctx.style.maxQuestions ?? (ctx.style.allowFollowUpQuestion ? 1 : 1);
  const questionDisallowed = ctx.questionCardShown
    ? isQuestion
    : isQuestion && (maxQ === 0 || questionsSeen >= maxQ);

  const lower = trimmed.toLowerCase();
  const isToolNarration =
    /^(?:i (?:will|shall) (?:now )?(?:search|consult|call|query|retrieve)|i (?:will|shall) now check|let me (?:search|consult|query|look up|retrieve|call)|searching the (?:catalogue|catalog|database|knowledge)|consulting (?:business )?knowledge|calling the \w+ tool)\b/i.test(trimmed);

  const reason =
    isToolNarration
      ? 'tool narration'
      : trimmed.includes('`') || lower.includes('concept://') || ctx.compiledIds.some((id) => id.test(trimmed))
      ? 'internal id'
      : questionDisallowed
      ? 'second question'
      : ctx.compiledPhrases.some((pattern) => pattern.test(trimmed))
      ? 'sends the customer elsewhere'
      : style.dropCompanyName && ctx.companyNames.some((name) => lower.includes(name))
      ? 'company name'
      : undefined;

  if (reason) {
    return { keep: false, reason, sentence: trimmed, isQuestion };
  }
  return { keep: true, sentence: trimmed, isQuestion };
}

/**
 * Shapes the words the model wrote for a customer. The model is asked to follow the style rules, but a model cannot be trusted to,
 * so what comes back is enforced: internal ids, list lines, a second question, "go and browse" directions, the company's own
 * name and anything past the sentence limit are removed. Sentences are removed whole, never rewritten, so nothing is added that
 * the model did not say. An empty result means nothing usable was left and the caller uses the tenant's own wording.
 */
export function shapeReply(text: string, context: ShapeContext): ShapedReply {
  const removed: ShapedReply['removed'] = [];
  const compiled = compileShapeContext(context);
  const { style } = compiled;

  const kept: string[] = [];
  let questionsSeen = 0;

  for (const line of text.split(/\n+/)) {
    if (style.dropListLines && LIST_LINE.test(line)) {
      removed.push({ reason: 'list', sentence: line.trim() });
      continue;
    }
    const sentences = LIST_LINE.test(line)
      ? [line.trim()]
      : line.split(/(?<!\b\d+[.!?:])(?<=[.!?:])\s+/);

    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const result = shapeSentence(sentence, compiled, kept.length, questionsSeen);
      if (result.keep) {
        kept.push(sentence);
        if (result.isQuestion) {
          questionsSeen++;
        }
      } else if (result.reason) {
        removed.push({ reason: result.reason, sentence });
      }
    }
  }
  const limited = kept.slice(0, style.maxSentences);
  for (const sentence of kept.slice(style.maxSentences)) {
    removed.push({ reason: 'too long', sentence });
  }

  const hasList = limited.some((s) => LIST_LINE.test(s));
  let formatted: string;
  if (hasList) {
    formatted = limited.reduce((acc, curr, idx) => {
      if (idx === 0) return curr;
      if (LIST_LINE.test(curr)) return `${acc}\n${curr}`;
      return `${acc} ${curr}`;
    }, '').replace(/\s+([,.;:!?])/g, '$1').trim();
  } else {
    formatted = limited.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  }

  return { text: formatted, removed };
}

/**
 * Detects vacuous filler phrases (such as "Would you like assistance with something else")
 * that must not replace a withheld answer.
 */
export function isFillerQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  return (
    /^(?:would you like|can i help you with|is there|do you need) (?:assistance with|help with|anything else|something else|guidance on a related topic|an alternative|further assistance)[^a-zA-Z0-9]*$/i.test(trimmed) ||
    /^(?:would you like assistance with (?:something|anything) else(?:\s+or\s+perhaps\s+guidance\s+on\s+a\s+related\s+topic)?\??)$/i.test(trimmed) ||
    /^(?:would you like assistance with anything else\??)$/i.test(trimmed) ||
    /^(?:would you like assistance with something else\??)$/i.test(trimmed)
  );
}

/**
 * Incremental sentence-by-sentence streaming processor.
 * Buffers chunks from executeStream, detects completed sentences, validates them against
 * OKF claim safety and reply shaping rules, and emits approved sentences.
 */
export class IncrementalSentenceShaper {
  private buffer = '';
  private emittedSentences: string[] = [];
  private withheldSentences: string[] = [];
  private streamedText = '';
  private compiledShape: CompiledShapeContext;
  private questionsSeen = 0;

  constructor(
    shapeContext: ShapeContext,
    private allowedClaims: ClaimClass[] | Set<ClaimClass>,
    private readonly isOkfRelease: boolean,
    private readonly onApprovedSentence: (sentence: string, delta: string) => void,
    private readonly packOrOptions?: any
  ) {
    this.compiledShape = compileShapeContext(shapeContext);
  }

  updateAllowedClaims(claims: ClaimClass[] | Set<ClaimClass>): void {
    this.allowedClaims = claims;
  }

  getWithheldCount(): number {
    return this.withheldSentences.length;
  }

  getWithheldSentences(): string[] {
    return [...this.withheldSentences];
  }

  processDelta(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split(/(?<!\b\d+[.!?])(?<=[.!?])\s+|\n+/);
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) {
        this.processSentence(parts[i]);
      }
      this.buffer = parts[parts.length - 1];
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.processSentence(this.buffer);
      this.buffer = '';
    }
  }

  private processSentence(rawSentence: string): void {
    let sentence = rawSentence.trim();
    if (sentence.startsWith('"') && (sentence.endsWith('"') || this.buffer === '')) {
      sentence = sentence.replace(/^"+|"+$/g, '').trim();
    }
    if (!sentence) return;

    if (this.isOkfRelease) {
      const allowed = this.allowedClaims instanceof Set ? Array.from(this.allowedClaims) : this.allowedClaims;
      const claimResult = validateOkfGeneratedClaims(sentence, allowed, this.packOrOptions);
      if (!claimResult.valid) {
        this.withheldSentences.push(sentence);
        console.warn(`[ClaimGuard] withheld sentence during stream: "${sentence}" asserting ${claimResult.forbidden.join(', ')}`);
        return;
      }
    }

    // A withheld answer must never be replaced by a filler such as "Would you like assistance with something else" (#99)
    if (this.withheldSentences.length > 0 && isFillerQuestion(sentence)) {
      console.warn(`[ClaimGuard] dropped filler sentence following withheld sentence: "${sentence}"`);
      return;
    }

    const shaped = shapeSentence(sentence, this.compiledShape, this.emittedSentences.length, this.questionsSeen);
    if (!shaped.keep) {
      console.warn(`[ReplyShaper] removed sentence during stream: "${sentence}" (${shaped.reason})`);
      return;
    }

    if (shaped.isQuestion) {
      this.questionsSeen++;
    }

    this.emittedSentences.push(sentence);
    const separator = LIST_LINE.test(sentence) ? '\n' : (this.streamedText ? ' ' : '');
    const delta = separator + sentence;
    this.streamedText += delta;
    this.onApprovedSentence(sentence, delta);
  }

  getStreamedText(): string {
    return this.streamedText;
  }

  getEmittedSentences(): string[] {
    return this.emittedSentences;
  }
}



