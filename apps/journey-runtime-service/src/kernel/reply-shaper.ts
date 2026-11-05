import type { ReplyStyle, TurnKind } from '../turn/fact-semantics';
import type { ClaimClass } from '@journeyax/knowledge';
import { validateOkfGeneratedClaims, type CatalogueWarrantyFact } from './okf-claim-validator';
import { repairSourceLinks } from './source-links';
import { ProductMeasurementEvidence } from './product-measurement-evidence';

export interface ShapeContext {
  style: ReplyStyle;
  /** Names of the company the customer is already shopping with. */
  companyNames: string[];
  /** Internal identifiers the system uses (concept and category ids); they never belong in a customer's reply. */
  internalIds: string[];
  /** Authorised staff can discuss source record references formatted as inline code. Internal platform IDs remain hidden. */
  allowCodeFormatting?: boolean;
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
  allowCodeFormatting?: boolean;
  questionCardShown: boolean;
  turnKind?: TurnKind;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_LINE = /^\s*(?:[-*•–]|\d+[.)])\s+/;
const HEADING_LINE = /^#{1,6}\s+\S/;
const TABLE_LINE = /^\|.*\|$/;

/** The part a line plays in a reply. A heading, a list item or a table row keeps its own place while its words are checked. */
export type LineKind = 'heading' | 'list' | 'listcont' | 'table' | 'text';

/** `indent` is the whitespace before the line; `previous` is the kind of the line above it (an indented line under a list item belongs to that item). */
export function lineKindOf(line: string, indent: string, previous: LineKind | undefined): LineKind {
  const text = line.trim();
  if (HEADING_LINE.test(text)) return 'heading';
  if (LIST_LINE.test(text)) return 'list';
  if (TABLE_LINE.test(text)) return 'table';
  if (indent.replace(/\t/g, '    ').length >= 2 && (previous === 'list' || previous === 'listcont')) return 'listcont';
  return 'text';
}

/**
 * What goes in front of a kept sentence so the reply keeps the shape the model gave it: sentences of one line run on, a new line of
 * prose is its own paragraph, list items stack, a line indented under an item stays inside it, table rows stay together.
 */
export function leadFor(kind: LineKind, previous: LineKind | undefined, startsLine: boolean, indent = ''): string {
  if (previous === undefined) return '';
  if (!startsLine) return ' ';
  // A list item keeps how far it was indented, so an item under an item stays under it.
  if (kind === 'list') return `\n${indent.replace(/\t/g, '    ').slice(0, 12)}`;
  if (kind === 'listcont') return '\n   ';
  if (kind === 'table') return previous === 'table' ? '\n' : '\n\n';
  return '\n\n';
}

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
    allowCodeFormatting: context.allowCodeFormatting,
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
  questionsSeen: number = 0,
  /** Which part of the reply the sentence belongs to, and how many list or table lines are already kept (when the style counts those apart). */
  kind?: LineKind,
  structureCount: number = 0
): { keep: boolean; reason?: string; sentence: string; isQuestion?: boolean } {
  const ctx = 'compiledIds' in context ? context : compileShapeContext(context);
  const { style } = ctx;
  const trimmed = sentence.trim();
  if (!trimmed) return { keep: false, sentence: trimmed };

  if (style.dropListLines && LIST_LINE.test(trimmed)) {
    return { keep: false, reason: 'list', sentence: trimmed };
  }
  // A style with `maxListLines` counts list items and table rows apart from sentences: a list of records is data, not chatter.
  const apart = style.maxListLines !== undefined && (kind === 'list' || kind === 'listcont' || kind === 'table');
  if (apart ? structureCount >= style.maxListLines! : currentCount >= style.maxSentences) {
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
      : (!ctx.allowCodeFormatting && trimmed.includes('`')) || lower.includes('concept://') || ctx.compiledIds.some((id) => id.test(trimmed))
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

  const kept: Array<{ sentence: string; kind: LineKind; lead: string }> = [];
  let questionsSeen = 0;
  let previousLine: LineKind | undefined;
  const countedApart = (kind: LineKind) => style.maxListLines !== undefined && (kind === 'list' || kind === 'listcont' || kind === 'table');
  let sentencesKept = 0;
  let structureKept = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const indent = /^[ \t]*/.exec(rawLine)?.[0] ?? '';
    const kind = lineKindOf(line, indent, previousLine);
    previousLine = kind;
    if (style.dropListLines && (kind === 'list' || kind === 'listcont')) {
      removed.push({ reason: 'list', sentence: line });
      continue;
    }
    // A heading, a list item or a table row is checked whole; prose is checked a sentence at a time.
    const sentences = kind === 'text' || kind === 'listcont'
      ? line.split(/(?<!\b\d+[.!?:])(?<=[.!?:])\s+/)
      : [line];

    let startsLine = true;
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const result = shapeSentence(sentence, compiled, style.maxListLines !== undefined ? sentencesKept : kept.length, questionsSeen, kind, structureKept);
      if (result.keep) {
        kept.push({ sentence, kind, lead: leadFor(kind, kept[kept.length - 1]?.kind, startsLine, startsLine ? indent : '') });
        if (countedApart(kind)) structureKept++; else sentencesKept++;
        startsLine = false;
        if (result.isQuestion) {
          questionsSeen++;
        }
      } else if (result.reason) {
        removed.push({ reason: result.reason, sentence });
      }
    }
  }
  const formatted = kept.map((entry) => entry.lead + entry.sentence).join('').replace(/[ \t]+([,.;:!?])/g, '$1').trim();

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
  /** The whitespace that came before the text now in `buffer`; the start of the reply counts as a new line. */
  private whitespaceBefore = '\n';
  /** What the line being read is, and what the last line shown was. */
  private lineKind: LineKind | undefined;
  private lastShownKind: LineKind | undefined;
  /** The first sentence of a line was not shown, so the next one of the same line starts the line instead. */
  private lineStartCarried = false;
  /** How many sentences and how many list or table lines have been shown, for a style that counts them apart. */
  private sentencesShown = 0;
  private structureShown = 0;
  private compiledShape: CompiledShapeContext;
  private questionsSeen = 0;
  private readonly voiceRules: Array<{ pattern: RegExp; replacement: string }>;
  private knownNames: string[] | undefined;
  private productNames: string[] | undefined;
  private knownNumbers: ReadonlySet<string> | undefined;
  private exactClaimStatements: ReadonlyMap<ClaimClass, ReadonlySet<string>> | undefined;
  private catalogueWarrantyFacts: readonly CatalogueWarrantyFact[] | undefined;
  private catalogueMisses: ReadonlySet<string> | undefined;
  private sourceUrls: ReadonlySet<string> | undefined;
  private readonly productMeasurements = new ProductMeasurementEvidence();

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

  updateNumericEvidence(values: ReadonlySet<string>): void { this.knownNumbers = values; }
  updateExactClaimStatements(values: ReadonlyMap<ClaimClass, ReadonlySet<string>> | undefined): void { this.exactClaimStatements = values; }
  updateCatalogueWarrantyFacts(values: readonly CatalogueWarrantyFact[] | undefined): void { this.catalogueWarrantyFacts = values; }
  updateCatalogueMisses(values: ReadonlySet<string> | undefined): void { this.catalogueMisses = values; }
  updateSourceUrls(values: ReadonlySet<string>): void { this.sourceUrls = values; }
  updateProductEvidence(products: any[], customerText: string): void { this.productMeasurements.update(products, customerText); }

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
    // The whitespace between pieces is kept (one capture group), so a new line is told apart from the next sentence of the same line.
    const parts = splitStreamingUnits(this.buffer);
    if (parts.length > 1) {
      for (let i = 0; i + 1 < parts.length; i += 2) {
        this.processSentence(parts[i], this.whitespaceBefore);
        this.whitespaceBefore = parts[i + 1];
      }
      this.buffer = parts[parts.length - 1];
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      if (hasIncompleteTail(this.buffer)) this.withheldSentences.push(this.buffer.trim());
      else this.processSentence(this.buffer, this.whitespaceBefore);
      this.buffer = '';
    }
  }

  private processSentence(rawSentence: string, whitespaceBefore: string): void {
    const lastBreak = whitespaceBefore.lastIndexOf('\n');
    const startsLine = lastBreak >= 0;
    const indent = (startsLine ? whitespaceBefore.slice(lastBreak + 1) : '') + (/^[ \t]*/.exec(rawSentence)?.[0] ?? '');
    let sentence = rawSentence.trim();
    if (sentence.startsWith('"') && (sentence.endsWith('"') || this.buffer === '')) {
      sentence = sentence.replace(/^"+|"+$/g, '').trim();
    }
    if (!sentence) {
      if (startsLine) this.lineStartCarried = true;
      return;
    }
    // The first sentence of a line says what the line is; the rest of that line is the same kind of line.
    let kind: LineKind;
    if (startsLine) {
      kind = lineKindOf(sentence, indent, this.lineKind);
      this.lineKind = kind;
    } else {
      kind = this.lineKind ?? 'text';
    }
    // A line indented under a list item that is not shown is not shown either.
    if (this.compiledShape.style.dropListLines && kind === 'listcont') {
      console.warn(`[ReplyShaper] removed sentence during stream: "${sentence}" (list)`);
      this.lineStartCarried = this.lineStartCarried || startsLine;
      return;
    }
    sentence = applyVoiceRules(sentence, this.voiceRules);
    if (this.sourceUrls) sentence = repairSourceLinks(sentence, this.sourceUrls).trim();
    if (!sentence) return;

    if (this.isOkfRelease) {
      const measurementProblem = this.productMeasurements.check(sentence, startsLine && kind === 'heading');
      if (measurementProblem) {
        this.withheldSentences.push(sentence); this.withheldClasses.add('catalog_fact');
        console.warn(`[ClaimGuard] withheld product measurement during stream (${measurementProblem}).`);
        this.lineStartCarried = this.lineStartCarried || startsLine; return;
      }
      const allowed = this.allowedClaims instanceof Set ? Array.from(this.allowedClaims) : this.allowedClaims;
      const claimResult = validateOkfGeneratedClaims(sentence, allowed, this.packOrOptions, { knownNames: this.knownNames, productNames: this.productNames, knownNumbers: this.knownNumbers, exactClaimStatements: this.exactClaimStatements, catalogueWarrantyFacts: this.catalogueWarrantyFacts, catalogueMisses: this.catalogueMisses });
      if (!claimResult.valid) {
        this.withheldSentences.push(sentence);
        for (const claim of claimResult.forbidden) this.withheldClasses.add(claim);
        console.warn(`[ClaimGuard] withheld sentence during stream: "${sentence}" asserting ${claimResult.forbidden.join(', ')}`);
        this.lineStartCarried = this.lineStartCarried || startsLine;
        return;
      }
    }

    const apart = this.compiledShape.style.maxListLines !== undefined && (kind === 'list' || kind === 'listcont' || kind === 'table');
    const shaped = shapeSentence(sentence, this.compiledShape, this.compiledShape.style.maxListLines !== undefined ? this.sentencesShown : this.emittedSentences.length, this.questionsSeen, kind, this.structureShown);
    if (!shaped.keep) {
      console.warn(`[ReplyShaper] removed sentence during stream: "${sentence}" (${shaped.reason})`);
      this.lineStartCarried = this.lineStartCarried || startsLine;
      return;
    }

    if (shaped.isQuestion) {
      this.questionsSeen++;
    }

    // When the first sentence of a line was removed, the next one of that line still starts a new line, as plain prose.
    const starts = startsLine || this.lineStartCarried;
    const shownKind: LineKind = startsLine || !starts ? kind : 'text';
    this.lineStartCarried = false;
    const delta = leadFor(shownKind, this.lastShownKind, starts, startsLine ? indent : '') + sentence;
    this.lastShownKind = shownKind;
    if (apart) this.structureShown++; else this.sentencesShown++;
    this.emittedSentences.push(sentence);
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

/** Keep abbreviations, parenthetical examples and Markdown links together when validating streamed text. */
export function splitStreamingUnits(text: string): string[] {
  const parts: string[] = []; let start = 0; let round = 0; let square = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '(') round++; else if (char === ')') round = Math.max(0, round - 1);
    if (char === '[') square++; else if (char === ']') square = Math.max(0, square - 1);
    if (round || square) continue;
    const unit = text.slice(start, i + 1);
    const newline = char === '\n';
    const end = /[.!?]/.test(char) && /\s/.test(text[i + 1] || '') && !/^\s*\d+[.)]$/.test(unit) && !/\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|prof|vs|approx)\.$/i.test(unit);
    if (!newline && !end) continue;
    const boundary = newline ? i : i + 1; let next = newline ? i + 1 : i + 1;
    while (next < text.length && /\s/.test(text[next])) next++;
    parts.push(text.slice(start, boundary), text.slice(boundary, next)); start = next; i = next - 1;
  }
  parts.push(text.slice(start)); return parts;
}

function hasIncompleteTail(text: string): boolean {
  let round = 0; let square = 0;
  for (const char of text) { if (char === '(') round++; if (char === ')') round--; if (char === '[') square++; if (char === ']') square--; }
  return round > 0 || square > 0 || /\b(?:e\.g\.|i\.e\.|such as|for example|including)\s*[:(,]*\s*$/i.test(text);
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
