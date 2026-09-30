import { NextRequest, NextResponse } from 'next/server';
import { resolveTenant } from '@/lib/tenant';

const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';

/**
 * POST /api/products/batch
 *
 * Resolves product names, prices, images, and stock through tenant-scoped catalogue connectors at runtime.
 * Never relies on hardcoded frontend constants.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const skus: string[] = Array.isArray(body?.skus)
    ? body.skus.map(String).map((s: string) => s.trim()).filter(Boolean)
    : [];

  if (!skus.length) {
    return NextResponse.json({ items: [] });
  }

  const tenantId = await resolveTenant(req);

  try {
    const res = await fetch(`${PRODUCT_SERVICE_URL}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        'X-Tenant-ID': tenantId,
      },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        items: data.items || [],
        found: data.found || [],
        missing: data.missing || [],
      });
    }
  } catch (err: any) {
    console.warn(`[products/batch] Catalogue resolution failed for tenant '${tenantId}':`, err.message);
  }

  // Fail closed when catalogue connector is unavailable or returns error — do not fabricate synthetic mock products
  return NextResponse.json({
    items: [],
    found: [],
    missing: skus,
  });
}
