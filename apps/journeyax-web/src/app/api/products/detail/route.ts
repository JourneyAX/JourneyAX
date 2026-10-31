import { NextRequest, NextResponse } from 'next/server';
import { resolveTenant } from '@/lib/tenant';

const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';

/**
 * GET /api/products/detail?sku=
 *
 * One product as a customer reads it (description, features, specifications, documents, what goes with it, branch
 * availability), read from the tenant's own catalogue. Never filled in with invented content: when the catalogue cannot answer
 * the response is an error and the storefront falls back to what the product tile already knew.
 */
export async function GET(req: NextRequest) {
  const sku = (req.nextUrl.searchParams.get('sku') || '').trim();
  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });

  const tenantId = await resolveTenant(req);
  try {
    const res = await fetch(
      `${PRODUCT_SERVICE_URL}/api/v1/${encodeURIComponent(tenantId)}/products/detail?sku=${encodeURIComponent(sku)}`,
      {
        headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '', 'X-Tenant-ID': tenantId },
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      },
    );
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ error: 'not available' }, { status: res.status === 404 ? 404 : 502 });
  } catch (err: any) {
    console.warn(`[products/detail] Catalogue lookup failed for tenant '${tenantId}':`, err.message);
    return NextResponse.json({ error: 'catalogue unavailable' }, { status: 502 });
  }
}
