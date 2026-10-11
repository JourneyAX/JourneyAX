import type { OkfReleaseContent, OkfRevocationEvent } from './contracts';
import { resolveOkfGate, type OkfGateDecision } from './gate';
import { renderOkfMessage, resolveOkfPolicy } from './policy';

type CommercePolicy = OkfGateDecision['commerce'];

export interface OkfBasketCatalogProduct {
  projectId?: string;
  tenantId?: string;
  sku?: string;
  parentSku?: string;
  partCode?: string;
  categoryId?: string;
  categoryPath?: string[];
  status?: string;
  discontinued?: boolean;
  delisted?: boolean;
  lifecycle?: { status?: string };
}

export interface OkfBasketCommerceInput {
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
  return new Set([product.categoryId, ...(Array.isArray(product.categoryPath) ? product.categoryPath : [])]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim().toLowerCase()));
}

/**
 * Re-evaluates every SKU against its catalog category and the pinned release.
 * The current conversation's last matched concept is deliberately irrelevant.
 */
export function resolveOkfBasketCommerce(content: OkfReleaseContent, input: OkfBasketCommerceInput): OkfBasketCommerceDecision {
  const policyMessages = resolveOkfPolicy(content.policy).messages;
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
    const status = String(product.status || product.lifecycle?.status || '').toLowerCase();
    if (product.discontinued === true || product.delisted === true ||
      ['discontinued', 'delisted', 'retired', 'poa'].includes(status)) {
      policy = strictest(policy, BLOCKED);
      reasonCodes.add('unavailable_catalog_sku');
      continue;
    }

    const productCategories = categoryIds(product);
    const governing = content.concepts.filter((concept) =>
      concept.tenantId === input.tenantId &&
      concept.lifecycle.status !== 'retired' &&
      concept.searchScope.catalogCategoryIds.some((id) => productCategories.has(id.trim().toLowerCase())) &&
      !concept.searchScope.excludeCategoryIds.some((id) => productCategories.has(id.trim().toLowerCase())));
    if (governing.length === 0) {
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
