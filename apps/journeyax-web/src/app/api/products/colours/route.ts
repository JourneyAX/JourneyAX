import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/products/colours — real values for named inks (AUG-81).
 *
 * The catalogue derives these from the brand's own renderer, so a swatch shows
 * the ink the garment will actually be printed in rather than a CSS guess made
 * from the colour's name. Names it cannot resolve are simply absent, and the
 * caller marks those as unknown instead of painting them white.
 */
const PRODUCT_API = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';

export async function POST(req: NextRequest) {
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const body = await req.json().catch(() => ({}));
    const res = await fetch(
      `${PRODUCT_API}/api/v1/${encodeURIComponent(projectId)}/products/colours/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
        body: JSON.stringify({ names: Array.isArray(body?.names) ? body.names : [] }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) return NextResponse.json({ colours: {} });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ colours: {} });
  }
}
