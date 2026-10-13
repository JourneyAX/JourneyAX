import { normalizePhrase } from './slug';

/** Splits a compound category name ("Hammers & Mallets", "Doors, Windows & Joinery Hardware") into its parts. */
export function splitName(name: string, separators: string[]): string[] {
  let parts = [name];
  for (const separator of separators) parts = parts.flatMap((part) => part.split(separator));
  const cleaned = parts.map((part) => part.trim()).filter(Boolean);
  return cleaned.length > 1 ? cleaned : [];
}

/**
 * Singular/plural forms of the final word, for languages that opt in. Only the English rules exist today; the
 * default ('none') adds nothing, so no language is assumed.
 */
export function pluralVariants(phrase: string, mode: 'english' | 'none'): string[] {
  if (mode === 'none') return [];
  const words = normalizePhrase(phrase).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const last = words[words.length - 1];
  const forms = new Set<string>();
  if (last.length > 3 && last.endsWith('ies')) forms.add(`${last.slice(0, -3)}y`);
  else if (last.length > 3 && /(ses|xes|zes|ches|shes)$/.test(last)) forms.add(last.slice(0, -2));
  else if (last.length > 3 && last.endsWith('s') && !/(ss|us|is)$/.test(last)) forms.add(last.slice(0, -1));
  else if (last.endsWith('y') && last.length > 2 && !/[aeiou]y$/.test(last)) forms.add(`${last.slice(0, -1)}ies`);
  else if (/(s|x|z|ch|sh)$/.test(last)) forms.add(`${last}es`);
  else forms.add(`${last}s`);
  return [...forms].map((form) => [...words.slice(0, -1), form].join(' '));
}

/** Terms shared by several leaf categories of the same group (for example "screws"), as authoring suggestions. */
export function familyTerms(categoryNames: string[], mode: 'english' | 'none'): Array<{ term: string; categories: string[] }> {
  const byTerm = new Map<string, Set<string>>();
  for (const name of categoryNames) {
    const words = normalizePhrase(name).split(' ').filter((word) => word.length > 2 && word !== 'and');
    const last = words[words.length - 1];
    if (!last) continue;
    const singular = pluralVariants(last, mode).find((form) => form.length < last.length) ?? last;
    byTerm.set(singular, (byTerm.get(singular) || new Set()).add(name));
  }
  return [...byTerm.entries()].filter(([, names]) => names.size >= 2)
    .map(([term, names]) => ({ term, categories: [...names].sort() }))
    .sort((a, b) => b.categories.length - a.categories.length || (a.term < b.term ? -1 : 1));
}
