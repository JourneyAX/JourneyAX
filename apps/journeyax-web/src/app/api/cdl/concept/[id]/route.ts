import { NextRequest } from 'next/server';

/**
 * GET /api/cdl/concept/:id  — same-origin proxy for a generated CDL design
 * concept image. The bytes live in product-service; the browser fetches them
 * here so an <img src> stays same-origin.
 *
 * We hit product-service DIRECTLY (not the gateway): the gateway's proxy only
 * handles JSON and collapses a binary image response to an empty `{}`. This
 * route is a server-side (node) fetch, so reaching the internal service is fine.
 */
export const runtime = 'nodejs';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'augusta'
  ).toLowerCase();

  try {
    const res = await fetch(
      `${PRODUCT_SERVICE_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/concept/${encodeURIComponent(id)}`,
      { headers: { 'X-Tenant-ID': projectId, 'X-Internal-Key': INTERNAL_API_KEY }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return new Response('not found', { status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new Response('concept unavailable', { status: 502 });
  }
}
