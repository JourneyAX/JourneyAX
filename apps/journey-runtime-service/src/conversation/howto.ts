import type { ClaimClass } from '@journeyax/knowledge';
import { validateOkfGeneratedClaims } from '../kernel/okf-claim-validator';
import type { ConversationPolicy } from './policy';
import { flatten, rankProducts } from './relevance';
import { fill, sentencesOf, tokens } from './text';
import type { Product } from './types';

/**
 * "How do I use it?" is answered from the product's own details, quoted, or not at all. Nothing is written by a model: a model
 * asked for steps invents them. The product must be one the customer's words clearly single out (or the only one on the shelf),
 * a sentence counts as usage only if it contains one of the policy's usage words, and a sentence that asserts a claim the release
 * has not verified is never used. With no usage sentence the answer says plainly that there is none on file.
 */
export function howToAnswer(items: Product[], terms: string[], allowed: ClaimClass[], policy: ConversationPolicy): { message: string; sku?: string; quoted: boolean } | undefined {
  if (items.length === 0) return undefined;
  const { ranked, informative } = rankProducts(items, terms, policy);
  const top = ranked[0];
  const second = ranked[1];
  const identified = items.length === 1 || (informative.length > 0 && top.matched.length > 0 && (!second || second.score <= top.score * (1 - policy.sufficiency.margin)));
  if (!identified) return undefined;

  // Exact words only: "wipes" and "brushes" name a product, "wipe" and "brush" give an instruction. A sentence is an instruction when
  // it opens with such a word ("Spray on, leave to dry") or has two of them ("For best results apply two coats").
  const cues = new Set(policy.usageCues.flatMap((cue) => tokens(cue)));
  const sentences: string[] = [];
  for (const text of [top.item.description ?? '', ...flatten(top.item.features), ...flatten(top.item.specifications)]) {
    for (const sentence of sentencesOf(text)) {
      const words = tokens(sentence);
      if (!(cues.has(words[0]) || new Set(words.filter((word) => cues.has(word))).size >= 2)) continue;
      if (!validateOkfGeneratedClaims(sentence, allowed).valid || sentences.includes(sentence)) continue;
      sentences.push(sentence);
    }
  }
  const chosen: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (chosen.length >= policy.howTo.maxSentences || (chosen.length > 0 && length + sentence.length + 1 > policy.howTo.maxChars)) break;
    chosen.push(sentence);
    length += sentence.length + 1;
  }
  const title = top.item.title;
  return chosen.length
    ? { message: fill(policy.templates.howTo, { title, steps: chosen.join(' ') }), sku: top.item.sku, quoted: true }
    : { message: fill(policy.templates.howToNone, { title }), sku: top.item.sku, quoted: false };
}
