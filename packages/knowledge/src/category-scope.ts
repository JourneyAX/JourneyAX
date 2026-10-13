import type { OkfConcept } from './contracts';

export type OkfSearchScope = OkfConcept['searchScope'];

const fold = (value: string) => value.trim().toLowerCase();

/** True when `productPath` starts with `scopePath`, segment by segment, exactly (case-insensitive). */
export function categoryPathCovers(scopePath: readonly string[], productPath: readonly string[]): boolean {
  if (scopePath.length === 0 || productPath.length < scopePath.length) return false;
  return scopePath.every((segment, index) => fold(segment) === fold(String(productPath[index] ?? '')));
}

/** The union of scopes, de-duplicated, preserving first-seen order. */
export function mergeSearchScopes(scopes: Array<Pick<OkfSearchScope, 'catalogCategoryIds' | 'catalogCategoryPaths'>>): { categoryIds: string[]; categoryPaths: string[][] } {
  const ids = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const scope of scopes) {
    for (const id of scope.catalogCategoryIds) ids.add(id);
    for (const path of scope.catalogCategoryPaths ?? []) {
      const key = path.map(fold).join('\u0000');
      if (!paths.has(key)) paths.set(key, [...path]);
    }
  }
  return { categoryIds: [...ids], categoryPaths: [...paths.values()] };
}

/**
 * Does the scope select a product with this category identifier and hierarchy path? Names (`catalogCategoryIds`) match
 * the category id or any path segment; paths match the hierarchy prefix.
 */
export function scopeSelectsProduct(
  scope: Pick<OkfSearchScope, 'catalogCategoryIds' | 'catalogCategoryPaths'>,
  product: { categoryId?: string; categoryNames?: readonly string[]; categoryPath?: readonly string[] },
): boolean {
  const path = Array.isArray(product.categoryPath) ? product.categoryPath.filter((segment): segment is string => typeof segment === 'string') : [];
  const names = new Set([product.categoryId, ...(product.categoryNames ?? []), ...path].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(fold));
  return scope.catalogCategoryIds.some((id) => names.has(fold(id))) ||
    (scope.catalogCategoryPaths ?? []).some((candidate) => categoryPathCovers(candidate, path));
}
