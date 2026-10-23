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
 * Words that only join two others ("pipe and fittings"), per language. A product type is matched on its content
 * words, so the joiner must not be required to appear in the catalogue text. Keyed by language; region variants
 * fall back to it. Any unknown or unmapped locale has none.
 */
export const LOCALE_CONNECTOR_WORDS: Record<string, readonly string[]> = {
  en: ['and'],
};

export function connectorWordsForLocale(locale?: string): ReadonlySet<string> {
  if (!locale) return new Set();
  const norm = locale.toLowerCase().trim();
  const lang = norm.split(/[-_]/)[0];
  return new Set(LOCALE_CONNECTOR_WORDS[norm] || LOCALE_CONNECTOR_WORDS[lang] || []);
}

/**
 * Transforms a word into a regex pattern matching singular/plural forms based on locale.
 * If locale is unknown, empty, or unmapped, returns the cleaned escaped word with NO stemming.
 */
export function stemPatternForLocale(word: string, locale?: string): string {
  const raw = word.toLowerCase().replace(/[®™]/g, '').trim();
  // A size written as numbers joined by x (150x50, 6x2, 2.4x1.2) matches however the catalogue spaces or spells the separator.
  if (/^\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)+$/.test(raw)) {
    return raw.split(/\s*[x×*]\s*/).map((n) => n.replace(/\./g, '\\.')).join('\\s*[x×*]\\s*');
  }
  const clean = escapeRegex(raw);
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
