/**
 * What a product card says about each product beyond its name and price: the catalogue's own feature statements, and which of
 * them answers what the customer asked for.
 *
 * Everything is taken from the catalogue record the tools returned and from the customer's own words. Nothing is written by the
 * model, so a card can show why a product fits without being able to invent a claim about it.
 */
import { connectorWordsForLocale, stemPatternForLocale } from '../capabilities/handlers/locale-stemmer';

/** A word this short says too little to tie a feature to the customer's request. */
const MIN_WORD_LENGTH = 4;
const MAX_SHOWN = 3;

const wordsOf = (text: string): string[] =>
  text.toLowerCase().replace(/[®™]/g, '').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= MIN_WORD_LENGTH);

export interface CardFacts {
  /** The feature statement that best answers what the customer asked for, when one does. */
  reason?: string;
  /** Up to three more feature statements, the reason not repeated. */
  highlights: string[];
}

export function productCardFacts(
  features: readonly string[] | undefined,
  input: { customerText?: string; locale?: string },
): CardFacts {
  const list = (features || []).filter((feature) => typeof feature === 'string' && feature.trim().length > 0);
  if (list.length === 0) return { highlights: [] };
  const connectors = connectorWordsForLocale(input.locale);
  const asked = [...new Set(wordsOf(input.customerText || '').filter((word) => !connectors.has(word)))];
  const patterns = asked.map((word) => new RegExp(`\\b${stemPatternForLocale(word, input.locale)}`, 'i'));
  let best = -1;
  let bestScore = 0;
  list.forEach((feature, index) => {
    const score = patterns.reduce((sum, pattern) => sum + (pattern.test(feature) ? 1 : 0), 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  const reason = best >= 0 ? list[best] : undefined;
  return { reason, highlights: list.filter((_, index) => index !== best).slice(0, MAX_SHOWN) };
}
