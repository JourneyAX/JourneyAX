import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/cdl/flat  { sourceId | artworkBase64 | artworkUrl }
 *
 * Faithful FLAT design texture (GPT-image) for the 3D projection. Hits
 * product-service directly (the gateway can't proxy this and it's server-side).
 * Slow — GPT-image runs a ~30-45s image edit — so allow a long timeout.
 */
export const runtime = 'nodejs';
export const maxDuration = 120;
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.sourceId && !body?.artworkBase64 && !body?.artworkUrl) {
    return NextResponse.json({ ok: false, error: 'sourceId or artwork is required' }, { status: 400 });
  }
  const projectId = (
    req.headers.get('x-tenant-id') || req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID || 'augusta'
  ).toLowerCase();
  try {
    const res = await fetch(`${PRODUCT_SERVICE_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/flat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId, 'X-Internal-Key': INTERNAL_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
    });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    return NextResponse.json(j, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `flat failed: ${e?.message || e}` }, { status: 502 });
  }
}
