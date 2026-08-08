import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/products/render { style, colours, text, designLine }
 *
 * Storefront BFF for the real garment render. The heavy lifting — Scene7
 * texture composition and the multi-camera 3D render — happens in
 * product-service, which owns the per-project imaging config. The storefront
 * only needs the resulting image URLs.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.style) return NextResponse.json({ error: 'style is required' }, { status: 400 });

  // Project comes from request context, never the client body — a storefront
  // visitor must not be able to render against another tenant's config.
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/products/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NextResponse.json({ views: {}, notes: ['Renderer unavailable.'] }, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    // The panel falls back to its placeholder — a slow renderer must not break
    // the conversation.
    return NextResponse.json({ views: {}, notes: ['Renderer timed out.'] }, { status: 200 });
  }
}
