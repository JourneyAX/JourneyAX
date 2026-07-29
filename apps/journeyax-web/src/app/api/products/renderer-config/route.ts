import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/products/renderer-config?project=…
 *
 * The project's non-secret renderer config — palette, id patterns, hosts. The
 * studio needs the PALETTE so it can only ever offer colours the brand actually
 * stocks; offering a colour that renders black is the failure this prevents.
 *
 * Credentials never live in this config, so it is safe to expose. The project
 * comes from request context, not the client body.
 */
const PRODUCT_API = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';

export async function GET(req: NextRequest) {
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const res = await fetch(
      `${PRODUCT_API}/api/v1/${encodeURIComponent(projectId)}/products/renderer-config`,
      { headers: { 'X-Tenant-ID': projectId }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return NextResponse.json({}, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({}, { status: 200 });
  }
}
