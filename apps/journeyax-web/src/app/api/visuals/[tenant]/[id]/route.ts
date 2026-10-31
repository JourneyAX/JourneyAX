import { NextRequest, NextResponse } from 'next/server';

const RUNTIME_URL = process.env.JOURNEY_RUNTIME_URL || process.env.RUNTIME_SERVICE_URL || 'http://localhost:3012';
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[a-f0-9]{32}$/;

/**
 * GET /api/visuals/<tenant>/<id>
 *
 * A picture the consultant made for the customer's project, fetched from the runtime with the internal key. The id is a random
 * 128-bit value kept with the tenant, so a picture can only be read by someone who was shown its link.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const tenantId = String(tenant || '').toLowerCase();
  if (!TENANT.test(tenantId) || !ID.test(String(id || '').toLowerCase())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const res = await fetch(`${RUNTIME_URL}/api/v1/visuals/${tenantId}/${String(id).toLowerCase()}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '', 'X-Tenant-ID': tenantId },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: 'not found' }, { status: res.status === 404 ? 404 : 502 });
    return new NextResponse(await res.arrayBuffer(), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } });
  } catch (err: any) {
    console.warn(`[visuals] Could not fetch a picture for tenant '${tenantId}':`, err.message);
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }
}
