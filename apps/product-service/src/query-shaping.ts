/**
 * Generic, tenant-agnostic query-shaping helpers.
 *
 * Two distinct problems, two distinct fixes — neither is a bigger candidate
 * pool or a synonym map, which is why they survived the earlier over-fetch and
 * domain-glossary fixes:
 *
 * 1. TYPO TOLERANCE — lexicalRerank's title-matching was exact-substring only,
 *    so a misspelled query token ("timbr") could never match "Timber" in a
 *    real title no matter how large the candidate pool was. `fuzzyWordMatch`
 *    adds a bounded edit-distance fallback, whole-word only (never substring),
 *    so it can't fire on an unrelated word that merely happens to be similar
 *    in length.
 *
 * 2. COMPOUND-PHRASE SEMANTIC DRIFT — a query like "purlins for a shed roof"
 *    embeds as one blended vector, and a strong secondary cluster ("shed")
 *    can outweigh the actual subject ("purlin"). `emphasizePrimaryClause`
 *    repeats the clause before the first preposition — almost always the
 *    actual product/subject the customer named — so it carries more weight
 *    in the embedding without discarding the rest of the sentence. Generic:
 *    no tenant vocabulary, just sentence structure.
 */

/** Iterative Levenshtein distance (no recursion, no library). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Whole-word fuzzy match, bounded by word length so short words need a near-
 * exact match (avoids "gib" fuzzy-matching half the catalogue) and longer
 * words tolerate a couple of real typos.
 */
export function fuzzyWordMatch(token: string, word: string): boolean {
  if (token === word) return true;
  if (token.length < 4 || word.length < 4) return false; // too short to fuzz safely
  if (Math.abs(token.length - word.length) > 2) return false; // cheap reject
  const maxDist = token.length <= 5 ? 1 : 2;
  return levenshtein(token, word) <= maxDist;
}

const CLAUSE_SPLIT = /\b(for|to|in|with|on|at|of|from|under|over|near|around)\b/i;

/**
 * Repeat the clause before the first preposition, so it weighs more heavily
 * in the resulting embedding than the qualifying context after it. Bails out
 * (returns the query unchanged) whenever the split looks unreliable — no
 * preposition found, the primary clause is empty, or it's long enough that
 * it's probably not a single focused subject anymore.
 */
export function emphasizePrimaryClause(query: string): string {
  const q = String(query || '');
  const match = q.match(CLAUSE_SPLIT);
  if (!match || match.index === undefined || match.index < 3) return q;
  const primary = q.slice(0, match.index).trim();
  if (!primary || primary.split(/\s+/).length > 4) return q;
  return `${primary} ${primary} ${q}`;
}
