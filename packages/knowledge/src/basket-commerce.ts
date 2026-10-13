import type { OkfReleaseContent, OkfRevocationEvent } from './contracts';
import { resolveOkfGate, type OkfGateDecision } from './gate';
import { renderOkfMessage, resolveOkfPolicy } from './policy';
import { categoryPathCovers, scopeSelectsProduct } from './category-scope';
import type { OkfConcept } from './contracts';

type CommercePolicy = OkfGateDecision['commerce'];

export interface OkfBasketCatalogProduct {
  projectId?: string;
  tenantId?: string;
  sku?: string;
  parentSku?: string;
  partCode?: string;
  categoryId?: string;
  /** Every category label the product carries, as read by the tenant's catalogue mapping. */
  categoryNames?: string[];
  categoryPath?: string[];
  status?: string;
  discontinued?: boolean;
  delisted?: boolean;
  lifecycle?: { status?: string };
  [field: string]: unknown;
}

/** Catalog lifecycle vocabulary; supplied by the caller from the tenant catalog mapping, never assumed here. */
export interface OkfBasketAvailabilityRules {
  excludeFlagPaths: string[];
  statusPaths: string[];
  /** Statuses (excluded or unpriced) that make a SKU unsellable in a basket. */
  unavailableStatuses: string[];
}

export interface OkfBasketCommerceInput {
  availability: OkfBasketAvailabilityRules;
  tenantId: string;
  environmentId: string;
  releaseId: string;
  items: Array<{ sku: string }>;
  products: OkfBasketCatalogProduct[];
  activeRevocations?: OkfRevocationEvent[];
  now?: Date;
}

export interface OkfBasketCommerceDecision {
  commerce: CommercePolicy;
  warnings: string[];
  reasonCodes: string[];
  /** Resolved message templates for runtime-level wording. */
  messages: Record<string, string>;
}

const BLOCKED: CommercePolicy = { addToCart: 'blocked', checkout: 'blocked' };
const ADD_RANK: Record<CommercePolicy['addToCart'], number> = {
  allowed: 0, allowed_with_warning: 1, blocked: 2,
};
const CHECKOUT_RANK: Record<CommercePolicy['checkout'], number> = {
  allowed: 0, requires_compatibility_resolution: 1,
  requires_professional_confirmation: 2, blocked: 3,
};

function strictest(a: CommercePolicy, b: CommercePolicy): CommercePolicy {
  return {
    addToCart: ADD_RANK[a.addToCart] >= ADD_RANK[b.addToCart] ? a.addToCart : b.addToCart,
    checkout: CHECKOUT_RANK[a.checkout] >= CHECKOUT_RANK[b.checkout] ? a.checkout : b.checkout,
  };
}

function categoryIds(product: OkfBasketCatalogProduct): Set<string> {
  return new Set([product.categoryId, ...(Array.isArray(product.categoryNames) ? product.categoryNames : []), ...(Array.isArray(product.categoryPath) ? product.categoryPath : [])]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim().toLowerCase()));
}

/**
 * Every concept whose scope selects the product, most specific first: the deepest hierarchy path that covers it, then the
 * narrowest scope (a leaf category before a family that spans several), then a stable order.
 */
export function governingConceptsForProduct(content: OkfReleaseContent, tenantId: string, product: OkfBasketCatalogProduct): OkfConcept[] {
  const names = categoryIds(product);
  const path = Array.isArray(product.categoryPath) ? product.categoryPath.filter((segment): segment is string => typeof segment === 'string') : [];
  const depth = (concept: OkfConcept) => Math.max(0, ...(concept.searchScope.catalogCategoryPaths ?? []).filter((scope) => categoryPathCovers(scope, path)).map((scope) => scope.length));
  const breadth = (concept: OkfConcept) => concept.searchScope.catalogCategoryIds.length + (concept.searchScope.catalogCategoryPaths ?? []).length;
  return content.concepts
    .filter((concept) => concept.tenantId === tenantId && concept.lifecycle.status !== 'retired' &&
      scopeSelectsProduct(concept.searchScope, product) &&
      !concept.searchScope.excludeCategoryIds.some((id) => names.has(id.trim().toLowerCase())))
    .sort((a, b) => depth(b) - depth(a) || breadth(a) - breadth(b) || (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0));
}

function readPath(doc: unknown, path: string): unknown {
  let current: any = doc;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function productUnavailable(product: OkfBasketCatalogProduct, rules: OkfBasketAvailabilityRules): boolean {
  if (rules.excludeFlagPaths.some((path) => readPath(product, path) === true)) return true;
  const blocked = new Set(rules.unavailableStatuses.map((status) => status.trim().toLowerCase()));
  return rules.statusPaths.some((path) => {
    const value = readPath(product, path);
    return typeof value === 'string' && blocked.has(value.trim().toLowerCase());
  });
}

/**
 * Re-evaluates every SKU against its catalog category and the pinned release.
 * The current conversation's last matched concept is deliberately irrelevant.
 */
export function resolveOkfBasketCommerce(content: OkfReleaseContent, input: OkfBasketCommerceInput): OkfBasketCommerceDecision {
  const resolvedPolicy = resolveOkfPolicy(content.policy);
  const policyMessages = resolvedPolicy.messages;
  const uncovered = resolvedPolicy.coverage.uncoveredShopping;
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
    return { commerce: { ...BLOCKED }, warnings: [], reasonCodes: ['invalid_basket'], messages: policyMessages };
  }

  let policy: CommercePolicy = { addToCart: 'allowed', checkout: 'allowed' };
  const warnings = new Set<string>();
  const reasonCodes = new Set<string>();
  for (const item of input.items) {
    const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
    if (!sku) return { commerce: { ...BLOCKED }, warnings: [], reasonCodes: ['invalid_basket_sku'], messages: policyMessages };
    const products = input.products.filter((product) =>
      (product.projectId === input.tenantId || product.tenantId === input.tenantId) &&
      (!product.projectId || product.projectId === input.tenantId) &&
      (!product.tenantId || product.tenantId === input.tenantId) &&
      [product.sku, product.parentSku, product.partCode].includes(sku));
    if (products.length !== 1) {
      policy = strictest(policy, BLOCKED);
      reasonCodes.add(products.length ? 'ambiguous_catalog_sku' : 'missing_catalog_sku');
      continue;
    }

    const product = products[0];
    if (productUnavailable(product, input.availability)) {
      policy = strictest(policy, BLOCKED);
      reasonCodes.add('unavailable_catalog_sku');
      continue;
    }

    const governing = governingConceptsForProduct(content, input.tenantId, product);
    if (governing.length === 0) {
      // Only an explicit, release-level opt-in lets an uncovered category into the basket, and then only with the
      // restricted commerce policy the merchant configured. The product has already passed availability above.
      if (uncovered.mode === 'catalogue_only') {
        policy = strictest(policy, { ...uncovered.commerce });
        reasonCodes.add('uncovered_catalog_category');
        warnings.add(renderOkfMessage(policyMessages, 'uncovered_catalogue_only'));
        continue;
      }
      policy = strictest(policy, BLOCKED);
      reasonCodes.add('unmapped_catalog_category');
      continue;
    }

    for (const concept of governing) {
      const gate = resolveOkfGate(content, {
        tenantId: input.tenantId, environmentId: input.environmentId,
        releaseId: input.releaseId, message: '', exactSku: sku,
        matchedConcepts: [{ id: concept.conceptId, score: 1, matchedBy: 'catalog_category' }],
        activeRevocations: input.activeRevocations, now: input.now,
      });
      policy = strictest(policy, gate.commerce);
      if (gate.commerce.addToCart === 'allowed_with_warning') {
        warnings.add(renderOkfMessage(policyMessages, 'basket_warning_merchant_review', { conceptName: concept.name }));
      }
      if (gate.commerce.checkout === 'requires_compatibility_resolution') {
        warnings.add(renderOkfMessage(policyMessages, 'basket_warning_compatibility', { conceptName: concept.name }));
      }
      if (gate.commerce.checkout === 'requires_professional_confirmation') {
        warnings.add(renderOkfMessage(policyMessages, 'basket_warning_professional', { conceptName: concept.name }));
      }
      for (const code of gate.trace.reasonCodes) if (code === 'concept_revoked') reasonCodes.add(code);
    }
  }
  return { commerce: policy, warnings: [...warnings], reasonCodes: [...reasonCodes], messages: policyMessages };
}
