/**
 * Provenance (v3 Card CMS, docs/v3-card-cms-architecture.md) — the same
 * existence check `enforceItemDesignability` already runs for `showItems`
 * (tooling-showitems-fake-sku-guard.md), generalised so a new presentation
 * tool gets it for free instead of re-deriving the lesson. `updateQuote` does
 * NOT need this: `QuoteService.build` already looks up every line
 * authoritatively (a fake SKU prices as `sourceOfPrice: 'unavailable'`, never
 * fabricated) — this module is for tools that show catalogue facts (price,
 * spec) taken directly from the model's arguments, the way showItems does.
 */

async function skusThatExist(tenantId: string, skus: string[]): Promise<Set<string>> {
  if (!skus.length) return new Set();
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/skus/exists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenantId,
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return new Set();
    const found = ((await res.json())?.found || []) as string[];
    return new Set(found.map((s) => String(s).toUpperCase()));
  } catch {
    // Best-effort, same stance as every sibling guard: never block the turn
    // on a validation hiccup — an unreachable check is not proof of fraud.
    return new Set();
  }
}

export interface SkuFact { sku: string; name: string; price: number | null; imageUrl: string | null; url?: string; category?: string }

/** Exact-code catalogue facts for SKUs the model named — same endpoint
 *  family and same best-effort stance as `skusThatExist`. */
export async function lookupSkuFacts(tenantId: string, skus: string[]): Promise<SkuFact[]> {
  if (!skus.length) return [];
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/skus/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    return (((await res.json())?.products || []) as SkuFact[]);
  } catch {
    return [];
  }
}

export interface ComparisonProvenanceResult {
  /** null when every SKU checked out — caller makes no change. */
  refusal: Record<string, unknown> | null;
  /** Present only when `refusal` is null AND some (not all) SKUs were dropped —
   *  the caller must re-filter `dimensions`/`rows` columns to match. */
  survivingSkus?: string[];
}

/**
 * Verify a `presentComparison` call's SKUs against the real catalogue, and
 * mutate `call.function.arguments` in place to drop any that don't exist —
 * exactly the pattern `enforceItemDesignability` uses for showItems, so every
 * dispatch site that already re-reads `call.function.arguments` after calling
 * it picks up the corrected value automatically.
 */
export async function verifyComparisonProvenance(tenantId: string, call: any): Promise<Record<string, unknown> | null> {
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return null; }
  const skus: string[] = Array.isArray(args?.skus) ? args.skus.map((s: unknown) => String(s || '').trim()) : [];
  const upper = [...new Set(skus.map((s) => s.toUpperCase()).filter(Boolean))];
  if (!upper.length) return null;

  const found = await skusThatExist(tenantId, upper);
  const keepMask = skus.map((s) => !s || found.has(s.toUpperCase())); // codeless entries pass through
  if (keepMask.every(Boolean)) return null; // nothing to drop

  const survivingIdx = keepMask.reduce<number[]>((acc, keep, i) => { if (keep) acc.push(i); return acc; }, []);
  const dropped = skus.filter((_, i) => !keepMask[i]);
  console.warn(`[presentation/provenance] presentComparison: dropped ${dropped.length} SKU(s) not in the catalogue: ${dropped.join(', ')}`);

  if (survivingIdx.length < 2) {
    // A comparison needs at least two real items — with fewer than that
    // surviving, refuse outright rather than render a comparison of one.
    return {
      success: false,
      removedNotFound: dropped,
      instruction: 'Fewer than two of those SKUs exist in the real catalogue — do not present a comparison. '
        + 'searchKnowledge for real alternatives, or tell the customer you could not find enough matching products to compare.',
    };
  }

  // Re-slice skus AND every row so columns stay aligned with the surviving SKUs.
  args.skus = survivingIdx.map((i) => skus[i]);
  if (Array.isArray(args.rows)) {
    args.rows = args.rows.map((row: unknown) => (Array.isArray(row) ? survivingIdx.map((i) => row[i]) : row));
  }
  call.function.arguments = JSON.stringify(args);
  return null;
}
