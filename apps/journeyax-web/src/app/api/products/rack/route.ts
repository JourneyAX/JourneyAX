import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/products/rack — what else can hang in this kit.
 *
 * Grouped by the catalogue's own garment types. Items we know we can render are
 * flagged, so the rack can lead with the ones that will actually appear.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function GET(req: NextRequest) {
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const res = await fetch(
      `${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/products/rack`,
      { headers: { 'X-Tenant-ID': projectId }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return NextResponse.json({ groups: [] });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ groups: [] });
  }
}
