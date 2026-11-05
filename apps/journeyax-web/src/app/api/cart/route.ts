import { resolveTenant } from '../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../lib/bff-auth';
import { isSameOriginRequest } from '../../../lib/request-origin';

async function cart(req: Request, write: boolean) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  if (write) {
    if (!isSameOriginRequest(req)) return Response.json({ error: 'Invalid origin.' }, { status: 403 });
  }
  const tenantId = await resolveTenant(req);
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  const body = write ? await req.json().catch(() => null) : undefined;
  if ((write && (!body || typeof body !== 'object' || Array.isArray(body))) || (!write && (!sessionId || sessionId.length > 200))) return Response.json({ error: 'A valid cart conversation is required.' }, { status: 400 });
  const base = (process.env.GATEWAY_URL || 'http://localhost:3010').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/commerce/cart${write ? '' : `?sessionId=${encodeURIComponent(sessionId!)}`}`, {
      method: write ? 'POST' : 'GET', headers: { ...auth, 'X-Tenant-ID': tenantId, 'Content-Type': 'application/json' }, ...(write ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(32_000),
    });
    return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'The cart service is unavailable.' }, { status: 502 }); }
}
export function GET(req: Request) { return cart(req, false); }
export function POST(req: Request) { return cart(req, true); }
