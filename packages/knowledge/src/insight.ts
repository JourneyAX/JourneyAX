import { stableKnowledgeJson } from './checksum';
import { findStaleVerifications } from './authoring';
import { scopeSelectsProduct } from './category-scope';
import { PROVENANCE_KEY } from './ingest/types';

/**
 * What a person needs to see about a body of business knowledge: where it covers the catalogue, what is authored versus
 * derived, which journeys it hands off to, what is verified, what still has no source, and what changed. Pure functions
 * over a release or draft: the same answer in the back office, a report and a test.
 */

type Content = {
  concepts: any[]; relationships?: any[]; sources?: any[]; evidenceChunks?: any[]; verifications?: any[]; factRegistry?: any[];
};

export interface CatalogueRow { path: string[]; category?: string; products: number }

export interface CoverageDepartment {
  name: string;
  concepts: number;
  authoredConcepts: number;
  conceptsWithCandidateSources: number;
  /** From the live catalogue, when it was supplied. */
  products?: number;
  productsCovered?: number;
}

export interface ConceptRef { conceptId: string; name: string }

export interface KnowledgeCoverage {
  totals: { concepts: number; relationships: number; sources: number; evidenceChunks: number; verifications: number; facts: number };
  layers: { derived: number; authored: number; manual: number };
  lenses: Record<string, number>;
  departments: CoverageDepartment[];
  authored: { families: ConceptRef[]; projects: ConceptRef[]; problems: ConceptRef[]; care: ConceptRef[]; other: ConceptRef[] };
  journeys: Array<{ journeyId: string; existsInPack: boolean | null; concepts: ConceptRef[] }>;
  projectsWithoutJourney: ConceptRef[];
  verification: {
    verifiedClaims: number;
    unverifiedClaims: number;
    byClaimClass: Record<string, { verified: number; unverified: number }>;
    conceptsWithCandidateSources: number;
    candidateSources: number;
    /** Problem and care concepts whose guidance nobody has verified: customers are referred to a professional. */
    guidanceGaps: Array<ConceptRef & { kind: 'problem' | 'care'; reason: string }>;
    stale: number;
  };
  catalogue?: {
    products: number;
    covered: number;
    uncovered: number;
    uncoveredCategories: Array<{ path: string[]; category?: string; products: number }>;
  };
}

const ref = (concept: any): ConceptRef => ({ conceptId: concept.conceptId, name: concept.name });
const provenanceOf = (concept: any) => {
  const structure = concept?.extensions?.[PROVENANCE_KEY]?.structure as { kind?: string; detail?: { section?: string } } | undefined;
  return structure ? { kind: structure.kind, section: structure.detail?.section } : undefined;
};

export function analyzeKnowledgeCoverage(
  content: Content,
  options: { journeyIds?: string[] | null; catalogue?: CatalogueRow[]; crossCuttingLabel?: string; uncoveredLimit?: number } = {},
): KnowledgeCoverage {
  const concepts = (content.concepts || []).filter((concept) => concept?.lifecycle?.status !== 'retired');
  const relationships = content.relationships || [];
  const sources = content.sources || [];
  const sourceKind = new Map(sources.map((source: any) => [source.sourceId, source.kind]));
  const stale = new Set(findStaleVerifications(content).map((entry) => `${entry.targetType}:${entry.targetId}`));

  const layers = { derived: 0, authored: 0, manual: 0 };
  const lenses: Record<string, number> = {};
  const departments = new Map<string, CoverageDepartment>();
  const authored: KnowledgeCoverage['authored'] = { families: [], projects: [], problems: [], care: [], other: [] };
  const candidateSources = new Set<string>();
  let conceptsWithCandidates = 0;

  const department = (name: string) => {
    if (!departments.has(name)) departments.set(name, { name, concepts: 0, authoredConcepts: 0, conceptsWithCandidateSources: 0 });
    return departments.get(name)!;
  };

  for (const concept of concepts) {
    lenses[concept.lens] = (lenses[concept.lens] ?? 0) + 1;
    const provenance = provenanceOf(concept);
    const isAuthored = provenance?.kind === 'authored_proposal';
    const isDerived = provenance?.kind === 'catalogue_taxonomy';
    if (isAuthored) layers.authored++; else if (isDerived) layers.derived++; else layers.manual++;

    const candidates = (concept.evidenceRefs || []).filter((id: string) => sourceKind.get(id) === 'crawl');
    for (const id of candidates) candidateSources.add(id);
    if (candidates.length) conceptsWithCandidates++;

    if (isAuthored) {
      const section = provenance?.section;
      const bucket = section === 'families' ? authored.families : section === 'projects' ? authored.projects
        : section === 'problems' ? authored.problems : section === 'care' ? authored.care : authored.other;
      bucket.push(ref(concept));
      continue;
    }
    const first = (concept.searchScope?.catalogCategoryPaths ?? [])[0] as string[] | undefined;
    const row = department(first?.[0] ?? options.crossCuttingLabel ?? '(by category name)');
    row.concepts++;
    if (candidates.length) row.conceptsWithCandidateSources++;
  }
  for (const concept of concepts) {
    if (provenanceOf(concept)?.kind === 'authored_proposal') {
      const first = (concept.searchScope?.catalogCategoryPaths ?? [])[0] as string[] | undefined;
      if (first) department(first[0]).authoredConcepts++;
    }
  }

  // Verification: only relationships that carry a claim class are claims.
  const byClaimClass: Record<string, { verified: number; unverified: number }> = {};
  let verifiedClaims = 0;
  let unverifiedClaims = 0;
  for (const relationship of relationships) {
    const classes: string[] = relationship.claimClasses || [];
    if (classes.length === 0) continue;
    const verified = !stale.has(`relationship:${relationship.relationshipId}`);
    verified ? verifiedClaims++ : unverifiedClaims++;
    for (const claimClass of classes) {
      byClaimClass[claimClass] ??= { verified: 0, unverified: 0 };
      byClaimClass[claimClass][verified ? 'verified' : 'unverified']++;
    }
  }

  const verifiedTargets = new Set((content.verifications || []).filter((record: any) => record.status === 'verified').map((record: any) => `${record.targetType}:${record.targetId}`));
  const guidanceGaps: KnowledgeCoverage['verification']['guidanceGaps'] = [];
  for (const concept of concepts) {
    if (concept.lens === 'problem') {
      const steps: string[] = concept.safety?.stepRefs || [];
      const verifiedSteps = steps.filter((id) => verifiedTargets.has(`concept:${id}`) && !stale.has(`concept:${id}`));
      if (steps.length === 0 || verifiedSteps.length < steps.length) {
        guidanceGaps.push({ ...ref(concept), kind: 'problem', reason: steps.length === 0 ? 'No first-response guidance has been written.' : 'Its guidance is not verified.' });
      }
    } else if (concept.lens === 'care') {
      const careEdges = relationships.filter((relationship: any) => relationship.from === concept.conceptId && (relationship.claimClasses || []).includes('care_safety'));
      if (!careEdges.some((relationship: any) => !stale.has(`relationship:${relationship.relationshipId}`))) {
        guidanceGaps.push({ ...ref(concept), kind: 'care', reason: 'No care guidance is verified.' });
      }
    }
  }

  // Journeys: which journeys the knowledge hands off to, and whether the active pack has them.
  const known = options.journeyIds ? new Set(options.journeyIds) : null;
  const byJourney = new Map<string, ConceptRef[]>();
  for (const concept of concepts) {
    const journeyId = concept.journeyRef?.journeyId as string | undefined;
    if (journeyId) byJourney.set(journeyId, [...(byJourney.get(journeyId) ?? []), ref(concept)]);
  }
  const journeys = [...byJourney.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([journeyId, list]) => ({
    journeyId, existsInPack: known ? known.has(journeyId) : null, concepts: list,
  }));
  const projectsWithoutJourney = concepts.filter((concept) => (concept.lens === 'project' || concept.type === 'project' || concept.type === 'room') && !concept.journeyRef).map(ref);

  const result: KnowledgeCoverage = {
    totals: {
      concepts: concepts.length, relationships: relationships.length, sources: sources.length,
      evidenceChunks: (content.evidenceChunks || []).length, verifications: (content.verifications || []).length, facts: (content.factRegistry || []).length,
    },
    layers, lenses,
    departments: [...departments.values()].sort((a, b) => b.concepts - a.concepts || (a.name < b.name ? -1 : 1)),
    authored, journeys, projectsWithoutJourney,
    verification: {
      verifiedClaims, unverifiedClaims, byClaimClass, conceptsWithCandidateSources: conceptsWithCandidates,
      candidateSources: candidateSources.size, guidanceGaps, stale: stale.size,
    },
  };

  if (options.catalogue) {
    let covered = 0;
    let total = 0;
    const uncovered: Array<{ path: string[]; category?: string; products: number }> = [];
    for (const row of options.catalogue) {
      total += row.products;
      const product = { categoryNames: row.category ? [row.category] : [], categoryPath: row.path };
      const isCovered = concepts.some((concept) => scopeSelectsProduct(concept.searchScope, product));
      if (isCovered) covered += row.products; else uncovered.push({ path: row.path, ...(row.category ? { category: row.category } : {}), products: row.products });
      // A product with neither a path nor a category cannot be attributed to any department (it is reported as uncovered).
      const dept = row.path.length > 0 || row.category ? department(row.path[0] ?? options.crossCuttingLabel ?? '(by category name)') : undefined;
      if (dept) { dept.products = (dept.products ?? 0) + row.products; if (isCovered) dept.productsCovered = (dept.productsCovered ?? 0) + row.products; else dept.productsCovered ??= 0; }
    }
    result.departments.sort((a, b) => (b.products ?? 0) - (a.products ?? 0) || b.concepts - a.concepts || (a.name < b.name ? -1 : 1));
    result.catalogue = {
      products: total, covered, uncovered: total - covered,
      uncoveredCategories: uncovered.sort((a, b) => b.products - a.products).slice(0, options.uncoveredLimit ?? 15),
    };
  }
  return result;
}

// ── What changed ────────────────────────────────────────────────────────────

export interface KnowledgeDiff {
  identical: boolean;
  concepts: { added: ConceptRef[]; removed: ConceptRef[]; changed: ConceptRef[]; total: number };
  relationships: { added: number; removed: number; changed: number };
  facts: { added: string[]; removed: string[]; changed: string[] };
  sources: { added: number; removed: number };
  verifications: { added: number; removed: number; changed: number };
}

const listCap = 20;

function compare<T>(base: T[], next: T[], key: (item: T) => string, signature: (item: T) => string) {
  const before = new Map(base.map((item) => [key(item), item]));
  const after = new Map(next.map((item) => [key(item), item]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && signature(before.get(id)!) !== signature(after.get(id)!));
  return { added, removed, changed, before, after };
}

/** Difference between two bodies of knowledge, by stable identity and content, never by position. */
export function diffKnowledge(base: Content | null | undefined, next: Content): KnowledgeDiff {
  const empty: Content = { concepts: [], relationships: [], sources: [], verifications: [], factRegistry: [] };
  const a = base ?? empty;
  const concepts = compare(a.concepts || [], next.concepts || [], (c: any) => c.conceptId, (c: any) => c.contentHash ?? stableKnowledgeJson(c));
  const relationships = compare(a.relationships || [], next.relationships || [], (r: any) => r.relationshipId, (r: any) => r.contentHash ?? stableKnowledgeJson(r));
  const facts = compare(a.factRegistry || [], next.factRegistry || [], (f: any) => f.factKey, (f: any) => stableKnowledgeJson(f));
  const sources = compare(a.sources || [], next.sources || [], (s: any) => s.sourceId, (s: any) => stableKnowledgeJson(s));
  const verifications = compare(a.verifications || [], next.verifications || [], (v: any) => v.recordId, (v: any) => `${v.status}:${v.contentHash}:${v.verifiedBy}`);
  const nameOf = (id: string) => ({ conceptId: id, name: (concepts.after.get(id) ?? concepts.before.get(id))?.name ?? id });
  const identical = [concepts, relationships, facts, sources, verifications].every((part) => part.added.length + part.removed.length + part.changed.length === 0);
  return {
    identical,
    concepts: {
      added: concepts.added.slice(0, listCap).map(nameOf), removed: concepts.removed.slice(0, listCap).map(nameOf), changed: concepts.changed.slice(0, listCap).map(nameOf),
      total: concepts.added.length + concepts.removed.length + concepts.changed.length,
    },
    relationships: { added: relationships.added.length, removed: relationships.removed.length, changed: relationships.changed.length },
    facts: { added: facts.added.slice(0, listCap), removed: facts.removed.slice(0, listCap), changed: facts.changed.slice(0, listCap) },
    sources: { added: sources.added.length, removed: sources.removed.length },
    verifications: { added: verifications.added.length, removed: verifications.removed.length, changed: verifications.changed.length },
  };
}
