/**
 * Tenant domain-glossary expansion.
 *
 * A retailer's own customers use trade slang and colloquial terms the catalogue
 * never spells out — "noggin"/"dwang" for a framing blocking piece, "gib" for
 * plasterboard, "tanking" for a waterproof membrane. Pure vector similarity on
 * the raw query silently misses these: the real product exists, but nothing in
 * its title or description matches the word the customer actually typed.
 *
 * A per-tenant glossary already gets generated during ingestion (one document
 * per tenant in `{projectId}_domain_glossary`, `{term, meaning, synonyms,
 * appliesToCategoryKeywords}[]`) but was never read at query time — this module
 * closes that gap. Deliberately ADDITIVE and tenant-generic: a tenant with no
 * glossary (or a term nobody's query happens to match) gets the query back
 * unchanged, so this can never make retrieval worse than it is today.
 */
import { Db } from 'mongodb';

export interface GlossaryTerm {
  term: string;
  meaning?: string;
  synonyms?: string[];
  appliesToCategoryKeywords?: string[];
}

export interface GlossaryExpansion {
  /** Query with matched terms' category keywords appended. */
  expandedQuery: string;
  /** Which glossary terms matched, for logging/explainability. */
  matched: string[];
  /** The keywords appended — also fed to lexicalRerank as extra boost tokens. */
  addedKeywords: string[];
}

// Static generated content, one small document per tenant — cache indefinitely
// per process rather than round-tripping to a currently-slow cluster on every
// single search call.
const glossaryCache = new Map<string, GlossaryTerm[]>();
// Concurrent requests for the same tenant before the cache is warm must share
// ONE Mongo round-trip, not each fire their own — without this, a burst of
// simultaneous searches during a slow cluster moment each independently wait
// on their own findOne(), compounding what should be a single cache-fill into
// a pile-up that can stall every one of them well past what a customer will
// tolerate. Confirmed live: a real chat turn's searchKnowledge calls all
// failed with "product service unavailable" during exactly this scenario.
const glossaryInFlight = new Map<string, Promise<GlossaryTerm[]>>();

export async function getDomainGlossary(db: Db, projectId: string): Promise<GlossaryTerm[]> {
  const cached = glossaryCache.get(projectId);
  if (cached) return cached;
  const inFlight = glossaryInFlight.get(projectId);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<GlossaryTerm[]> => {
    try {
      // Two independent bounds, because a slow moment on this cluster has
      // shown up both as slow query EXECUTION and as slow connection/server
      // selection — maxTimeMS only covers the former. The race is the actual
      // hard ceiling; maxTimeMS just gives the server a chance to cancel its
      // own side of the work instead of running on after the client's given up.
      //
      // The lookup promise gets its own .catch() — if `timeout` wins the race,
      // `lookup` keeps running in the background and can still reject later
      // (e.g. the maxTimeMS cancellation itself surfacing as a driver error).
      // With nothing attached to that eventual rejection it becomes an
      // UNHANDLED REJECTION, which crashed this exact process mid-session
      // tonight — Caroma kept working throughout because it never touches this
      // function at all (no glossary document), which is what made it obvious
      // this was PlaceMakers-specific rather than a general server crash.
      const lookup = db.collection(`${projectId}_domain_glossary`)
        .findOne({ projectId }, { maxTimeMS: 3000 })
        .catch(() => null);
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
      const doc = await Promise.race([lookup, timeout]);
      const terms: GlossaryTerm[] = Array.isArray((doc as any)?.terms) ? (doc as any).terms : [];
      glossaryCache.set(projectId, terms);
      return terms;
    } catch {
      // No glossary collection for this tenant, or a transient lookup failure
      // (including a maxTimeMS timeout) — either way, degrade to "no
      // expansion" rather than let a slow lookup block the whole search.
      glossaryCache.set(projectId, []);
      return [];
    } finally {
      glossaryInFlight.delete(projectId);
    }
  })();
  glossaryInFlight.set(projectId, promise);
  return promise;
}

/** Does the query contain this term or one of its synonyms as a whole word? */
function queryMentions(q: string, phrase: string): boolean {
  const p = phrase.toLowerCase().trim();
  if (!p) return false;
  // Whole-word-ish match: padded on both sides so "nog" doesn't match inside
  // "catalogue", but still matches "noggins" via the trailing space padding
  // only requiring the phrase to START at a word boundary.
  const re = new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return re.test(q);
}

export function expandWithGlossary(query: string, terms: GlossaryTerm[]): GlossaryExpansion {
  const q = ` ${String(query || '').toLowerCase()} `;
  const matched: string[] = [];
  const addedKeywords: string[] = [];

  for (const t of terms) {
    const candidates = [t.term, ...(t.synonyms || [])];
    const hit = candidates.find((c) => queryMentions(q, c));
    if (!hit) continue;
    matched.push(t.term);
    for (const kw of t.appliesToCategoryKeywords || []) {
      if (!addedKeywords.includes(kw)) addedKeywords.push(kw);
    }
  }

  const expandedQuery = addedKeywords.length ? `${query} ${addedKeywords.join(' ')}` : query;
  return { expandedQuery, matched, addedKeywords };
}
