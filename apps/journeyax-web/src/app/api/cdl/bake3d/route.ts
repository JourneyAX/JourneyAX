import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/cdl/bake3d  { sku, glbUrl?, frontSourceId?|front?, backSourceId?|back?, backText?, tier?, size? }
 *
 * Faithful-in-3D bake: wraps the customer's design onto the REAL per-SKU mesh
 * via the Python retexture-service (through product-service). Returns a
 * retextured.glb URL + diagnostics (palette/hex, coverage, per-view IoU, verdict).
 *
 * Slow by nature — it renders the mesh, Gemini-paints each view and bakes a
 * multi-MB atlas (tens of seconds to a few minutes) — so allow a long timeout.
 * Hits product-service directly (the gateway can't proxy this, and it's server-side).
 */
export const runtime = 'nodejs';
export const maxDuration = 600;
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.sku) {
    return NextResponse.json({ ok: false, error: 'sku is required' }, { status: 400 });
  }
  const projectId = (
    req.headers.get('x-tenant-id') || req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID || 'augusta'
  ).toLowerCase();
  try {
    const res = await fetch(`${PRODUCT_SERVICE_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/bake3d`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId, 'X-Internal-Key': INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9 * 60_000),
    });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    return NextResponse.json(j, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `bake3d failed: ${e?.message || e}` }, { status: 502 });
  }
}
