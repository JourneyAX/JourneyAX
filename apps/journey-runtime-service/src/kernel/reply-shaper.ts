import type { ReplyStyle } from '../turn/fact-semantics';
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
}

export interface ShapedReply { text: string; removed: Array<{ reason: string; sentence: string }> }

export interface CompiledShapeContext {
  style: ReplyStyle;
  companyNames: string[];
  compiledIds: RegExp[];
  compiledPhrases: RegExp[];
  questionCardShown: boolean;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_LINE = /^\s*(?:[-*•–]|\d+[.)])\s+/;

/**
 * Pre-compiles regexes and normalized sets for sentence-by-sentence reply shaping.
 */
export function compileShapeContext(context: ShapeContext): CompiledShapeContext {
  const ids = context.internalIds
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length >= 6 && /[-_/:]/.test(id))
    .map((id) => new RegExp(`(?<![a-z0-9_-])${escape(id)}(?![a-z0-9_-])`, 'i'));
  const names = context.companyNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const phrases = context.style.forbiddenPhrases.map(
    (phrase) => new RegExp(`(?<![A-Za-z])${escape(phrase.trim())}(?![A-Za-z])`, 'i')
  );

  return {
    style: context.style,
    companyNames: names,
    compiledIds: ids,
    compiledPhrases: phrases,
    questionCardShown: context.questionCardShown,
  };
}

/**
 * Evaluates an individual sentence or line against the compiled reply shaping rules.
 */
export function shapeSentence(
  sentence: string,
  context: CompiledShapeContext | ShapeContext,
  currentCount: number = 0
): { keep: boolean; reason?: string; sentence: string } {
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
  const lower = trimmed.toLowerCase();
  const reason =
    trimmed.includes('`') || lower.includes('concept://') || ctx.compiledIds.some((id) => id.test(trimmed))
      ? 'internal id'
      : ctx.questionCardShown && trimmed.endsWith('?')
      ? 'second question'
      : ctx.compiledPhrases.some((pattern) => pattern.test(trimmed))
      ? 'sends the customer elsewhere'
      : style.dropCompanyName && ctx.companyNames.some((name) => lower.includes(name))
      ? 'company name'
      : undefined;

  if (reason) {
    return { keep: false, reason, sentence: trimmed };
  }
  return { keep: true, sentence: trimmed };
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
  const { style } = context;

  const kept: string[] = [];
  for (const line of text.split(/\n+/)) {
    if (style.dropListLines && LIST_LINE.test(line)) {
      removed.push({ reason: 'list', sentence: line.trim() });
      continue;
    }
    for (const raw of line.split(/(?<=[.!?:])\s+/)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const result = shapeSentence(sentence, compiled, kept.length);
      if (result.keep) {
        kept.push(sentence);
      } else if (result.reason) {
        removed.push({ reason: result.reason, sentence });
      }
    }
  }
  const limited = kept.slice(0, style.maxSentences);
  for (const sentence of kept.slice(style.maxSentences)) {
    removed.push({ reason: 'too long', sentence });
  }
  return { text: limited.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim(), removed };
}

/**
 * Incremental sentence-by-sentence streaming processor.
 * Buffers chunks from executeStream, detects completed sentences, validates them against
 * OKF claim safety and reply shaping rules, and emits approved sentences.
 */
export class IncrementalSentenceShaper {
  private buffer = '';
  private emittedSentences: string[] = [];
  private streamedText = '';
  private compiledShape: CompiledShapeContext;

  constructor(
    shapeContext: ShapeContext,
    private readonly allowedClaims: ClaimClass[],
    private readonly isOkfRelease: boolean,
    private readonly onApprovedSentence: (sentence: string, delta: string) => void
  ) {
    this.compiledShape = compileShapeContext(shapeContext);
  }

  processDelta(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split(/(?<=[.!?])\s+|\n+/);
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
      const claimResult = validateOkfGeneratedClaims(sentence, this.allowedClaims);
      if (!claimResult.valid) {
        console.warn(`[ClaimGuard] withheld sentence during stream: "${sentence}" asserting ${claimResult.forbidden.join(', ')}`);
        return;
      }
    }

    const shaped = shapeSentence(sentence, this.compiledShape, this.emittedSentences.length);
    if (!shaped.keep) {
      console.warn(`[ReplyShaper] removed sentence during stream: "${sentence}" (${shaped.reason})`);
      return;
    }

    this.emittedSentences.push(sentence);
    const delta = (this.streamedText ? ' ' : '') + sentence;
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


