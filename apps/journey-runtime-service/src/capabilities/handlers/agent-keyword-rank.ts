/**
 * Orders the candidates of an agent search by how well they match the words asked for.
 *
 * A word that few candidates contain (a size, a brand) counts for more than one nearly all of them contain, but never for nothing:
 * when every candidate holds the main word ("ladder"), the other words must not be the only thing that separates them, or a product
 * that merely shares a second word (a "step", a "safety" item) ties with the real thing. So each word keeps a floor weight, and a
 * product whose name holds the asked-for words together, in order ("step ladder"), is lifted above one that holds them apart.
 */
export interface RankRow<T> { d: T; name: string; cat: string; rest: string }

/** The least a word counts for, however many candidates contain it. */
export const MIN_WORD_WEIGHT = 1;
/** What each word of a phrase adds when the product name holds the whole phrase, contiguously and in order. */
export const PHRASE_WORD_BONUS = 3;

/** What a match through the shop's word list (a synonym) counts for, next to the word itself being there. */
export const SYNONYM_FACTOR = 0.5;

export interface RankOptions {
  /** One pattern per word, in the order of `words`, matching the word and its synonyms. */
  regexes: RegExp[];
  /** One pattern per word matching only the word itself. A synonym can be loose (a shelf named "Safety & Ladders" makes "safety" a synonym of "ladder"), so the word itself counts for more. */
  exact?: RegExp[];
  /** The words the patterns stand for. */
  words: string[];
  /** The phrases the model asked for as written (each keyword with two or more words). */
  phrases: string[];
}

/** The rows, best match first. Rows that score the same keep their incoming order. */
export function rankByKeywords<T>(rows: Array<RankRow<T>>, options: RankOptions): T[] {
  const { regexes, words, phrases } = options;
  const exact = options.exact && options.exact.length === regexes.length ? options.exact : regexes;
  const weights = regexes.map((rx) => {
    const df = rows.filter((r) => rx.test(`${r.name} ${r.cat} ${r.rest}`)).length;
    return Math.max(MIN_WORD_WEIGHT, Math.log((rows.length + 1) / (df + 0.5)));
  });
  // A phrase is matched word by word with the same patterns as the single words, so a stem or a synonym still counts; the words must
  // follow one another in the name with nothing but separators between them.
  const phraseMatchers = phrases
    // Words the search dropped (stop words) are left out of the phrase, so "a step ladder" still counts as "step ladder".
    .map((phrase) => phrase.toLowerCase().replace(/[®™]/g, '').split(/\s+/).filter((part) => words.includes(part)))
    .filter((parts) => parts.length >= 2)
    .map((parts) => {
      const indices = parts.map((part) => words.indexOf(part));
      const source = indices.map((i) => `(?:${exact[i].source})`).join('[\\W_]+');
      return { rx: new RegExp(source, 'i'), size: parts.length };
    });
  // How much word `i` counts in a field: in full when the word itself is there, in part when only a synonym is.
  const hit = (i: number, text: string) => (exact[i].test(text) ? 1 : regexes[i].test(text) ? SYNONYM_FACTOR : 0);
  const scored = rows.map((r, order) => {
    let s = regexes.reduce((sum, _rx, i) => sum + Math.max(3 * hit(i, r.name), 2 * hit(i, r.cat), hit(i, r.rest)) * weights[i], 0);
    for (const matcher of phraseMatchers) if (matcher.rx.test(r.name)) s += PHRASE_WORD_BONUS * matcher.size;
    return { d: r.d, s, order };
  });
  scored.sort((x, y) => y.s - x.s || x.order - y.order);
  return scored.map((x) => x.d);
}
