/**
 * GET /api/customize/access-preview?audience=shopper|staff&groups=a,b
 *
 * "View as": which agents a shopper, or a member of staff in the given groups, would get from the project's current settings.
 * Read-only. The answer is computed by the project service with the same function the runtime uses; this route only forwards the
 * signed-in person's token and the question, and never writes.
 */
import { NextResponse } from 'next/server';
import { resolveTenant } from '@/lib/tenant';
import { unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { previewQuery, readAccessPreview } from '@/lib/customize/accessPreview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';

export async function GET(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const tenantId = await resolveTenant(req);
  const url = new URL(req.url);
  const audience = url.searchParams.get('audience') === 'staff' ? 'staff' : 'shopper';
  const query = previewQuery(audience, url.searchParams.get('groups') || '');
  try {
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}/access-preview?${query}`, {
      headers: { ...auth, 'X-Tenant-ID': tenantId },
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
    if (res.status === 403) return NextResponse.json({ error: 'Forbidden', message: 'You do not have access to view this.' }, { status: 403 });
    if (res.status === 404) return NextResponse.json({ error: 'ProjectNotFound', message: 'This project does not exist.' }, { status: 404 });
    if (!res.ok) throw new Error(`project-service answered ${res.status}`);
    const preview = readAccessPreview(await res.json());
    if (!preview) throw new Error('unexpected answer');
    return NextResponse.json(preview, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    console.warn(`[customize/access-preview] failed for tenant '${tenantId}':`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'PreviewUnavailable', message: 'The preview could not be read just now.' }, { status: 502 });
  }
}
