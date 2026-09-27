/** A failed presentBundle grounding result must never be emitted as a card. */
export function bundleRefused(call: any, verdict: any): boolean {
  return call?.function?.name === 'presentBundle' && !!verdict && verdict.success === false;
}

/**
 * Prevent an empty item card after stock, catalogue, or variant filtering.
 * The model receives a reason it can turn into an honest next step.
 */
export function emptyShowItemsVerdict(
  call: any,
  facts: { soldOut: string[] } | void,
  hardDropped: string[] = [],
): Record<string, unknown> | null {
  if (call?.function?.name !== 'showItems') return null;
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return null; }
  if (Array.isArray(args?.products) && args.products.length) return null;
  const soldOut = facts?.soldOut || [];
  if (hardDropped.length) {
    return {
      success: false,
      shown: 0,
      wrongVariant: hardDropped,
      message: `Nothing was shown — every item was the wrong variant for this customer: ${hardDropped.join('; ')}. searchKnowledge again with the customer's variant in the query (it is appended automatically) and showItems only matching items. Say the size/variant reason once, plainly.`,
    };
  }
  return {
    success: false,
    shown: 0,
    soldOut,
    message: soldOut.length
      ? `Nothing was shown: ${soldOut.join(', ')} ${soldOut.length > 1 ? 'are' : 'is'} SOLD OUT. Tell the customer plainly it is sold out, then searchKnowledge for an in-stock alternative in the same family/art style and showItems those. Never describe a sold-out item as available.`
      : 'Nothing was shown: none of those items exist in the catalogue. searchKnowledge again with the customer\'s own words and showItems only real results.',
  };
}

export async function findCatalogueMatch(tenantId: string, query: string): Promise<any | null> {
  if (!query || !query.trim()) return null;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ query, limit: 1 }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body: any = await response.json();
    const results = body?.results || body?.items || (Array.isArray(body) ? body : []);
    return Array.isArray(results) && results.length ? results[0] : null;
  } catch { return null; }
}

/** Ground showItems cards with authoritative stock, price, and catalogue facts. */
export async function groundItemFacts(tenantId: string, call: any): Promise<{ soldOut: string[] }> {
  const out = { soldOut: [] as string[] };
  if (call?.function?.name !== 'showItems') return out;
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return out; }
  const products = args?.products;
  if (!Array.isArray(products) || !products.length) return out;
  const skus = [...new Set(products.map((product: any) => String(product?.sku || '').trim()).filter(Boolean))];
  if (!skus.length) return out;
  let payload: any;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return out;
    payload = await response.json();
  } catch { return out; }
  const bySku = new Map((payload?.items || []).map((item: any) => [String(item.sku).trim().toUpperCase(), item]));
  const missing = new Set((payload?.missing || []).map((sku: any) => String(sku).trim().toUpperCase()));
  const usedSkus = new Set<string>();
  let grounded = 0, dropped = 0, substituted = 0;
  const kept: any[] = [];
  for (const product of products) {
    const key = String(product?.sku || '').trim().toUpperCase();
    if (key && missing.has(key)) {
      const match = await findCatalogueMatch(tenantId, String(product?.name || product?.category || '').trim());
      const matchKey = match ? String(match.sku || '').trim().toUpperCase() : '';
      if (match && matchKey && !usedSkus.has(matchKey)) {
        usedSkus.add(matchKey); substituted++;
        kept.push({ ...product, sku: match.sku, name: match.name || product.name, price: typeof match.price === 'number' ? match.price : product.price, imageUrl: match.imageUrl || match.mainImage || product.imageUrl, url: match.url || product.url, category: match.category || product.category });
      } else dropped++;
      continue;
    }
    if (key) usedSkus.add(key);
    const row: any = key ? bySku.get(key) : null;
    if (!row) { kept.push(product); continue; }
    if (row.inStock === false) { dropped++; out.soldOut.push(String(row.name || product.name || key)); continue; }
    const groundedProduct = { ...product };
    if (row.imageUrl) groundedProduct.imageUrl = row.imageUrl;
    if (typeof row.price === 'number') groundedProduct.price = row.price;
    if (row.name) groundedProduct.name = row.name;
    if (row.url) groundedProduct.url = row.url;
    if (Array.isArray(row.colors) && row.colors.length) groundedProduct.colors = row.colors;
    if (Array.isArray(row.sizes) && row.sizes.length) groundedProduct.sizes = row.sizes;
    if (row.rating) groundedProduct.rating = row.rating;
    if (Array.isArray(row.completeTheLook) && row.completeTheLook.length) groundedProduct.completeTheLook = row.completeTheLook.slice(0, 12);
    if (typeof row.originalPrice === 'number' && row.originalPrice > (row.price || 0)) groundedProduct.originalPrice = row.originalPrice;
    if (groundedProduct.imageUrl !== product.imageUrl || groundedProduct.price !== product.price) grounded++;
    kept.push(groundedProduct);
  }
  const seen = new Set<string>();
  const deduped = kept.filter((product) => {
    const signature = `${String(product?.name || '').trim().toLowerCase()}|${product?.price ?? ''}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  args.products = deduped;
  call.function.arguments = JSON.stringify(args);
  if (grounded || dropped || substituted || deduped.length !== kept.length) {
    console.warn(`[AgentService] showItems: grounded ${grounded}, substituted ${substituted} fabricated→real, dropped ${dropped}, deduped ${kept.length - deduped.length}; ${deduped.length} real card(s)`);
  }
  return out;
}
