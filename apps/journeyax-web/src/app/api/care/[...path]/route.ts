/**
 * Customer care proxy: the care canvases' calls, forwarded to the gateway's commerce route with the signed-in person's token. The gateway adds who
 * the person is (their role and team) and the care desk decides what they may see and do; nothing here widens that. Only the known care paths pass.
 */
import { resolveTenant } from '../../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../../lib/bff-auth';
import { allowedCarePath } from '../../../../lib/care/allowedPath';

// A recording can send the care desk's calls to a separate gateway (CARE_GATEWAY_URL) that reaches pretend systems; normally it is the one gateway.
const GATEWAY_URL = process.env.CARE_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:3010';
async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const segments = Array.isArray(path) ? path : [];
  if (!allowedCarePath(req.method, segments)) return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/care/${segments.map(encodeURIComponent).join('/')}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, ...auth },
      body: req.method === 'POST' ? await req.text() : undefined,
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Could not reach the care desk.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}

export const GET = forward;
export const POST = forward;
