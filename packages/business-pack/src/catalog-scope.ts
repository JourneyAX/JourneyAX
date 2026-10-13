import { readPath, type ResolvedCatalogMapping } from './catalog-mapping';

/** What a concept (or any caller) wants to see of the catalogue, expressed in the tenant's own category vocabulary. */
export interface CategoryScope {
  /** Category names: matched case-insensitively, as a substring, against the mapping's category scope fields. */
  categoryIds?: string[];
  /** Hierarchy scopes (department → group → category): a product matches when its path starts with one, exactly. */
  categoryPaths?: string[][];
  excludeCategoryIds?: string[];
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (value: string) => value.trim().toLowerCase();

/** Only well-formed paths (non-empty string segments) are honoured; anything else is dropped, never widened. */
export function cleanCategoryPaths(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((path): path is string[] => Array.isArray(path) && path.length > 0 && path.every((segment) => typeof segment === 'string' && segment.trim().length > 0))
    .map((path) => path.map((segment) => segment.trim()));
}

/** True when `productPath` starts with `scopePath`, segment by segment, exactly (case-insensitive). */
export function pathCovers(scopePath: readonly string[], productPath: readonly string[]): boolean {
  if (scopePath.length === 0 || productPath.length < scopePath.length) return false;
  return scopePath.every((segment, index) => fold(segment) === fold(String(productPath[index] ?? '')));
}

const textOf = (doc: unknown, paths: string[]): string => paths
  .map((path) => readPath(doc, path))
  .map((value) => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value)))
  .join(' ')
  .toLowerCase();

/** Does this product fall inside the scope? An empty scope selects everything; an excluded category always loses. */
export function categoryScopeMatches(mapping: ResolvedCatalogMapping, scope: CategoryScope, doc: unknown): boolean {
  const ids = (scope.categoryIds ?? []).filter(Boolean);
  const paths = cleanCategoryPaths(scope.categoryPaths);
  const categoryText = textOf(doc, mapping.categoryScopePaths);
  if (ids.length > 0 || paths.length > 0) {
    const byName = ids.some((id) => categoryText.includes(id.toLowerCase()));
    const byPath = mapping.categoryHierarchyPaths.some((hierarchy) => {
      const value = readPath(doc, hierarchy);
      return Array.isArray(value) && paths.some((candidate) => pathCovers(candidate, value.map(String)));
    });
    if (!byName && !byPath) return false;
  }
  return !(scope.excludeCategoryIds ?? []).filter(Boolean).some((id) => categoryText.includes(id.toLowerCase()));
}

/**
 * The same scope as database clauses, to be ANDed into a product query. A path scope is an exact, anchored match on each
 * hierarchy segment, so a same-named category elsewhere is not selected; every segment is matched literally.
 */
export function buildCategoryScopeClauses(mapping: ResolvedCatalogMapping, scope: CategoryScope): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [];
  const ids = (scope.categoryIds ?? []).filter(Boolean);
  const paths = cleanCategoryPaths(scope.categoryPaths);
  const anyOf = (fields: string[], matcher: unknown) => fields.map((field) => ({ [field]: matcher }));
  if (ids.length > 0 || paths.length > 0) {
    const byName = ids.map((value) => new RegExp(escapeRegex(value), 'i'));
    const byPath = paths.flatMap((candidate) => mapping.categoryHierarchyPaths.map((hierarchy) => Object.fromEntries(
      candidate.map((segment, index) => [`${hierarchy}.${index}`, new RegExp(`^${escapeRegex(segment)}$`, 'i')]))));
    clauses.push({ $or: [...(byName.length ? anyOf(mapping.categoryScopePaths, { $in: byName }) : []), ...byPath] });
  }
  const excluded = (scope.excludeCategoryIds ?? []).filter(Boolean).map((value) => new RegExp(escapeRegex(value), 'i'));
  if (excluded.length > 0) clauses.push({ $nor: anyOf(mapping.categoryScopePaths, { $in: excluded }) });
  return clauses;
}

/** Tenant ownership and lifecycle exclusions, as a base query to which scope and text clauses are added. */
export function buildCatalogueBaseFilter(mapping: ResolvedCatalogMapping, tenantId: string): { filter: Record<string, any>; and: Array<Record<string, unknown>> } {
  const excluded = [
    ...mapping.availability.excludeFlagPaths.map((path) => ({ [path]: true })),
    ...mapping.availability.statusPaths.flatMap((path) =>
      mapping.availability.excludedStatuses.map((status) => ({ [path]: new RegExp(`^${escapeRegex(status)}$`, 'i') }))),
  ];
  const and: Array<Record<string, unknown>> = excluded.length > 0 ? [{ $nor: excluded }] : [];
  return { filter: { $or: mapping.tenantFields.map((path) => ({ [path]: tenantId })), $and: and }, and };
}
