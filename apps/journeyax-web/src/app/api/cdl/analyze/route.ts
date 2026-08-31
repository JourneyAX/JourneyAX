import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/cdl/analyze  { imageUrl | imageBase64, sizes?[] }
 *
 * Storefront BFF for CDL Step 1+2: analyse an uploaded custom-jersey design and
 * match it to Augusta's template library. Vision + match run in product-service
 * (reached via the gateway's new `cdl` domain); the browser only gets the result.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.imageUrl && !body?.imageBase64) {
    return NextResponse.json({ error: 'imageUrl or imageBase64 is required' }, { status: 400 });
  }

  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'augusta'
  ).toLowerCase();

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({ error: 'bad response from CDL service' }));
    return NextResponse.json(j, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ error: `analyze failed: ${e?.message || e}` }, { status: 502 });
  }
}
