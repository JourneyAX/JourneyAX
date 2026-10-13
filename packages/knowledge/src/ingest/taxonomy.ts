import type { IngestConfig, TaxonomyRow, TaxonomySnapshot } from './types';
import { slugify, uniqueSlug } from './slug';

export type NodeStatus = 'concept' | 'covered_by_ancestor' | 'excluded';

export interface TaxonomyNode {
  /** Path from the department down to this node. */
  path: string[];
  name: string;
  level: number;
  parent?: TaxonomyNode;
  children: TaxonomyNode[];
  /** Products attached to exactly this node (not its descendants). */
  ownProducts: number;
  /** Products in this node and everything below it. */
  products: number;
  /** Exact catalogue identifiers that scope products to this node: its name plus any leaf-category alias. */
  identifiers: string[];
  slug: string;
  /** Stable identifier path, e.g. department/group/category. */
  slugPath: string[];
  status: NodeStatus;
  exclusionReason?: string;
}

export interface ExcludedRow { row: TaxonomyRow; reason: string }

export interface TaxonomyTree {
  roots: TaxonomyNode[];
  nodes: TaxonomyNode[];
  excluded: ExcludedRow[];
  /** Sum of all row counts, including excluded rows. */
  rowProductTotal: number;
  /** Products carrying neither a path nor a category, and not filed under an unassigned department. */
  unplacedProducts: number;
}

const keyOf = (path: string[]) => path.join('\u0000');

/** Builds the department → group → category tree from snapshot rows, deterministically. */
export function buildTaxonomyTree(snapshot: Pick<TaxonomySnapshot, 'rows'>, config: Pick<IngestConfig, 'unassignedDepartment' | 'exclusions' | 'minProductsForConcept'>): TaxonomyTree {
  const byKey = new Map<string, TaxonomyNode>();
  const excluded: ExcludedRow[] = [];
  let rowProductTotal = 0;
  let unplacedProducts = 0;

  const ensure = (path: string[]): TaxonomyNode => {
    const key = keyOf(path);
    const existing = byKey.get(key);
    if (existing) return existing;
    const parent = path.length > 1 ? ensure(path.slice(0, -1)) : undefined;
    const node: TaxonomyNode = {
      path, name: path[path.length - 1], level: path.length - 1, parent, children: [], ownProducts: 0, products: 0,
      identifiers: [path[path.length - 1]], slug: '', slugPath: [], status: 'concept',
    };
    byKey.set(key, node);
    parent?.children.push(node);
    return node;
  };

  for (const row of snapshot.rows) {
    rowProductTotal += row.productCount;
    let path = row.path;
    if (path.length === 0) {
      if (config.unassignedDepartment) path = row.category ? [config.unassignedDepartment, row.category] : [config.unassignedDepartment];
      else { excluded.push({ row, reason: 'no_department' }); unplacedProducts += row.productCount; continue; }
    }
    const rule = config.exclusions.find((entry) =>
      (!entry.department || entry.department === path[0]) && (!entry.category || entry.category === (row.category ?? path[path.length - 1])));
    if (rule) { excluded.push({ row, reason: rule.reason }); continue; }
    const node = ensure(path);
    node.ownProducts += row.productCount;
    if (row.category && row.category !== node.name && !node.identifiers.includes(row.category)) node.identifiers.push(row.category);
  }

  // Aggregate counts upward, order children (largest first, then name), assign stable slugs.
  const roots = [...byKey.values()].filter((node) => !node.parent);
  const aggregate = (node: TaxonomyNode): number => {
    node.products = node.ownProducts + node.children.reduce((sum, child) => sum + aggregate(child), 0);
    node.children.sort((a, b) => b.products - a.products || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return node.products;
  };
  roots.forEach(aggregate);
  roots.sort((a, b) => b.products - a.products || (a.name < b.name ? -1 : 1));

  const assign = (nodes: TaxonomyNode[], parentSlugPath: string[]) => {
    const taken = new Set<string>();
    for (const node of nodes) {
      node.slug = uniqueSlug(slugify(node.name), taken);
      node.slugPath = [...parentSlugPath, node.slug];
      assign(node.children, node.slugPath);
    }
  };
  assign(roots, []);

  const all: TaxonomyNode[] = [];
  const walk = (node: TaxonomyNode) => { all.push(node); node.children.forEach(walk); };
  roots.forEach(walk);

  // A node below the threshold has no concept of its own; its nearest concept-bearing ancestor covers it.
  for (const node of all) {
    if (node.level > 0 && node.products < config.minProductsForConcept) node.status = 'covered_by_ancestor';
  }
  return { roots, nodes: all, excluded, rowProductTotal, unplacedProducts };
}

/** The nearest ancestor that owns a concept (the node itself when it does). */
export function conceptOwner(node: TaxonomyNode): TaxonomyNode | undefined {
  for (let cursor: TaxonomyNode | undefined = node; cursor; cursor = cursor.parent) {
    if (cursor.status === 'concept') return cursor;
  }
  return undefined;
}
