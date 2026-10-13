import type { GateView } from './decide';
import { conceptWordsOf, extractNeeds, isCardAnswerLine } from './needs';
import type { ConversationPolicy } from './policy';
import { stem, tokens } from './text';

export type ReadingMode = 'tapped' | 'browse';

/** The shopping modes in which "show me" for a shelf is a complete request. Anything else (safety, evidence, orders…) is read by the model as before. */
const SHELF_MODES = new Set(['direct_results', 'overview_then_ask', 'clarify_then_search']);

const phraseIn = (words: string, phrases: string[]) => phrases.some((phrase) => words.includes(` ${tokens(phrase).join(' ')} `));

/**
 * Cheap first look at a message, before anything slow runs: could it be understood without the model that reads free text?
 *   tapped  every line is a tapped answer ("question → answer"), with at most a short heading such as "My answers:"
 *   browse  a short "show me…" with no number in it
 * This only says it is worth trying; {@link readsWithoutModel} confirms it against what the knowledge decision actually read.
 */
export function pendingReadingMode(message: string, policy: ConversationPolicy): ReadingMode | undefined {
  const rules = policy.modelReading;
  const lines = message.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const answers = lines.filter(isCardAnswerLine);
  if (rules.skipForTappedAnswers && answers.length > 0 && lines.filter((line) => !isCardAnswerLine(line)).every((line) => tokens(line).length <= rules.maxHeaderWords)) return 'tapped';
  if (rules.skipForBrowse && answers.length === 0 && !/\d/.test(message) && tokens(message).length <= rules.browseMaxWords && phraseIn(` ${tokens(message).join(' ')} `, policy.browsePhrases)) return 'browse';
  return undefined;
}

/** What the customer said beyond the shelf and the words of "show me": if anything is left, a model might find a fact in it. */
function leftoverNeeds(message: string, gate: GateView, policy: ConversationPolicy): string[] {
  const asking = new Set(policy.browsePhrases.flatMap((phrase) => tokens(phrase)).map((word) => stem(word, policy)));
  return extractNeeds(message, conceptWordsOf(gate), policy).terms.filter((term) => !asking.has(term));
}

/**
 * Confirms that the model's reading would add nothing, from what the deterministic reading already produced:
 *   tapped  every answer line was read: by the release's own question (a certain fact) or by the question built from the products
 *   browse  the knowledge decision is a shelf, and nothing is left in the message once the shelf and "show me" are taken out
 * Anything less keeps the model in the loop, exactly as before.
 */
export function readsWithoutModel(
  mode: ReadingMode, message: string, gate: GateView, candidateFacts: Record<string, { source?: string } | undefined> | undefined, policy: ConversationPolicy,
): boolean {
  if (mode === 'tapped') {
    const lines = message.split(/\n+/).filter(isCardAnswerLine).length;
    const fromRelease = Object.values(candidateFacts ?? {}).filter((fact) => fact?.source === 'card_answer').length;
    const fromProducts = gate.trace.reasonCodes.includes('conversation_answer_continuity') ? 1 : 0;
    return lines > 0 && fromRelease + fromProducts >= lines;
  }
  return Boolean(gate.conceptId) && SHELF_MODES.has(gate.mode) && leftoverNeeds(message, gate, policy).length === 0;
}
