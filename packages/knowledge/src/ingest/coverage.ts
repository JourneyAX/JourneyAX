import type { GeneratedKnowledge, IngestWarnings } from './build-draft';
import { conceptOwner, type TaxonomyNode } from './taxonomy';
import { familyTerms } from './variants';

export interface CoverageNodeRow {
  level: 'department' | 'group' | 'category';
  path: string[];
  products: number;
  status: 'concept' | 'covered_by_ancestor';
  conceptId?: string;
  coveredBy?: string;
  navigationFact?: string;
  documentSources: number;
  searchPhrases: number;
}

export interface CoverageReport {
  tenantId: string;
  snapshotAt: string;
  source: string;
  generator: string;
  totals: {
    snapshotProducts: number;
    productsInRows: number;
    productsCovered: number;
    productsExcluded: number;
    productsWithoutDepartment: number;
    departments: number;
    groups: number;
    leafCategories: number;
    leafCategoriesWithOwnConcept: number;
    leafCategoriesCoveredByAncestor: number;
    concepts: number;
    relationships: number;
    navigationFacts: number;
    documentSources: number;
  };
  /** Every product the snapshot counted must be covered, excluded with a reason, or reported as unaccounted. */
  reconciliation: { ok: boolean; unaccountedProducts: number; note: string };
  departments: Array<{
    name: string; conceptId?: string; products: number; groups: number; categories: number;
    categoriesWithOwnConcept: number; categoriesCoveredByAncestor: number; documentSources: number;
  }>;
  nodes: CoverageNodeRow[];
  excluded: Array<{ path: string[]; category?: string; products: number; reason: string }>;
  documents?: { documents: number; mappedToProduct: number; byKind: Record<string, number>; categoriesWithCandidates: number };
  warnings: IngestWarnings;
  /** Customer terms that name several categories (for example "screws"): candidates for an authored family concept. */
  familySuggestions: Array<{ term: string; categories: string[] }>;
  /** Generated knowledge asserts no claim: the only verified content is whatever a human adds afterwards. */
  claims: { verifiedClaims: number; derivedConcepts: number; note: string };
}

/** A node's role comes from its place in the tree, not its depth: a leaf directly under a department is a category. */
const levelName = (node: TaxonomyNode): 'department' | 'group' | 'category' =>
  node.level === 0 ? 'department' : node.children.length > 0 ? 'group' : 'category';

export function buildCoverageReport(generated: GeneratedKnowledge): CoverageReport {
  const { tree, snapshot, draft, conceptIdByNode, documentSourcesByNode, keywordCountByNode, navigationFactByNode } = generated;
  const leaves = tree.nodes.filter((node) => node.children.length === 0);
  const nodes: CoverageNodeRow[] = tree.nodes.map((node) => {
    const owner = conceptOwner(node);
    return {
      level: levelName(node), path: node.path, products: node.products,
      status: node.status === 'concept' ? 'concept' : 'covered_by_ancestor',
      ...(node.status === 'concept' ? { conceptId: conceptIdByNode.get(node) } : { coveredBy: owner ? conceptIdByNode.get(owner) : undefined }),
      ...(navigationFactByNode.get(node) ? { navigationFact: navigationFactByNode.get(node) } : {}),
      documentSources: documentSourcesByNode.get(node)?.length ?? 0,
      searchPhrases: keywordCountByNode.get(node) ?? 0,
    };
  });

  const excludedProducts = tree.excluded.reduce((sum, entry) => sum + entry.row.productCount, 0);
  const productsCovered = tree.roots.reduce((sum, root) => sum + root.products, 0);
  const unaccounted = snapshot.totalProducts - productsCovered - excludedProducts;
  const departments = tree.roots.map((root) => {
    const subtree: TaxonomyNode[] = [];
    const walk = (node: TaxonomyNode) => { subtree.push(node); node.children.forEach(walk); };
    walk(root);
    const departmentLeaves = subtree.filter((node) => node.children.length === 0 && node.level > 0);
    return {
      name: root.name, conceptId: conceptIdByNode.get(root), products: root.products,
      groups: subtree.filter((node) => levelName(node) === 'group').length,
      categories: departmentLeaves.length,
      categoriesWithOwnConcept: departmentLeaves.filter((node) => node.status === 'concept').length,
      categoriesCoveredByAncestor: departmentLeaves.filter((node) => node.status !== 'concept').length,
      documentSources: new Set(subtree.flatMap((node) => documentSourcesByNode.get(node) || [])).size,
    };
  });

  const byKind = snapshot.documentTotals?.byKind ?? {};
  const categoriesWithCandidates = new Set(snapshot.documentCandidates.map((doc) => doc.path.join('\u0000'))).size;
  return {
    tenantId: snapshot.tenantId,
    snapshotAt: snapshot.snapshotAt,
    source: snapshot.source,
    generator: 'okf-taxonomy-ingest/1',
    totals: {
      snapshotProducts: snapshot.totalProducts,
      productsInRows: tree.rowProductTotal,
      productsCovered,
      productsExcluded: excludedProducts,
      productsWithoutDepartment: tree.unplacedProducts,
      departments: tree.roots.length,
      groups: tree.nodes.filter((node) => levelName(node) === 'group').length,
      leafCategories: leaves.length,
      leafCategoriesWithOwnConcept: leaves.filter((node) => node.status === 'concept').length,
      leafCategoriesCoveredByAncestor: leaves.filter((node) => node.status !== 'concept').length,
      concepts: draft.concepts.length,
      relationships: draft.relationships.length,
      navigationFacts: draft.factRegistry.length,
      documentSources: draft.sources.filter((source: any) => source.kind === 'crawl').length,
    },
    reconciliation: {
      ok: unaccounted === 0,
      unaccountedProducts: unaccounted,
      note: unaccounted === 0
        ? 'Every product in the snapshot is covered by a concept or excluded with a stated reason.'
        : `${unaccounted} product(s) in the snapshot are neither covered nor excluded.`,
    },
    departments,
    nodes,
    excluded: tree.excluded.map((entry) => ({ path: entry.row.path, category: entry.row.category, products: entry.row.productCount, reason: entry.reason })),
    ...(snapshot.documentTotals ? { documents: { ...snapshot.documentTotals, categoriesWithCandidates } } : {}),
    warnings: generated.warnings,
    familySuggestions: familyTerms([...new Set(leaves.map((node) => node.name))], generated.config.synonyms.pluralise).slice(0, 80),
    claims: {
      verifiedClaims: draft.verifications.filter((record: any) => record.status === 'verified').length,
      derivedConcepts: draft.concepts.length,
      note: 'Generated material is derived structure only. Compatibility, safety, installation, care and warranty claims are authored and verified separately.',
    },
  };
}

const n = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function renderCoverageMarkdown(report: CoverageReport): string {
  const t = report.totals;
  const lines: string[] = [
    `# ${report.tenantId} knowledge coverage`, '',
    `Snapshot **${report.snapshotAt}** · source: ${report.source} · generator \`${report.generator}\``, '',
    '## Summary', '',
    '| Measure | Value |', '|---|---|',
    `| Products in snapshot | ${n(t.snapshotProducts)} |`,
    `| Products covered by a concept | ${n(t.productsCovered)} |`,
    `| Products excluded (with reason) | ${n(t.productsExcluded)} |`,
    `| Departments / groups / leaf categories | ${t.departments} / ${t.groups} / ${t.leafCategories} |`,
    `| Leaf categories with their own concept | ${t.leafCategoriesWithOwnConcept} |`,
    `| Leaf categories covered by a parent concept | ${t.leafCategoriesCoveredByAncestor} |`,
    `| Concepts / relationships / navigation questions | ${t.concepts} / ${t.relationships} / ${t.navigationFacts} |`,
    `| Candidate document sources linked | ${t.documentSources} |`,
    `| **Verified claims** | **${report.claims.verifiedClaims}** |`, '',
    `Reconciliation: ${report.reconciliation.ok ? '✅' : '❌'} ${report.reconciliation.note}`, '',
    `> ${report.claims.note}`, '',
    '## Departments', '',
    '| Department | Products | Groups | Categories | Own concept | Via parent | Doc sources |', '|---|---:|---:|---:|---:|---:|---:|',
    ...report.departments.map((d) => `| ${d.name} | ${n(d.products)} | ${d.groups} | ${d.categories} | ${d.categoriesWithOwnConcept} | ${d.categoriesCoveredByAncestor} | ${d.documentSources} |`), '',
  ];
  if (report.excluded.length) {
    lines.push('## Excluded', '', '| Path | Category | Products | Reason |', '|---|---|---:|---|');
    for (const entry of report.excluded) lines.push(`| ${entry.path.join(' › ') || '—'} | ${entry.category ?? '—'} | ${n(entry.products)} | ${entry.reason} |`);
    lines.push('');
  }
  if (report.documents) {
    lines.push('## Documents', '', `${n(report.documents.documents)} crawled documents considered; ${n(report.documents.mappedToProduct)} mapped to a product through a stated SKU; ${report.documents.categoriesWithCandidates} categories have at least one candidate. By kind: ${Object.entries(report.documents.byKind).map(([kind, count]) => `${kind} ${n(count)}`).join(', ') || '—'}.`, '');
  }
  const w = report.warnings;
  lines.push(
    '## Warnings', '',
    `- Duplicate names qualified with their parent: ${w.duplicateNames.length}`,
    `- Search phrases dropped because several concepts claimed them: ${w.droppedAmbiguousPhrases}`,
    `- Name-derived synonyms dropped because another concept owns the phrase: ${w.droppedAmbiguousSynonyms}`,
    `- Phrases several concepts claimed, handed to their common parent: ${w.phrasesResolvedToParent} (${w.phrasesResolvedByDominance} by department dominance)`,
    `- Navigation questions truncated at the option limit: ${w.truncatedOptions.length}`,
    `- Scope identifiers that also match another department: ${w.scopeAmbiguity.length}`, '',
  );
  if (report.familySuggestions.length) {
    lines.push('## Family suggestions (for the authored layer)', '', 'Customer terms that name several categories. A family concept would let "screws" reach all of them.', '');
    for (const entry of report.familySuggestions.slice(0, 25)) lines.push(`- **${entry.term}** — ${entry.categories.join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderDepartmentMarkdown(report: CoverageReport, department: string): string {
  const rows = report.nodes.filter((node) => node.path[0] === department);
  const summary = report.departments.find((entry) => entry.name === department);
  const lines = [
    `# ${department}`, '',
    summary ? `${n(summary.products)} products · ${summary.groups} groups · ${summary.categories} categories (${summary.categoriesWithOwnConcept} with their own concept).` : '', '',
    '| Level | Path | Products | Status | Concept | Navigation question | Doc sources | Search phrases |', '|---|---|---:|---|---|---|---:|---:|',
    ...rows.map((row) => `| ${row.level} | ${row.path.join(' › ')} | ${n(row.products)} | ${row.status === 'concept' ? 'own concept' : 'covered by parent'} | ${row.conceptId ?? row.coveredBy ?? '—'} | ${row.navigationFact ?? '—'} | ${row.documentSources} | ${row.searchPhrases} |`),
    '', '_Derived from the catalogue taxonomy. Nothing on this page is a verified claim._', '',
  ];
  return `${lines.join('\n')}\n`;
}
