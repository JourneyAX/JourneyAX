/**
 * Locale-keyed stemming rule definitions.
 * Maps language/locale code (e.g. 'en', 'en-NZ', 'en-AU', 'en-US') to its suffix stemming transformations.
 * Any unknown or unmapped locale has NO stemming (returns the clean escaped word unchanged).
 */

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type StemmerRule = (clean: string) => string | undefined;

export const LOCALE_STEMMING_RULES: Record<string, StemmerRule[]> = {
  en: [
    // -ies -> y or ies (e.g. batteries -> battery / batteries)
    (clean) => (clean.endsWith('ies') && clean.length > 4 ? clean.slice(0, -3) + '(?:y|ies)' : undefined),
    // -es -> e or es (e.g. boxes, dishes, finishes)
    (clean) =>
      clean.endsWith('es') &&
      (clean.endsWith('shes') || clean.endsWith('ches') || clean.endsWith('xes') || clean.endsWith('zes'))
        ? clean.slice(0, -2) + '(?:es)?'
        : undefined,
    // -s -> singular or plural (e.g. screws -> screw(s)?)
    (clean) => (clean.endsWith('s') && !clean.endsWith('ss') && clean.length > 2 ? clean.slice(0, -1) + '(?:s)?' : undefined),
  ],
};

// Map region-specific English locales to 'en'
LOCALE_STEMMING_RULES['en-nz'] = LOCALE_STEMMING_RULES['en'];
LOCALE_STEMMING_RULES['en-au'] = LOCALE_STEMMING_RULES['en'];
LOCALE_STEMMING_RULES['en-us'] = LOCALE_STEMMING_RULES['en'];
LOCALE_STEMMING_RULES['en-gb'] = LOCALE_STEMMING_RULES['en'];

/**
 * Transforms a word into a regex pattern matching singular/plural forms based on locale.
 * If locale is unknown, empty, or unmapped, returns the cleaned escaped word with NO stemming.
 */
export function stemPatternForLocale(word: string, locale?: string): string {
  const clean = escapeRegex(word.toLowerCase().replace(/[®™]/g, '').trim());
  if (!clean) return '';
  if (!locale) return clean; // Unknown locale = no stemming

  const norm = locale.toLowerCase().trim();
  const lang = norm.split(/[-_]/)[0];
  const rules = LOCALE_STEMMING_RULES[norm] || LOCALE_STEMMING_RULES[lang];

  if (!rules || rules.length === 0) {
    return clean; // Unknown locale has no stemming
  }

  for (const rule of rules) {
    const res = rule(clean);
    if (res) return res;
  }
  return clean;
}
