/**
 * What the customer reads when the claim guard has removed everything the model wrote.
 *
 * The tenant's own refusal (`withheldAnswerMessage`) is written for the questions the guard exists for: safety, the law, what a
 * professional must decide. It is the wrong answer to "which cordless drill?" when the lookup found drills. When products were found
 * and nothing the guard removed was about safety, care or the law, the customer is told what was found and the cards follow; the
 * refusal stays for everything else.
 */
import type { ClaimClass } from '@journeyax/knowledge';

/** Classes whose removal means the customer asked something the shop will not answer from its own head: the refusal fits, "here is what I found" does not. */
export const CAUTION_CLASSES: ReadonlySet<ClaimClass> = new Set<ClaimClass>(['safety_instruction', 'care_safety', 'legal_requirement']);

export const DEFAULT_FOUND_MESSAGE = 'Here’s what I found in our range. If you’d like me to check anything else, just ask.';

/** The tenant's own wording (`conversationPolicy.foundMessage`, a string or one per locale), else a neutral line. */
export function foundMessageOf(release?: any, locale = 'en-NZ'): string {
  const custom = release?.conversationPolicy?.foundMessage;
  if (typeof custom === 'string' && custom.trim()) return custom;
  if (custom && typeof custom === 'object') {
    const loc = locale || release?.profile?.primaryLocale || 'en-NZ';
    const msg = custom[loc] || custom[loc.split('-')[0]] || custom['default'] || Object.values(custom)[0];
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return DEFAULT_FOUND_MESSAGE;
}

/**
 * The text that replaces a reply the guard emptied (or cut to questions only), or `undefined` to leave the reply as it is.
 * With products to show and nothing cautious removed, an emptied reply becomes the "found" line and a reply that kept only its
 * questions keeps them (the cards follow it); otherwise the tenant's refusal replaces both, as before.
 */
export function chooseWithheldFallback(input: {
  reply: string;
  onlyQuestions: boolean;
  hasProducts: boolean;
  withheldClasses: Iterable<ClaimClass>;
  foundMessage: string;
  withheldMessage: string;
}): string | undefined {
  const cautious = [...input.withheldClasses].some((claim) => CAUTION_CLASSES.has(claim));
  const showFound = input.hasProducts && !cautious;
  if (!input.reply) return showFound ? input.foundMessage : input.withheldMessage;
  if (input.onlyQuestions) return showFound ? undefined : input.withheldMessage;
  return undefined;
}

/**
 * Should the model be asked once to answer again without the removed statements?
 * Yes when little is left of the reply (and no card carries it), or when the removed sentences were most of what the model wrote:
 * a reply that lost its recommendation reads as an answer that never came, whether or not cards are shown after it.
 */
export function needsRepair(input: {
  withheldCount: number;
  removedChars: number;
  keptChars: number;
  cardShown: boolean;
  thinBelowChars: number;
  removedShareAbove: number;
}): boolean {
  if (input.withheldCount === 0) return false;
  if (input.keptChars < input.thinBelowChars && !input.cardShown) return true;
  const written = input.removedChars + input.keptChars;
  return written > 0 && input.removedChars / written >= input.removedShareAbove;
}
