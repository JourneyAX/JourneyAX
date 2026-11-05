import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@journeyax/capability-sdk';
import { buildCatalogueIdentityFilter, classifyAvailability, normalizeCatalogProduct, readPath, resolveCatalogMapping } from '@journeyax/business-pack';
import { PAID_ORDER_LIMITS, priceCommerceLines, validatePaidOrderItems } from '@journeyax/shared-types';
import type { QuoteLine } from '@journeyax/shared-types';
import type { Db } from 'mongodb';
import { COLLECTION_PRODUCTS } from '@journeyax/database';

export function commerceOwner(ctx: ExecutionContext) {
  if (!ctx.tenantId || !ctx.environmentId || !ctx.principalId || !ctx.workspaceId) throw new Error('A verified commerce owner, environment and workspace are required.');
  return { tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId, workspaceId: ctx.workspaceId };
}

export function scopedCommerceId(ctx: ExecutionContext, resourceId: string): string {
  return createHash('sha256').update(JSON.stringify([commerceOwner(ctx), resourceId])).digest('hex');
}

export function commerceItems(items: unknown, allowEmpty = false): Array<{ sku: string; quantity: number }> {
  if (!Array.isArray(items) || (!allowEmpty && items.length === 0)) throw new Error('Commerce items must be a bounded list of catalogue SKUs.');
  if (items.length > PAID_ORDER_LIMITS.maxLines) throw new Error(`A checkout supports at most ${PAID_ORDER_LIMITS.maxLines} lines.`);
  validatePaidOrderItems(items.map(item => ({ quantity: item?.quantity ?? 1 })));
  const seen = new Set<string>();
  return items.map(item => {
    const quantity = item?.quantity ?? 1;
    if (typeof item?.sku !== 'string' || !item.sku.trim() || item.sku.length > 200 || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > PAID_ORDER_LIMITS.maxQuantityPerLine) throw new Error('Commerce items require a catalogue SKU and positive whole quantity.');
    const sku = item.sku.trim();
    if (seen.has(sku)) throw new Error('Duplicate cart or quote SKUs require one explicit combined quantity.');
    seen.add(sku);
    return { sku, quantity };
  });
}

/** Both carts and quotes hydrate prices and descriptions from the same mapped catalogue. */
export async function catalogueCommerceLines(items: Array<{ sku: string; quantity: number }>, ctx: ExecutionContext, source: Db | readonly unknown[]): Promise<Array<QuoteLine & { currency?: string }>> {
  if (!items.length) return [];
  const mapping = resolveCatalogMapping(ctx.packSettings?.catalogMapping ?? ctx.release?.catalogMapping);
  const skus = items.map(item => item.sku);
  // Count all source identities first. A retired/conflicted duplicate must not disappear before ambiguity is checked.
  const docs: any[] = Array.isArray(source) ? [...source] : await (source as Db).collection(COLLECTION_PRODUCTS).find(buildCatalogueIdentityFilter(mapping, ctx.tenantId, skus)).limit(401).toArray();
  if (docs.length > 400) throw new Error('Catalogue identity lookup exceeded its bound.');
  return items.map(item => {
    const matches = docs.filter(doc => {
      const owners = mapping.tenantFields.map(path => readPath(doc, path)).filter(value => value != null && value !== '');
      return owners.length > 0 && owners.every(value => value === ctx.tenantId) && mapping.identifierPaths.some(path => String(readPath(doc, path) ?? '') === item.sku);
    });
    if (matches.length !== 1 || classifyAvailability(matches[0], mapping) === 'excluded') throw new Error(`Uncatalogued or ambiguous SKU '${item.sku}' cannot enter commerce.`);
    const product = normalizeCatalogProduct(matches[0], mapping, { title: item.sku, category: '' });
    if (product.currencyUndeclared) throw new Error('Missing authoritative currency for a catalogue price.');
    const lineTotal = product.priceCents == null ? 0 : product.priceCents * item.quantity / 100;
    if (!Number.isSafeInteger(Math.round(lineTotal * 100))) throw new Error('Commerce line total is outside the supported range.');
    return { sku: item.sku, name: product.title, quantity: item.quantity, unitPrice: product.priceCents == null ? null : product.priceCents / 100, lineTotal, sourceOfPrice: product.priceCents == null ? 'unavailable' : 'catalogue', inStock: product.inStock, imageUrl: product.imageUrl, category: product.category, ...(product.currency ? { currency: product.currency } : {}) };
  });
}

/** The same monetary calculation is used by runtime carts and specialised configurator quotes. */
export function priceCommerceQuote(lines: Array<QuoteLine & { currency?: string }>, ctx: ExecutionContext, requestedCurrency?: string) {
  return priceCommerceLines(lines, ctx.release?.extensions?.commerce?.pricing, requestedCurrency);
}
