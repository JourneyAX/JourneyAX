import type { OkfConcept, OkfReleaseContent } from '@journeyax/knowledge';
import { connectorWordsForLocale, stemPatternForLocale } from '../capabilities/handlers/locale-stemmer';

/**
 * Describes what a tenant's range holds for a broad request: which product groups the customer's word points at, how each
 * splits into smaller groups, how many products sit in each, a few real examples, and what is commonly bought with it.
 *
 * Everything comes from the pinned knowledge release (category concepts, their customer phrases, their child groups and
 * suggestion relationships) and from live catalogue counts. Nothing here knows any industry or tenant.
 */

export interface RangeExample {
  sku: string;
  title: string;
  price?: number | null;
  currency?: string;
  imageUrl?: string | null;
}

export interface RangeGroup {
  name: string;
  conceptId: string;
  path?: string[];
  productCount?: number;
  /** A few real products from this group, each from the catalogue. */
  examples?: RangeExample[];
}

export interface RangeNode extends RangeGroup {
  /** `direct`: what the customer asked for. `related`: a group that shares part of their words (a supporting item, a tool). */
  match?: 'direct' | 'related';
  /** The merchant's own words about the group, present only when the knowledge carries a description that is not a catalogue count. */
  about?: string;
  /** Smaller groups inside this one (what a broad question can be narrowed by). */
  children?: RangeGroup[];
  /** Groups customers commonly buy with this one. Suggestions only: nothing here is confirmed compatible or required. */
  goesWith?: Array<RangeGroup & { label?: string }>;
}

export interface RangeBrowseDeps {
  okf: OkfReleaseContent | null | undefined;
  locale?: string;
  topic?: string;
  /** A category path from an earlier answer, to open one group directly. */
  path?: string[];
  maxNodes?: number;
  count: (paths: string[][]) => Promise<number[]>;
  examples: (groups: Array<{ conceptId: string; label: string; categoryPaths: string[][]; maxItems: number }>) => Promise<Array<{ conceptId: string; items: RangeExample[] }>>;
}

const CATEGORY_TYPE = 'product_category';
const SUGGESTION_RELATIONSHIPS = new Set(['cross_sell']);
/** A group is worth showing when its best term scores at least this (0 to 1)... */
const MIN_MATCH_SCORE = 0.3;
/** ...and at least this fraction of the best group's score. */
const RELATIVE_CUTOFF = 0.45;
/** At or above this a group is what the customer asked for; below it, a group that shares only part of their words. */
const DIRECT_MATCH_SCORE = 0.8;
/** A word used by this many groups or fewer is distinctive enough to identify a group on its own. */
const DISTINCTIVE_SHARE = 0.02;
const MAX_CANDIDATE_CHILDREN = 24;
const MAX_CHILDREN = 8;
const EXAMPLES_PER_GROUP = 2;

const wordsOf = (text: string): string[] =>
  String(text || '').toLowerCase().replace(/[®™]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const pathOf = (concept: OkfConcept): string[] | undefined => {
  const paths = (concept.searchScope as any)?.catalogCategoryPaths;
  return Array.isArray(paths) && Array.isArray(paths[0]) && paths[0].length > 0 ? paths[0].map(String) : undefined;
};

/** Description is the merchant's words only when its own provenance says it did not come from the catalogue structure. */
function aboutOf(concept: OkfConcept): string | undefined {
  const text = String(concept.description || '').trim();
  if (!text) return undefined;
  const provenance = (concept.extensions as any)?.['x-journeyax-provenance']?.description;
  if (!provenance || provenance.kind === 'catalogue_taxonomy') return undefined;
  return text;
}

export interface RangeMatch {
  concept: OkfConcept;
  /** 0 to 1: how much of what the customer said, and how distinctive it is, the best name or phrase of this group accounts for. */
  score: number;
}

/**
 * The category concepts a customer's words point at, best first. Each name, synonym and phrase of a concept is compared with the
 * customer's words, whatever the plural. A term scores by how much of itself the customer said, weighted by how few groups use
 * each word: "plasterboard" (a few groups) identifies a group, "board" (many) hardly does. Extra words in the customer's
 * sentence cost nothing. Words that only join others are ignored.
 */
export function matchRangeConcepts(okf: OkfReleaseContent | null | undefined, topic: string, locale: string | undefined, max = 4): RangeMatch[] {
  if (!okf || !topic) return [];
  const joiners = connectorWordsForLocale(locale);
  // A size, a count or any word with a digit names no group, so it neither finds one nor gets corrected.
  const topicWords = wordsOf(topic).filter((w) => !joiners.has(w) && !/\d/.test(w));
  if (topicWords.length === 0) return [];
  const matcher = (word: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${stemPatternForLocale(word, locale)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  const topicMatchers = topicWords.map(matcher);
  const topicText = ` ${topicWords.join(' ')} `;

  const groups = (okf.concepts || []).filter((c) => c.type === CATEGORY_TYPE && c.lifecycle?.status !== 'retired' && pathOf(c));
  const termsOf = (concept: OkfConcept): string[][] =>
    [concept.name, ...(concept.synonyms || []), ...(concept.customerPhrases || [])]
      .map((term) => wordsOf(String(term || '')).filter((w) => !joiners.has(w)))
      .filter((words) => words.length > 0);
  const termsByConcept = new Map(groups.map((concept) => [concept.conceptId, termsOf(concept)]));

  // Which groups use each word anywhere in their names and phrases (looked up lazily, once per word).
  const groupsByWord = new Map<string, Set<string>>();
  for (const [conceptId, terms] of termsByConcept) {
    for (const word of terms.flat()) {
      let ids = groupsByWord.get(word);
      if (!ids) groupsByWord.set(word, (ids = new Set()));
      ids.add(conceptId);
    }
  }
  const idfCache = new Map<string, number>();
  const idf = (word: string): number => {
    let value = idfCache.get(word);
    if (value === undefined) {
      const rx = matcher(word);
      const users = new Set<string>();
      for (const [key, ids] of groupsByWord) if (rx.test(` ${key} `)) ids.forEach((id) => users.add(id));
      value = Math.log((groups.length + 1) / (users.size + 0.5));
      idfCache.set(word, value);
    }
    return value;
  };
  const distinctive = Math.log((groups.length + 1) / (Math.max(1, groups.length * DISTINCTIVE_SHARE) + 0.5));

  const scored: RangeMatch[] = [];
  for (const concept of groups) {
    let best = 0;
    for (const termWords of termsByConcept.get(concept.conceptId) || []) {
      const termMatchers = termWords.map(matcher);
      const said = termMatchers.map((rx) => rx.test(topicText));
      if (!said.some(Boolean)) continue;
      const weights = termWords.map(idf);
      const total = weights.reduce((sum, w) => sum + w, 0);
      const matched = weights.reduce((sum, w, i) => sum + (said[i] ? w : 0), 0);
      // How much of the term the customer said, times how well what they said identifies a group.
      best = Math.max(best, (matched / total) * Math.min(1, matched / distinctive));
    }
    if (best >= MIN_MATCH_SCORE) scored.push({ concept, score: best });
  }
  scored.sort((a, b) => b.score - a.score || pathOf(a.concept)!.length - pathOf(b.concept)!.length || String(a.concept.name).localeCompare(String(b.concept.name)));
  const top = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score >= top * RELATIVE_CUTOFF).slice(0, max);
}

/** Edit distance of at most one: a letter changed, added or dropped, or two neighbouring letters swapped. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let first = -1;
    let differing = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (first < 0) first = i;
      if (++differing > 2) return false;
    }
    return differing === 1 || (differing === 2 && a[first] === b[first + 1] && a[first + 1] === b[first]);
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return shorter.slice(i) === longer.slice(i + 1);
}

export interface TopicCorrection {
  topic: string;
  changes: Array<{ from: string; to: string }>;
}

/**
 * For a customer's word that no group uses: the word the groups do use that is one slip away (a changed, missing, extra or swapped
 * letter), preferring the one more groups use. Null when every word is already known or nothing is close.
 */
export function correctTopic(okf: OkfReleaseContent | null | undefined, topic: string, locale: string | undefined): TopicCorrection | null {
  if (!okf || !topic) return null;
  const joiners = connectorWordsForLocale(locale);
  // A size, a count or any word with a digit names no group, so it neither finds one nor gets corrected.
  const topicWords = wordsOf(topic).filter((w) => !joiners.has(w) && !/\d/.test(w));
  const usedBy = new Map<string, number>();
  for (const concept of okf.concepts || []) {
    if (concept.type !== CATEGORY_TYPE || concept.lifecycle?.status === 'retired' || !pathOf(concept)) continue;
    const words = new Set([concept.name, ...(concept.synonyms || []), ...(concept.customerPhrases || [])].flatMap((term) => wordsOf(String(term || ''))));
    for (const word of words) usedBy.set(word, (usedBy.get(word) || 0) + 1);
  }
  const changes: TopicCorrection['changes'] = [];
  const corrected = topicWords.map((word) => {
    const known = new RegExp(`^${stemPatternForLocale(word, locale)}$`, 'i');
    if (word.length < 3 || [...usedBy.keys()].some((key) => known.test(key))) return word;
    const near = [...usedBy.entries()].filter(([key]) => key.length >= 3 && withinOneEdit(word, key)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (near.length === 0) return word;
    changes.push({ from: word, to: near[0][0] });
    return near[0][0];
  });
  return changes.length > 0 ? { topic: corrected.join(' '), changes } : null;
}

function childrenOf(okf: OkfReleaseContent, concept: OkfConcept): OkfConcept[] {
  const byId = new Map((okf.concepts || []).map((c) => [c.conceptId, c]));
  const ids = new Set<string>(((concept as any).broadQueryPolicy?.groupConceptIds as string[] | undefined) || []);
  for (const relationship of okf.relationships || []) {
    if (relationship.type === 'child_of' && relationship.to === concept.conceptId) ids.add(relationship.from);
  }
  return [...ids]
    .map((id) => byId.get(id))
    .filter((child): child is OkfConcept => Boolean(child) && child!.type === CATEGORY_TYPE && child!.lifecycle?.status !== 'retired' && Boolean(pathOf(child!)))
    .slice(0, MAX_CANDIDATE_CHILDREN);
}

function suggestionsFor(okf: OkfReleaseContent, concept: OkfConcept): Array<{ concept: OkfConcept; label?: string }> {
  const byId = new Map((okf.concepts || []).map((c) => [c.conceptId, c]));
  const out: Array<{ concept: OkfConcept; label?: string }> = [];
  for (const relationship of okf.relationships || []) {
    if (!SUGGESTION_RELATIONSHIPS.has(relationship.type) || relationship.from !== concept.conceptId) continue;
    const target = byId.get(relationship.to);
    // Only something a customer could buy is worth suggesting.
    if (!target || target.lifecycle?.status === 'retired' || (target as any).lens !== 'product' || !pathOf(target)) continue;
    out.push({ concept: target, label: relationship.customerLabel });
  }
  return out.slice(0, MAX_CHILDREN);
}

const groupOf = (concept: OkfConcept): RangeGroup => ({ name: concept.name, conceptId: concept.conceptId, path: pathOf(concept) });

export async function browseRange(deps: RangeBrowseDeps): Promise<{ found: boolean; topic?: string; interpretedAs?: TopicCorrection; nodes: RangeNode[] }> {
  const { okf } = deps;
  const topic = String(deps.topic || '').trim();
  if (!okf) return { found: false, topic, nodes: [] };
  let interpretedAs: TopicCorrection | undefined;

  let matches: RangeMatch[] = [];
  if (deps.path && deps.path.length > 0) {
    const wanted = deps.path.map((segment) => String(segment).toLowerCase()).join('\u0000');
    matches = (okf.concepts || []).filter((c) => {
      const path = pathOf(c);
      return c.type === CATEGORY_TYPE && path && path.map((segment) => segment.toLowerCase()).join('\u0000') === wanted;
    }).slice(0, 1).map((concept) => ({ concept, score: 1 }));
  }
  if (matches.length === 0 && topic) matches = matchRangeConcepts(okf, topic, deps.locale, deps.maxNodes ?? 4);
  if (matches.length === 0 && topic) {
    // A word no group uses may be a slip of the keyboard for one they do: try the closest known word, and say so.
    const fix = correctTopic(okf, topic, deps.locale);
    if (fix) {
      matches = matchRangeConcepts(okf, fix.topic, deps.locale, deps.maxNodes ?? 4);
      if (matches.length > 0) interpretedAs = fix;
    }
  }
  if (matches.length === 0) return { found: false, topic, nodes: [] };

  // A group inside another match is already described by it.
  const inside = (path: string[], ancestor: string[]) => ancestor.length < path.length && ancestor.every((segment, i) => segment === path[i]);
  matches = matches.filter((entry) => !matches.some((other) => other !== entry && inside(pathOf(entry.concept)!, pathOf(other.concept)!)));

  // Smaller groups and suggestions are spelled out for what the customer asked for; a related group is just named.
  const asked = matches.some((entry) => entry.score >= DIRECT_MATCH_SCORE) ? (entry: RangeMatch) => entry.score >= DIRECT_MATCH_SCORE : (entry: RangeMatch) => entry === matches[0];
  const nodes: RangeNode[] = matches.map((entry) => {
    const { concept, score } = entry;
    const node: RangeNode = { ...groupOf(concept), match: score >= DIRECT_MATCH_SCORE ? 'direct' : 'related' };
    const about = aboutOf(concept);
    if (about) node.about = about;
    if (!asked(entry)) return node;
    const children = childrenOf(okf, concept);
    if (children.length > 0) node.children = children.map(groupOf);
    // What is bought with the group, or with any group inside it, that is not itself one of its own groups.
    const own = pathOf(concept)!;
    const seen = new Set<string>();
    const goesWith = [concept, ...children]
      .flatMap((source) => suggestionsFor(okf, source))
      .filter((suggestion) => !inside(pathOf(suggestion.concept)!, own) && !seen.has(suggestion.concept.conceptId) && Boolean(seen.add(suggestion.concept.conceptId)));
    if (goesWith.length > 0) node.goesWith = goesWith.map((suggestion) => ({ ...groupOf(suggestion.concept), ...(suggestion.label ? { label: suggestion.label } : {}) }));
    return node;
  });

  // Live counts for every group shown, in one pass.
  const groups: RangeGroup[] = nodes.flatMap((node) => [node, ...(node.children || []), ...(node.goesWith || [])]);
  const counted = groups.filter((group) => group.path);
  const counts = await deps.count(counted.map((group) => group.path!));
  counted.forEach((group, index) => { group.productCount = counts[index] ?? 0; });
  // The groups with the most products first, and no more than a customer can take in.
  const biggest = (a: RangeGroup, b: RangeGroup) => (b.productCount ?? 0) - (a.productCount ?? 0) || a.name.localeCompare(b.name);
  for (const node of nodes) {
    if (node.children) node.children = node.children.filter((child) => (child.productCount ?? 0) > 0).sort(biggest).slice(0, MAX_CHILDREN);
    if (node.goesWith) node.goesWith = node.goesWith.filter((entry) => (entry.productCount ?? 0) > 0).sort(biggest).slice(0, MAX_CHILDREN);
  }

  // Real products for the best match: one or two from each of its smaller groups, or from the group itself when it has none.
  const lead = nodes[0];
  const sampled = (lead.children && lead.children.length > 0 ? lead.children : [lead]).filter((group) => group.path && (group.productCount ?? 0) > 0);
  if (sampled.length > 0) {
    const results = await deps.examples(sampled.map((group) => ({ conceptId: group.conceptId, label: group.name, categoryPaths: [group.path!], maxItems: EXAMPLES_PER_GROUP })));
    for (const result of results) {
      const group = sampled.find((entry) => entry.conceptId === result.conceptId);
      if (group && result.items.length > 0) group.examples = result.items;
    }
  }

  // A group with nothing in the catalogue is not worth a customer's time.
  return { found: true, topic, ...(interpretedAs ? { interpretedAs } : {}), nodes: nodes.filter((node) => node.productCount === undefined || node.productCount > 0) };
}
