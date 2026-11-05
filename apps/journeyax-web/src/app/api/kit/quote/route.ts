import { resolveTenant } from '../../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../../lib/bff-auth';
import { isSameOriginRequest } from '../../../../lib/request-origin';

/** Specialised configurator quote (roster/planner constraints), through the same verified gateway as checkout. */
export async function POST(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  if (!isSameOriginRequest(req)) return Response.json({ error: 'Invalid origin.' }, { status: 403 });
  const tenantId = await resolveTenant(req);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid quote request.' }, { status: 400 });
  const base = (process.env.GATEWAY_URL || 'http://localhost:3010').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/commerce/kit/quote`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'The quote service is unavailable.' }, { status: 502 }); }
}
