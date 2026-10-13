import { createHash } from 'node:crypto';
import { computeKnowledgeEntityHash } from '../checksum';
import type { OkfDraftContent } from '../contracts';
import {
  GENERATOR, IngestConfigSchema, PROVENANCE_KEY, TaxonomySnapshotSchema,
  type IngestConfig, type Provenance, type ProvenanceMap, type TaxonomySnapshot,
} from './types';
import { buildTaxonomyTree, conceptOwner, nodeScope, type TaxonomyNode, type TaxonomyTree } from './taxonomy';
import { normalizePhrase } from './slug';
import { pluralVariants, splitName } from './variants';

export interface IngestWarnings {
  /** Concept names that occur more than once and were qualified with their parent. */
  duplicateNames: Array<{ name: string; paths: string[][] }>;
  /** Search phrases dropped because more than one concept claimed them. */
  droppedAmbiguousPhrases: number;
  /** Name-derived synonyms dropped because another concept owns the phrase. */
  droppedAmbiguousSynonyms: number;
  /** Phrases several concepts claimed that were handed to their lowest common parent concept instead. */
  phrasesResolvedToParent: number;
  /** Of those, phrases that spanned departments and went to the dominant one. */
  phrasesResolvedByDominance: number;
  /** Navigation options cut at `maxOptions`. */
  truncatedOptions: Array<{ concept: string; offered: number; available: number }>;
  /** Scope identifiers that would also select products in another department. */
  scopeAmbiguity: Array<{ identifier: string; concept: string; alsoIn: string[] }>;
}

export interface GeneratedKnowledge {
  draft: OkfDraftContent;
  tree: TaxonomyTree;
  config: IngestConfig;
  snapshot: TaxonomySnapshot;
  conceptIdByNode: Map<TaxonomyNode, string>;
  /** Source ids attached to each concept (taxonomy source excluded). */
  documentSourcesByNode: Map<TaxonomyNode, string[]>;
  keywordCountByNode: Map<TaxonomyNode, number>;
  navigationFactByNode: Map<TaxonomyNode, string>;
  warnings: IngestWarnings;
}

const TAXONOMY_SOURCE_ID = 'src-catalogue-taxonomy';

const withThousands = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{([A-Za-z]+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));

function provenance(kind: Provenance['kind'], snapshotAt: string, detail?: Record<string, unknown>): Provenance {
  return { kind, generator: GENERATOR, snapshotAt, verified: false, ...(detail ? { detail } : {}) };
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/**
 * Builds a navigable OKF draft from a dated taxonomy snapshot. Everything generated is *derived*: structure from the
 * catalogue taxonomy, retrieval phrases from model-generated keywords, document links as unverified candidates.
 * No claim class is asserted and no verification record is written; SKU, price, stock and availability stay live.
 */
export function buildTaxonomyDraft(snapshotInput: unknown, configInput: unknown): GeneratedKnowledge {
  const snapshot = TaxonomySnapshotSchema.parse(snapshotInput);
  const config = IngestConfigSchema.parse(configInput);
  if (snapshot.tenantId !== config.tenantId) throw new Error(`Snapshot tenant '${snapshot.tenantId}' does not match config tenant '${config.tenantId}'`);

  const tree = buildTaxonomyTree(snapshot, config);
  const conceptNodes = tree.nodes.filter((node) => node.status === 'concept');
  const idOf = (node: TaxonomyNode) => `concept://${config.tenantId}/${node.slugPath.join('/')}`;
  const conceptIdByNode = new Map(conceptNodes.map((node) => [node, idOf(node)] as const));
  const warnings: IngestWarnings = { duplicateNames: [], droppedAmbiguousPhrases: 0, droppedAmbiguousSynonyms: 0, phrasesResolvedToParent: 0, phrasesResolvedByDominance: 0, truncatedOptions: [], scopeAmbiguity: [] };

  // ── Display names: qualify names that would otherwise collide ────────────
  const nameCounts = new Map<string, TaxonomyNode[]>();
  for (const node of conceptNodes) {
    const key = normalizePhrase(node.name);
    nameCounts.set(key, [...(nameCounts.get(key) || []), node]);
  }
  const displayName = new Map<TaxonomyNode, string>();
  for (const node of conceptNodes) {
    const same = nameCounts.get(normalizePhrase(node.name))!;
    if (same.length > 1) {
      displayName.set(node, node.parent ? `${node.name} (${node.parent.name})` : node.name);
      if (same[0] === node) warnings.duplicateNames.push({ name: node.name, paths: same.map((entry) => entry.path) });
    } else displayName.set(node, node.name);
  }

  // ── Sources ──────────────────────────────────────────────────────────────
  const sources: any[] = [{
    sourceId: TAXONOMY_SOURCE_ID, kind: 'catalog_feed', title: `${config.tenantId} catalogue taxonomy (${snapshot.source})`,
    feedId: `${config.tenantId}-catalogue-taxonomy`, snapshotAt: snapshot.snapshotAt,
  }];
  const sourceIdByUrl = new Map<string, string>();
  const documentSourcesByNode = new Map<TaxonomyNode, string[]>();
  const candidates = [...snapshot.documentCandidates];
  for (const node of conceptNodes) {
    const isLeaf = node.children.length === 0;
    const matching = candidates
      .filter((doc) => isLeaf
        ? doc.path.length === node.path.length && startsWith(doc.path, node.path) || node.identifiers.includes(doc.category) && startsWith(doc.path, node.path.slice(0, 1))
        : startsWith(doc.path, node.path))
      .sort((a, b) => b.chunkCount - a.chunkCount || (a.sourceUrl < b.sourceUrl ? -1 : 1));
    const chosen: string[] = [];
    for (const doc of matching) {
      if (chosen.length >= config.sources.maxPerConcept) break;
      let id = sourceIdByUrl.get(doc.sourceUrl);
      if (!id) {
        id = `src-doc-${createHash('sha256').update(doc.sourceUrl).digest('hex').slice(0, 12)}`;
        sourceIdByUrl.set(doc.sourceUrl, id);
        sources.push({ sourceId: id, kind: 'crawl', title: doc.title || doc.sourceUrl, url: doc.sourceUrl, crawledAt: doc.crawledAt || snapshot.snapshotAt });
      }
      if (!chosen.includes(id)) chosen.push(id);
    }
    documentSourcesByNode.set(node, chosen);
  }

  // ── Phrase ownership: a concept's own name beats synonyms, which beat model keywords ──
  // A phrase several concepts claim is not guessed: it goes to the lowest concept that contains all its owners
  // (that concept then asks which type is meant). Owners spread across departments leave it unassigned.
  const nodeByPath = new Map(tree.nodes.map((node) => [node.path.join('\u0000'), node] as const));
  const lowestCommonConcept = (owners: TaxonomyNode[]): TaxonomyNode | undefined => {
    const first = owners[0].path;
    let length = first.length;
    for (const owner of owners) {
      let shared = 0;
      while (shared < length && shared < owner.path.length && owner.path[shared] === first[shared]) shared++;
      length = shared;
    }
    for (let depth = length; depth >= 1; depth--) {
      const node = nodeByPath.get(first.slice(0, depth).join('\u0000'));
      if (node && node.status === 'concept') return node;
    }
    return undefined;
  };
  const nameOwners = new Map<string, Set<TaxonomyNode>>();
  for (const node of conceptNodes) {
    const key = normalizePhrase(displayName.get(node)!);
    nameOwners.set(key, (nameOwners.get(key) || new Set()).add(node));
  }
  // An ignored word is ignored in its singular and plural forms alike.
  const ignore = new Set(config.synonyms.ignoreTerms.flatMap((term) => [normalizePhrase(term), ...pluralVariants(term, config.synonyms.pluralise)]));
  const claims = new Map<string, Set<TaxonomyNode>>();
  const claim = (phrase: string, node: TaxonomyNode) => claims.set(phrase, (claims.get(phrase) || new Set()).add(node));
  for (const node of conceptNodes) {
    const parts = splitName(node.name, config.synonyms.splitOn);
    // Variants apply to each part of a compound name, never to the compound itself ("hammers mallet" is noise).
    const bases = new Set<string>(parts.length ? parts : [node.name]);
    if (config.synonyms.headNouns) {
      for (const base of [...bases]) {
        const words = normalizePhrase(base).split(' ').filter(Boolean);
        if (words.length > 1) bases.add(words[words.length - 1]);
      }
    }
    const own = normalizePhrase(displayName.get(node)!);
    for (const base of bases) {
      for (const phrase of [normalizePhrase(base), ...pluralVariants(base, config.synonyms.pluralise)]) {
        if (phrase.length >= config.synonyms.minLength && phrase !== own && !ignore.has(phrase)) claim(phrase, node);
      }
    }
  }
  const synonyms = new Map<TaxonomyNode, string[]>(conceptNodes.map((node) => [node, [] as string[]] as const));
  const resolveClaims = (
    target: Map<TaxonomyNode, string[]>,
    entries: Map<string, Set<TaxonomyNode>>,
    counter: 'droppedAmbiguousSynonyms' | 'droppedAmbiguousPhrases',
  ) => {
    for (const [phrase, owners] of entries) {
      // A phrase that is another concept's own name belongs to that concept.
      const named = nameOwners.get(phrase);
      if (named && ![...owners].every((owner) => named.has(owner))) { warnings[counter]++; continue; }
      let holder = owners.size === 1 ? [...owners][0] : lowestCommonConcept([...owners]);
      if (!holder && config.synonyms.dominanceThreshold < 1) {
        const byDepartment = new Map<string, { products: number; nodes: TaxonomyNode[] }>();
        for (const owner of owners) {
          const entry = byDepartment.get(owner.path[0]) || { products: 0, nodes: [] };
          entry.products += owner.products; entry.nodes.push(owner);
          byDepartment.set(owner.path[0], entry);
        }
        const total = [...byDepartment.values()].reduce((sum, entry) => sum + entry.products, 0);
        const top = [...byDepartment.values()].sort((a, b) => b.products - a.products)[0];
        if (total > 0 && top.products / total >= config.synonyms.dominanceThreshold) {
          holder = lowestCommonConcept(top.nodes);
          if (holder) warnings.phrasesResolvedByDominance++;
        }
      }
      if (!holder) { warnings[counter]++; continue; }
      if (owners.size > 1) warnings.phrasesResolvedToParent++;
      target.set(holder, [...(target.get(holder) || []), phrase]);
    }
  };
  resolveClaims(synonyms, claims, 'droppedAmbiguousSynonyms');
  for (const [node, list] of synonyms) synonyms.set(node, [...new Set(list)].sort());
  const synonymPhrases = new Set([...synonyms.values()].flat());

  // ── Search phrases from model-generated keywords ──
  const keywordClaims = new Map<string, Set<TaxonomyNode>>();
  const hintMeta = new Map<TaxonomyNode, { model?: string; generatedAt?: string }>();
  for (const node of conceptNodes) {
    if (node.children.length > 0 || config.keywords.maxPerConcept === 0) continue;
    // A category can have several sub-class keyword sets; use all of them, interleaved so each contributes.
    const hints = snapshot.keywordHints.filter((entry) =>
      (entry.path.length === node.path.length && startsWith(entry.path, node.path)) ||
      (node.identifiers.includes(entry.category) && entry.path[0] === node.path[0]));
    if (hints.length === 0) continue;
    hintMeta.set(node, { model: hints[0].model, generatedAt: hints[0].generatedAt });
    const own = normalizePhrase(displayName.get(node)!);
    const lists = hints.map((hint) => [...new Set(hint.keywords.map(normalizePhrase))]);
    const interleaved: string[] = [];
    for (let index = 0; lists.some((list) => index < list.length); index++) {
      for (const list of lists) if (index < list.length) interleaved.push(list[index]);
    }
    for (const phrase of new Set(interleaved)) {
      if (phrase.length >= config.keywords.minLength && phrase !== own && !nameOwners.has(phrase) && !synonymPhrases.has(phrase)) {
        keywordClaims.set(phrase, (keywordClaims.get(phrase) || new Set()).add(node));
      }
    }
  }
  const customerPhrases = new Map<TaxonomyNode, string[]>();
  resolveClaims(customerPhrases, keywordClaims, 'droppedAmbiguousPhrases');
  const keywordCountByNode = new Map<TaxonomyNode, number>();
  for (const [node, list] of customerPhrases) {
    const kept = [...new Set(list)].slice(0, config.keywords.maxPerConcept);
    customerPhrases.set(node, kept);
    keywordCountByNode.set(node, kept.length);
  }

  // ── Navigation facts and concepts ────────────────────────────────────────
  const navigationFactByNode = new Map<TaxonomyNode, string>();
  const factRegistry: any[] = [];
  const conceptChildren = (node: TaxonomyNode) => node.children.filter((child) => child.status === 'concept');
  for (const node of conceptNodes) {
    const children = conceptChildren(node);
    if (children.length < 2) continue;
    const factKey = `nav_${node.slugPath.join('_').replace(/-/g, '_')}`;
    navigationFactByNode.set(node, factKey);
    const offered = children.slice(0, config.navigation.maxOptions);
    if (offered.length < children.length) warnings.truncatedOptions.push({ concept: displayName.get(node)!, offered: offered.length, available: children.length });
    factRegistry.push({
      factKey, type: 'enum', questionRef: `q.${factKey}`,
      question: fill(config.navigation.questionTemplate, { name: node.name }),
      uiInputType: config.navigation.uiInputType,
      options: offered.map((child) => ({ value: child.slug, label: child.name })),
    });
  }

  const date = snapshot.snapshotAt.slice(0, 10);
  const concepts: any[] = conceptNodes.map((node) => {
    const children = conceptChildren(node);
    const factKey = navigationFactByNode.get(node);
    const sourceRefs = [TAXONOMY_SOURCE_ID, ...(documentSourcesByNode.get(node) || [])];
    const marks: ProvenanceMap = {
      structure: provenance('catalogue_taxonomy', snapshot.snapshotAt, { path: node.path, products: node.products, identifiers: node.identifiers, scopedBy: node.placed ? 'path' : 'name' }),
    };
    if ((synonyms.get(node) || []).length) {
      marks.synonyms = provenance('catalogue_taxonomy', snapshot.snapshotAt, { derivedFrom: 'category name' });
    }
    if ((customerPhrases.get(node) || []).length) {
      const meta = hintMeta.get(node);
      marks.customerPhrases = provenance('model_generated_keywords', snapshot.snapshotAt, { model: meta?.model, generatedAt: meta?.generatedAt });
    }
    if ((documentSourcesByNode.get(node) || []).length) {
      marks.evidenceRefs = provenance('crawl_document_candidate', snapshot.snapshotAt, { note: 'Candidate documents; not verified and not evidence for any claim until a qualified person confirms applicability.' });
    }
    const concept: any = {
      conceptId: conceptIdByNode.get(node)!,
      tenantId: config.tenantId,
      type: node.level === 0 ? 'department' : 'product_category',
      name: displayName.get(node)!,
      description: fill(children.length ? config.descriptions.parent : config.descriptions.leaf, {
        name: node.name, products: withThousands(node.products), children: children.length, date,
      }),
      synonyms: synonyms.get(node) || [],
      customerPhrases: customerPhrases.get(node) || [],
      lens: 'product',
      riskClass: 'standard',
      compatibilitySensitive: false,
      requiredFacts: factKey ? [{ factKey, importance: 'medium' }] : [],
      discriminators: factKey ? [{
        factKey, questionRef: `q.${factKey}`, clarifyFirst: false,
        valueMap: Object.fromEntries(children.slice(0, config.navigation.maxOptions).map((child) => [child.slug, conceptIdByNode.get(child)!])),
      }] : [],
      searchScope: nodeScope(node),
      commercePolicy: { ...config.commerce },
      safety: { blocksProducts: false, stepRefs: [] },
      evidenceRefs: sourceRefs,
      lifecycle: { status: 'active_draft' },
      version: 1,
      extensions: { [PROVENANCE_KEY]: marks },
    };
    if (factKey) {
      concept.broadQueryPolicy = {
        groupConceptIds: children.slice(0, config.navigation.overviewGroups).map((child) => conceptIdByNode.get(child)!),
        maxItemsPerGroup: config.navigation.maxItemsPerGroup,
        questionRef: `q.${factKey}`,
        productRetrievalAllowed: true,
      };
    }
    concept.contentHash = computeKnowledgeEntityHash(concept);
    return concept;
  });

  // ── child_of relationships (derived structure, no claims) ────────────────
  const relationships: any[] = [];
  for (const node of conceptNodes) {
    const parent = node.parent ? conceptOwner(node.parent) : undefined;
    if (!parent) continue;
    const relationship: any = {
      relationshipId: `rel-${node.slugPath.join('--')}-child-of`,
      from: conceptIdByNode.get(node)!, to: conceptIdByNode.get(parent)!,
      type: 'child_of', strength: 'required', scope: 'category', confidence: 'high',
      sourceRefs: [TAXONOMY_SOURCE_ID], claimClasses: [],
      extensions: { [PROVENANCE_KEY]: { structure: provenance('catalogue_taxonomy', snapshot.snapshotAt) } },
    };
    relationship.contentHash = computeKnowledgeEntityHash(relationship);
    relationships.push(relationship);
  }

  // ── Scope ambiguity: an identifier that also selects products in another department ──
  const departmentsByIdentifier = new Map<string, Set<string>>();
  for (const node of tree.nodes) {
    for (const element of node.path) {
      const key = element.toLowerCase();
      departmentsByIdentifier.set(key, (departmentsByIdentifier.get(key) || new Set()).add(node.path[0]));
    }
  }
  for (const node of conceptNodes) {
    for (const identifier of nodeScope(node).catalogCategoryIds) {
      const others = [...(departmentsByIdentifier.get(identifier.toLowerCase()) || [])].filter((department) => department !== node.path[0]);
      if (others.length) warnings.scopeAmbiguity.push({ identifier, concept: displayName.get(node)!, alsoIn: others.sort() });
    }
  }

  const draft = {
    schemaVersion: '1.0.0' as const,
    modelId: config.modelId,
    factRegistry, concepts, relationships, sources,
    evidenceChunks: [], verifications: [],
  } as unknown as OkfDraftContent;

  return { draft, tree, config, snapshot, conceptIdByNode, documentSourcesByNode, keywordCountByNode, navigationFactByNode, warnings };
}
