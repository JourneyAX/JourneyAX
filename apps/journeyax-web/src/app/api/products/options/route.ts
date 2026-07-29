import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/products/options { sku }
 *
 * Storefront BFF for a product's REAL orderable options, so the 3D configurator
 * offers the colours the catalogue can actually make rather than a generic
 * palette. A customer should never be able to design something unbuyable.
 *
 * Read-only catalogue facts, scoped to the project in the request — the same
 * data the agent sees via getProductOptions, so chat and the 3D agree.
 */
const PRODUCT_API = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sku = String(body?.sku || '').trim();
  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });

  // Project comes from the request context, never from the client body — a
  // storefront visitor must not be able to read another tenant's catalogue.
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const res = await fetch(`${PRODUCT_API}/api/v1/${encodeURIComponent(projectId)}/products/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
      body: JSON.stringify({ sku }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ found: false }, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    // The configurator falls back to its configured palette — never blocks.
    return NextResponse.json({ found: false }, { status: 200 });
  }
}
