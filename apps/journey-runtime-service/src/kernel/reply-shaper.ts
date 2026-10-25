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
      return LIST_LINE.test(limited[idx - 1]) ? `${acc}\n\n${curr}` : `${acc} ${curr}`;
    }, '').replace(/\s+([,.;:!?])/g, '$1').trim();
  } else {
    formatted = limited.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  }

  return { text: formatted, removed };
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
  private withheldClasses = new Set<ClaimClass>();
  private streamedText = '';
  private compiledShape: CompiledShapeContext;
  private questionsSeen = 0;
  private readonly voiceRules: Array<{ pattern: RegExp; replacement: string }>;
  private knownNames: string[] | undefined;
  private productNames: string[] | undefined;

  constructor(
    shapeContext: ShapeContext,
    private allowedClaims: ClaimClass[] | Set<ClaimClass>,
    private readonly isOkfRelease: boolean,
    private readonly onApprovedSentence: (sentence: string, delta: string) => void,
    private readonly packOrOptions?: any
  ) {
    this.compiledShape = compileShapeContext(shapeContext);
    this.voiceRules = compileVoiceRules(packOrOptions?.extensions?.voice?.rewrites);
  }

  updateAllowedClaims(claims: ClaimClass[] | Set<ClaimClass>): void {
    this.allowedClaims = claims;
  }

  /** The product and group names the tools have returned so far, which the claim guard reads past (see `ClaimContext`). */
  updateKnownNames(known: { names: string[]; productNames: string[] }): void {
    this.knownNames = known.names;
    this.productNames = known.productNames;
  }

  getWithheldCount(): number {
    return this.withheldSentences.length;
  }

  getWithheldSentences(): string[] {
    return [...this.withheldSentences];
  }

  /** The claim classes the removed sentences asserted, so the caller can tell a removed product line from a removed safety line. */
  getWithheldClasses(): ClaimClass[] {
    return [...this.withheldClasses];
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
    sentence = applyVoiceRules(sentence, this.voiceRules);

    if (this.isOkfRelease) {
      const allowed = this.allowedClaims instanceof Set ? Array.from(this.allowedClaims) : this.allowedClaims;
      const claimResult = validateOkfGeneratedClaims(sentence, allowed, this.packOrOptions, { knownNames: this.knownNames, productNames: this.productNames });
      if (!claimResult.valid) {
        this.withheldSentences.push(sentence);
        for (const claim of claimResult.forbidden) this.withheldClasses.add(claim);
        console.warn(`[ClaimGuard] withheld sentence during stream: "${sentence}" asserting ${claimResult.forbidden.join(', ')}`);
        return;
      }
    }

    const shaped = shapeSentence(sentence, this.compiledShape, this.emittedSentences.length, this.questionsSeen);
    if (!shaped.keep) {
      console.warn(`[ReplyShaper] removed sentence during stream: "${sentence}" (${shaped.reason})`);
      return;
    }

    if (shaped.isQuestion) {
      this.questionsSeen++;
    }

    const previous = this.emittedSentences[this.emittedSentences.length - 1];
    this.emittedSentences.push(sentence);
    // A list line stands on its own line; prose that follows a list starts a new paragraph instead of running on from the last item.
    const separator = LIST_LINE.test(sentence)
      ? '\n'
      : (this.streamedText ? (previous !== undefined && LIST_LINE.test(previous) ? '\n\n' : ' ') : '');
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

/** The shop's own phrase swaps (pack `extensions.voice.rewrites`), compiled once; a rule that does not compile is left out. */
export function compileVoiceRules(rules: unknown): Array<{ pattern: RegExp; replacement: string }> {
  if (!Array.isArray(rules)) return [];
  const out: Array<{ pattern: RegExp; replacement: string }> = [];
  for (const rule of rules.slice(0, 40)) {
    if (!rule || typeof rule.pattern !== 'string' || typeof rule.replacement !== 'string') continue;
    try { out.push({ pattern: new RegExp(rule.pattern, `${rule.flags === 'i' ? 'i' : ''}g`), replacement: rule.replacement }); } catch { /* not a pattern */ }
  }
  return out;
}

/** Swaps only the words a rule matches; a sentence that began with a capital still does. */
export function applyVoiceRules(sentence: string, rules: Array<{ pattern: RegExp; replacement: string }>): string {
  if (rules.length === 0) return sentence;
  let text = sentence;
  for (const rule of rules) text = text.replace(rule.pattern, rule.replacement);
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text && /^[A-Z]/.test(sentence) && /^[a-z]/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
  return text || sentence;
}
