import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/cdl/flat-views  { sourceId? | artworkBase64? | artworkUrl?, brief? }
 *
 * Coach team-order journey — four flat 2D views (front/back/left/right), cheap
 * and fast (no 3D bake). Small JSON in/out, so — unlike /flat and /bake3d, which
 * are slow/binary and hit product-service directly — this goes through the
 * gateway's `cdl` domain like /analyze does.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.sourceId && !body?.artworkBase64 && !body?.artworkUrl && !body?.brief) {
    return NextResponse.json({ ok: false, error: 'sourceId, artwork, or a brief is required' }, { status: 400 });
  }

  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'augusta'
  ).toLowerCase();

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/flat-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response from CDL service' }));
    return NextResponse.json(j, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `flat-views failed: ${e?.message || e}` }, { status: 502 });
  }
}
