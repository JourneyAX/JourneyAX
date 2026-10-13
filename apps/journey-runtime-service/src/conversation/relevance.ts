import type { ClaimClass } from '@journeyax/knowledge';
import { validateOkfGeneratedClaims } from '../kernel/okf-claim-validator';
import type { ConversationPolicy } from './policy';
import type { PlannedProduct, Product } from './types';
import { sentencesOf, stem, tokens } from './text';

type Field = 'title' | 'features' | 'description' | 'brand' | 'category';
type FieldSets = Record<Field, Set<string>>;

/** Every string a product states about itself, from a field that may be text, a list, or an object of values. */
export function flatten(value: unknown, depth = 0): string[] {
  if (value == null || depth > 3) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => flatten(entry, depth + 1));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap((entry) => flatten(entry, depth + 1));
  return [];
}

export const brandOf = (item: Product): string | undefined => {
  const value = item.brand ?? (item.attributes as any)?.brand;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export function fieldSetsOf(item: Product, policy: ConversationPolicy): FieldSets {
  const set = (texts: string[]) => new Set(texts.flatMap((text) => tokens(text)).map((word) => stem(word, policy)));
  return {
    title: set([item.title]),
    description: set([item.description ?? '']),
    features: set([...flatten(item.features), ...flatten(item.specifications)]),
    brand: set([brandOf(item) ?? '']),
    category: set([String(item.category ?? '')]),
  };
}

/**
 * Scores each product against what the customer said they need, using only the product's own text. A word that nearly every
 * candidate contains ("clean", among cleaners) says nothing and is ignored; a word only a few contain ("oil", "driveway") decides.
 * A match in the title counts most, then listed features, then the description.
 */
export function rankProducts(items: Product[], terms: string[], policy: ConversationPolicy): { ranked: PlannedProduct[]; informative: string[] } {
  const sets = items.map((item) => fieldSetsOf(item, policy));
  const N = items.length;
  const weights = policy.relevance.fieldWeights;
  const fields = Object.keys(weights) as Field[];
  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = sets.filter((entry) => fields.some((field) => entry[field].has(term))).length;
    if (df >= 1) idf.set(term, Math.log((N + 1) / (df + 0.5)));
  }
  const informative = terms.filter((term) => (idf.get(term) ?? 0) >= policy.relevance.minIdf);
  const ranked = items.map((item, index) => {
    let score = 0;
    const matched: string[] = [];
    for (const term of informative) {
      const weight = Math.max(0, ...fields.filter((field) => sets[index][field].has(term)).map((field) => weights[field]));
      if (weight > 0) { score += (idf.get(term) ?? 0) * weight; matched.push(term); }
    }
    return { item, score, matched, index };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return { ranked: ranked.map(({ item, score, matched }) => ({ item, score, matched })), informative };
}

/** A window of the sentence around the first word that matched, so a long run-on still gives a short, exact quote. */
function windowOf(sentence: string, hit: Set<string>, maxChars: number, policy: ConversationPolicy): string {
  if (sentence.length <= maxChars) return sentence;
  let at = 0;
  for (const match of sentence.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (hit.has(stem(tokens(match[0])[0] ?? '', policy))) { at = match.index ?? 0; break; }
  }
  let start = Math.max(0, at - 40);
  if (start > 0) { const space = sentence.lastIndexOf(' ', start); start = space >= 0 ? space + 1 : start; }
  let end = Math.min(sentence.length, start + maxChars);
  if (end < sentence.length) { const space = sentence.lastIndexOf(' ', end); if (space > start) end = space; }
  return `${start > 0 ? '…' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '…' : ''}`;
}

/**
 * Why this product, for this customer: the product's own sentences that best match the customer's words, quoted as written. It
 * takes the best sentence, then a second one only if it covers a need the first did not and both still fit the length limit.
 * A sentence that asserts a claim the knowledge has not verified (suitability, compliance, installation...) is never used;
 * with no such sentence the reason is only the words that matched. Nothing here is written by a model.
 */
export function reasonFor(item: Product, matched: string[], surfaces: Record<string, string>, allowed: ClaimClass[], policy: ConversationPolicy): { needs: string[]; excerpt?: string } {
  const needs = matched.map((term) => surfaces[term] ?? term);
  const options: Array<{ sentence: string; hit: Set<string>; order: number }> = [];
  for (const text of [item.description ?? '', ...flatten(item.features), ...flatten(item.specifications)]) {
    for (const sentence of sentencesOf(text)) {
      const words = new Set(tokens(sentence).map((word) => stem(word, policy)));
      const hit = new Set(matched.filter((term) => words.has(term)));
      if (hit.size === 0 || !validateOkfGeneratedClaims(sentence, allowed).valid) continue;
      options.push({ sentence, hit, order: options.length });
    }
  }
  const rank = (entry: { sentence: string; hit: Set<string> }, uncovered: Set<string>) =>
    [...entry.hit].filter((term) => uncovered.has(term)).length * 100 - Math.min(entry.sentence.length, 400) / 10;
  const uncovered = new Set(matched);
  const chosen: typeof options = [];
  const { maxChars, maxSentences } = policy.reason;
  while (chosen.length < maxSentences) {
    const total = chosen.reduce((sum, entry) => sum + entry.sentence.length + 1, 0);
    const next = options
      .filter((entry) => !chosen.includes(entry) && [...entry.hit].some((term) => uncovered.has(term)))
      .filter((entry) => chosen.length === 0 || total + entry.sentence.length <= maxChars)
      .sort((a, b) => rank(b, uncovered) - rank(a, uncovered) || a.order - b.order)[0];
    if (!next) break;
    chosen.push(next);
    for (const term of next.hit) uncovered.delete(term);
  }
  if (chosen.length === 0) return { needs };
  const excerpt = chosen.length === 1
    ? windowOf(chosen[0].sentence, chosen[0].hit, maxChars, policy)
    : chosen.sort((a, b) => a.order - b.order).map((entry) => entry.sentence).join(' ');
  return { needs, excerpt };
}
