import type { ConversationPolicy } from './policy';

/** The same folding the knowledge package uses for matching, kept local so this module has no dependency on it. */
export const tokens = (value: string): string[] =>
  value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

/** A light, data-driven stemmer: "stains" and "stain", "cleaning" and "clean" meet. Rules and thresholds come from the policy. */
export function stem(word: string, policy: ConversationPolicy): string {
  const { rules, minStem, keepEndings } = policy.stem;
  for (const [suffix, replacement] of rules) {
    if (!word.endsWith(suffix)) continue;
    if (suffix === 's' && keepEndings.some((ending) => word.endsWith(ending))) continue;
    const base = word.slice(0, word.length - suffix.length);
    if (base.length >= minStem) return `${base}${replacement}`;
  }
  return word;
}

/** Splits into sentences, and also on line breaks (catalogue descriptions often run features together without punctuation). */
export const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);

/** A stable pick from a list of variants: the same conversation and turn always say the same thing, different turns vary. */
export function pick(variants: string[], seed: string): string {
  if (variants.length === 0) return '';
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return variants[Math.abs(hash) % variants.length];
}

export const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{([A-Za-z]+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));

/** "a", "a and b", "a, b and c" */
export function listWords(words: string[], limit = 3): string {
  const shown = words.slice(0, limit);
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
