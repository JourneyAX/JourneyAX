import { resolveTenant } from '../../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../../lib/bff-auth';
import { isSameOriginRequest } from '../../../../lib/request-origin';

export async function POST(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  if (!isSameOriginRequest(req)) return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  const { path = [] } = await params;
  if (path.length !== 2 || path[1] !== 'prepare' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(path[0])) return Response.json({ error: 'Not found.' }, { status: 404 });
  const auth = upstreamAuthHeaders(req); if (!auth) return unauthorized();
  const body = await req.json().catch(() => null);
  if (typeof body?.recordId !== 'string' || !body.recordId || body.recordId.length > 200) return Response.json({ error: 'Invalid record.' }, { status: 400 });
  if (body.workId !== undefined && (typeof body.workId !== 'string' || !/^[a-f0-9]{64}$/.test(body.workId))) return Response.json({ error: 'Invalid investigation.' }, { status: 400 });
  const tenantId = await resolveTenant(req);
  const base = (process.env.GATEWAY_URL || 'http://localhost:3010').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/commerce/desks/${encodeURIComponent(path[0])}/prepare`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId }, body: JSON.stringify({ recordId: body.recordId, workId: body.workId }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(95_000) });
    return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'The investigation is unavailable.' }, { status: 502 }); }
}

export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length > 1 || path.some(value => !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value))) return Response.json({ error: 'Not found.' }, { status: 404 });
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const tenantId = await resolveTenant(req);
  const recordId = new URL(req.url).searchParams.get('recordId');
  const cursor = new URL(req.url).searchParams.get('cursor');
  if (recordId !== null && (!path.length || !recordId || recordId.length > 200)) return Response.json({ error: 'Invalid record.' }, { status: 400 });
  if (cursor !== null && (!path.length || !cursor || cursor.length > 1000 || /[\u0000-\u001f\u007f]/.test(cursor))) return Response.json({ error: 'Invalid page.' }, { status: 400 });
  const query = new URLSearchParams({ ...(recordId !== null ? { recordId } : {}), ...(cursor !== null ? { cursor } : {}) }).toString();
  const base = (process.env.GATEWAY_URL || 'http://localhost:3010').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/commerce/desks${path.length ? `/${encodeURIComponent(path[0])}` : ''}${query ? `?${query}` : ''}`, {
      headers: { ...auth, 'X-Tenant-ID': tenantId }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(32_000),
    });
    return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'The working surface is unavailable.' }, { status: 502 }); }
}
